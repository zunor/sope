// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { Editor } from "../src/ui/editor";

function selected(text: string, from: number, to: number): Editor {
  const editor = new Editor();
  editor.set(text);
  const row = editor.layout(80).rows[0]!;
  editor.moveToCell(row, from);
  editor.moveToCell(row, to, true);
  return editor;
}

test("both delete keys remove forward and backward selections exactly once", () => {
  for (const key of ["backspace", "delete", "ctrl+w", "ctrl+u", "ctrl+k"]) {
    for (const [from, to] of [[2, 5], [5, 2]] as const) {
      const editor = selected("abcdefg", from, to);
      expect(editor.selection).toEqual([2, 5]);
      editor.key(key, 80);
      expect(editor.text).toBe("abfg");
      expect(editor.cursor).toBe(2);
      expect(editor.selection).toBeNull();
    }
  }
});

test("typing, paste and newline replace selections; empty insert leaves them alone", () => {
  const editor = selected("abcdefg", 5, 2);
  editor.insert("");
  expect(editor.selection).toEqual([2, 5]);
  editor.insert("你好\nworld");
  expect(editor.text).toBe("ab你好\nworldfg");
  expect(editor.cursor).toBe(10);
  expect(editor.selection).toBeNull();
  const newline = selected("abcdefg", 2, 5);
  newline.key("ctrl+j", 80);
  expect(newline.text).toBe("ab\nfg");
});

test("selection never splits CJK, combining marks or emoji clusters", () => {
  const family = "👨‍👩‍👧";
  const editor = selected(`a你${family}e\u0301z`, 2, 6);
  expect(editor.selection).toEqual([1, 4 + family.length]);
  editor.backspace();
  expect(editor.text).toBe("az");
});

test("selection spans soft wraps, hard newlines and empty lines", () => {
  const editor = new Editor();
  editor.set("abcdef\n\n你好世界");
  const { rows } = editor.layout(4);
  editor.moveToCell(rows[0]!, 2);
  editor.moveToCell(rows[3]!, 2, true);
  expect(editor.text.slice(...editor.selection!)).toBe("cdef\n\n你");
  // Reflowing the input cannot change its selected text.
  editor.layout(40);
  editor.deleteForward();
  expect(editor.text).toBe("ab好世界");
});

test("drag reversal retains the original anchor, including passing through it", () => {
  const editor = selected("abcdef", 3, 5);
  const row = editor.layout(80).rows[0]!;
  editor.moveToCell(row, 3, true);
  expect(editor.selection).toBeNull();
  editor.moveToCell(row, 1, true);
  expect(editor.selection).toEqual([1, 3]);
  editor.backspace();
  expect(editor.text).toBe("adef");
});

test("clicks, cursor motion and resets clear the selection", () => {
  for (const key of ["left", "right", "home", "end", "up", "down", "alt+left", "alt+right"]) {
    const editor = selected("abcdefg", 2, 5);
    editor.key(key, 80);
    expect(editor.selection).toBeNull();
    expect(editor.text).toBe("abcdefg");
    if (key === "left") expect(editor.cursor).toBe(2);
    if (key === "right") expect(editor.cursor).toBe(5);
  }
  const editor = selected("abcdefg", 2, 5);
  editor.moveToCell(editor.layout(80).rows[0]!, 1);
  editor.backspace();
  expect(editor.text).toBe("bcdefg");
  editor.set("fresh");
  expect(editor.selection).toBeNull();
  editor.clear();
  expect(editor.cursor).toBe(0);
});

test("select all deletes to an empty input and the next edit has no stale range", () => {
  const editor = selected("你好", 0, 99);
  editor.deleteForward();
  expect(editor.text).toBe("");
  expect(editor.cursor).toBe(0);
  editor.insert("new");
  editor.backspace();
  expect(editor.text).toBe("ne");
});
