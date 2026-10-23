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

test("user bubbles align right while assistant replies retain their left gutter", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "你好" });
  chat.add({ role: "assistant", text: "Hello" });
  const buf = render(chat, { x: 1, y: 2, w: 30, h: 20 });
  expect(row(buf, 2)).toBe(" ".repeat(23) + "╭──────╮");
  expect(row(buf, 3)).toBe(" ".repeat(23) + "│ 你好 │");
  expect(row(buf, 4)).toBe(" ".repeat(23) + "╰──────╯");
  expect(row(buf, 6)).toBe(" ● Hello");
});

test("only the latest user border breathes slowly, without recoloring text or mutating cached lines", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "old" });
  chat.add({ role: "user", text: "new" });
  const paint = (now: number) => {
    const buf = new CellBuffer(40, 20);
    chat.render(buf, { x: 0, y: 0, w: 40, h: 20 }, "*", now);
    return buf;
  };
  const initial = paint(0);
  const rising = paint(1500);
  const peak = paint(3000);
  const falling = paint(4500);
  const end = paint(6000);
  expect(chat.hasVisibleAnimation).toBe(true);
  expect(initial.fg[4 * 40 + 33]).toBe(palette.faint);
  expect(rising.fg[4 * 40 + 33]).toBeGreaterThan(palette.faint);
  expect(peak.fg[4 * 40 + 33]).toBe(0xffffff);
  expect(falling.fg[4 * 40 + 33]).toBe(rising.fg[4 * 40 + 33]);
  expect(end.fg).toEqual(initial.fg);
  for (const buf of [initial, rising, peak, falling, end]) {
    expect(buf.fg[33]).toBe(palette.faint); // older bubble
    expect(buf.fg[5 * 40 + 35]).toBe(-1); // text inside newest bubble
    expect(buf.chars).toEqual(initial.chars);
  }
  chat.add({ role: "user", text: "next" });
  const next = paint(9000);
  expect(next.fg[4 * 40 + 33]).toBe(palette.faint);
  expect(next.fg[8 * 40 + 32]).toBe(palette.faint); // new cycle begins at gray
});

test("border animation stops offscreen and resumes when the newest bubble returns", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "hello" });
  const buf = new CellBuffer(40, 5);
  const rect = { x: 0, y: 0, w: 40, h: 5 };
  chat.render(buf, rect, "*", 0);
  expect(chat.hasVisibleAnimation).toBe(true);
  chat.add({ role: "assistant", text: output(20) });
  chat.render(buf, rect, "*", 1000);
  expect(chat.hasVisibleAnimation).toBe(false);
  chat.scrollBy(100);
  chat.render(buf, rect, "*", 3000);
  expect(chat.hasVisibleAnimation).toBe(true);
  chat.resetInteractions(); // session list covers the transcript
  expect(chat.hasVisibleAnimation).toBe(false);
  chat.clear();
  chat.render(buf, rect, "*", 4000);
  expect(chat.hasVisibleAnimation).toBe(false);
});

test("user bubbles preserve wrapped CJK and multiline text across resizing and scrolling", () => {
  const chat = new ChatView();
  const text = "你好世界这是一个长消息\nsecond line";
  chat.add({ role: "user", text });
  for (const w of [50, 18]) {
    const rect = { x: 1, y: 0, w, h: 30 };
    const buf = render(chat, rect);
    const drawn = rows(buf).filter(Boolean);
    expect(drawn[0]!.endsWith("╮")).toBe(true);
    expect(drawn.at(-1)!.endsWith("╯")).toBe(true);
    const content = drawn.slice(1, -1).map((s) => s.slice(s.indexOf("│") + 1, s.lastIndexOf("│")).trim()).join("");
    expect(content.replaceAll(" ", "")).toBe(text.replace(/\s/g, ""));
    for (let y = 0; y < drawn.length; y++) {
      expect(buf.chars[y * buf.width + w]).toBe(y === 0 ? "╮" : y === drawn.length - 1 ? "╯" : "│");
      expect(buf.chars[y * buf.width + w + 1]).toBe(" ");
    }
    const clipped = render(chat, { ...rect, h: 3 });
    expect(row(clipped, 2)).toBe(drawn.at(-1)!);
  }
});

test("hover links the connector and more-lines label, without coloring the output", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", text: output(41) });
  let buf = render(chat);
  expect(row(buf, 9)).toContain("… 35 more lines");
  expect(rows(buf).join("\n")).not.toContain("output 7");
  for (const point of [{ x: 3, y: 3 }, { x: 10, y: 9 }, { x: 10, y: 5 }, { x: 18, y: 4 }]) {
    chat.hover(point);
    buf = render(chat);
    expect(buf.fg[3 * 90 + 3]).toBe(0xffffff);
    expect(buf.fg[9 * 90 + 5]).toBe(0xffffff);
    expect(buf.fg[3 * 90 + 5]).toBe(palette.muted);
  }
  chat.hover({ x: 30, y: 9 });
  buf = render(chat);
  expect(buf.fg[3 * 90 + 3]).toBe(palette.faint);
  expect(buf.fg[9 * 90 + 5]).toBe(palette.faint);
});

test("clicking output toggles the whole block without inserting collapse controls", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", text: output(10), ok: false });
  render(chat);
  expect(chat.toggleAt(10, 5)).toBe(true);
  let buf = render(chat);
  expect(row(buf, 9)).toContain("output 7");
  expect(row(buf, 12)).toContain("output 10");
  expect(buf.fg[12 * 90 + 5]).toBe(palette.error);
  expect(rows(buf).join("\n")).not.toContain("show fewer lines");
  expect(rows(buf).join("\n")).not.toContain("more lines");
  chat.hover({ x: 10, y: 12 });
  buf = render(chat);
  expect(buf.fg[3 * 90 + 3]).toBe(0xffffff);
  expect(chat.toggleAt(10, 12)).toBe(true);
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
  expect(rows(buf).some((s) => s.includes("show fewer lines"))).toBe(false);
  expect(rows(buf).some((s) => s.includes("output 41"))).toBe(false);
  chat.scrollToBottom();
  buf = render(chat, rect);
  expect(row(buf, 11)).toContain("output 41");
  expect(chat.toggleAt(5, 11)).toBe(true);
  buf = render(chat, rect);
  expect(row(buf, 9)).toContain("… 35 more lines");
});

test("block hit targets include output but exclude titles, clipped cells, and hidden transcript", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", text: output(10) });
  const rect = { x: 10, y: 3, w: 12, h: 8 };
  render(chat, rect);
  expect(chat.toggleAt(12, 3)).toBe(false); // title
  expect(chat.toggleAt(22, 10)).toBe(false); // outside chat / inside trace
  expect(chat.toggleAt(14, 11)).toBe(false); // below viewport
  expect(chat.toggleAt(14, 4)).toBe(true); // body text toggles the entire block
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
