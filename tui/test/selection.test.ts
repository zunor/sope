// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer, INVERSE } from "../src/render/buffer";
import { Selection } from "../src/ui/selection";
import { parseEnvFile } from "../src/config";

function screen(...rows: string[]): CellBuffer {
  const buf = new CellBuffer(12, rows.length);
  rows.forEach((row, y) => buf.text(0, y, row));
  return buf;
}

test("a drag selects like a terminal: rest of the first row, whole rows, start of the last", () => {
  const buf = screen("● hello", "  world  x", "› input");
  const s = new Selection();
  s.press({ x: 2, y: 0 });
  s.drag({ x: 5, y: 1 });
  expect(s.release({ x: 5, y: 2 })).toBe(true);
  expect(s.text(buf)).toBe("hello\n  world  x\n› inpu");
});

test("dragging backwards selects the same text", () => {
  const buf = screen("● hello", "  world");
  const s = new Selection();
  s.press({ x: 6, y: 1 });
  s.release({ x: 2, y: 0 });
  expect(s.text(buf)).toBe("hello\n  world");
});

test("a click selects nothing", () => {
  const s = new Selection();
  s.press({ x: 3, y: 1 });
  expect(s.release({ x: 3, y: 1 })).toBe(false);
  expect(s.active).toBe(false);
});

test("wide characters are copied whole and highlighted", () => {
  const buf = screen("ＨＩＡＢ");
  const s = new Selection();
  s.press({ x: 3, y: 0 }); // the second half of Ｉ
  s.release({ x: 4, y: 0 });
  expect(s.text(buf)).toBe("ＩＡ");
  s.highlight(buf);
  expect([...buf.attr.slice(0, 7)].map((a) => (a & INVERSE ? 1 : 0))).toEqual([0, 0, 1, 1, 1, 1, 0]);
});

test("SOPE_MOUSE=0 turns mouse capture off", async () => {
  const { loadConfig } = await import("../src/config");
  expect(loadConfig({}, {}, {}).mouse).toBe(true);
  expect(loadConfig({}, { SOPE_MOUSE: "0" }, {}).mouse).toBe(false);
  expect(loadConfig({}, {}, parseEnvFile("SOPE_MOUSE=off")).mouse).toBe(false);
});

test("a scrolled-up transcript stays put while output streams in", async () => {
  const { ChatView } = await import("../src/ui/chat");
  const chat = new ChatView();
  for (let i = 0; i < 10; i++) chat.add({ role: "info", text: `line ${i}` });
  const frame = () => {
    const buf = new CellBuffer(30, 5);
    chat.render(buf, { x: 0, y: 0, w: 30, h: 5 }, "");
    return buf.chars.slice(0, 30).join("").trim();
  };
  frame();
  chat.scrollBy(4);
  const top = frame();
  const reply = chat.add({ role: "assistant", text: "streaming" });
  chat.append(reply, "\nmore\nand more");
  expect(frame()).toBe(top);
  chat.scrollToBottom();
  expect(frame()).not.toBe(top);
});
