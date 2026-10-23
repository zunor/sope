// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { diffLines, hunks, splitLines } from "../src/ui/diff";
import { Highlighter, langFor } from "../src/ui/highlight";

const show = (a: string, b: string) => diffLines(splitLines(a), splitLines(b)).map((l) => `${l.kind[0]}${l.no} ${l.text}`);

test("line diffs keep common lines and put removals before additions", () => {
  expect(show("a\nb\nc\n", "a\nB\nc\n")).toEqual(["c1 a", "r2 b", "a2 B", "c3 c"]);
  expect(show("a\nc", "a\nb\nc")).toEqual(["c1 a", "a2 b", "c2 c"]);
  expect(show("", "x\ny")).toEqual(["a1 x", "a2 y"]);
  expect(show("1\n2\n3\n4", "1\n3\n2\n4")).toEqual(["c1 1", "r2 2", "c3 3", "a3 2", "c4 4"]);
});

test("hunks keep context around changes and fold the rest", () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const b = [...a];
  b[9] = "changed";
  const h = hunks(diffLines(a, b), 2);
  expect(h[0]).toEqual({ kind: "gap", skipped: 7 });
  expect(h.slice(1, -1).map((l) => ("text" in l ? l.text : ""))).toEqual(["line 8", "line 9", "line 10", "changed", "line 11", "line 12"]);
  expect(h.at(-1)).toEqual({ kind: "gap", skipped: 8 });
});

test("big inputs fall back to a block replacement", () => {
  const a = Array.from({ length: 600 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 600 }, (_, i) => `b${i}`);
  const d = diffLines(a, b);
  expect(d.length).toBe(1200);
  expect(d[0]!.kind).toBe("remove");
  expect(d[600]!.kind).toBe("add");
});

test("languages by extension", () => {
  expect(langFor("src/a.ts")).toBe("js");
  expect(langFor("x/y.h")).toBe("c");
  expect(langFor("CMakeLists.txt")).toBe("sh");
  expect(langFor("notes.txt")).toBe("plain");
});

test("highlighting finds keywords, strings, numbers, comments and types", () => {
  const h = new Highlighter("js");
  const kinds = (line: string) => h.line(line).filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);
  expect(kinds('const n: Map = 42; // the "answer"')).toEqual(["keyword:const", "type:Map", "number:42", 'comment:// the "answer"']);
  expect(kinds("x = 'it\\'s' + `t`")).toEqual(["string:'it\\'s'", "string:`t`"]);
  expect(kinds("a1 = b2")).toEqual([]); // digits inside names are not numbers
  // block comments span lines
  expect(kinds("/* start")).toEqual(["comment:/* start"]);
  expect(kinds("still */ return 1")).toEqual(["comment:still */", "keyword:return", "number:1"]);
  const py = new Highlighter("py");
  expect(py.line("def f(): # note").map((t) => t.kind)).toEqual(["keyword", "plain", "comment"]);
});
