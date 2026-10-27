// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { graphemes, stringWidth, truncate } from "../src/unicode/width";
import { wrapText } from "../src/ui/wrap";

const rows = (text: string, width: number) => wrapText(text, width).map((r) => text.slice(r.start, r.end));

describe("width", () => {
  test("ASCII, CJK range boundaries, fullwidth letters and punctuation", () => {
    expect(stringWidth("hello")).toBe(5);
    expect(stringWidth(String.fromCodePoint(0x4e00, 0x9fff))).toBe(4);
    expect(stringWidth("ＨＩ，ＡＢ")).toBe(10);
    expect(stringWidth("ｈｉ")).toBe(4);
  });

  test("emoji and combining sequences count once", () => {
    expect(stringWidth("👍")).toBe(2);
    expect(stringWidth("👨‍👩‍👧")).toBe(2); // ZWJ family is one grapheme
    expect(stringWidth("❤️")).toBe(2); // text heart + emoji presentation selector
    expect(stringWidth("é")).toBe(1); // e + combining acute
    expect(graphemes("éx")).toEqual(["é", "x"]);
  });

  test("truncate respects wide characters", () => {
    expect(truncate("ＨＩＡＢ", 5)).toBe("ＨＩ…");
    expect(truncate("short", 10)).toBe("short");
  });
});

describe("wrap", () => {
  test("breaks after spaces", () => {
    expect(rows("hello world", 5)).toEqual(["hello ", "world"]);
    expect(rows("ab cd", 4)).toEqual(["ab ", "cd"]);
  });

  test("splits words longer than the width", () => {
    expect(rows("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("breaks between wide characters", () => {
    expect(rows("ＨＩＡＢ", 5)).toEqual(["ＨＩ", "ＡＢ"]);
    expect(rows("abcＨＩ", 4)).toEqual(["abc", "ＨＩ"]);
  });

  test("keeps hard newlines and empty lines", () => {
    expect(rows("a\n\nb", 10)).toEqual(["a", "", "b"]);
    const wrapped = wrapText("ab\ncd", 10);
    expect(wrapped[1]).toEqual({ start: 3, end: 5, width: 2 });
  });
});
