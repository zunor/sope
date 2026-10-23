// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { InputParser, keyId, type InputEvent } from "../src/term/input";

const enc = new TextEncoder();
const ids = (events: InputEvent[]) =>
  events.map((e) =>
    e.type === "key" ? keyId(e) : e.type === "mouse" ? `mouse:${e.action}` : (e.type === "osc" || e.type === "apc") ? `${e.type}:${e.data}` : `${e.type}:${e.text}`,
  );

function parse(...chunks: string[]): string[] {
  const p = new InputParser();
  const out: InputEvent[] = [];
  for (const c of chunks) out.push(...p.feed(enc.encode(c)));
  out.push(...p.flush());
  return ids(out);
}

test("text runs and control keys", () => {
  expect(parse("hi你好\r")).toEqual(["text:hi你好", "enter"]);
  expect(parse("\x03\x0a\x7f\t")).toEqual(["ctrl+c", "ctrl+j", "backspace", "tab"]);
});

test("CSI keys with modifiers", () => {
  expect(parse("\x1b[A\x1b[1;5C\x1b[3~\x1b[5~\x1b[Z")).toEqual(["up", "ctrl+right", "delete", "pageup", "shift+tab"]);
  expect(parse("\x1bOP")).toEqual(["f1"]);
  expect(parse("\x1b[13;2u")).toEqual(["shift+enter"]);
});

test("alt combinations", () => {
  expect(parse("\x1bb\x1b\x7f\x1bB")).toEqual(["alt+b", "alt+backspace", "alt+shift+b"]);
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
  const bytes = enc.encode("你");
  const p = new InputParser();
  expect(p.feed(bytes.slice(0, 1))).toEqual([]);
  expect(ids(p.feed(bytes.slice(1)))).toEqual(["text:你"]);
});

test("bracketed paste, including a split terminator", () => {
  expect(parse("\x1b[200~line1\r\nli", "ne2\x1b[20", "1~x")).toEqual(["paste:line1\nline2", "text:x"]);
});

test("SGR mouse wheel and drag", () => {
  expect(parse("\x1b[<64;10;5M\x1b[<65;10;5M")).toEqual(["mouse:wheel-up", "mouse:wheel-down"]);
  expect(parse("\x1b[<0;3;2M\x1b[<32;9;4M\x1b[<0;9;4m")).toEqual(["mouse:press", "mouse:drag", "mouse:release"]);
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
