// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { renderMarkdown, slice } from "../src/ui/markdown";

const styledText = (src: string) => renderMarkdown(src).text;

test("strips markers and keeps text", () => {
  expect(styledText("# Title\n- **bold** and `code`\n> quote")).toBe("Title\n• bold and code\n│ quote");
  expect(styledText("```ts\nconst x = 1;\n```\nafter")).toBe("const x = 1;\nafter");
});

test("styles bold and inline code runs", () => {
  const s = renderMarkdown("a **b** `c` d");
  const spans = slice(s, 0, s.text.length, {});
  expect(spans.map((x) => x.text)).toEqual(["a ", "b", " ", "c", " d"]);
  expect(spans[1]!.style.bold).toBe(true);
  expect(spans[3]!.style.fg).toBeDefined();
});

test("leaves unclosed markers alone while streaming", () => {
  expect(styledText("partial **bold")).toBe("partial **bold");
  expect(styledText("a `b")).toBe("a `b");
});

test("slices runs across wrapped rows", () => {
  const s = renderMarkdown("**abcdef**");
  expect(slice(s, 2, 4, {})).toEqual([{ text: "cd", style: { bold: true } }]);
});

test("slicing a late row skips earlier style runs", () => {
  const s = renderMarkdown("**row**\n".repeat(20_000));
  let reads = 0;
  s.runs = new Proxy(s.runs, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  expect(slice(s, s.text.length - 4, s.text.length - 1, {})).toEqual([{ text: "row", style: { bold: true } }]);
  expect(reads).toBeLessThan(32);
});

test("style slicing preserves gaps and empty intervals", () => {
  const s = renderMarkdown("a **bc** d `ef` g");
  expect(slice(s, 3, 8, { italic: true }).map((span) => span.text)).toEqual(["c", " d ", "e"]);
  expect(slice(s, 4, 7, {})).toEqual([{ text: " d ", style: {} }]);
  expect(slice(s, 3, 3, {})).toEqual([]);
});
