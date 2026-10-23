// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, Store, type SavedMessage } from "../src/store";

const msg = (role: SavedMessage["role"], text: string): SavedMessage => ({ role, text });
const state = { title: "fix the bug", tokensIn: 10, tokensOut: 5, context: 15 };

test("sessions are listed per directory, oldest first, without closed ones", () => {
  const s = new Store(":memory:");
  s.create("a", "/work/one", "first", 1);
  s.create("b", "/work/two", "elsewhere", 2);
  s.create("c", "/work/one", "second", 3);
  s.create("d", "/work/one", "closed", 4);
  s.delete("d");
  expect(s.list("/work/one").map((x) => x.title)).toEqual(["first", "second"]);
  expect(s.list("/work/two").map((x) => x.id)).toEqual(["b"]);
});

test("a save writes changed transcript rows and trims dropped ones", () => {
  const s = new Store(":memory:");
  s.create("a", "/w", "New session");
  s.save("a", { ...state, history: '[{"role":"user","content":"hi"}]' }, new Map([[0, msg("user", "hi")], [1, msg("assistant", "hello")]]), 2, 50);
  expect(s.messages("a")).toEqual([msg("user", "hi"), msg("assistant", "hello")]);
  expect(s.list("/w")[0]).toMatchObject({ title: "fix the bug", tokensIn: 10, tokensOut: 5, context: 15, updated: 50 });

  // only row 1 changed; no history this time (a turn was running): the saved one stays
  s.save("a", state, new Map([[1, msg("assistant", "hello there")]]), 2);
  expect(s.messages("a")[1]!.text).toBe("hello there");
  expect(s.list("/w")[0]!.history).toBe('[{"role":"user","content":"hi"}]');

  s.save("a", { ...state, history: "[]" }, new Map(), 0); // /clear
  expect(s.messages("a")).toEqual([]);
  expect(s.list("/w")[0]!.history).toBe("[]");
});

test("the database lives under XDG_DATA_HOME unless SOPE_DB says otherwise", () => {
  expect(defaultDbPath({ XDG_DATA_HOME: "/d" })).toBe("/d/sope/sope.db");
  expect(defaultDbPath({ SOPE_DB: "/tmp/x.db", XDG_DATA_HOME: "/d" })).toBe("/tmp/x.db");
});

test("a file database survives reopening and refuses a newer schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-store-"));
  try {
    const path = join(dir, "nested", "sope.db");
    const a = new Store(path);
    a.create("x", "/w", "kept");
    a.close();
    const b = Store.open(path).store!;
    expect(b.list("/w").map((s) => s.title)).toEqual(["kept"]);
    b.close();

    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const raw = new Database(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const refused = Store.open(path);
    expect(refused.store).toBeNull();
    expect(refused.error).toContain("newer sope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summaries list newest first with transcript sizes; get loads one", () => {
  const s = new Store(":memory:");
  s.create("a", "/w", "older", 1);
  s.create("b", "/w", "newer", 2);
  s.save("a", { ...state, history: "[1]" }, new Map([[0, msg("user", "x")], [1, msg("assistant", "y")]]), 2, 100);
  s.save("b", { ...state, title: "newer" }, new Map(), 0, 50);
  expect(s.summaries("/w").map((x) => [x.id, x.messages])).toEqual([
    ["a", 2],
    ["b", 0],
  ]);
  expect(s.get("a")).toMatchObject({ id: "a", history: "[1]", updated: 100 });
  s.delete("a");
  expect(s.get("a")).toBeNull();
  expect(s.summaries("/w").map((x) => x.id)).toEqual(["b"]);
});
