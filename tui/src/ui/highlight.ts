// SPDX-License-Identifier: MIT
// A small syntax highlighter for diff previews: keywords, strings, numbers,
// comments and capitalized type names, by file extension. Line by line, but
// /* block comments */ carry over from one line to the next.

export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment" | "type";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Lang {
  keywords: Set<string>;
  line: string[]; // line comment markers
  block: boolean; // /* */ comments
  types: boolean; // Capitalized identifiers are types
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = "if else for while do switch case break continue default return goto sizeof typedef struct union enum static const extern inline volatile register void char short int long float double signed unsigned bool true false NULL nullptr";
const LANGS: Record<string, Lang> = {
  c: { keywords: words(`${C_LIKE} include define ifdef ifndef endif elif pragma undef`), line: ["//"], block: true, types: false },
  cpp: { keywords: words(`${C_LIKE} class public private protected virtual override template typename namespace using new delete auto this throw try catch noexcept constexpr`), line: ["//"], block: true, types: true },
  js: {
    keywords: words(
      "const let var function return if else for while do switch case break continue default new class extends implements interface type enum import export from as async await yield try catch finally throw typeof instanceof in of null undefined true false this super void readonly private public protected static keyof declare namespace abstract satisfies",
    ),
    line: ["//"],
    block: true,
    types: true,
  },
  py: {
    keywords: words("def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal async await assert del match case self"),
    line: ["#"],
    block: false,
    types: true,
  },
  go: { keywords: words("package import func return if else for range switch case default break continue go defer select chan map struct interface type var const nil true false make new len cap append"), line: ["//"], block: true, types: true },
  rs: { keywords: words("fn let mut const static if else match for while loop in return break continue struct enum impl trait pub use mod crate self Self super as where move ref true false Some None Ok Err async await dyn unsafe"), line: ["//"], block: true, types: true },
  java: { keywords: words(`${C_LIKE} class interface extends implements public private protected abstract final new this super throw throws try catch finally import package null instanceof var`), line: ["//"], block: true, types: true },
  sh: { keywords: words("if then else elif fi for while until do done case esac function in return local export readonly set unset echo exit source"), line: ["#"], block: false, types: false },
  json: { keywords: words("true false null"), line: [], block: false, types: false },
  plain: { keywords: new Set(), line: [], block: false, types: false },
};

const EXTENSIONS: Record<string, string> = {
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "c", mm: "cpp",
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js",
  py: "py", pyi: "py", go: "go", rs: "rs", java: "java", kt: "java", kts: "java", swift: "java", cs: "java",
  sh: "sh", bash: "sh", zsh: "sh", cmake: "sh", json: "json", jsonc: "js",
};

/** The language name for a path, by extension ("plain" when unknown). */
export function langFor(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (base === "CMakeLists.txt" || base === "Makefile" || base.startsWith(".")) return "sh";
  return EXTENSIONS[base.split(".").pop()?.toLowerCase() ?? ""] ?? "plain";
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;

export class Highlighter {
  readonly #lang: Lang;
  #inBlock = false;

  constructor(lang: string) {
    this.#lang = LANGS[lang] ?? LANGS.plain!;
  }

  /** Tokens of the next line. */
  line(text: string): Token[] {
    const L = this.#lang;
    const out: Token[] = [];
    let plain = "";
    const push = (t: string, kind: TokenKind) => {
      if (kind === "plain") return void (plain += t);
      if (plain) out.push({ text: plain, kind: "plain" });
      plain = "";
      out.push({ text: t, kind });
    };
    let i = 0;
    if (this.#inBlock) {
      const end = text.indexOf("*/");
      if (end < 0) return [{ text, kind: "comment" }];
      push(text.slice(0, end + 2), "comment");
      this.#inBlock = false;
      i = end + 2;
    }
    while (i < text.length) {
      const ch = text[i]!;
      if (L.line.some((m) => text.startsWith(m, i))) {
        push(text.slice(i), "comment");
        break;
      }
      if (L.block && text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) {
          push(text.slice(i), "comment");
          this.#inBlock = true;
          break;
        }
        push(text.slice(i, end + 2), "comment");
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
        push(text.slice(i, Math.min(j + 1, text.length)), "string");
        i = j + 1;
        continue;
      }
      if (/\d/.test(ch) && !/[\w$]/.test(text[i - 1] ?? " ")) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(text);
        if (m) {
          push(m[0], "number");
          i += m[0].length;
          continue;
        }
      }
      IDENT.lastIndex = i;
      const id = /[A-Za-z_$]/.test(ch) ? IDENT.exec(text) : null;
      if (id) {
        const w = id[0];
        push(w, L.keywords.has(w) ? "keyword" : L.types && /^[A-Z][a-z0-9]/.test(w) ? "type" : "plain");
        i += w.length;
        continue;
      }
      push(ch, "plain");
      i++;
    }
    if (plain) out.push({ text: plain, kind: "plain" });
    return out;
  }
}
