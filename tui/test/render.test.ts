// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { Renderer } from "../src/render/renderer";
import { Editor } from "../src/ui/editor";

const row = (b: CellBuffer, y: number) => b.chars.slice(y * b.width, (y + 1) * b.width).join("");

test("wide characters occupy two cells and clip cleanly", () => {
  const b = new CellBuffer(5, 1);
  expect(b.text(0, 0, "aＨＩ")).toBe(5);
  expect(row(b, 0)).toBe("aＨＩ"); // continuation cells are ""
  b.clear();
  b.text(0, 0, "abcdＨ"); // Ｈ would straddle the edge
  expect(row(b, 0)).toBe("abcd ");
});

test("overwriting half of a wide character blanks the other half", () => {
  const b = new CellBuffer(4, 1);
  b.text(0, 0, "ＨＩ");
  b.text(1, 0, "x");
  expect(row(b, 0)).toBe(" xＩ");
});

test("second frame only writes the changed cells", () => {
  let out = "";
  const r = new Renderer((s) => (out = s), true);
  let b = r.begin(10, 2);
  b.text(0, 0, "hello");
  b.text(0, 1, "world");
  r.end();
  expect(out).toContain("\x1b[2J");

  b = r.begin(10, 2);
  b.text(0, 0, "hello");
  b.text(0, 1, "wOrld");
  r.end();
  expect(out).not.toContain("\x1b[2J");
  expect(out).toMatch(/\x1b\[2;2H(\x1b\[[\d;]*m)?O\x1b\[0m/); // move, style, one char
  expect(out).not.toContain("hello");
  expect(out).not.toContain("rld");
});

test("editor moves by grapheme and word, wide characters included", () => {
  const e = new Editor();
  e.insert("hi 👨‍👩‍👧");
  e.backspace();
  expect(e.text).toBe("hi ");
  e.insert("ＨＩＡＢ");
  e.left();
  e.left();
  expect(e.cursor).toBe(5);
  e.lineStart();
  e.wordRight();
  expect(e.cursor).toBe(2);
});

test("editor cursor layout wraps and survives a full last row", () => {
  const e = new Editor();
  e.insert("abcd");
  const l = e.layout(4);
  expect(l.cursorRow).toBe(1);
  expect(l.cursorCol).toBe(0);
  expect(e.moveVertical(-1, 4)).toBe(true);
  expect(e.cursor).toBe(0);
});
