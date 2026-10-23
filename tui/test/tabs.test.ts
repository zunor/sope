// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { BOLD, CellBuffer } from "../src/render/buffer";
import type { PixelImage } from "../src/render/graphics";
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
    [1, 20],
    [22, 20],
  ]);
  expect(l.plusX).toBe(42);
  expect(l.moreX).toBe(78);
  expect(l.dir).toEqual({ x: 68, text: "~/src/app" });
});

test("titles truncate inside fixed boxes and overflowing tabs keep the active one visible", () => {
  const shrunk = layoutTabs(tabs(3, "a much longer session title"), 0, 0, 60, "~/src/app");
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

test("two-row tab area retains the subtle text fallback and compact hit targets", () => {
  expect(TAB_ROWS).toBe(2);
  for (const background of [0x18191e, 0xffffff]) {
    const colors = surfaces(background);
    const buf = new CellBuffer(100, 3);
    const hits = drawTabs(buf, 0, 0, 100, [
      { title: "one", state: "idle" }, { title: "two", state: "waiting" }, { title: "three", state: "unread" },
    ], 0, "~/x", 1, 0, colors);
    expect(row(buf, 1).slice(0, 41)).toBe("  one                  ? two          ×  ");
    expect(row(buf, 0)).toBe("");
    expect(row(buf, 2)).toBe("");
    for (let i = 0; i < 20; i++) {
      expect(buf.bg[100 + i]).toBe(colors.tabSelected);
      expect(buf.bg[121 + i]).toBe(colors.tabHover);
      expect(buf.bg[142 + i]).toBe(colors.tab);
    }
    expect(buf.bg[120]).toBe(-1);
    expect(buf.bg[141]).toBe(-1);
    expect(buf.attr[at(buf, 2, 1)]! & BOLD).toBe(0);
    const hit = (x: number, y: number) => hits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1);
    expect(hit(38, 1)).toMatchObject({ index: 1, close: true });
    expect(hit(38, 0)?.index).toBe(1);
    expect(hit(38, 0)?.close).toBeUndefined();
    expect(hit(30, 0)).toEqual({ x0: 21, x1: 41, y0: 0, y1: 2, index: 1 });
    expect(hit(20, 0)).toBeUndefined();
    expect(hit(21, 0)?.index).toBe(1);
    expect(hit(63, 1)?.index).toBe(NEW_TAB);
    expect(hit(98, 1)?.index).toBe(ALL_SESSIONS);
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
  const original = row(buf, 1);
  buf.clear();
  const later = drawTabs(buf, 0, 0, 80, info, 0, "~/x", 0, 2000);
  expect(later).toEqual(first);
  expect(row(buf, 1)).not.toBe(original);
  expect(buf.chars[99]).toBe(" ");
  expect(buf.bg[99]).toBe(surfaces(null).tabSelected);
  expect(buf.chars[97]).toBe("×");
  buf.clear();
  drawTabs(buf, 0, 0, 80, info, 0, "~/x", null, 2000);
  expect(row(buf, 1)).toContain("A very long t…");
});

test("fixed-width active tabs and overflow controls fit a narrow terminal", () => {
  const l = layoutTabs(tabs(12), 7, 1, 22, "~/src/app");
  expect(l.tabs.some((t) => t.index === 7)).toBe(true);
  expect(l.plusX + 3).toBeLessThanOrEqual(l.moreX);
});

test("image titles keep both rows clickable; only the text image changes during marquee", () => {
  const buf = new CellBuffer(100, 4);
  const images: PixelImage[] = [];
  const info = tabs(3, "a long title that scrolls");
  const hits = drawTabs(buf, 1, 0, 98, info, 0, "", 1, 0, surfaces(null), { cell: { width: 10, height: 22 }, images });
  expect(images).toHaveLength(4);
  expect(images.slice(0, 3).map((image) => [image.x, image.y, image.columns, image.rows, image.slot])).toEqual([
    [1, 0, 20, 2, 1], [22, 0, 20, 2, 2], [43, 0, 20, 2, 3],
  ]);
  expect(buf.bg.every((color) => color === -1)).toBe(true);
  expect(row(buf, 0)).toBe("");
  expect(row(buf, 1)).toBe(""); // no duplicate native text beneath the image
  expect(hits.find((h) => h.index === 1 && !h.close)).toMatchObject({ y0: 0, y1: 2 });
  expect(hits.find((h) => h.index === 1 && h.close)).toMatchObject({ y0: 0, y1: 2 });
  const later: PixelImage[] = [];
  buf.clear();
  drawTabs(buf, 1, 0, 98, info, 0, "", 1, 2000, surfaces(null), { cell: { width: 10, height: 22 }, images: later });
  expect(later.slice(0, 3)).toEqual(images.slice(0, 3));
  expect(later[3]!.data).not.toBe(images[3]!.data);
  expect(later[3]!.compression).toBe("zlib");
});

test("English and Chinese image titles stay centered with padding inside compact frames", () => {
  for (const cell of [{ width: 10, height: 22 }, { width: 18, height: 36 }]) {
    for (const title of ["Ag title", "中文标签居中"]) {
      const buf = new CellBuffer(80, 3);
      const images: PixelImage[] = [];
      drawTabs(buf, 0, 0, 80, [{ title, state: "idle" }], 0, "", null, 0, surfaces(null), { cell, images });
      const label = images.find((image) => image.slot === 100)!;
      const pixels = inflateSync(Buffer.from(label.data, "base64"));
      const occupied: number[] = [];
      for (let y = 0; y < label.height; y++) {
        for (let x = 2 * cell.width; x < (TAB_WIDTH - 3) * cell.width; x++) {
          if (pixels[(y * label.width + x) * 4 + 3]! > 30) { occupied.push(y); break; }
        }
      }
      expect(occupied.length).toBeGreaterThan(0);
      const top = occupied[0]!, bottom = label.height - 1 - occupied.at(-1)!;
      expect(top).toBeGreaterThan(cell.height * 0.4);
      expect(bottom).toBeGreaterThan(cell.height * 0.4);
      expect(Math.abs(top - bottom)).toBeLessThanOrEqual(3);
      const frame = images[0]!;
      const outline = Buffer.from(frame.data, "base64");
      const borderRows = Array.from({ length: frame.height }, (_, y) => y)
        .filter((y) => outline[(y * frame.width + frame.width / 2) * 4 + 3]! > 30);
      expect(occupied[0]! - borderRows[0]!).toBeGreaterThan(cell.height * 0.15);
      expect(borderRows.at(-1)! - occupied.at(-1)!).toBeGreaterThan(cell.height * 0.15);
    }
  }
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
