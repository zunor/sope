// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { surfaces } from "../src/theme";
import { ALL_SESSIONS, drawTabs, layoutTabs, NEW_TAB, type TabInfo } from "../src/ui/tabs";
import { ago, SessionList } from "../src/ui/sessions";

const tabs = (n: number, title = "a session title"): TabInfo[] =>
  Array.from({ length: n }, (_, i) => ({ title: `${title} ${i + 1}`, state: "idle" as const }));
const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();
const at = (buf: CellBuffer, x: number, y: number) => y * buf.width + x;

test("tabs touch; + follows them, the directory and ⋯ sit at the right", () => {
  const l = layoutTabs(tabs(2), 0, 1, 80, "~/src/app");
  expect(l.tabs.map((t) => [t.x, t.width])).toEqual([
    [1, 22],
    [23, 22],
  ]);
  expect(l.plusX).toBe(45);
  expect(l.moreX).toBe(78);
  expect(l.dir).toEqual({ x: 68, text: "~/src/app" });
});

test("titles shrink, then the directory goes, then the bar scrolls to the active tab", () => {
  const shrunk = layoutTabs(tabs(3), 0, 0, 70, "~/src/app");
  expect(shrunk.tabs.length).toBe(3);
  expect(shrunk.tabs[0]!.title.endsWith("…")).toBe(true);

  const scrolled = layoutTabs(tabs(12), 7, 0, 60, "~/src/app");
  expect(scrolled.dir).toBeNull();
  expect(scrolled.tabs.some((t) => t.index === 7)).toBe(true);
  expect(scrolled.hiddenLeft + scrolled.tabs.length + scrolled.hiddenRight).toBe(12);
  expect(scrolled.plusX + 3).toBeLessThanOrEqual(scrolled.moreX);
});

test("a tab is one row: a block whose right edge fades into shadow; × on hover", () => {
  const buf = new CellBuffer(40, 1);
  const c = surfaces(0x1e1e1e);
  const hits = drawTabs(buf, 0, 0, 40, [{ title: "one", state: "idle" }, { title: "two", state: "waiting" }], 0, "~/x", 1, c);
  expect(row(buf, 0)).toBe(" one     ? two ×   +             ~/x  ⋯");
  // tab 1: cells 0..5 flat, 6..7 fading darker; tab 2 starts flat again at 8
  expect(buf.bg[at(buf, 0, 0)]).toBe(c.tabActive);
  expect(buf.bg[at(buf, 5, 0)]).toBe(c.tabActive);
  const fade1 = buf.bg[at(buf, 6, 0)]!;
  const fade2 = buf.bg[at(buf, 7, 0)]!;
  expect(fade1 & 0xff).toBeLessThan(c.tabActive & 0xff);
  expect(fade2 & 0xff).toBeLessThan(fade1 & 0xff);
  expect(buf.bg[at(buf, 8, 0)]).toBe(c.tab);
  // clicks: the × closes, the rest of the tab selects, + and ⋯
  expect(hits.find((h) => 15 >= h.x0 && 15 < h.x1)).toMatchObject({ index: 1, close: true });
  expect(hits.find((h) => 11 >= h.x0 && 11 < h.x1)?.close).toBeUndefined();
  expect(hits.find((h) => h.index === NEW_TAB)!.x0).toBe(18);
  expect(hits.find((h) => h.index === ALL_SESSIONS)!.x0).toBe(37);
});

test("surfaces follow the terminal background", () => {
  const dark = surfaces(0x101010);
  expect(dark.tabActive).toBeGreaterThan(dark.tab); // lighter on dark
  expect(dark.shadow).toBeLessThan(0x101010);
  const light = surfaces(0xffffff);
  expect(light.tabActive).toBeLessThan(light.tab); // darker on light
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
