// SPDX-License-Identifier: MIT
// Decodes raw terminal input bytes into key, text, paste and mouse events.
//
// Handles UTF-8 split across reads, CSI/SS3 escape sequences with xterm
// modifiers, kitty's CSI-u keys, bracketed paste, SGR mouse reports and OSC
// replies (such as the background color, OSC 11). A
// lone ESC is ambiguous (Escape key, or the start of a sequence still in
// flight), so it stays pending until more input arrives or flush() is called.

export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type KeyEvent = { type: "key"; name: string } & Mods;
export type TextEvent = { type: "text"; text: string };
export type PasteEvent = { type: "paste"; text: string };
export type MouseEvent = {
  type: "mouse";
  /** "move": the pointer moved with no button held (hover). */
  action: "press" | "release" | "drag" | "move" | "wheel-up" | "wheel-down";
  button: number;
  x: number;
  y: number;
} & Mods;
/** A reply to an OSC query, without the ESC ] and the terminator, e.g. "11;rgb:1e1e/1e1e/1e1e". */
export type OscEvent = { type: "osc"; data: string };
export type ApcEvent = { type: "apc"; data: string };
export type InputEvent = KeyEvent | TextEvent | PasteEvent | MouseEvent | OscEvent | ApcEvent;

const PASTE_END = "\x1b[201~";

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

function key(name: string, mods: Partial<Mods> = {}): KeyEvent {
  return { type: "key", name, ...NO_MODS, ...mods };
}

/** Canonical id such as "ctrl+shift+left", for matching bindings. */
export function keyId(ev: KeyEvent): string {
  return `${ev.ctrl ? "ctrl+" : ""}${ev.alt ? "alt+" : ""}${ev.shift ? "shift+" : ""}${ev.name}`;
}

function modsFrom(param: number | undefined): Mods {
  if (!param || param < 2) return { ...NO_MODS };
  const bits = param - 1;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

function controlKey(code: number, alt = false): KeyEvent {
  switch (code) {
    case 0x0d:
      return key("enter", { alt });
    case 0x09:
      return key("tab", { alt });
    case 0x7f:
    case 0x08:
      return key("backspace", { alt });
    case 0x1b:
      return key("escape", { alt });
    case 0x00:
      return key("space", { ctrl: true, alt });
  }
  if (code >= 0x01 && code <= 0x1a) return key(String.fromCharCode(code + 0x60), { ctrl: true, alt });
  return key(String.fromCharCode(code + 0x40).toLowerCase(), { ctrl: true, alt }); // 0x1c-0x1f
}

const TILDE_KEYS: Record<number, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10",
  23: "f11", 24: "f12",
};

const LETTER_KEYS: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4",
};

type Parsed = { event?: InputEvent; paste?: boolean; end: number } | null;

function parseCsi(s: string, i: number, final: boolean): Parsed {
  let j = i + 2;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c >= 0x40 && c <= 0x7e) break;
    j++;
  }
  if (j >= s.length) return final ? { event: key("[", { alt: true }), end: i + 2 } : null;

  const body = s.slice(i + 2, j);
  const fin = s[j]!;
  const end = j + 1;

  if (body === "200" && fin === "~") return { paste: true, end };
  if (body.startsWith("<") && (fin === "M" || fin === "m")) {
    const [b = 0, x = 1, y = 1] = body.slice(1).split(";").map(Number);
    const mods = { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
    const button = b & 3;
    const action =
      b & 64
        ? button === 0 ? "wheel-up" : "wheel-down"
        : b & 32
          ? button === 3 ? "move" : "drag"
          : fin === "m" ? "release" : "press";
    return { event: { type: "mouse", action, button, x: x - 1, y: y - 1, ...mods }, end };
  }

  const params = body.split(";").map((p) => parseInt(p.split(":")[0] ?? "", 10));
  if (fin === "~") {
    const name = TILDE_KEYS[params[0] ?? 0];
    return { event: name ? key(name, modsFrom(params[1])) : undefined, end };
  }
  if (fin === "u") {
    // kitty keyboard protocol: CSI code ; mods u
    const code = params[0] ?? 0;
    const mods = modsFrom(params[1]);
    const named: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };
    return { event: key(named[code] ?? String.fromCodePoint(code).toLowerCase(), mods), end };
  }
  if (fin === "Z") return { event: key("tab", { shift: true }), end };
  const name = LETTER_KEYS[fin];
  return { event: name ? key(name, modsFrom(params[1])) : undefined, end }; // unknown: swallow
}

function parseEscape(s: string, i: number, final: boolean): Parsed {
  if (i + 1 >= s.length) return final ? { event: key("escape"), end: i + 1 } : null;
  const next = s[i + 1]!;
  if (next === "[") return parseCsi(s, i, final);
  if (next === "_") {
    // Kitty graphics replies use APC, terminated by ST. Never treat them as typing.
    const end = s.indexOf("\x1b\\", i + 2);
    if (end < 0) return final ? { end: s.length } : null;
    return { event: { type: "apc", data: s.slice(i + 2, end) }, end: end + 2 };
  }
  if (next === "]") {
    // OSC reply, ended by BEL or ST (ESC \). Unterminated at flush: dropped.
    const bel = s.indexOf("\x07", i + 2);
    const st = s.indexOf("\x1b\\", i + 2);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) return final ? { end: s.length } : null;
    return { event: { type: "osc", data: s.slice(i + 2, end) }, end: end + (end === bel ? 1 : 2) };
  }
  if (next === "O") {
    if (i + 2 >= s.length) return final ? { event: key("o", { alt: true, shift: true }), end: i + 2 } : null;
    const name = LETTER_KEYS[s[i + 2]!];
    return { event: name ? key(name) : undefined, end: i + 3 };
  }
  if (next === "\x1b") return { event: key("escape"), end: i + 1 };
  // Alt+<key> arrives as ESC followed by the key.
  const cp = s.codePointAt(i + 1)!;
  const len = cp > 0xffff ? 2 : 1;
  if (cp < 0x20 || cp === 0x7f) return { event: controlKey(cp, true), end: i + 2 };
  const ch = String.fromCodePoint(cp);
  const lower = ch.toLowerCase();
  return { event: key(lower, { alt: true, shift: lower !== ch }), end: i + 1 + len };
}

/** Number of trailing chars of s (from `from`) that could begin `marker`. */
function partialSuffix(s: string, from: number, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length - from); n > 0; n--)
    if (marker.startsWith(s.slice(s.length - n))) return n;
  return 0;
}

export class InputParser {
  #decoder = new TextDecoder();
  #pending = "";
  #paste: string | null = null;

  feed(chunk: Uint8Array): InputEvent[] {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    return this.#parse(false);
  }

  /** Resolves a pending lone ESC as the Escape key. Call it shortly after input goes quiet. */
  flush(): InputEvent[] {
    return this.#parse(true);
  }

  get hasPending(): boolean {
    return this.#pending.length > 0 && this.#paste === null;
  }

  #parse(final: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    const s = this.#pending;
    let i = 0;
    let text = "";
    const flushText = () => {
      if (text) out.push({ type: "text", text });
      text = "";
    };

    while (i < s.length) {
      if (this.#paste !== null) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          const keep = partialSuffix(s, i, PASTE_END);
          this.#paste += s.slice(i, s.length - keep);
          i = s.length - keep;
          break;
        }
        this.#paste += s.slice(i, end);
        out.push({ type: "paste", text: this.#paste.replace(/\r\n?/g, "\n") });
        this.#paste = null;
        i = end + PASTE_END.length;
        continue;
      }

      const code = s.charCodeAt(i);
      if (code === 0x1b) {
        flushText();
        const r = parseEscape(s, i, final);
        if (!r) break; // incomplete sequence: wait for more input
        if (r.paste) this.#paste = "";
        else if (r.event) out.push(r.event);
        i = r.end;
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        flushText();
        out.push(controlKey(code));
        i++;
        continue;
      }
      text += s[i];
      i++;
    }

    flushText();
    this.#pending = s.slice(i);
    return out;
  }
}
