// SPDX-License-Identifier: MIT
// Searching the conversation (ctrl+f, /find): one line in the input's place,
// so the transcript above stays in view with its hits tinted. Typing searches
// as you go and starts at the hit nearest the view; hits are numbered from the
// newest. Enter steps to the next (older) hit and shift+enter back, wrapping
// around, as do ↑↓ and the two buttons. After the first enter, n and N step too and o unfolds the
// output a hit is in; typing anything else goes back to the query. q closes
// and stays on the hit; esc goes back to where the view was.
//
//   ╭─ Search ────────────────────────────────────────────────────╮
//   │ › error▏                                           3/17  ↑  ↓ │
//   ╰──────────────────────── enter next · ↑↓ older/newer · esc back ─╯

import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import { graphemes, stringWidth } from "../unicode/width";
import type { ChatView } from "./chat";
import { Editor } from "./editor";
import type { ChoiceHit, Hints, Popup, PopupFrame, Reply } from "./popup";

const TYPING: Hints = [["enter", "next"], ["↑↓", "older/newer"], ["esc", "back"]];
const BROWSING: Hints = [["enter/n", "older"], ["N", "newer"], ["o", "unfold"], ["q", "stay"], ["esc", "back"]];

/** The buttons at the right end: ↑ steps to an older hit, ↓ to a newer one. */
const BUTTONS = [{ label: " ↑ ", by: 1 }, { label: " ↓ ", by: -1 }] as const;
const BUTTONS_WIDTH = BUTTONS.length * 3;

/** Keys left to the app while searching: scrolling, the trace, switching sessions. */
const PASSED = /^(pageup|pagedown|ctrl\+t|f2|ctrl\+l|alt\+[1-9nw])$/;

export class SearchBar implements Popup {
  readonly title = "Search";
  readonly color = palette.accent;
  #query = new Editor();
  #browsing = false;

  /** Searches `chat`; a query given up front is browsed straight away. */
  constructor(readonly chat: ChatView, query = "") {
    chat.startSearch();
    if (query) {
      this.#query.set(query);
      chat.setQuery(query);
      this.#browsing = true;
    }
  }

  get hints(): Hints {
    return this.#browsing ? BROWSING : TYPING;
  }

  get query(): string {
    return this.#query.text;
  }

  get browsing(): boolean {
    return this.#browsing;
  }

  /** ctrl+f again: back to editing the query. */
  edit(): void {
    this.#browsing = false;
  }

  key(id: string): Reply {
    switch (id) {
      case "escape":
      case "ctrl+c":
        this.chat.endSearch(true);
        return "close";
      case "enter":
        if (!this.#query.text) {
          this.chat.endSearch(true);
          return "close";
        }
        this.#browsing = true;
        this.chat.moveHit(1);
        return "handled";
      case "up":
      case "ctrl+p":
        this.chat.moveHit(1);
        return "handled";
      case "shift+enter":
      case "down":
      case "ctrl+n":
        this.chat.moveHit(-1);
        return "handled";
      case "ctrl+f":
      case "super+f":
        this.edit();
        return "handled";
      case "tab":
        if (this.#browsing) this.chat.toggleHit();
        return "handled";
      case "ctrl+j":
      case "alt+enter":
        return "handled"; // a query is one line
    }
    if (PASSED.test(id)) return "ignored";
    // Editing keys go back to the query, as typing does.
    const before = this.#query.text;
    if (this.#query.key(id, Number.MAX_SAFE_INTEGER)) {
      this.#browsing = false;
      if (this.#query.text !== before) this.chat.setQuery(this.#query.text);
    }
    return "handled";
  }

  type(text: string): Reply {
    if (this.#browsing) {
      switch (text) {
        case "n":
          this.chat.moveHit(1);
          return "handled";
        case "N":
          this.chat.moveHit(-1);
          return "handled";
        case "o":
          this.chat.toggleHit();
          return "handled";
        case "q":
          this.chat.endSearch(false);
          return "close";
        case "/":
          this.edit();
          return "handled";
      }
      this.#browsing = false; // anything else is typed into the query
    }
    this.#query.insert(text.replace(/[\r\n\t]+/g, " "));
    this.chat.setQuery(this.#query.text);
    return "handled";
  }

  select(): void {}

  click(index: number): void {
    const button = BUTTONS[index];
    if (button) this.chat.moveHit(button.by);
  }

  height(): number {
    return 1;
  }

  render(buf: CellBuffer, x: number, y: number, w: number): PopupFrame {
    const end = x + w;
    const text = this.#query.text;
    const { index, total } = this.chat.searchStatus;

    // The buttons, then the count before them.
    const hits: ChoiceHit[] = [];
    let bx = end - BUTTONS_WIDTH;
    for (const [i, b] of BUTTONS.entries()) {
      buf.text(bx, y, b.label, { fg: total ? palette.accent : palette.faint, bold: true });
      hits.push({ y, x0: bx, x1: bx + 3, index: i });
      bx += 3;
    }
    const count = !text ? "" : total ? `${index}/${total}` : "no matches";
    const countX = end - BUTTONS_WIDTH - 1 - stringWidth(count);
    if (count) buf.text(countX, y, count, { fg: total ? palette.muted : palette.error });

    const cx = buf.text(x, y, "› ", { fg: palette.accent, bold: true });
    const room = Math.max(1, countX - 2 - cx);
    if (!text) {
      buf.text(cx, y, "Search this conversation", { fg: palette.faint }, cx + room);
      return { hits, cursor: this.#browsing ? undefined : { x: cx, y } };
    }
    // Long queries scroll so the cursor stays in view.
    let start = 0;
    const cursor = this.#query.cursor;
    for (const g of graphemes(text)) {
      if (stringWidth(text.slice(start, cursor)) < room) break;
      start += g.length;
    }
    const color = this.#browsing ? palette.muted : total ? undefined : palette.error;
    buf.text(cx, y, text.slice(start), { fg: color }, cx + room);
    return { hits, cursor: this.#browsing ? undefined : { x: cx + stringWidth(text.slice(start, cursor)), y } };
  }
}
