// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer, INVERSE } from "../src/render/buffer";
import { Selection } from "../src/ui/selection";
import { parseEnvFile } from "../src/config";
import { ChatView } from "../src/ui/chat";

test("multiline bubble selection excludes borders, padding and other messages in both directions", () => {
  for (const reverse of [false, true]) {
    const chat = new ChatView();
    chat.add({ role: "user", text: "alpha\n\nＨbeta" });
    chat.add({ role: "assistant", text: "Outside the bubble" });
    const buf = new CellBuffer(60, 16);
    chat.render(buf, { x: 2, y: 1, w: 30, h: 12 }, "");
    const bounds = chat.selectionBoundsAt(28, 2)!;
    expect(bounds.rows).toEqual([{ x: 24, y: 2, w: 5 }, { x: 24, y: 3, w: 1 }, { x: 24, y: 4, w: 6 }]);
    const a = { x: 25, y: 2 }, b = { x: 26, y: 4 };
    const s = new Selection();
    s.press(reverse ? b : a, bounds);
    s.release(reverse ? a : b);
    expect(s.text(buf)).toBe("lpha\n\nＨb");
    s.highlight(buf);
    for (let y = 0; y < buf.height; y++) for (let x = 0; x < buf.width; x++) {
      if (buf.attr[y * buf.width + x]! & INVERSE) {
        expect(bounds.rows.some(r => y === r.y && x >= r.x && x < r.x + r.w)).toBe(true);
      }
    }
    expect(buf.attr[2 * buf.width + 31]! & INVERSE).toBe(0); // right border
    expect(buf.attr[3 * buf.width + 0]! & INVERSE).toBe(0); // outside the empty row
  }
});

test("bubble drags clamp outside endpoints and preserve whole wide graphemes", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "aＨ👨‍👩‍👧e\u0301\nlast" });
  const buf = new CellBuffer(50, 12);
  chat.render(buf, { x: 2, y: 1, w: 30, h: 10 }, "");
  const bounds = chat.selectionBoundsAt(28, 2)!;
  const first = bounds.rows[0]!, last = bounds.rows.at(-1)!;
  const s = new Selection();
  s.press({ x: first.x + 2, y: first.y }, bounds); // second cell of the wide letter
  s.release({ x: 49, y: 11 });
  expect(s.text(buf)).toBe("Ｈ👨‍👩‍👧e\u0301\nlast");
  s.press({ x: last.x + last.w - 1, y: last.y }, bounds);
  s.release({ x: 0, y: 0 });
  expect(s.text(buf)).toBe("aＨ👨‍👩‍👧e\u0301\nlast");
});

test("bubble bounds follow clipped and wrapped layouts inside the chat pane", () => {
  for (const w of [30, 18]) for (const h of [3, 12]) {
    const chat = new ChatView();
    chat.add({ role: "user", text: "ＨＥＬＬＯＷＯＲＬＤ！\nsecond line" });
    const buf = new CellBuffer(60, 20);
    chat.render(buf, { x: 3, y: 2, w, h }, "");
    const bounds = chat.selectionBoundsAt(3 + w - 2, 3)!;
    expect(bounds.rows.length).toBeGreaterThan(0);
    const s = new Selection();
    s.press(bounds.rows[0]!, bounds);
    s.release({ x: 59, y: 19 });
    expect(s.text(buf)).not.toMatch(/[│╭╮╰╯─]/);
    for (const row of bounds.rows) {
      expect(row.y).toBeGreaterThanOrEqual(2);
      expect(row.y).toBeLessThan(2 + h);
      expect(row.x).toBeGreaterThanOrEqual(3);
      expect(row.x + row.w).toBeLessThanOrEqual(3 + w - 2);
    }
  }
});

test("bubble selections survive animation but expire when their layout moves or is hidden", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "one\ntwo" });
  const buf = new CellBuffer(50, 12);
  const rect = { x: 2, y: 1, w: 30, h: 10 };
  chat.render(buf, rect, "", 0);
  const select = () => {
    const bounds = chat.selectionBoundsAt(28, 2)!;
    const s = new Selection();
    s.press(bounds.rows[0]!, bounds);
    s.release({ x: 49, y: 11 });
    return s;
  };
  const validate = (s: Selection) => s.validateBounds(p => chat.selectionBoundsAt(p.x, p.y));
  const s = select();
  chat.render(buf, rect, "", 1500);
  validate(s);
  expect(s.active).toBe(true);
  chat.render(buf, { ...rect, w: 20 }, "");
  validate(s);
  expect(s.active).toBe(false);
  chat.render(buf, rect, "");
  const moving = select();
  chat.add({ role: "assistant", text: Array.from({ length: 12 }, (_, i) => `streamed row ${i}`).join("\n") });
  chat.render(buf, rect, "");
  validate(moving);
  expect(moving.active).toBe(false);
  chat.scrollBy(100);
  chat.render(buf, rect, "");
  const hidden = select();
  chat.resetInteractions();
  validate(hidden);
  expect(hidden.active).toBe(false);
  expect(chat.selectionBoundsAt(28, 2)).toBeUndefined();
});

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
