// SPDX-License-Identifier: MIT
// The permission mode popup (/permissions, or a click on the mode in the
// footer): who approves edits, commands and web fetches.
//
//   ╭─ Permissions ───────────────────────────────────────────────╮
//   │ Who approves edits, shell commands and web fetches?          │
//   │                                                              │
//   │   1. Ask for approval  edits, commands and fetches wait…     │
//   │ › 2. Approve for me ✓  only risky steps ask: deleting…       │
//   │   3. Full access       everything runs without asking        │
//   ╰─────────────────────── ↑↓ select · enter choose · esc close ─╯

import { MODES, type PermissionMode } from "../agent/permissions";
import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import { truncate } from "../unicode/width";
import { drawChoices, step, type Choice, type Hints, type Popup, type PopupFrame, type Reply } from "./popup";

const indexOf = (mode: PermissionMode) => MODES.findIndex((m) => m.id === mode);

export class ModePicker implements Popup {
  readonly title = "Permissions";
  readonly color = palette.accent;
  readonly hints: Hints = [["↑↓", "select"], ["enter", "choose"], ["esc", "close"]];
  #selected: number;

  constructor(
    /** The mode in force, shared by every session. */
    readonly current: () => PermissionMode,
    readonly choose: (mode: PermissionMode) => void,
  ) {
    this.#selected = indexOf(current());
  }

  /** Moves the selection to the mode in force, after shift+tab changed it. */
  follow(): void {
    this.#selected = indexOf(this.current());
  }

  height(): number {
    return 2 + MODES.length;
  }

  key(id: string): Reply {
    const n = MODES.length;
    switch (id) {
      case "up":
      case "ctrl+p":
      case "k":
        this.#selected = step(this.#selected, -1, n);
        return "handled";
      case "down":
      case "ctrl+n":
      case "j":
      case "tab":
        this.#selected = step(this.#selected, 1, n);
        return "handled";
      case "escape":
      case "ctrl+c":
        return "close";
      case "enter":
        this.choose(MODES[this.#selected]!.id);
        return "close";
    }
    const picked = MODES[Number(id) - 1];
    if (!picked) return "handled";
    this.choose(picked.id);
    return "close";
  }

  select(index: number): void {
    this.#selected = index;
  }

  render(buf: CellBuffer, x: number, y: number, w: number): PopupFrame {
    buf.text(x, y, truncate("Who approves edits, shell commands and web fetches?", w), { fg: palette.muted });
    const current = this.current();
    const choices: Choice[] = MODES.map((m) => ({ label: m.id === current ? `${m.label} ✓` : m.label, detail: m.description }));
    return { hits: drawChoices(buf, x, y + 2, w, choices, this.#selected, true) };
  }
}
