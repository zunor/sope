// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeTracker } from "../src/agent/changes";
import { CellBuffer } from "../src/render/buffer";
import type { PixelImage } from "../src/render/graphics";
import { palette, surfaces } from "../src/theme";
import { ChangesPanel, drawChangeSummary } from "../src/ui/changes";
import { ChatView } from "../src/ui/chat";

const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();

let dir = "";
let cwd = "";
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "sope-changes-"));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Writes and moves the mtime on, so a rewrite within the same millisecond still reads as changed. */
let tick = 1_700_000_000;
const put = (path: string, text: string) => {
  writeFileSync(join(dir, path), text);
  utimesSync(join(dir, path), ++tick, ++tick);
};

test("an edited file diffs against what it was before sope's first change", () => {
  put("a.ts", "one\ntwo\nthree\n");
  const t = new ChangeTracker();
  t.track("a.ts");
  put("a.ts", "one\n2\nthree\nfour\n");
  t.track("a.ts"); // a later edit keeps the first baseline
  put("a.ts", "one\nTWO\nthree\nfour\n");
  t.refresh();
  expect(t.files.map((f) => [f.path, f.added, f.removed])).toEqual([["a.ts", 2, 1]]);
  expect([t.added, t.removed]).toEqual([2, 1]);

  put("a.ts", "one\ntwo\nthree\n"); // back as it was: no change left
  t.refresh();
  expect(t.files).toEqual([]);
});

test("a new file counts every line as added", () => {
  const t = new ChangeTracker();
  t.track("new.ts");
  put("new.ts", "a\nb\n");
  t.refresh();
  expect(t.files.map((f) => [f.path, f.added, f.removed])).toEqual([["new.ts", 2, 0]]);
});

test("files a command changed, created or deleted are found by the snapshot", () => {
  put("keep.txt", "same\n");
  put("mod.txt", "a\nb\n");
  put("gone.txt", "x\ny\nz\n");
  const t = new ChangeTracker();
  t.snapshot();
  put("mod.txt", "a\nB\n");
  put("made.txt", "1\n");
  unlinkSync(join(dir, "gone.txt"));
  t.detect();
  expect(t.files.map((f) => [f.path, f.added, f.removed])).toEqual([
    ["gone.txt", 0, 3],
    ["made.txt", 1, 0],
    ["mod.txt", 1, 1],
  ]);
});

test("changes before a snapshot are not sope's", () => {
  put("mine.txt", "a\n");
  const t = new ChangeTracker();
  t.snapshot();
  put("mine.txt", "b\n"); // the user, between two commands
  t.snapshot();
  t.detect();
  expect(t.files).toEqual([]);
});

test("the summary is two rows: a pixel outline like a tab's, or tinted text without graphics", () => {
  put("a.ts", "x\n");
  const t = new ChangeTracker();
  t.track("a.ts");
  put("a.ts", "y\nz\n");
  t.refresh();
  const colors = surfaces(0);
  let buf = new CellBuffer(40, 2);
  expect(drawChangeSummary(buf, 0, 40, 0, new ChangeTracker(), false, colors)).toBeNull();
  const hit = drawChangeSummary(buf, 0, 40, 0, t, false, colors)!;
  expect([row(buf, 0), row(buf, 1)]).toEqual([" ".repeat(16) + "  1 file changed +2 -1", ""]); // beside the status
  expect(hit).toEqual({ x0: 16, x1: 40, y0: 0, y1: 2 });
  expect(buf.bg[16]).toBe(colors.tab);
  expect(buf.fg[18]).toBe(palette.muted); // grey, white under the pointer
  drawChangeSummary(buf, 0, 40, 0, t, true, colors);
  expect(buf.fg[18]).toBe(0xffffff);
  expect(drawChangeSummary(new CellBuffer(10, 2), 0, 10, 0, t, false, colors)).toBeNull(); // no room

  buf = new CellBuffer(40, 2);
  const graphics = { cell: { width: 8, height: 16 }, images: [] as PixelImage[] };
  drawChangeSummary(buf, 0, 40, 0, t, false, colors, graphics);
  expect(graphics.images.map((i) => [i.slot, i.x, i.y, i.columns, i.rows])).toEqual([[190, 16, 0, 24, 2], [191, 16, 0, 24, 2]]);
  expect([row(buf, 0), row(buf, 1)]).toEqual(["", ""]); // the images show it
});

test("the panel lists the files and shows the picked one's diff", () => {
  put("a.ts", "one\n");
  put("b.ts", "two\n");
  const t = new ChangeTracker();
  t.track("a.ts");
  t.track("b.ts");
  put("a.ts", "ONE\n");
  put("b.ts", "two\nthree\n");
  t.refresh();
  const panel = new ChangesPanel(() => t);
  const buf = new CellBuffer(40, 10);
  panel.render(buf, { x: 0, y: 0, w: 40, h: 10 }, surfaces(0));
  expect(row(buf, 0)).toBe("Changes · 2 files +2 -1" + " ".repeat(16) + "✕");
  expect(row(buf, 1)).toBe("› a.ts" + " ".repeat(29) + "+1 -1");
  expect(row(buf, 3)).toBe("─".repeat(40));
  expect(row(buf, 4)).toBe("1 - one");
  expect(row(buf, 5)).toBe("1 + ONE");

  expect(panel.click(5, 2)).toBe("handled"); // b.ts
  buf.clear();
  panel.render(buf, { x: 0, y: 0, w: 40, h: 10 }, surfaces(0));
  expect(row(buf, 2).startsWith("› b.ts")).toBe(true);
  expect(row(buf, 4)).toBe("1   two");
  expect(row(buf, 5)).toBe("2 + three");
  expect(panel.click(39, 0)).toBe("close");
  expect(panel.click(5, 6)).toBeNull(); // the diff: left to text selection
});

test("diff wheel uses single rows, honors speed, and reverses immediately at an edge", () => {
  const t = new ChangeTracker();
  t.track("long.txt");
  put("long.txt", Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  t.refresh();
  const panel = new ChangesPanel(() => t);
  const buf = new CellBuffer(40, 10);
  const paint = () => {
    buf.clear();
    panel.render(buf, { x: 0, y: 0, w: 40, h: 10 }, surfaces(0));
    return row(buf, 3).trim();
  };
  expect(paint()).toBe("1 + line 1");
  panel.wheel(5, 1);
  expect(paint()).toBe("2 + line 2");
  panel.wheel(5, 1, 3);
  expect(paint()).toBe("5 + line 5");
  panel.wheel(5, -100);
  expect(paint()).toBe("1 + line 1");
  panel.wheel(5, -100);
  panel.wheel(5, 1);
  expect(paint()).toBe("2 + line 2");
});

test("a new turn starts counting from zero", () => {
  put("a.ts", "x\n");
  const t = new ChangeTracker();
  t.track("a.ts");
  put("a.ts", "y\n");
  t.refresh();
  const kept = t.toSet();
  t.reset();
  expect(t.files).toEqual([]);
  expect(kept.files.map((f) => f.path)).toEqual(["a.ts"]); // the transcript keeps the last turn's
  put("b.txt", "1\n"); // between turns, then a command's snapshot
  t.detect();
  expect(t.files).toEqual([]);
});

test("a turn's changes stay in the transcript as a summary that lights up and can be found by a click", () => {
  put("a.ts", "x\n");
  const t = new ChangeTracker();
  t.track("a.ts");
  put("a.ts", "y\nz\n");
  t.refresh();
  const chat = new ChatView();
  chat.add({ role: "assistant", text: "Done" });
  const changes = t.toSet();
  chat.add({ role: "changes", text: "", changes });
  const paint = (open?: typeof changes, graphics?: { cell: { width: number; height: number }; images: PixelImage[] }) => {
    const buf = new CellBuffer(40, 8);
    chat.render(buf, { x: 0, y: 0, w: 40, h: 8 }, "*", 0, surfaces(0), open, graphics);
    return buf;
  };
  let buf = paint();
  expect([2, 3].map((y) => row(buf, y))).toEqual(["", " ".repeat(16) + "  1 file changed +2 -1"]);
  expect(buf.fg[3 * 40 + 18]).toBe(palette.muted);
  expect(chat.changesAt(20, 2)).toBe(changes);
  expect(chat.changesAt(20, 3)).toBe(changes);
  expect(chat.changesAt(10, 3)).toBeUndefined();
  chat.hover({ x: 20, y: 2 });
  buf = paint();
  expect(buf.fg[3 * 40 + 18]).toBe(0xffffff);
  chat.hover(null);
  buf = paint(changes); // its diffs are open
  expect(buf.fg[3 * 40 + 18]).toBe(0xffffff);

  const graphics = { cell: { width: 8, height: 16 }, images: [] as PixelImage[] };
  buf = paint(undefined, graphics);
  expect(graphics.images.map((i) => [i.slot, i.x, i.y, i.rows])).toEqual([[200, 16, 2, 2], [201, 16, 2, 2]]);
  expect(row(buf, 3)).toBe("");
});
