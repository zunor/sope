// SPDX-License-Identifier: MIT
// The sope TUI: wires the terminal, input decoding and the sessions together,
// and lays out each frame. Each tab is a session (session.ts) with its own
// agent; input and commands go to the one on screen. Sessions are saved
// per directory (store.ts); the most recent few come back as tabs on start,
// and ⋯ (or /sessions) lists them all.
//
//     explain thread pools     fix grep ×    +             ~/src/app  ⋯
//
//   › user message
//
//   ✻ Thought for 2.1s
//   ● assistant reply …
//   ◆ agent · general-purpose  explain thread pools
//     ● read  src/pool.c
//     ⎿ report …
//
//   ⠉⠉ Thinking… (1m 4s · 38 tok/s · tip: …)  (while a turn runs: a
//                                                    meteor circles a one-row square)
//   ──────────────────────────────────────────────────────────────────────
//   › input                         (or a popup: a permission prompt for
//   ───────────────────────────────  write / edit / bash / web_fetch, the
//                                    permission modes, or the models)
//     ◈ Approve for me                 (and short notices after it)

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { version, type SopeEvent } from "sope";
import { clipboardImage, describeImage, imageRefs, pastedImagePath, readImageFile, type ImageFile } from "./agent/images";
import { listModels, type ModelInfo } from "./agent/models";
import { MODES, modeLabel, parseMode, type PermissionMode } from "./agent/permissions";
import { ASKING_TOOLS, previewFor, READ_TOOLS, type HostTool, type PreviewLine } from "./agent/tools";
import { configPath, type Config } from "./config";
import type { CellBuffer } from "./render/buffer";
import { parseOscColor } from "./render/color";
import { Renderer } from "./render/renderer";
import { InputParser, keyId, type InputEvent, type MouseEvent as MouseInput } from "./term/input";
import { Terminal } from "./term/terminal";
import { Session, type Approval, type Decision } from "./session";
import { Store } from "./store";
import { palette, SPINNER, SPINNER_MS, surfaces, type Surfaces } from "./theme";
import { SessionList } from "./ui/sessions";
import { Highlighter, type TokenKind } from "./ui/highlight";
import { CommandSuggestions } from "./ui/commands";
import { ModelPicker } from "./ui/models";
import { drawBox, drawChoices, step, type Choice, type ChoiceHit, type Hints } from "./ui/popup";
import type { Editor } from "./ui/editor";
import { copyToClipboard, Selection } from "./ui/selection";
import { pixelMeteor } from "./ui/pixel-meteor";
import { METEOR_ROWS } from "./ui/meteor";
import { drawStatus, tipAt } from "./ui/status";
import { ALL_SESSIONS, drawTabs, NEW_TAB, TAB_ROWS, type TabHit, type TabInfo } from "./ui/tabs";
import { stringWidth, truncate } from "./unicode/width";

const PAD = 1;
const PROMPT = "› ";
const MAX_INPUT_ROWS = 8;
const ESC_TIMEOUT_MS = 25;
const TICK_MS = 50; // animation frame rate while anything runs
const MAX_TABS = 5; // sessions shown as tabs; the rest are a click on ⋯ away
const HELP = (hostTools: HostTool[]) => [
  `sope ${version()}. Commands:`,
  "  /help              show this help",
  "  /new               open a new session in a tab (alt+n, or click +)",
  "  /close             close this session (alt+w, or × on its tab); it is no longer listed",
  "  /sessions          list every saved session of this directory (or click ⋯)",
  "  /clear             clear the transcript and the conversation history",
  "  /compact [focus]   summarize the conversation to free context (also automatic)",
  "  /model [name]      choose the model (alt+m), or switch to <name>; from the next turn",
  "  /thinking          show or hide the model's full reasoning",
  "  /trace             toggle the ABI trace panel (ctrl+t)",
  "  /mouse             toggle mouse capture (wheel scroll, drag to copy); off gives selection back to the terminal",
  "  /set <key> [val]   sope_agent_set_option; omit val to unset",
  "  /permissions [m]   choose who approves edits and commands (shift+tab cycles): ask, auto, full",
  "  /quit              exit",
  "Images: ctrl+v pastes one from the clipboard, dragging an image file into the terminal attaches it, and sope --image <file> attaches one to the first message. They go to the image model (SOPE_IMAGE_MODEL).",
  "Sessions: alt+1 … alt+9 or a click switches tabs; each keeps running in the background. They are saved per directory and come back on the next start.",
  `Tools (built into libsope): ${[...READ_TOOLS, ...ASKING_TOOLS.map((t) => `${t}*`)].join(", ")}, plus \`agent\` for subagents (* may ask first).`,
  "Permissions: Ask for approval asks before every * tool; Approve for me (the default) runs everything except risky steps: deleting or writing outside this directory, git push and other publishing, discarding uncommitted git work, sudo, global installs, ssh, curl uploads; Full access never asks.",
  ...(hostTools.length ? [`Host tools (this TUI): ${hostTools.map((t) => t.name).join(", ")}.`] : []),
  `Config: ${configPath()} or environment variables (SOPE_API_KEY, SOPE_MODEL, SOPE_BASE_URL, ...).`,
  "Mock provider: plain text streams a reply; !echo <x>, !clock, !sleep <s> call host tools; !read {\"file_path\":\"README.md\"} (any tool, JSON input); !agent t1 | t2 runs subagents; !panic fails.",
].join("\n");

const MAX_PREVIEW_ROWS = 20;
const MAX_MODEL_ROWS = 14;

/** Key hints in the bottom edge of each popup. */
const APPROVAL_HINTS: Hints = [["↑↓", "select"], ["enter", "confirm"], ["y/a/n", "answer"], ["esc", "stop"], ["shift+tab", "mode"]];
const PICKER_HINTS: Hints = [["↑↓", "select"], ["enter", "choose"], ["esc", "close"]];
const MODEL_HINTS: Hints = [["type", "search"], ["↑↓", "select"], ["enter", "use"], ["esc", "close"]];

/** The answers of a permission prompt, in order (1-4). */
const DECISIONS: Decision[] = ["once", "always", "deny", "stop"];
const QUICK: Record<string, Decision> = { y: "once", a: "always", n: "deny" };

const MODE_COLOR: Record<PermissionMode, number> = { ask: palette.muted, auto: palette.muted, full: palette.error };
const MODE_ICON: Record<PermissionMode, string> = { ask: "◇", auto: "◈", full: "◆" };

const SYNTAX: Record<TokenKind, number | undefined> = {
  plain: undefined,
  keyword: 0xc678dd,
  string: 0x98c379,
  number: 0xd19a66,
  comment: 0x7f848e,
  type: 0xe5c07b,
};

export interface AppOptions {
  config: Config;
  /** Sent as the first message. */
  prompt?: string;
  /** Attached to the first message (--image). */
  images?: ImageFile[];
}

const previewColor = (kind: PreviewLine["kind"]) =>
  kind === "add" ? palette.ok : kind === "remove" ? palette.error : kind === "command" ? palette.tool : palette.muted;

/** The background from $COLORFGBG ("fg;bg", set by some terminals) until the terminal answers the OSC 11 query. */
function guessBackground(env = process.env): number | null {
  const bg = Number(env.COLORFGBG?.split(";").at(-1));
  if (!Number.isInteger(bg)) return null;
  return bg === 7 || bg === 15 ? 0xffffff : 0x000000;
}

export class App {
  #term = new Terminal();
  #renderer = new Renderer((s) => this.#term.write(s), this.#term.truecolor, this.#term.graphics);
  #parser = new InputParser();
  #selection = new Selection();
  #notice: string | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #config: Config;
  #mode: PermissionMode; // shared by every session
  #picker: number | null = null; // the selected mode while the mode popup is open
  #choice = { callId: -1, index: 0 }; // the selected answer of the permission prompt on screen
  #choiceHits: ChoiceHit[] = [];
  #modeHit = { x0: 0, x1: 0 }; // the mode in the footer: a click opens the popup
  #models: ModelPicker | null = null; // the model popup, while open
  #modelList: Promise<ModelInfo[]> | null = null; // the endpoint's models, asked for once
  #commands = new CommandSuggestions();
  #commandHits: ChoiceHit[] = [];
  #commandBounds: { x: number; y: number; w: number; h: number } | null = null;
  #popupRows = 0; // rows the popup on screen takes, its edges included
  #initialPrompt?: string;
  #initialImages: ImageFile[];
  #dir = process.cwd().replace(homedir(), "~");
  #directory = realpathSync(process.cwd()); // the key sessions are saved under
  #store: Store | null;
  #list: SessionList | null = null; // the session list, while open

  #sessions: Session[] = [];
  #active = 0;
  #tabHits: TabHit[] = [];
  #hoverStarted = 0;
  #hover: number | null = null; // tab bar item under the pointer
  #colors: Surfaces = surfaces(guessBackground());

  #showThinking = false;
  #showTrace = false;
  #inputWidth = 40;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #escTimer: ReturnType<typeof setTimeout> | null = null;
  #renderQueued = false;
  #frame = { ms: 0, bytes: 0 };
  #quitting = false;

  constructor({ config, prompt, images = [] }: AppOptions) {
    this.#config = config;
    this.#mode = config.permissions;
    this.#initialPrompt = prompt;
    this.#initialImages = images;
    this.#term.setMouse(config.mouse);

    const { store, error } = Store.open();
    this.#store = store;
    // The most recent few, in the order they were started; the newest is on screen.
    const recent = (store?.summaries(this.#directory) ?? []).slice(0, prompt ? MAX_TABS - 1 : MAX_TABS);
    for (const summary of [...recent].reverse()) {
      const stored = store!.get(summary.id);
      if (stored) this.#sessions.push(this.#restore(stored));
    }
    if (!this.#sessions.length || prompt) this.#newSession();
    else this.#switchTo(this.#sessions.length - 1);
    if (error) this.#session.chat.add({ role: "error", text: `sessions will not be saved: ${error}` });
  }

  get #session(): Session {
    return this.#sessions[this.#active]!;
  }

  start(): void {
    this.#term.onInput((data) => this.#onInput(data));
    this.#term.enter();
    this.#term.onResize(() => {
      this.#renderer.invalidate();
      this.#render();
    });
    if (this.#initialPrompt) {
      const numbers = this.#initialImages.map((img) => this.#session.addImage(img));
      this.#send([this.#initialPrompt, ...numbers.map((n) => `[Image #${n}]`)].join(" "));
    }
    this.#render();
  }

  /** Puts the terminal back to normal; safe to call from crash handlers. */
  restoreTerminal(): void {
    this.#term.leave();
  }

  async quit(): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.#tick(false);
    await Promise.all(this.#sessions.map((s) => s.shutdown()));
    this.#store?.close();
    this.#term.leave();
    process.exit(0);
  }

  // ---- sessions -------------------------------------------------------

  #restore(stored: NonNullable<ReturnType<Store["get"]>>): Session {
    const s = new Session(this.#config, () => this.#mode, (session, events) => this.#onSessionEvents(session, events), {
      store: this.#store!,
      directory: this.#directory,
      stored,
    });
    s.chat.showThinking = this.#showThinking;
    return s;
  }

  #newSession(): void {
    this.#makeRoom();
    const persist = this.#store ? { store: this.#store, directory: this.#directory } : undefined;
    const s = new Session(this.#config, () => this.#mode, (session, events) => this.#onSessionEvents(session, events), persist);
    s.chat.showThinking = this.#showThinking;
    const c = this.#config;
    const hint = c.provider === "mock" && !c.apiKey ? " · set SOPE_API_KEY (or .env) to talk to a real model" : "";
    const full = this.#mode === "full" ? " · Full access: edits and commands run without asking" : "";
    s.chat.add({ role: "info", text: `/help for commands${hint}${full}` });
    this.#sessions.push(s);
    this.#switchTo(this.#sessions.length - 1);
  }

  #switchTo(index: number): void {
    if (index < 0 || index >= this.#sessions.length) return;
    this.#active = index;
    this.#session.chat.resetInteractions();
    this.#commands = new CommandSuggestions();
    this.#commandHits = [];
    this.#commandBounds = null;
    this.#session.unread = false;
    this.#session.lastUsed = performance.now();
    this.#selection.clear();
  }

  /**
   * Keeps the tabs at MAX_TABS before one more opens: the least recently
   * used idle tab is put away (saved and stopped, still in the list).
   */
  #makeRoom(): void {
    if (this.#sessions.length < MAX_TABS) return;
    const idle = this.#sessions.filter((s, i) => i !== this.#active && !s.busy && !s.approvals.length);
    const victim = idle.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return; // all busy: let the bar grow (it scrolls)
    const index = this.#sessions.indexOf(victim);
    void victim.shutdown();
    this.#sessions.splice(index, 1);
    if (index < this.#active) this.#active--;
  }

  /** Brings a saved session up in a tab: switches to it if it is open, else restores it. */
  #openSession(id: string): void {
    const open = this.#sessions.findIndex((s) => s.id === id);
    if (open >= 0) return this.#switchTo(open);
    const stored = this.#store?.get(id);
    if (!stored) return this.#flash("that session is gone");
    this.#makeRoom();
    this.#sessions.push(this.#restore(stored));
    this.#switchTo(this.#sessions.length - 1);
  }

  #openList(): void {
    const open = new Set(this.#sessions.map((s) => s.id));
    const all = (this.#store?.summaries(this.#directory) ?? []).map((s) => ({ ...s, open: open.has(s.id) }));
    this.#list = new SessionList(all, this.#dir);
  }

  /** Keys while the session list is open. */
  #handleListKey(id: string): void {
    const list = this.#list!;
    switch (id) {
      case "escape":
      case "ctrl+c":
        this.#list = null;
        return;
      case "enter": {
        const picked = list.selected;
        this.#list = null;
        if (picked) this.#openSession(picked.id);
        return;
      }
      case "up":
      case "ctrl+p":
        return list.move(-1);
      case "down":
      case "ctrl+n":
        return list.move(1);
      case "pageup":
        return list.move(-10);
      case "pagedown":
        return list.move(10);
      case "home":
        return list.move(-Infinity);
      case "end":
        return list.move(Infinity);
      case "backspace":
        return list.backspace();
    }
  }

  /** Closes a tab: the session stops and is no longer listed, but stays in the store. */
  #closeSession(index = this.#active): void {
    const s = this.#sessions[index];
    if (!s) return;
    void s.shutdown().then(() => s.delete());
    this.#sessions.splice(index, 1);
    this.#setHover(null);
    if (!this.#sessions.length) return this.#newSession();
    if (index < this.#active || this.#active >= this.#sessions.length) this.#active--;
    this.#switchTo(Math.max(0, this.#active));
  }

  #onSessionEvents(session: Session, events: SopeEvent[]): void {
    if (session !== this.#session) {
      if (events.some((ev) => ev.type === "turn_end" && !ev.agentId)) session.unread = true;
      if (events.some((ev) => ev.type === "permission") && session.approvals.length) {
        this.#flash(`“${session.title}” is waiting for your approval (alt+${this.#sessions.indexOf(session) + 1})`, 4000);
      }
    }
    this.#tick(this.#sessions.some((s) => s.busy));
    this.#scheduleRender();
  }

  // ---- input ----------------------------------------------------------

  #onInput(data: Uint8Array): void {
    if (this.#escTimer) clearTimeout(this.#escTimer);
    this.#escTimer = null;
    for (const ev of this.#parser.feed(data)) this.#handle(ev);
    if (this.#parser.hasPending) {
      this.#escTimer = setTimeout(() => {
        this.#escTimer = null;
        for (const ev of this.#parser.flush()) this.#handle(ev);
        this.#scheduleRender();
      }, ESC_TIMEOUT_MS);
    }
    this.#scheduleRender();
  }

  #handle(ev: InputEvent): void {
    if (ev.type === "apc") return this.#term.graphics.reply(ev.data);
    if (ev.type === "osc") return this.#handleOsc(ev.data);
    if (ev.type === "mouse") return this.#handleMouse(ev);
    this.#selection.clear();
    if (this.#list) {
      if (ev.type === "key") return this.#handleListKey(keyId(ev));
      return this.#list.type(ev.text);
    }
    if (this.#models && !this.#session.approvals.length && (ev.type === "text" || ev.type === "paste")) return this.#models.type(ev.text);
    if ((this.#session.approvals.length || this.#picker !== null) && (ev.type === "text" || ev.type === "paste")) {
      if (ev.type === "text" && [...ev.text].length === 1) this.#handleKey(ev.text);
      return; // the input box is hidden while a popup is up
    }
    switch (ev.type) {
      case "text":
        this.#session.editor.insert(ev.text);
        return;
      case "paste": {
        // A file dragged into the terminal arrives as its path.
        const path = pastedImagePath(ev.text);
        if (path) {
          try {
            return this.#insertImage(readImageFile(path));
          } catch (err) {
            this.#flash((err as Error).message, 4000);
          }
        }
        this.#session.editor.insert(ev.text);
        return;
      }
      case "key":
        this.#handleKey(keyId(ev));
    }
  }

  /** The terminal's answer to the background color query (terminal.ts). */
  #handleOsc(data: string): void {
    if (!data.startsWith("11;")) return;
    const bg = parseOscColor(data);
    if (bg !== null) this.#colors = surfaces(bg);
  }

  #tabAt(x: number, y: number): TabHit | undefined {
    return this.#tabHits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1);
  }

  #setHover(index: number | null): void {
    if (index === this.#hover) return;
    this.#hover = index;
    this.#hoverStarted = performance.now();
    this.#tick(this.#sessions.some((s) => s.busy));
  }

  #syncCommands(): boolean {
    if (this.#list || this.#models || this.#picker !== null || this.#session.approvals.length) return false;
    const editor = this.#session.editor;
    return this.#commands.sync(editor.text, editor.cursor);
  }

  #completeCommand(fillOnly: boolean): void {
    const completion = this.#commands.completion(fillOnly);
    if (!completion) return;
    const editor = this.#session.editor;
    editor.set(completion.text);
    this.#commands.sync(editor.text, editor.cursor);
    this.#commands.dismiss();
    this.#commandHits = [];
    this.#commandBounds = null;
    if (completion.execute) this.#submit();
  }

  #handleMouse(ev: MouseInput): void {
    const p = { x: ev.x, y: ev.y };
    this.#session.chat.hover(null);
    if (ev.action === "move" || ev.action === "drag") this.#setHover(this.#tabAt(ev.x, ev.y)?.index ?? null);
    if (this.#list) return this.#handleListMouse(ev);
    if (this.#syncCommands() && this.#commandBounds) {
      const b = this.#commandBounds;
      const inside = ev.x >= b.x && ev.x < b.x + b.w && ev.y >= b.y && ev.y < b.y + b.h;
      if (inside) {
        if (ev.action === "wheel-up" || ev.action === "wheel-down") {
          this.#commands.move(ev.action === "wheel-up" ? -1 : 1);
          return;
        }
        const hit = this.#commandHits.find((h) => h.y === ev.y && ev.x >= h.x0 && ev.x < h.x1);
        if (hit && (ev.action === "move" || (ev.action === "press" && ev.button === 0))) {
          this.#commands.select(hit.index);
          if (ev.action === "press") this.#completeCommand(false);
        }
        return;
      }
    }
    // Popup choices follow the pointer and take a click.
    const choice = this.#choiceHits.find((h) => h.y === ev.y && ev.x >= h.x0 && ev.x < h.x1);
    if (choice && (ev.action === "move" || (ev.action === "press" && ev.button === 0))) {
      if (this.#session.approvals.length) this.#choice.index = choice.index;
      else if (this.#models) this.#models.select(choice.index);
      else if (this.#picker !== null) this.#picker = choice.index;
      if (ev.action === "press") this.#handleKey("enter");
      return;
    }
    if (ev.action === "press" && ev.button === 0 && ev.y === this.#term.rows - 1 && ev.x >= this.#modeHit.x0 && ev.x < this.#modeHit.x1) {
      this.#picker = this.#picker === null ? MODES.findIndex((m) => m.id === this.#mode) : null;
      return;
    }
    if (ev.action !== "drag") this.#session.chat.hover(p);
    switch (ev.action) {
      case "move":
        return;
      case "wheel-up":
      case "wheel-down":
        if (this.#models && ev.y >= this.#term.rows - 1 - this.#popupRows) return this.#models.move(ev.action === "wheel-up" ? -1 : 1);
        this.#selection.clear(); // it is in screen cells: the text under it is about to move
        return this.#session.chat.scrollBy(ev.action === "wheel-up" ? 3 : -3);
      case "press": {
        if (ev.button !== 0) return;
        const hit = this.#tabAt(ev.x, ev.y);
        if (hit) {
          if (hit.index === NEW_TAB) return this.#newSession();
          if (hit.index === ALL_SESSIONS) return this.#openList();
          return hit.close ? this.#closeSession(hit.index) : this.#switchTo(hit.index);
        }
        if (this.#session.chat.toggleAt(ev.x, ev.y)) {
          this.#selection.clear();
          return;
        }
        this.#selection.press(p);
        return;
      }
      case "drag":
        return this.#selection.drag(p);
      case "release":
        if (this.#selection.release(p)) this.#copySelection();
    }
  }

  #handleListMouse(ev: MouseInput): void {
    const list = this.#list!;
    if (ev.action === "wheel-up" || ev.action === "wheel-down") return list.move(ev.action === "wheel-up" ? -3 : 3);
    if (ev.action !== "press" || ev.button !== 0) return;
    if (this.#tabAt(ev.x, ev.y)?.index === ALL_SESSIONS) {
      this.#list = null; // ⋯ again closes it
      return;
    }
    const hit = list.hit(ev.x, ev.y);
    if (hit === "outside") this.#list = null;
    else if (hit) {
      this.#list = null;
      this.#openSession(hit.id);
    }
  }

  #copySelection(): void {
    const screen = this.#renderer.screen;
    const text = screen ? this.#selection.text(screen) : "";
    if (!text.trim()) return;
    copyToClipboard(text, (s) => this.#term.write(s));
    this.#flash(`copied ${[...text].length} characters`);
  }

  /** Shows a short message after the permission mode in the footer. */
  #flash(text: string, ms = 2000): void {
    this.#notice = text;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#notice = null;
      this.#scheduleRender();
    }, ms);
  }

  #handleKey(id: string): void {
    if (id === "shift+tab") return this.#cycleMode();
    if (this.#session.approvals.length && this.#handleApprovalKey(id)) return;
    if (this.#models) return this.#handleModelKey(id);
    if (this.#picker !== null) return this.#handlePickerKey(id);
    const s = this.#session;
    const e = s.editor;
    if (this.#syncCommands()) {
      switch (id) {
        case "up": case "ctrl+p": return this.#commands.move(-1);
        case "down": case "ctrl+n": return this.#commands.move(1);
        case "escape": return this.#commands.dismiss();
        case "tab": return this.#completeCommand(true);
        case "enter":
          if (this.#commands.selected) return this.#completeCommand(false);
      }
    }
    const tab = /^alt\+([1-9])$/.exec(id);
    if (tab) return this.#switchTo(Number(tab[1]) - 1);
    switch (id) {
      case "alt+n":
        return this.#newSession();
      case "alt+m":
        return this.#openModels();
      case "alt+w":
        return this.#closeSession();
      case "enter":
        return this.#submit();
      case "ctrl+j":
      case "alt+enter":
      case "shift+enter":
        return e.insert("\n");
      case "ctrl+v":
        this.#flash("reading the clipboard…");
        void clipboardImage()
          .then((img) => (img ? this.#insertImage(img) : this.#flash("no image on the clipboard (paste text with your terminal's paste)", 4000)))
          .catch((err: Error) => this.#flash(err.message, 4000))
          .finally(() => this.#scheduleRender());
        return;
      case "ctrl+c":
        if (s.busy) return s.cancel();
        if (e.text) return e.clear();
        void this.quit();
        return;
      case "ctrl+d":
        if (!e.text) void this.quit();
        else e.deleteForward();
        return;
      case "escape":
        if (s.busy) s.cancel();
        return;
      case "ctrl+t":
      case "f2":
        this.#showTrace = !this.#showTrace;
        return;
      case "ctrl+l":
        return this.#renderer.invalidate();
      case "pageup":
        return s.chat.scrollBy(s.chat.pageSize);
      case "pagedown":
        return s.chat.scrollBy(-s.chat.pageSize);
      case "backspace":
        return e.backspace();
      case "delete":
        return e.deleteForward();
      case "left":
      case "ctrl+b":
        return e.left();
      case "right":
      case "ctrl+f":
        return e.right();
      case "home":
      case "ctrl+a":
        return e.lineStart();
      case "end":
      case "ctrl+e":
        return e.lineEnd();
      case "alt+left":
      case "ctrl+left":
      case "alt+b":
        return e.wordLeft();
      case "alt+right":
      case "ctrl+right":
      case "alt+f":
        return e.wordRight();
      case "ctrl+w":
      case "alt+backspace":
        return e.deleteWordLeft();
      case "ctrl+u":
        return e.killToLineStart();
      case "ctrl+k":
        return e.killToLineEnd();
      case "up":
      case "ctrl+p":
        if (!e.moveVertical(-1, this.#inputWidth)) e.historyPrev();
        return;
      case "down":
      case "ctrl+n":
        if (!e.moveVertical(1, this.#inputWidth)) e.historyNext();
        return;
    }
  }

  /** The selected answer of the prompt on screen; a new prompt starts at "Yes". */
  #selectedAnswer(): number {
    const head = this.#session.approvals[0];
    if (head && head.callId !== this.#choice.callId) this.#choice = { callId: head.callId, index: 0 };
    return this.#choice.index;
  }

  #handleApprovalKey(id: string): boolean {
    const index = this.#selectedAnswer();
    const move = (by: number) => {
      this.#choice.index = step(index, by, DECISIONS.length);
      return true;
    };
    switch (id) {
      case "up":
      case "ctrl+p":
      case "k":
        return move(-1);
      case "down":
      case "ctrl+n":
      case "j":
      case "tab":
        return move(1);
    }
    const decision =
      id === "enter" ? DECISIONS[index] : id === "escape" || id === "ctrl+c" ? "stop" : (DECISIONS[Number(id) - 1] ?? QUICK[id.toLowerCase()]);
    if (!decision) {
      // Switching tabs still works; everything else is swallowed.
      return !["pageup", "pagedown", "ctrl+t", "f2", "ctrl+l", "alt+n", "alt+w"].includes(id) && !/^alt\+[1-9]$/.test(id);
    }
    this.#session.decide(decision);
    return true;
  }

  // ---- permission modes -----------------------------------------------

  #setMode(mode: PermissionMode): void {
    this.#mode = mode;
    for (const s of this.#sessions) s.recheck(); // waiting requests the new mode allows go ahead
    this.#flash(MODES.find((x) => x.id === mode)!.description, 3000); // the footer names the mode already
  }

  /** shift+tab: ask → auto → full → ask. */
  #cycleMode(): void {
    const i = MODES.findIndex((m) => m.id === this.#mode);
    this.#setMode(MODES[step(i, 1, MODES.length)]!.id);
    if (this.#picker !== null) this.#picker = step(i, 1, MODES.length);
  }

  /** Keys while the mode popup is open. */
  #handlePickerKey(id: string): void {
    const n = MODES.length;
    switch (id) {
      case "up":
      case "ctrl+p":
      case "k":
        this.#picker = step(this.#picker!, -1, n);
        return;
      case "down":
      case "ctrl+n":
      case "j":
      case "tab":
        this.#picker = step(this.#picker!, 1, n);
        return;
      case "escape":
      case "ctrl+c":
        this.#picker = null;
        return;
      case "enter":
        this.#setMode(MODES[this.#picker!]!.id);
        this.#picker = null;
        return;
    }
    const picked = MODES[Number(id) - 1];
    if (picked) {
      this.#setMode(picked.id);
      this.#picker = null;
    }
  }

  // ---- models ---------------------------------------------------------

  #openModels(): void {
    this.#picker = null;
    const picker = new ModelPicker(this.#session.model, this.#store?.recentModels() ?? []);
    this.#models = picker;
    this.#modelList ??= listModels(this.#config);
    this.#modelList
      .then((models) => picker.setModels(models))
      .catch((err: Error) => {
        this.#modelList = null; // ask again next time
        picker.setError(err.message);
      })
      .finally(() => this.#scheduleRender());
  }

  /** Keys while the model popup is open; typing goes to its search. */
  #handleModelKey(id: string): void {
    const m = this.#models!;
    switch (id) {
      case "up":
      case "ctrl+p":
        return m.move(-1);
      case "down":
      case "ctrl+n":
      case "tab":
        return m.move(1);
      case "pageup":
        return m.move(-10);
      case "pagedown":
        return m.move(10);
      case "backspace":
        return m.backspace();
      case "escape":
      case "ctrl+c":
        this.#models = null;
        return;
      case "enter": {
        const picked = m.selected;
        this.#models = null;
        if (picked) this.#useModel(picked);
        return;
      }
    }
  }

  /** Switches this session's model and makes it the one new sessions start with. */
  #useModel(id: string): void {
    const s = this.#session;
    this.#config.model = id; // sessions already open keep theirs
    if (s.model && s.model !== id) this.#store?.usedModel(s.model, Date.now() - 1); // so it is in Recent to go back to
    this.#store?.usedModel(id);
    if (id === s.model) return this.#flash(`already on ${id}`);
    s.setOption("model", id);
    s.chat.add({ role: "info", text: `model = ${id} (from the next turn)` });
  }

  #submit(): void {
    const s = this.#session;
    const text = s.editor.text.trim();
    if (!text) return;
    s.editor.submit();
    s.chat.scrollToBottom();
    if (text.startsWith("/")) return this.#command(text);
    this.#send(text);
  }

  #send(text: string): void {
    const s = this.#session;
    s.send(text, imageRefs(text).filter((n) => s.images.has(n)));
    this.#tick(s.busy);
  }

  /** Puts an image into the message being written, as an [Image #N] token. */
  #insertImage(img: ImageFile): void {
    const s = this.#session;
    const n = s.addImage(img);
    const e = s.editor;
    const before = e.text.slice(0, e.cursor);
    e.insert(`${before && !/\s$/.test(before) ? " " : ""}[Image #${n}] `);
    this.#flash(`attached [Image #${n}] ${describeImage(img)}`);
  }

  #command(line: string): void {
    const [cmd = "", ...args] = line.slice(1).split(/\s+/);
    const s = this.#session;
    const info = (text: string) => s.chat.add({ role: "info", text });
    try {
      switch (cmd) {
        case "help":
          return void info(HELP(s.hostTools));
        case "new":
          return this.#newSession();
        case "close":
          return this.#closeSession();
        case "sessions":
          return this.#openList();
        case "compact":
          s.compact(args.join(" "));
          this.#tick(true);
          return;
        case "permissions": {
          if (args[0]) {
            const mode = parseMode(args.join(" "));
            if (!mode) return void s.chat.add({ role: "error", text: "usage: /permissions [ask|auto|full]" });
            return this.#setMode(mode);
          }
          const allowed = [...s.alwaysAllowed];
          if (allowed.length) info(`Allowed for this session without asking: ${allowed.join(", ")}.`);
          this.#picker = MODES.findIndex((m) => m.id === this.#mode);
          return;
        }
        case "clear":
          return s.reset();
        case "model":
          if (!args[0]) return this.#openModels();
          return this.#useModel(args[0]);
        case "thinking":
          this.#showThinking = !this.#showThinking;
          for (const other of this.#sessions) other.chat.showThinking = this.#showThinking;
          return void info(`full reasoning ${this.#showThinking ? "shown" : "collapsed"}`);
        case "trace":
          this.#showTrace = !this.#showTrace;
          return;
        case "mouse":
          this.#term.setMouse(!this.#term.mouse);
          return void info(`mouse reporting ${this.#term.mouse ? "on" : "off"}`);
        case "set": {
          const [key, ...rest] = args;
          if (!key) return void s.chat.add({ role: "error", text: "usage: /set <key> [value]" });
          const value = rest.length ? rest.join(" ") : null;
          s.setOption(key, value);
          return void info(value === null ? `unset ${key}` : `${key} = ${key.includes("key") ? "***" : value}`);
        }
        case "quit":
        case "exit":
          void this.quit();
          return;
        default:
          s.chat.add({ role: "error", text: `unknown command /${cmd} (try /help)` });
      }
    } catch (err) {
      s.chat.add({ role: "error", text: (err as Error).message });
    }
  }

  // ---- rendering ------------------------------------------------------

  /** Redraws while a session runs or a hovered tab may scroll its title. */
  #tick(on: boolean): void {
    on = !this.#quitting && (on || (this.#hover !== null && this.#hover >= 0));
    if (on && !this.#ticker) {
      this.#ticker = setInterval(() => this.#scheduleRender(), TICK_MS);
    } else if (!on && this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  #scheduleRender(): void {
    if (this.#renderQueued || this.#quitting) return;
    this.#renderQueued = true;
    setTimeout(() => {
      this.#renderQueued = false;
      this.#render();
    }, 8);
  }

  #render(): void {
    const t0 = performance.now();
    const W = this.#term.cols;
    const H = this.#term.rows;
    const buf = this.#renderer.begin(W, H);
    this.#commandHits = [];
    this.#commandBounds = null;
    const s = this.#session;

    if (W < 24 || H < 10) {
      s.chat.resetInteractions();
      buf.text(0, 0, "terminal too small", { fg: palette.muted });
      this.#renderer.end();
      return;
    }

    const inner = W - PAD * 2;
    const promptWidth = stringWidth(PROMPT);
    this.#inputWidth = inner - promptWidth;
    const layout = s.editor.layout(this.#inputWidth);
    const approval = s.approvals[0];
    // A popup takes the input's place, its box where the two rules were.
    // Rows besides a prompt's preview: the question, why it asks, a gap, the answers.
    const asking = approval ? 1 + (approval.reason ? 1 : 0) + 1 + DECISIONS.length : 0;
    const room = H - (TAB_ROWS + 1) - 2 - (s.busy ? 1 : 0) - 1 - 2 - 1; // tab bar and gap, transcript, status gap, status, box edges, footer
    const preview = approval ? this.#previewRows(approval, Math.max(0, Math.min(MAX_PREVIEW_ROWS, room - asking))) : [];
    const models = approval ? null : this.#models;
    const picking = !approval && !models && this.#picker !== null;
    const inputRows = approval
      ? asking + preview.length
      : models
        ? models.height(Math.max(3, Math.min(MAX_MODEL_ROWS, room)))
        : picking
          ? 2 + MODES.length
          : Math.min(MAX_INPUT_ROWS, layout.rows.length);
    this.#popupRows = approval || models || picking ? inputRows + 2 : 0;

    const footerY = H - 1;
    const ruleBottomY = footerY - 1;
    const inputY = ruleBottomY - inputRows;
    const ruleTopY = inputY - 1;
    const statusY = ruleTopY - (s.busy ? METEOR_ROWS : 1); // a blank row when idle
    const bodyY = TAB_ROWS + 1; // below the tab bar and a blank row
    const bodyH = Math.max(1, statusY - bodyY - (s.busy ? 1 : 0)); // one blank row above the running status

    this.#tabHits = drawTabs(buf, PAD, 0, inner, this.#tabs(), this.#active, this.#dir, this.#hover, t0 - this.#hoverStarted, this.#colors);
    this.#drawBody(buf, { x: PAD, y: bodyY, w: inner, h: bodyH }, t0);
    if (s.busy) this.#drawStatus(buf, statusY, inner, t0);
    this.#choiceHits = [];
    if (approval) {
      const box = drawBox(buf, PAD, ruleTopY, inner, inputRows + 2, palette.tool, "Permission required", APPROVAL_HINTS);
      this.#drawApproval(buf, inputY, box, approval, preview);
    } else if (models) {
      const box = drawBox(buf, PAD, ruleTopY, inner, inputRows + 2, palette.accent, "Select model", MODEL_HINTS);
      this.#choiceHits = models.render(buf, box.x, inputY, box.w, inputRows);
      this.#renderer.cursor = { x: box.x + 2 + stringWidth(models.query), y: inputY, visible: true };
    } else if (picking) {
      const box = drawBox(buf, PAD, ruleTopY, inner, inputRows + 2, palette.accent, "Permissions", PICKER_HINTS);
      this.#drawPicker(buf, inputY, box);
    } else {
      buf.text(PAD, ruleTopY, "─".repeat(inner), { fg: palette.faint });
      this.#drawInput(buf, inputY, inputRows, layout, promptWidth);
      buf.text(PAD, ruleBottomY, "─".repeat(inner), { fg: palette.faint });
    }
    this.#drawFooter(buf, footerY, inner);
    if (this.#list) {
      s.chat.resetInteractions();
      this.#renderer.image = null;
      this.#list.render(buf, { x: PAD, y: bodyY, w: inner, h: H - bodyY - 1 }, this.#colors);
      this.#renderer.cursor = { x: 0, y: 0, visible: false };
    }
    this.#selection.highlight(buf);
    if (this.#syncCommands()) {
      const h = this.#commands.height(ruleTopY - TAB_ROWS);
      if (h) {
        const y = ruleTopY - h;
        this.#commandBounds = { x: PAD, y, w: inner, h };
        this.#commandHits = this.#commands.render(buf, PAD, y, inner, h);
        // The menu covers the status area; remove the pixel overlay beneath it.
        this.#renderer.image = null;
      }
    }

    const bytes = this.#renderer.end();
    this.#frame = { ms: performance.now() - t0, bytes };
  }

  #tabs(): TabInfo[] {
    return this.#sessions.map((s) => ({
      title: s.title,
      state: s.approvals.length ? "waiting" : s.busy ? "busy" : s.unread ? "unread" : "idle",
    }));
  }

  #previewRows(a: Approval, max: number): PreviewLine[] {
    const rows = previewFor(a.name, a.input);
    return rows.length > max ? [...rows.slice(0, max - 1), { text: `⋯ ${rows.length - max + 1} more lines`, kind: "gap" }] : rows;
  }

  #drawApproval(buf: CellBuffer, y: number, box: { x: number; w: number }, a: Approval, preview: PreviewLine[]): void {
    const waiting = this.#session.approvals.length;
    const who = a.subagent ? `subagent ${a.subagent} wants` : "sope wants";
    const left = box.x;
    const end = box.x + box.w;
    let x = buf.text(left, y, `${who} to run `);
    x = buf.text(x, y, a.name, { fg: palette.tool, bold: true });
    if (waiting > 1) buf.text(x, y, `  (+${waiting - 1} more waiting)`, { fg: palette.faint });

    // Diff lines: line number, +/- on a tinted row, highlighted code.
    const numWidth = Math.max(0, ...preview.map((l) => (l.no ? String(l.no).length : 0)));
    const code = preview.find((l) => l.lang)?.lang;
    const hl = code ? new Highlighter(code) : null;
    const marks = { add: "+", remove: "-", context: " ", command: "$", gap: " ", plain: " " } as const;
    preview.forEach((line, i) => {
      const ry = y + 1 + i;
      const kind = line.kind ?? "plain";
      const tint = kind === "add" ? this.#colors.added : kind === "remove" ? this.#colors.removed : undefined;
      if (tint !== undefined) buf.fill(left + 2, ry, box.w - 2, 1, { bg: tint });
      let x = left + 2;
      if (numWidth) x = buf.text(x, ry, `${line.no ? String(line.no).padStart(numWidth) : " ".repeat(numWidth)} `, { fg: palette.faint, bg: tint });
      x = buf.text(x, ry, `${marks[kind]} `, { fg: previewColor(line.kind), bg: tint, bold: kind === "add" || kind === "remove" });
      const text = line.text.replace(/\t/g, "  ");
      if (kind === "gap" || kind === "plain") return void buf.text(x, ry, truncate(text, end - x), { fg: palette.muted });
      if (!hl || !line.lang) return void buf.text(x, ry, truncate(text, end - x), { bg: tint });
      // Removed and added lines are both highlighted by the same pass; good enough for a preview.
      for (const tok of hl.line(text)) {
        if (x >= end) break;
        x = buf.text(x, ry, tok.text, { fg: SYNTAX[tok.kind], bg: tint, italic: tok.kind === "comment", dim: kind === "remove" && tok.kind === "plain" }, end);
      }
    });

    let ry = y + 1 + preview.length;
    if (a.reason) buf.text(left, ry++, truncate(`Approve for me asks because ${a.reason}.`, box.w), { fg: palette.muted });
    const what = ({ bash: "commands", web_fetch: "web fetches", edit: "file edits", write: "writing files" } as Record<string, string>)[a.name] ?? a.name;
    const choices: Choice[] = [
      { label: "Yes" },
      { label: `Yes, and don't ask again for ${what} in this session` },
      { label: "No", detail: "sope is told and tries another way" },
      { label: "No, and stop", detail: "ends the turn" },
    ];
    this.#choiceHits = drawChoices(buf, left, ry + 1, box.w, choices, this.#selectedAnswer());
    this.#renderer.cursor = { x: 0, y: 0, visible: false };
  }

  /** The permission modes to choose from. */
  #drawPicker(buf: CellBuffer, y: number, box: { x: number; w: number }): void {
    buf.text(box.x, y, truncate("Who approves edits, shell commands and web fetches?", box.w), { fg: palette.muted });
    const choices: Choice[] = MODES.map((m) => ({ label: m.id === this.#mode ? `${m.label} ✓` : m.label, detail: m.description }));
    this.#choiceHits = drawChoices(buf, box.x, y + 2, box.w, choices, this.#picker ?? 0, true);
    this.#renderer.cursor = { x: 0, y: 0, visible: false };
  }

  #drawBody(buf: CellBuffer, r: { x: number; y: number; w: number; h: number }, now: number): void {
    const { chat, trace } = this.#session;
    const spin = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length]!;
    if (!this.#showTrace) return chat.render(buf, r, spin);

    const stats = `${trace.count} · ${this.#frame.ms.toFixed(1)}ms ${this.#frame.bytes}B`;
    if (r.w >= 100) {
      const traceW = Math.min(64, Math.floor(r.w * 0.42));
      const chatW = r.w - traceW - 3;
      chat.render(buf, { ...r, w: chatW }, spin);
      for (let y = r.y; y < r.y + r.h; y++) buf.text(r.x + chatW + 1, y, "│", { fg: palette.faint });
      trace.render(buf, { x: r.x + chatW + 3, y: r.y, w: traceW, h: r.h }, stats);
    } else {
      const traceH = Math.max(3, Math.floor(r.h * 0.45));
      const chatH = r.h - traceH - 1;
      chat.render(buf, { ...r, h: chatH }, spin);
      buf.text(r.x, r.y + chatH, "┄".repeat(r.w), { fg: palette.faint });
      trace.render(buf, { x: r.x, y: r.y + chatH + 1, w: r.w, h: traceH }, stats);
    }
  }

  #drawStatus(buf: CellBuffer, y: number, inner: number, now: number): void {
    const s = this.#session;
    const elapsedMs = now - s.turnStarted;
    const activity = s.activity();
    const pixel = this.#term.graphics.supported;
    if (pixel) this.#renderer.image = pixelMeteor(PAD, y, activity.color, now);
    drawStatus(buf, PAD, y, inner, { ...activity, elapsedMs, rate: s.rate.rate(now), tip: tipAt(elapsedMs, s.turnCount) }, now, pixel);
  }

  #drawInput(buf: CellBuffer, y: number, rows: number, layout: ReturnType<Editor["layout"]>, promptWidth: number): void {
    const editor = this.#session.editor;
    const x = PAD + promptWidth;
    buf.text(PAD, y, PROMPT, { fg: palette.accent, bold: true });

    if (!editor.text) {
      const placeholder = this.#session.provider === "mock" ? "Message sope…  try !echo hi, !agent a | b, or /help" : "Message sope…  /help for commands";
      buf.text(x, y, placeholder, { fg: palette.faint });
    } else {
      const scroll = Math.max(0, layout.cursorRow - rows + 1);
      for (let i = 0; i < rows; i++) {
        const row = layout.rows[scroll + i];
        if (row) buf.text(x, y + i, editor.text.slice(row.start, row.end), {}, x + this.#inputWidth);
      }
      layout.cursorRow -= scroll;
    }
    // The real cursor sits in the input so IME candidate windows appear in the right place.
    this.#renderer.cursor = { x: x + layout.cursorCol, y: y + layout.cursorRow, visible: true };
  }

  /** The permission mode, then a notice when there is one. */
  #drawFooter(buf: CellBuffer, y: number, inner: number): void {
    const end = PAD + inner;
    const left = PAD + 2;
    let x = buf.text(left, y, `${MODE_ICON[this.#mode]} `, { fg: MODE_COLOR[this.#mode] }, end);
    x = buf.text(x, y, modeLabel(this.#mode), { fg: MODE_COLOR[this.#mode] }, end);
    this.#modeHit = { x0: left, x1: x };
    if (this.#notice) buf.text(x + 2, y, truncate(this.#notice, end - x - 2), { fg: palette.tool });
  }
}
