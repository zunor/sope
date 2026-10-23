// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { palette } from "../src/theme";
import { ChatView, type Rect } from "../src/ui/chat";

const output = (n: number) => Array.from({ length: n }, (_, i) => `output ${i + 1}`).join("\n");
const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();
const rows = (buf: CellBuffer) => Array.from({ length: buf.height }, (_, y) => row(buf, y));
const render = (chat: ChatView, rect: Rect = { x: 1, y: 2, w: 70, h: 25 }) => {
  const buf = new CellBuffer(90, 30);
  chat.render(buf, rect, "*");
  return buf;
};

test("hover links the connector and more-lines label, without coloring the output", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", text: output(41) });
  let buf = render(chat);
  expect(row(buf, 9)).toContain("… 35 more lines");
  expect(rows(buf).join("\n")).not.toContain("output 7");
  for (const point of [{ x: 3, y: 3 }, { x: 10, y: 9 }]) {
    chat.hover(point);
    buf = render(chat);
    expect(buf.fg[3 * 90 + 3]).toBe(palette.accent);
    expect(buf.fg[9 * 90 + 5]).toBe(palette.accent);
    expect(buf.fg[3 * 90 + 5]).toBe(palette.muted);
  }
  chat.hover({ x: 30, y: 9 });
  buf = render(chat);
  expect(buf.fg[3 * 90 + 3]).toBe(palette.faint);
  expect(buf.fg[9 * 90 + 5]).toBe(palette.faint);
});

test("click toggles all output and keeps the original collapse control in place", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", text: output(10), ok: false });
  render(chat);
  expect(chat.toggleAt(5, 9)).toBe(true);
  let buf = render(chat);
  expect(row(buf, 9)).toContain("show fewer lines");
  expect(row(buf, 13)).toContain("output 10");
  expect(buf.fg[13 * 90 + 5]).toBe(palette.error);
  expect(row(buf, 14)).toContain("show fewer lines");
  expect(chat.toggleAt(5, 9)).toBe(true);
  buf = render(chat);
  expect(row(buf, 9)).toContain("… 4 more lines");
  expect(rows(buf).join("\n")).not.toContain("output 10");
  expect(chat.toggleAt(3, 3)).toBe(true);
  render(chat);
  expect(chat.toggleAt(3, 3)).toBe(true);
  expect(row(render(chat), 9)).toContain("… 4 more lines");
});

test("long results open near the click and can collapse from the bottom", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", text: output(41) });
  const rect = { x: 1, y: 2, w: 70, h: 10 };
  render(chat, rect);
  expect(chat.toggleAt(5, 9)).toBe(true);
  let buf = render(chat, rect);
  expect(rows(buf).some((s) => s.includes("output 7"))).toBe(true);
  expect(rows(buf).some((s) => s.includes("show fewer lines"))).toBe(true);
  expect(rows(buf).some((s) => s.includes("output 41"))).toBe(false);
  chat.scrollToBottom();
  buf = render(chat, rect);
  expect(row(buf, 10)).toContain("output 41");
  expect(row(buf, 11)).toContain("show fewer lines");
  expect(chat.toggleAt(5, 11)).toBe(true);
  buf = render(chat, rect);
  expect(row(buf, 9)).toContain("… 35 more lines");
});

test("hit targets exclude ordinary output, clipped cells, and hidden transcript", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", text: output(10) });
  const rect = { x: 10, y: 3, w: 12, h: 8 };
  render(chat, rect);
  expect(chat.toggleAt(14, 4)).toBe(false); // result text stays selectable
  expect(chat.toggleAt(12, 3)).toBe(false); // title
  expect(chat.toggleAt(22, 10)).toBe(false); // outside chat / inside trace
  expect(chat.toggleAt(14, 11)).toBe(false); // below viewport
  expect(chat.toggleAt(14, 10)).toBe(true);
  render(chat, rect);
  chat.resetInteractions();
  expect(chat.toggleAt(14, 10)).toBe(false);
  chat.clear();
  expect(rows(render(chat)).every((s) => s === "")).toBe(true);
});

test("short and streaming tool results have no folding targets", () => {
  for (const args of [{ text: output(6) }, { text: output(10), streaming: true }]) {
    const chat = new ChatView();
    chat.add({ role: "tool", ...args });
    const buf = render(chat);
    expect(rows(buf).join("\n")).not.toContain("more lines");
    expect(chat.toggleAt(3, 3)).toBe(false);
    expect(chat.toggleAt(5, 9)).toBe(false);
  }
});

test("fold state is per message and subagent results support the same interaction", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", text: output(8) });
  const agent = chat.add({ role: "subagent", text: output(9), steps: [{ name: "read", detail: "file", done: true }] });
  let buf = render(chat);
  expect(row(buf, 19)).toContain("… 3 more lines");
  expect(chat.toggleAt(5, 19)).toBe(true);
  buf = render(chat);
  expect(row(buf, 9)).toContain("… 2 more lines");
  expect(rows(buf).join("\n")).toContain("output 9");
  chat.update(agent, { text: output(10) });
  expect(rows(render(chat)).join("\n")).toContain("output 10");
});

test("resizing recalculates wrapped line counts and visible controls", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", text: "abcdefghij\n".repeat(6) });
  let buf = render(chat, { x: 1, y: 2, w: 9, h: 25 });
  expect(row(buf, 9)).toContain("… 6 m");
  expect(chat.toggleAt(5, 9)).toBe(true);
  render(chat, { x: 1, y: 2, w: 9, h: 25 });
  buf = render(chat);
  expect(rows(buf).join("\n")).not.toContain("fewer lines");
  expect(chat.toggleAt(3, 3)).toBe(false);
});
