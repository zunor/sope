// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { InputParser, keyId, type InputEvent } from "../src/term/input";
import { Editor } from "../src/ui/editor";

const enc = new TextEncoder();
const ids = (events: InputEvent[]) =>
  events.map((e) =>
    e.type === "key" ? keyId(e) : e.type === "mouse" ? `mouse:${e.action}` : e.type === "cell-size" ? `cell:${e.width}x${e.height}` : (e.type === "osc" || e.type === "apc") ? `${e.type}:${e.data}` : `${e.type}:${e.text}`,
  );

function parse(...chunks: string[]): string[] {
  const p = new InputParser();
  const out: InputEvent[] = [];
  for (const c of chunks) out.push(...p.feed(enc.encode(c)));
  out.push(...p.flush());
  return ids(out);
}

test("text runs and control keys", () => {
  expect(parse("hiＨＩ\r")).toEqual(["text:hiＨＩ", "enter"]);
  expect(parse("\x03\x0a\x7f\t")).toEqual(["ctrl+c", "ctrl+j", "backspace", "tab"]);
});

test("CSI keys with modifiers", () => {
  expect(parse("\x1b[A\x1b[1;5C\x1b[3~\x1b[5~\x1b[Z")).toEqual(["up", "ctrl+right", "delete", "pageup", "shift+tab"]);
  expect(parse("\x1bOP")).toEqual(["f1"]);
  expect(parse("\x1b[13;2u")).toEqual(["shift+enter"]);
  // Cmd (super) keys a terminal passes on, such as cmd+f once Ghostty unbinds it.
  expect(parse("\x1b[102;9u\x1b[102;13u\x1b[1;9A")).toEqual(["super+f", "super+ctrl+f", "super+up"]);
});

test("invalid CSI-u code points are ignored without losing later input", () => {
  for (const code of ["", "-1", "1114112", "99999999999999999999999999", "55296"]) {
    expect(parse(`\x1b[${code}uok`)).toEqual(["text:ok"]);
  }
});

test("alt combinations", () => {
  expect(parse("\x1bb\x1b\x7f\x1bB")).toEqual(["alt+b", "alt+backspace", "alt+shift+b"]);
});

test("legacy and enhanced newline shortcuts insert a line while Enter remains send", () => {
  for (const sequence of ["\x0a", "\x1b\r", "\x1b[13;2u", "\x1b[106;5u", "\x1b[13;3u"]) {
    const editor = new Editor();
    editor.insert("first");
    for (const id of parse(sequence)) expect(editor.key(id, 20)).toBe(true);
    editor.insert("second");
    expect(editor.text).toBe("first\nsecond");
    expect(editor.layout(20).rows).toHaveLength(2);
  }
  expect(parse("\r")).toEqual(["enter"]);
});

test("a lone ESC resolves on flush, a split sequence does not", () => {
  const p = new InputParser();
  expect(p.feed(enc.encode("\x1b"))).toEqual([]);
  expect(p.hasPending).toBe(true);
  expect(ids(p.feed(enc.encode("[D")))).toEqual(["left"]);
  p.feed(enc.encode("\x1b"));
  expect(ids(p.flush())).toEqual(["escape"]);
});

test("UTF-8 split across reads", () => {
  const bytes = enc.encode("Ｈ");
  const p = new InputParser();
  expect(p.feed(bytes.slice(0, 1))).toEqual([]);
  expect(ids(p.feed(bytes.slice(1)))).toEqual(["text:Ｈ"]);
});

test("bracketed paste, including a split terminator", () => {
  expect(parse("\x1b[200~line1\r\nli", "ne2\x1b[20", "1~x")).toEqual(["paste:line1\nline2", "text:x"]);
});

test("SGR mouse wheel and drag", () => {
  expect(parse("\x1b[<64;10;5M\x1b[<65;10;5M")).toEqual(["mouse:wheel-up", "mouse:wheel-down"]);
  expect(parse("\x1b[<0;3;2M\x1b[<32;9;4M\x1b[<0;9;4m")).toEqual(["mouse:press", "mouse:drag", "mouse:release"]);
});

test("horizontal and modified wheel reports keep their axis across split reads", () => {
  expect(parse("\x1b[<66;10;5M\x1b[<67;10;5M")).toEqual(["mouse:wheel-left", "mouse:wheel-right"]);
  expect(parse("\x1b[<64;10;5M\x1b[<6", "6;10;5M\x1b[<64;10;5M\x1b[<67;10;5M"))
    .toEqual(["mouse:wheel-up", "mouse:wheel-left", "mouse:wheel-up", "mouse:wheel-right"]);
  const p = new InputParser();
  for (const [button, action] of [[64, "wheel-up"], [65, "wheel-down"], [66, "wheel-left"], [67, "wheel-right"]] as const) {
    expect(p.feed(enc.encode(`\x1b[<${button + 4 + 8 + 16};12;8M`))).toEqual([
      { type: "mouse", action, button: button & 3, x: 11, y: 7, shift: true, alt: true, ctrl: true },
    ]);
  }
});

test("OSC replies (background color) are recognized, split or whole", () => {
  expect(parse("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\x")).toEqual(["osc:11;rgb:1e1e/1e1e/1e1e", "text:x"]);
  expect(parse("\x1b]11;rgb:ffff/ffff/ffff\x07")).toEqual(["osc:11;rgb:ffff/ffff/ffff"]);
  expect(parse("\x1b]11;rgb:00", "00/0000/0000\x07a")).toEqual(["osc:11;rgb:0000/0000/0000", "text:a"]);
});

test("pointer motion without a button is a move (hover)", () => {
  expect(parse("\x1b[<35;10;1M")).toEqual(["mouse:move"]);
  expect(parse("\x1b[<32;10;1M")).toEqual(["mouse:drag"]);
});

test("editor clicks map display cells to whole graphemes and clamp to line ends", () => {
  const editor = new Editor();
  const family = "👨‍👩‍👧";
  editor.set(`aＨ${family}e\u0301z`);
  const row = editor.layout(40).rows[0]!;
  for (const [column, offset] of [[-2, 0], [0, 0], [1, 1], [2, 1], [3, 2], [4, 2], [5, 2 + family.length], [6, 4 + family.length], [30, editor.text.length]]) {
    editor.moveToCell(row, column!);
    expect(editor.cursor).toBe(offset!);
  }
  editor.moveToCell(row, 4);
  editor.insert("X");
  expect(editor.text).toBe(`aＨX${family}e\u0301z`);
});

test("editor clicks follow soft wraps, explicit newlines and empty rows", () => {
  const editor = new Editor();
  editor.set("ab cd\n\nＨＩＡＢ");
  const { rows } = editor.layout(4);
  for (const [row, column, offset] of [[0, 1, 1], [0, 10, 3], [1, 1, 4], [1, 10, 5], [2, 2, 6], [3, 3, 8], [4, 0, 9]]) {
    editor.moveToCell(rows[row!]!, column!);
    expect(editor.cursor).toBe(offset!);
  }
});

test("editor clicks handle an empty input and the extra cursor row after a full line", () => {
  const editor = new Editor();
  editor.moveToCell(editor.layout(4).rows[0]!, 3);
  expect(editor.cursor).toBe(0);
  editor.set("abcd");
  const { rows } = editor.layout(4);
  expect(rows).toHaveLength(2);
  editor.moveToCell(rows[1]!, 2);
  expect(editor.cursor).toBe(4);
  editor.moveToCell(rows[0]!, 2);
  editor.insert("X");
  expect(editor.text).toBe("abXcd");
});
