// SPDX-License-Identifier: MIT
// Slash command suggestions above the composer, filtered as the user types.
// The commands themselves are in ../commands.ts.
import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import { truncate } from "../unicode/width";
import { drawBox, step, type ChoiceHit } from "./popup";

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
  /** Its arguments must be typed: completing it only fills it in. */
  required?: boolean;
}

export class CommandSuggestions {
  #text = "";
  #cursor = 0;
  #dismissed = false;
  #active = false;
  #selected = 0;
  #scroll = 0;
  matches: SlashCommand[] = [];

  constructor(readonly commands: SlashCommand[]) {}

  sync(text: string, cursor: number): boolean {
    if (text !== this.#text || cursor !== this.#cursor) {
      this.#text = text;
      this.#cursor = cursor;
      this.#dismissed = false;
      this.#selected = 0;
      this.#scroll = 0;
    }
    this.#active = /^\/[a-z]*$/i.test(text) && cursor === text.length && !this.#dismissed;
    const q = text.slice(1).toLowerCase();
    this.matches = this.#active ? this.commands.filter((c) => c.name.startsWith(q)) : [];
    return this.#active;
  }

  dismiss(): void {
    this.#dismissed = true;
    this.#active = false;
  }

  get selected(): SlashCommand | undefined {
    return this.#active ? this.matches[this.#selected] : undefined;
  }

  move(by: number): void {
    if (this.matches.length) this.#selected = step(this.#selected, by, this.matches.length);
  }

  select(index: number): void {
    if (index >= 0 && index < this.matches.length) this.#selected = index;
  }

  completion(fillOnly: boolean): { text: string; execute: boolean } | null {
    const command = this.selected;
    if (!command) return null;
    const execute = !fillOnly && !command.required;
    return { text: `/${command.name}${!execute && command.args ? " " : ""}`, execute };
  }

  /** Height includes the border; short terminals still show one result. */
  height(available: number): number {
    if (!this.#active || available < 3) return 0;
    return Math.min(available, Math.max(1, Math.min(6, this.matches.length)) + 2);
  }

  render(buf: CellBuffer, x: number, y: number, w: number, h: number): ChoiceHit[] {
    const { x: left, w: inner } = drawBox(buf, x, y, w, h, palette.faint,
      `Commands (${this.matches.length})`, [["↑↓", "select"], ["enter", "use"], ["tab", "fill"], ["esc", "close"]]);
    if (!this.matches.length) {
      buf.text(left, y + 1, truncate("No matching commands", inner), { fg: palette.muted }, left + inner);
      return [];
    }
    const count = h - 2;
    this.#scroll = Math.max(0, Math.min(this.#scroll, this.#selected, this.matches.length - count));
    if (this.#selected >= this.#scroll + count) this.#scroll = this.#selected - count + 1;
    const hits: ChoiceHit[] = [];
    for (let row = 0; row < count; row++) {
      const index = this.#scroll + row;
      const command = this.matches[index];
      if (!command) break;
      const on = index === this.#selected;
      const ry = y + row + 1;
      const end = left + inner;
      let cx = buf.text(left, ry, on ? "› " : "  ", { fg: palette.accent }, end);
      const label = `/${command.name}`;
      cx = buf.text(cx, ry, truncate(label, end - cx), { fg: on ? palette.accent : palette.muted, bold: on }, end);
      const detail = command.args ? `${command.args}  ${command.description}` : command.description;
      const dx = Math.max(cx + 2, left + 17);
      if (end - dx >= 8) buf.text(dx, ry, truncate(detail, end - dx), { fg: palette.muted }, end);
      hits.push({ x0: x + 1, x1: x + w - 1, y: ry, index });
    }
    return hits;
  }
}
