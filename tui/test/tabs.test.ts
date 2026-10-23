// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { BOLD, CellBuffer } from "../src/render/buffer";
import { palette, surfaces } from "../src/theme";
import { ALL_SESSIONS, drawTabs, layoutTabs, tabTitle, TAB_ROWS, TAB_WIDTH, NEW_TAB, type TabInfo } from "../src/ui/tabs";
import { ago, SessionList } from "../src/ui/sessions";

const tabs = (n: number, title = "a session title"): TabInfo[] =>
  Array.from({ length: n }, (_, i) => ({ title: `${title} ${i + 1}`, state: "idle" as const }));
const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();
const at = (buf: CellBuffer, x: number, y: number) => y * buf.width + x;

test("tabs sit side by side; + follows them, the directory and ⋯ sit at the right", () => {
  const l = layoutTabs(tabs(2), 0, 1, 80, "~/src/app");
  expect(l.tabs.map((t) => [t.x, t.width])).toEqual([
    [1, 24],
    [26, 24],
  ]);
  expect(l.plusX).toBe(50);
  expect(l.moreX).toBe(78);
  expect(l.dir).toEqual({ x: 68, text: "~/src/app" });
});

test("titles truncate inside fixed boxes and overflowing tabs keep the active one visible", () => {
  const shrunk = layoutTabs(tabs(3, "a much longer session title"), 0, 0, 70, "~/src/app");
  expect(shrunk.tabs.length).toBe(2);
  expect(shrunk.tabs.every((t) => t.width === TAB_WIDTH)).toBe(true);
  expect(shrunk.tabs[0]!.title.endsWith("…")).toBe(true);
  const mixed = layoutTabs([{ title: "a", state: "idle" }, { title: "a very long title that will be truncated", state: "waiting" }], 0, 0, 80, "~/src/app");
  expect(mixed.tabs.map((t) => t.width)).toEqual([TAB_WIDTH, TAB_WIDTH]);

  const scrolled = layoutTabs(tabs(12), 7, 0, 60, "~/src/app");
  expect(scrolled.dir).toBeNull();
  expect(scrolled.tabs.some((t) => t.index === 7)).toBe(true);
  expect(scrolled.hiddenLeft + scrolled.tabs.length + scrolled.hiddenRight).toBe(12);
  expect(scrolled.plusX + 3).toBeLessThanOrEqual(scrolled.moreX);
});

test("one-row tabs wrap text in subtle backgrounds with compact spacing and matching hit targets", () => {
  expect(TAB_ROWS).toBe(1);
  for (const background of [0x18191e, 0xffffff]) {
    const colors = surfaces(background);
    const buf = new CellBuffer(100, 3);
    const hits = drawTabs(buf, 0, 0, 100, [
      { title: "one", state: "idle" }, { title: "two", state: "waiting" }, { title: "three", state: "unread" },
    ], 0, "~/x", 1, 0, colors);
    expect(row(buf, 0).slice(0, 49)).toBe("  one                      ? two              ×  ");
    expect(row(buf, 1)).toBe("");
    expect(row(buf, 2)).toBe("");
    for (let i = 0; i < 24; i++) {
      expect(buf.bg[i]).toBe(colors.tabSelected);
      expect(buf.bg[25 + i]).toBe(colors.tabHover);
      expect(buf.bg[50 + i]).toBe(colors.tab);
    }
    expect(buf.bg[24]).toBe(-1);
    expect(buf.bg[49]).toBe(-1);
    expect(buf.attr[at(buf, 2, 0)]! & BOLD).toBe(BOLD);
    const hit = (x: number, y: number) => hits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1);
    expect(hit(46, 0)).toMatchObject({ index: 1, close: true });
    expect(hit(46, 1)).toBeUndefined();
    expect(hit(30, 0)).toEqual({ x0: 25, x1: 49, y0: 0, y1: 1, index: 1 });
    expect(hit(24, 0)).toBeUndefined();
    expect(hit(25, 0)?.index).toBe(1);
    expect(hit(75, 0)?.index).toBe(NEW_TAB);
    expect(hit(98, 0)?.index).toBe(ALL_SESSIONS);
  }
});

test("hovered titles scroll after a pause, show the end and reset when unhovered", () => {
  expect(tabTitle("abcdefghij", 5)).toBe("abcd…");
  expect(tabTitle("abcdefghij", 5, 0)).toBe("abcd…");
  expect(tabTitle("abcdefghij", 5, 1040)).toBe("bcdef");
  expect(tabTitle("abcdefghij", 5, 2000)).toBe("fghij");
  expect(tabTitle("abcdefghij", 5, 3040)).toBe("efghi");
  expect(tabTitle("你好世界abc", 5, 1040)).toBe(" 好世"); // no half-wide characters
  expect(tabTitle("e\u0301abcdefgh", 4, 1040)).toBe("abcd");
  expect(tabTitle("short", 18, 9000)).toBe("short");

  const buf = new CellBuffer(80, 3);
  const info: TabInfo[] = [{ title: "A very long title that scrolls without moving its border", state: "idle" }];
  const first = drawTabs(buf, 0, 0, 80, info, 0, "~/x", 0, 0);
  const original = row(buf, 0);
  buf.clear();
  const later = drawTabs(buf, 0, 0, 80, info, 0, "~/x", 0, 2000);
  expect(later).toEqual(first);
  expect(row(buf, 0)).not.toBe(original);
  expect(buf.chars[23]).toBe(" ");
  expect(buf.bg[23]).toBe(surfaces(null).tabSelected);
  expect(buf.chars[21]).toBe("×");
  buf.clear();
  drawTabs(buf, 0, 0, 80, info, 0, "~/x", null, 2000);
  expect(row(buf, 0)).toContain("A very long title…");
});

test("fixed-width active tabs and overflow controls fit a narrow terminal", () => {
  const l = layoutTabs(tabs(12), 7, 1, 22, "~/src/app");
  expect(l.tabs.some((t) => t.index === 7)).toBe(true);
  expect(l.plusX + 3).toBeLessThanOrEqual(l.moreX);
});

test("surfaces follow the terminal background", () => {
  const dark = surfaces(0x101010);
  expect(dark.panelSelected).toBeGreaterThan(dark.panel); // lighter on dark
  const light = surfaces(0xffffff);
  expect(light.panelSelected).toBeLessThan(light.panel); // darker on light
});

test("relative times", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  expect(ago(now - 5_000, now)).toBe("just now");
  expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
  expect(ago(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(ago(now - 2 * 86400_000, now)).toBe("2d ago");
  expect(ago(Date.UTC(2026, 0, 2, 12), now)).toBe("2026-01-02");
});

test("the session list sorts newest first, filters, and maps clicks to rows", () => {
  const list = new SessionList(
    [
      { id: "a", title: "explain the pool", updated: 1, messages: 4, open: false },
      { id: "b", title: "fix grep", updated: 3, messages: 9, open: true },
      { id: "c", title: "grep context", updated: 2, messages: 2, open: false },
    ],
    "~/w",
  );
  expect(list.shown.map((s) => s.id)).toEqual(["b", "c", "a"]);
  list.move(1);
  expect(list.selected?.id).toBe("c");
  list.type("GREP");
  expect(list.shown.map((s) => s.id)).toEqual(["b", "c"]);
  expect(list.selected?.id).toBe("b");
  list.backspace();
  expect(list.filter).toBe("GRE");

  const buf = new CellBuffer(90, 20);
  list.render(buf, { x: 0, y: 0, w: 90, h: 20 }, surfaces(null), 10);
  const y = Array.from({ length: 20 }, (_, i) => i).find((r) => row(buf, r).includes("grep context"))!;
  expect(row(buf, y)).toContain("2 msgs");
  expect(list.hit(30, y)).toMatchObject({ id: "c" });
  expect(list.hit(0, 19)).toBe("outside");
});
