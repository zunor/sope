// Raw terminal control: raw mode, alternate screen, bracketed paste, mouse
// reporting, and guaranteed restoration on exit.

import { detectTruecolor } from "../render/color";

const ENTER = [
  "\x1b[?1049h", // alternate screen
  "\x1b[?25l", // hide cursor
  "\x1b[?7l", // no auto-wrap: writing the last column must never scroll
  "\x1b[?2004h", // bracketed paste
  "\x1b[H\x1b[2J",
].join("");

const LEAVE = ["\x1b[0m", "\x1b[?2004l", "\x1b[?7h", "\x1b[?25h", "\x1b[?1049l"].join("");

const MOUSE_ON = "\x1b[?1000h\x1b[?1006h"; // button events, SGR encoding
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

export class Terminal {
  readonly truecolor = detectTruecolor();
  #active = false;
  #mouse = false;
  #restoreOnExit = () => this.leave();

  get cols(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  get mouse(): boolean {
    return this.#mouse;
  }

  enter(): void {
    if (this.#active) return;
    this.#active = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.write(ENTER + (this.#mouse ? MOUSE_ON : ""));
    process.on("exit", this.#restoreOnExit);
  }

  leave(): void {
    if (!this.#active) return;
    this.#active = false;
    this.write((this.#mouse ? MOUSE_OFF : "") + LEAVE);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.off("exit", this.#restoreOnExit);
  }

  /** Mouse reporting enables wheel scrolling but disables the terminal's own text selection. */
  setMouse(on: boolean): void {
    if (on === this.#mouse) return;
    this.#mouse = on;
    if (this.#active) this.write(on ? MOUSE_ON : MOUSE_OFF);
  }

  onInput(cb: (data: Uint8Array) => void): void {
    process.stdin.on("data", cb);
  }

  onResize(cb: () => void): void {
    process.stdout.on("resize", cb);
  }

  write(s: string): void {
    process.stdout.write(s);
  }
}
