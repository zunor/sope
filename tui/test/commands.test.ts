// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { COMMANDS } from "../src/commands";
import { CommandSuggestions } from "../src/ui/commands";

const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("");

test("slash opens suggestions, typing filters them, arguments and ordinary text close them", () => {
  const menu = new CommandSuggestions(COMMANDS);
  expect(menu.sync("/", 1)).toBe(true);
  expect(menu.matches).toEqual(COMMANDS);
  menu.sync("/mo", 3);
  expect(menu.matches.map((c) => c.name)).toEqual(["model", "mouse"]);
  for (const text of ["hello /", "/model name", "/tmp/file", "/\n", ""]) {
    expect(menu.sync(text, text.length)).toBe(false);
  }
  expect(menu.sync("/model", 2)).toBe(false);
});

test("selection wraps, filtering resets it, and Escape stays dismissed until editing resumes", () => {
  const menu = new CommandSuggestions(COMMANDS);
  menu.sync("/", 1);
  menu.move(-1);
  expect(menu.selected?.name).toBe("exit");
  menu.move(1);
  expect(menu.selected?.name).toBe("help");
  menu.sync("/mo", 3);
  menu.move(1);
  expect(menu.selected?.name).toBe("mouse");
  menu.sync("/mod", 4);
  expect(menu.selected?.name).toBe("model");
  menu.dismiss();
  expect(menu.sync("/mod", 4)).toBe(false);
  expect(menu.sync("/mo", 3)).toBe(true);
  menu.sync("/zzzz", 5);
  menu.move(-1);
  expect(menu.completion(false)).toBeNull();
});

test("Enter executes commands, Tab only fills, and required arguments remain editable", () => {
  const menu = new CommandSuggestions(COMMANDS);
  menu.sync("/mod", 4);
  expect(menu.completion(false)).toEqual({ text: "/model", execute: true });
  expect(menu.completion(true)).toEqual({ text: "/model ", execute: false });
  menu.sync("/set", 4);
  expect(menu.completion(false)).toEqual({ text: "/set ", execute: false });
  menu.sync("/thi", 4);
  expect(menu.completion(true)).toEqual({ text: "/thinking", execute: false });
});

test("menu scrolls to the selection, maps mouse rows, and clips within the popup", () => {
  const menu = new CommandSuggestions(COMMANDS);
  menu.sync("/", 1);
  const buf = new CellBuffer(80, 12);
  buf.fill(0, 0, 80, 12, {}, ".");
  menu.move(-1);
  const hits = menu.render(buf, 2, 1, 70, menu.height(9));
  expect(row(buf, 1)).toContain(`Commands (${COMMANDS.length})`);
  const last = hits.at(-1)!;
  expect(row(buf, last.y)).toContain("/exit");
  menu.select(last.index);
  expect(menu.selected?.name).toBe("exit");
  expect(buf.chars[1 * 80 + 1]).toBe(".");
  expect(buf.chars[1 * 80 + 72]).toBe(".");
  expect(row(buf, 9)).toBe(".".repeat(80));

  menu.sync("/unknown", 8);
  buf.clear();
  expect(menu.render(buf, 1, 1, 22, menu.height(3))).toEqual([]);
  expect(row(buf, 2)).toContain("No matching");
  expect(menu.height(2)).toBe(0);
});
