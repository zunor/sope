// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { DiagramFrame, diagramBlocks, diagramSlice, expandDiagramTabs, repairDiagram } from "../src/ui/diagram";
import { renderMarkdown } from "../src/ui/markdown";
import { stringWidth } from "../src/unicode/width";

const broken = "┌────────┐\n│ ACTOR │\n└────────┘";
const fixed = "┌────────┐\n│ ACTOR  │\n└────────┘";

test("repairs nearby walls without moving labels, and is idempotent", () => {
  expect(repairDiagram(broken)).toBe(fixed);
  expect(repairDiagram(fixed)).toBe(fixed);
  const wide = "┌────────┐\n│ ＡＢ │\n└────────┘";
  expect(repairDiagram(wide)).toBe("┌────────┐\n│ ＡＢ   │\n└────────┘");
  const combining = "┌────────┐\n│ é 👩‍💻 │\n└────────┘";
  expect(repairDiagram(combining).split("\n")[1]).toBe("│ é 👩‍💻   │");
});

test("expands a short corner to an existing column and repairs nested boxes", () => {
  const text = ["┌─────────────────┐", "│ ┌──────┐       │", "│ │ X   │        │", "│ └──────┘       │", "└────────────────┘"].join("\n");
  const output = repairDiagram(text);
  expect(output.split("\n").map(stringWidth)).toEqual([19, 19, 19, 19, 19]);
  expect(output.split("\n")[2]).toContain("│ X    │");
  expect(repairDiagram(output)).toBe(output);
});

test("rejects ambiguous walls, occupied cells, connected arrows, and oversized inputs", () => {
  for (const body of ["│ ACTOR││", "│ ACTOR X│", "│ A ───│", "│ＡＢＣＤ│"]) {
    const text = `┌────────┐\n${body}\n└────────┘`;
    expect(repairDiagram(text)).toBe(text);
  }
  const huge = "┌" + "─".repeat(600) + "┐\n│ X│\n└" + "─".repeat(600) + "┘";
  expect(repairDiagram(huge)).toBe(huge);
  const code = 'if (x > 0) {\n  return a | b;\n}';
  expect(repairDiagram(code)).toBe(code);
});

test("fills an isolated edge gap, but preserves labels and arrow topology", () => {
  const text = "┌── ─────┐\n│ ACTOR  │\n└────────┘";
  expect(repairDiagram(text)).toBe(fixed);
  const labeled = "┌── title ───┐\n│            │\n└─────┬──────┘\n      ▼";
  expect(repairDiagram(labeled)).toBe(labeled);
});

test("tab stops and viewport clipping use display cells, not code units", () => {
  expect(expandDiagramTabs("Ａ\tx\nabc\tx")).toBe("Ａ  x\nabc x");
  expect(diagramSlice("aＡé👩‍💻z", 2, 4)).toBe(" é👩‍💻");
  expect(diagramSlice("aＡz", 0, 2)).toBe("a ");
});

test("detects plain fenced and unfenced diagrams without interpreting code or prose", () => {
  for (const source of [broken, `\`\`\`text\n${broken}\n\`\`\``, `~~~~ascii\n${broken}\n~~~~`]) {
    const rendered = renderMarkdown(source);
    expect(rendered.diagrams).toHaveLength(1);
    expect(rendered.diagrams![0]!.frame.rows.join("\n")).toBe(fixed);
  }
  expect(renderMarkdown(`\`\`\`ts\n${broken}\n\`\`\``).diagrams).toBeUndefined();
  expect(renderMarkdown("Normal prose → other text").diagrams).toBeUndefined();
});

test("streaming frames retain complete rows, scroll state, and repair only on closure", () => {
  const frames = new Map<number, DiagramFrame>();
  const prefix = "```text\n┌────────┐\n│ ACTOR │\n";
  const first = renderMarkdown(prefix, true, frames).diagrams![0]!.frame;
  expect(first.complete).toBe(false);
  expect(first.rows).toEqual(["┌────────┐", "│ ACTOR │"]);
  first.offset = 3;
  first.showOriginal = true;
  for (const tail of ["└", "└──", "└────────┘"]) {
    const next = renderMarkdown(prefix + tail, true, frames).diagrams![0]!.frame;
    expect(next).toBe(first);
    expect(next.rows).toEqual(["┌────────┐", "│ ACTOR │"]);
    expect(next.offset).toBe(3);
  }
  const final = renderMarkdown(prefix + "└────────┘\n```", true, frames).diagrams![0]!.frame;
  expect(final.complete).toBe(true);
  expect(final.repaired.join("\n")).toBe(fixed);
  expect(final.showOriginal).toBe(true);
  expect(final.offset).toBe(3);
});

test("unfenced streaming blocks do not repair just because a line ended", () => {
  const source = broken + "\n";
  const block = diagramBlocks(source.split("\n"), true)[0]!;
  expect(block.complete).toBe(false);
  expect(block.text).toBe(broken);
  expect(diagramBlocks((source + "\nNext paragraph").split("\n"), true)[0]!.complete).toBe(true);
});
