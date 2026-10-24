// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { palette, surfaces } from "../src/theme";
import { ChatView, type Rect } from "../src/ui/chat";
import { SearchBar } from "../src/ui/search";

const colors = surfaces(null);
const W = 60;
const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();
const rows = (buf: CellBuffer) => Array.from({ length: buf.height }, (_, y) => row(buf, y));
const render = (chat: ChatView, rect: Rect = { x: 0, y: 0, w: W, h: 20 }) => {
  const buf = new CellBuffer(W, rect.h);
  chat.render(buf, rect, "*", 0, colors);
  return buf;
};
/** Columns of row `y` tinted as the current hit ("C") or another hit ("m"). */
const tints = (buf: CellBuffer, y: number) =>
  Array.from({ length: buf.width }, (_, x) => {
    const bg = buf.bg[y * buf.width + x];
    return bg === palette.tool ? "C" : bg === colors.match ? "m" : ".";
  }).join("").replace(/\.+$/, "");
const lines = (n: number, word = "output") => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n");

test("hits are numbered from the newest, the nearest one is current, and smart case narrows", () => {
  const chat = new ChatView();
  chat.add({ role: "user", text: "find the Error" });
  chat.add({ role: "tool", title: "bash", detail: JSON.stringify({ command: "bun test" }), text: "error: expected 3", ok: false });
  chat.add({ role: "assistant", text: "The **error** comes from a fixture." });
  render(chat);
  chat.startSearch();
  chat.setQuery("error");
  expect(chat.searchStatus).toEqual({ index: 1, total: 3 });
  chat.moveHit(1);
  expect(chat.searchStatus).toEqual({ index: 2, total: 3 });
  chat.moveHit(-1);
  chat.moveHit(-1); // wraps to the oldest
  expect(chat.searchStatus).toEqual({ index: 3, total: 3 });
  chat.setQuery("Error");
  expect(chat.searchStatus).toEqual({ index: 1, total: 1 });
  chat.setQuery("bash");
  expect(chat.searchStatus.total).toBe(1); // tool names are searchable
  chat.setQuery("a.c");
  expect(chat.searchStatus.total).toBe(0); // literal text, not a pattern
});

test("the current hit stands out and the others are tinted, over markdown styling", () => {
  const chat = new ChatView();
  chat.add({ role: "assistant", text: "an **error** and another error" });
  chat.startSearch();
  chat.setQuery("error");
  const buf = render(chat);
  expect(row(buf, 0)).toBe("● an error and another error");
  expect(tints(buf, 0)).toBe(".....mmmmm.............CCCCC");
  expect(buf.fg[27]).not.toBe(palette.tool);
  chat.moveHit(1);
  expect(tints(render(chat), 0)).toBe(".....CCCCC.............mmmmm");
  chat.setQuery("");
  expect(tints(render(chat), 0)).toBe("");
  chat.setQuery("error");
  render(chat);
  chat.endSearch(false);
  expect(tints(render(chat), 0)).toBe("");
});

test("a hit across a wrapped row tints both rows", () => {
  const chat = new ChatView();
  chat.add({ role: "info", text: `${"x".repeat(45)} needle haystack` });
  chat.startSearch();
  chat.setQuery("needle hay");
  const buf = render(chat, { x: 0, y: 0, w: 60, h: 5 });
  expect(rows(buf).slice(0, 2)).toEqual([`· ${"x".repeat(45)} needle`, "  haystack"]);
  expect(tints(buf, 0)).toBe(".".repeat(48) + "CCCCCCC"); // the space at the break too
  expect(tints(buf, 1)).toBe("..CCC");
});

test("a hit in folded output unfolds it and scrolls it a third of the way down", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "read", detail: "{}", text: `${lines(30)}\nneedle here` });
  chat.add({ role: "assistant", text: lines(30, "reply") });
  chat.add({ role: "assistant", text: "needle at the end" });
  const rect = { x: 0, y: 0, w: W, h: 12 };
  render(chat, rect);
  chat.startSearch();
  chat.setQuery("needle");
  let buf = render(chat, rect);
  expect(row(buf, 11)).toBe("● needle at the end"); // nearest: already in view, no scroll
  chat.moveHit(1);
  buf = render(chat, rect);
  const at = rows(buf).findIndex((r) => r.includes("needle here"));
  expect(at).toBe(4);
  expect(tints(buf, at)).toBe("....CCCCCC");
  expect(rows(buf).some((r) => r.includes("more lines"))).toBe(false);
  chat.toggleHit(); // folds it again; the view goes to the block
  expect(rows(render(chat, rect)).some((r) => r.includes("more lines"))).toBe(true);
});

test("ending a search goes back to where the view was, or stays on the hit", () => {
  const chat = new ChatView();
  chat.add({ role: "assistant", text: lines(10, "intro") });
  chat.add({ role: "assistant", text: "needle" });
  chat.add({ role: "assistant", text: lines(40, "reply") });
  const rect = { x: 0, y: 0, w: W, h: 10 };
  render(chat, rect);
  const bottom = rows(render(chat, rect));
  chat.startSearch();
  chat.setQuery("needle");
  expect(row(render(chat, rect), 3)).toBe("● needle");
  chat.endSearch(true);
  expect(rows(render(chat, rect))).toEqual(bottom);

  chat.scrollBy(10);
  const middle = rows(render(chat, rect));
  chat.startSearch();
  chat.setQuery("needle");
  render(chat, rect);
  chat.endSearch(true);
  chat.add({ role: "info", text: "arrived meanwhile" });
  const back = rows(render(chat, rect));
  expect(back.slice(0, -1)).toEqual(middle.slice(0, -1));
  expect(back.at(-1)).toEndWith("↓ 12 more"); // the same text, with more below it

  chat.startSearch();
  chat.setQuery("needle");
  render(chat, rect);
  chat.endSearch(false);
  expect(row(render(chat, rect), 3)).toBe("● needle");
});

test("only text on screen is found: a cut-off tool input and collapsed reasoning are not", () => {
  const chat = new ChatView();
  chat.add({ role: "tool", title: "bash", detail: JSON.stringify({ command: `${"a".repeat(80)} needle` }), text: "ok" });
  chat.add({ role: "thinking", text: "a hidden needle", startedAt: 0, endedAt: 1000 });
  render(chat);
  chat.startSearch();
  chat.setQuery("needle");
  expect(chat.searchStatus.total).toBe(0);
  chat.showThinking = true;
  expect(chat.searchStatus.total).toBe(1);
  chat.setQuery("aaaa");
  expect(chat.searchStatus.total).toBeGreaterThan(0);
});

test("new output keeps the current hit and adds to the count", () => {
  const chat = new ChatView();
  chat.add({ role: "assistant", text: "needle one" });
  render(chat);
  chat.startSearch();
  chat.setQuery("needle");
  expect(chat.searchStatus).toEqual({ index: 1, total: 1 });
  const m = chat.add({ role: "assistant", text: "", streaming: true });
  chat.append(m, "needle two");
  render(chat);
  expect(chat.searchStatus).toEqual({ index: 2, total: 2 });
});

test("the search bar searches as you type, enter cycles through the hits, and esc goes back", () => {
  const chat = new ChatView();
  chat.add({ role: "assistant", text: "needle one" });
  chat.add({ role: "assistant", text: lines(30, "reply") });
  chat.add({ role: "assistant", text: "needle two" });
  const rect = { x: 0, y: 0, w: W, h: 10 };
  const before = rows(render(chat, rect));
  const bar = new SearchBar(chat);
  const draw = () => {
    render(chat, rect);
    const buf = new CellBuffer(40, 1);
    return { frame: bar.render(buf, 0, 0, 40), text: row(buf, 0) };
  };
  expect(draw().text).toBe(`› Search this conversation${" ".repeat(9)}↑  ↓`);
  bar.type("needl");
  bar.type("e");
  const buttons = [{ y: 0, x0: 34, x1: 37, index: 0 }, { y: 0, x0: 37, x1: 40, index: 1 }];
  expect(draw()).toEqual({ frame: { hits: buttons, cursor: { x: 8, y: 0 } }, text: `› needle${" ".repeat(22)}1/2  ↑  ↓` });
  // enter steps to the next older hit and wraps around to the newest
  expect(bar.key("enter")).toBe("handled");
  expect(chat.searchStatus.index).toBe(2);
  bar.key("enter");
  expect(chat.searchStatus.index).toBe(1);
  bar.key("shift+enter");
  expect(chat.searchStatus.index).toBe(2);
  // so do ↑↓ and the buttons
  bar.key("down");
  expect(chat.searchStatus.index).toBe(1);
  bar.click(0);
  expect(chat.searchStatus.index).toBe(2);
  bar.click(0);
  expect(chat.searchStatus.index).toBe(1);
  bar.click(1);
  expect(chat.searchStatus.index).toBe(2);
  // after enter, n and N step and the cursor leaves the query
  expect(bar.browsing).toBe(true);
  expect(draw().frame.cursor).toBeUndefined();
  bar.type("N");
  expect(chat.searchStatus.index).toBe(1);
  bar.type("n");
  expect(chat.searchStatus.index).toBe(2);
  // anything else goes back to the query
  bar.type("s");
  expect(bar.browsing).toBe(false);
  expect(bar.query).toBe("needles");
  bar.key("backspace");
  expect(bar.query).toBe("needle");
  bar.key("enter");
  bar.key("backspace"); // editing keys go back to the query too
  expect(bar.browsing).toBe(false);
  expect(bar.query).toBe("needl");
  expect(bar.key("pageup")).toBe("ignored");
  bar.type("zz");
  expect(draw().text).toContain("no matches");
  expect(bar.key("escape")).toBe("close");
  expect(chat.searching).toBe(false);
  expect(rows(render(chat, rect))).toEqual(before);
});

test("a query given to the search bar is browsed straight away, and q closes it on the hit", () => {
  const chat = new ChatView();
  chat.add({ role: "assistant", text: "needle" });
  chat.add({ role: "assistant", text: lines(30, "reply") });
  const rect = { x: 0, y: 0, w: W, h: 10 };
  render(chat, rect);
  const bar = new SearchBar(chat, "needle");
  expect(bar.browsing).toBe(true);
  expect(chat.searchStatus).toEqual({ index: 1, total: 1 });
  render(chat, rect);
  expect(bar.type("q")).toBe("close");
  expect(chat.searching).toBe(false);
  expect(row(render(chat, rect), 0)).toBe("● needle");
});
