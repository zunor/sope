// SPDX-License-Identifier: MIT
// The sope TUI: wires the terminal, input decoding and the sessions together,
// and lays out each frame. Each tab is a session (session.ts) with its own
// agent; input and commands go to the one on screen. Sessions are saved
// per directory (store.ts); the most recent few come back as tabs on start
// (workspace.ts), and ⋯ (or /sessions) lists them all.
//
//     explain thread pools     fix grep ×    +             ~/src/app  ⋯
//
//   › user message
//
//   ✻ Thought for 2.1s
//   ● assistant reply …
//   ◆ agent · general-purpose  explain thread pools          12s · 7 tools
//                                    (one row; a click shows its calls and report)
//
//   ⠉⠉ Thinking… (1m 4s · 38 tok/s)        ╭─────────────────────────╮
//      tip: …                              ╰ 2 files changed +42 -7 ─╯
//                   (while a turn runs: a meteor circles a one-row square;
//                    the files the turn changed, which the transcript keeps
//                    when it ends: a click opens their diff on the right of
//                    the screen, ui/changes.ts)
//   ──────────────────────────────────────────────────────────────────────
//   › input                         (or a popup in its place: the permission
//   ───────────────────────────────  prompt, the permission modes, the models,
//                                    the search bar; see ui/popup.ts)
//     ◈ Approve for me · ⠋ 2 agents · ◑ 1 shell   (what runs in the background,
//                       then short notices: ui/tasks.ts)            glm-5.3 · 42.1k / 200k
//
// What a popup, the session list, a command or the editor does with a key
// is theirs to decide; the app routes input, owns the layout and the state
// shared by every tab (the permission mode, the panels shown).

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { SopeEvent } from "sope";
import { effortLabel, type Effort } from "./agent/effort";
import { clipboardImage, describeImage, imageRefs, pastedImagePath, readImageFile, type ImageFile } from "./agent/images";
import { listModels, type ModelInfo } from "./agent/models";
import { MODES, modeLabel, type PermissionMode } from "./agent/permissions";
import { COMMANDS, runCommand, type CommandHost } from "./commands";
import type { Config } from "./config";
import { INVERSE, type CellBuffer } from "./render/buffer";
import { parseOscColor } from "./render/color";
import { Renderer } from "./render/renderer";
import { FrameScheduler } from "./render/scheduler";
import { InputParser, keyId, type InputEvent, type MouseEvent as MouseInput } from "./term/input";
import { Terminal } from "./term/terminal";
import { Session } from "./session";
import { Store, type StoredSession } from "./store";
import { palette, SPINNER, SPINNER_MS, surfaces, type Surfaces } from "./theme";
import { ApprovalPrompt } from "./ui/approval";
import type { ChangeSet } from "./agent/changes";
import { ChangesPanel, drawChangeSummary, type Graphics } from "./ui/changes";
import { CommandSuggestions } from "./ui/commands";
import { formatTokens } from "./ui/context";
import { EffortPicker } from "./ui/effort";
import type { Editor, EditorLayout } from "./ui/editor";
import { METEOR_ROWS } from "./ui/meteor";
import { ModePicker } from "./ui/modes";
import { ModelPicker } from "./ui/models";
import { pixelMeteor } from "./ui/pixel-meteor";
import { drawBox, step, type ChoiceHit, type Popup } from "./ui/popup";
import { SearchBar } from "./ui/search";
import { copyToClipboard, Selection } from "./ui/selection";
import { SessionList } from "./ui/sessions";
import { drawStatus, drawTip, tipAt } from "./ui/status";
import { ALL_SESSIONS, drawTabs, NEW_TAB, TAB_ROWS, type TabHit, type TabInfo } from "./ui/tabs";
import { drawTaskSummary, TaskPanel } from "./ui/tasks";
import { stringWidth, truncate } from "./unicode/width";
import { Workspace } from "./workspace";

const PAD = 1;
const PROMPT = "› ";
const MAX_INPUT_ROWS = 8;
const ESC_TIMEOUT_MS = 25;
const TICK_MS = 50; // animation frame rate while anything runs
const SHELL_TICK_MS = 1000; // while only background shells run: notice when they exit
const MAX_TABS = 5; // sessions shown as tabs; the rest are a click on ⋯ away

const MODE_COLOR: Record<PermissionMode, number> = { ask: palette.muted, auto: 0xfacc15, full: palette.error };
const MODE_ICON: Record<PermissionMode, string> = { ask: "◇", auto: "◈", full: "◆" };

export interface AppOptions {
  config: Config;
  /** Sent as the first message. */
  prompt?: string;
  /** Attached to the first message (--image). */
  images?: ImageFile[];
}

interface InputHit {
  x: number;
  y: number;
  w: number;
  h: number;
  textX: number;
  editor: Editor;
  rows: EditorLayout["rows"];
}

/** The background from $COLORFGBG ("fg;bg", set by some terminals) until the terminal answers the OSC 11 query. */
function guessBackground(env = process.env): number | null {
  const bg = Number(env.COLORFGBG?.split(";").at(-1));
  if (!Number.isInteger(bg)) return null;
  return bg === 7 || bg === 15 ? 0xffffff : 0x000000;
}

export class App {
  #term = new Terminal();
  #renderer = new Renderer((s) => this.#term.write(s), this.#term.truecolor, this.#term.graphics);
  #frames = new FrameScheduler(() => this.#render(), () => this.#term.writable);
  #parser = new InputParser();
  #selection = new Selection();
  #notice: string | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #config: Config;
  #mode: PermissionMode; // shared by every session
  #initialPrompt?: string;
  #initialImages: ImageFile[];
  #dir = process.cwd().replace(homedir(), "~");
  #tabs: Workspace;
  #colors: Surfaces = surfaces(guessBackground());

  // Popups: the permission prompt of the session on screen takes the input's
  // place while it waits; otherwise the one the user opened (modes, models).
  #approval = new ApprovalPrompt(() => this.#session);
  #popup: Popup | null = null;
  #popupRows = 0; // rows the popup on screen takes, its edges included
  #choiceHits: ChoiceHit[] = [];
  #modelList: Promise<ModelInfo[]> | null = null; // the endpoint's models, asked for once
  #models: ModelInfo[] = []; // what it said: each session's context window
  #list: SessionList | null = null; // the session list, while open
  #commands = new CommandSuggestions(COMMANDS);
  #commandHits: ChoiceHit[] = [];
  #commandBounds: { x: number; y: number; w: number; h: number } | null = null;

  #tabHits: TabHit[] = [];
  #hoverStarted = 0;
  #hover: number | null = null; // tab bar item under the pointer
  #modeHit = { x0: 0, x1: 0 }; // the mode in the footer: a click opens the popup
  #tasksHit: { x0: number; x1: number } | null = null; // the task summary in the footer: a click opens the panel
  #changesHit: { x0: number; x1: number; y0: number; y1: number } | null = null; // the change summary's box: a click opens the diff
  #changesLit = false; // the pointer is on it
  #changes: ChangesPanel | null = null; // the diff panel, while open: the right of the screen

  #showThinking = false;
  #showTrace = false;
  #inputWidth = 40;
  #inputScroll = 0;
  #inputHit: InputHit | null = null;
  #inputDrag: InputHit | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #tickInterval = 0;
  #escTimer: ReturnType<typeof setTimeout> | null = null;
  #frame = { ms: 0, bytes: 0 };
  #quitting = false;

  constructor({ config, prompt, images = [] }: AppOptions) {
    this.#config = config;
    this.#mode = config.permissions;
    this.#initialPrompt = prompt;
    this.#initialImages = images;
    this.#term.setMouse(config.mouse);

    const { store, error } = Store.open();
    this.#tabs = new Workspace(store, realpathSync(process.cwd()), MAX_TABS, (stored) => this.#makeSession(stored));
    if (!this.#tabs.restore(prompt ? MAX_TABS - 1 : MAX_TABS) || prompt) this.#newSession();
    this.#switched();
    if (error) this.#session.chat.add({ role: "error", text: `sessions will not be saved: ${error}` });
  }

  get #session(): Session {
    return this.#tabs.current;
  }

  /** The popup on screen, if any. */
  get #docked(): Popup | null {
    return this.#session.approvals.length ? this.#approval : this.#popup;
  }

  start(): void {
    void this.#fetchModels().catch(() => {}); // the model popup asks again and shows the error
    this.#term.onInput((data) => this.#onInput(data));
    this.#term.onDrain(() => this.#frames.resume());
    this.#term.enter();
    this.#term.onResize(() => {
      this.#inputDrag = null;
      this.#selection.clear();
      this.#renderer.invalidate();
      this.#scheduleRender();
    });
    if (this.#initialPrompt) {
      const numbers = this.#initialImages.map((img) => this.#session.addImage(img));
      this.#send([this.#initialPrompt, ...numbers.map((n) => `[Image #${n}]`)].join(" "));
    }
    this.#scheduleRender();
  }

  /** Puts the terminal back to normal; safe to call from crash handlers. */
  restoreTerminal(): void {
    this.#frames.stop();
    this.#term.leave();
  }

  async quit(): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.#frames.stop();
    this.#tick(false);
    await Promise.all(this.#tabs.sessions.map((s) => s.shutdown()));
    this.#tabs.store?.close();
    this.#term.leave();
    process.exit(0);
  }

  // ---- sessions -------------------------------------------------------

  #makeSession(stored?: StoredSession): Session {
    const store = this.#tabs.store;
    const persist = store ? { store, directory: this.#tabs.directory, stored } : undefined;
    const s = new Session(this.#config, () => this.#mode, (session, events) => this.#onSessionEvents(session, events), persist);
    s.chat.showThinking = this.#showThinking;
    this.#sizeContext(s);
    return s;
  }

  #newSession(): void {
    const s = this.#tabs.add();
    const c = this.#config;
    const hint = c.provider === "mock" && !c.apiKey ? " · set SOPE_API_KEY (or .env) to talk to a real model" : "";
    const full = this.#mode === "full" ? " · Full access: edits and commands run without asking" : "";
    s.chat.add({ role: "info", text: `/help for commands${hint}${full}` });
    this.#switched();
  }

  #switchTo(index: number): void {
    if (this.#tabs.switchTo(index)) this.#switched();
  }

  #openSession(id: string): void {
    if (!this.#tabs.open(id)) return this.#flash("that session is gone");
    this.#switched();
  }

  #closeSession(index?: number): void {
    if (!this.#tabs.close(index)) return;
    this.#setHover(null);
    if (!this.#tabs.sessions.length) return this.#newSession();
    this.#switched();
  }

  /** Another session is on screen: what pointed into the last one goes. */
  #switched(): void {
    if (this.#popup instanceof SearchBar) {
      this.#popup.chat.endSearch(false); // a search belongs to the session it began in
      this.#popup = null;
    }
    this.#session.chat.resetInteractions();
    this.#commands = new CommandSuggestions(COMMANDS);
    this.#commandHits = [];
    this.#commandBounds = null;
    this.#selection.clear();
    this.#inputHit = null;
    this.#inputDrag = null;
    this.#inputScroll = 0;
    this.#session.editor.clearSelection();
  }

  #openList(): void {
    this.#list = new SessionList(this.#tabs.summaries(), this.#dir, (id) => this.#openSession(id));
  }

  #onSessionEvents(session: Session, events: SopeEvent[]): void {
    if (session !== this.#session) {
      if (events.some((ev) => ev.type === "turn_end" && !ev.agentId)) session.unread = true;
      if (events.some((ev) => ev.type === "permission") && session.approvals.length) {
        this.#flash(`“${session.title}” is waiting for your approval (alt+${this.#tabs.sessions.indexOf(session) + 1})`, 4000);
      }
    }
    this.#tick(this.#busy);
    this.#scheduleRender();
  }

  get #busy(): boolean {
    return this.#tabs.sessions.some((s) => s.busy);
  }

  // ---- what commands act on (commands.ts) -----------------------------

  #host: CommandHost = ((app: App): CommandHost => ({
    get session() {
      return app.#session;
    },
    newSession: () => app.#newSession(),
    closeSession: () => app.#closeSession(),
    openSessions: () => app.#openList(),
    openModels: () => app.#openModels(),
    useModel: (id) => app.#useModel(id),
    openModes: () => (app.#popup = app.#modePicker()),
    openEffort: () => (app.#popup = app.#effortPicker()),
    openSearch: (query) => app.#openSearch(query),
    openTasks: () => app.#openTasks(),
    setEffort: (effort) => app.#setEffort(effort),
    setMode: (mode) => app.#setMode(mode),
    toggleThinking: () => {
      app.#showThinking = !app.#showThinking;
      for (const s of app.#tabs.sessions) s.chat.showThinking = app.#showThinking;
      return app.#showThinking;
    },
    toggleTrace: () => (app.#showTrace = !app.#showTrace),
    toggleChanges: () => app.#toggleChanges(),
    toggleMouse: () => {
      app.#term.setMouse(!app.#term.mouse);
      return app.#term.mouse;
    },
    quit: () => void app.quit(),
  }))(this);

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
    if (ev.type === "cell-size") {
      this.#term.cellSize = { width: ev.width, height: ev.height };
      return;
    }
    if (ev.type === "apc") return this.#term.graphics.reply(ev.data);
    if (ev.type === "osc") return this.#handleOsc(ev.data);
    if (ev.type === "mouse") return this.#handleMouse(ev);
    this.#inputDrag = null;
    this.#selection.clear();
    if (this.#list) {
      if (ev.type !== "key") return this.#list.type(ev.text);
      if (this.#list.key(keyId(ev)) === "close") this.#list = null;
      return;
    }
    const popup = this.#docked;
    if (popup && ev.type !== "key") {
      // The input box is hidden while a popup is up: typing is the popup's, or a key.
      if (popup.type) {
        if (popup.type(ev.text) === "close" && popup === this.#popup) this.#popup = null;
      } else if (ev.type === "text" && [...ev.text].length === 1) this.#handleKey(ev.text);
      return;
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

  #handleKey(id: string): void {
    if (id === "shift+tab") return this.#cycleMode();
    const popup = this.#docked;
    if (popup) {
      const reply = popup.key(id);
      if (reply === "close" && popup === this.#popup) this.#popup = null;
      if (reply !== "ignored") return;
    }
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
      case "ctrl+v":
        this.#flash("reading the clipboard…");
        void clipboardImage()
          .then((img) => (img ? this.#insertImage(img) : this.#flash("no image on the clipboard (paste text with your terminal's paste)", 4000)))
          .catch((err: Error) => this.#flash(err.message, 4000))
          .finally(() => this.#scheduleRender());
        return;
      case "ctrl+c":
        if (e.selection) return void this.#copyInputSelection();
        if (s.busy) return s.cancel();
        if (e.text) return e.clear();
        void this.quit();
        return;
      case "super+c":
      case "ctrl+shift+c":
        return void this.#copyInputSelection();
      case "ctrl+d":
        if (!e.text) void this.quit();
        else e.deleteForward();
        return;
      case "escape":
        if (e.selection) return e.clearSelection();
        if (this.#changes) this.#changes = null; // the diff panel first, then the turn
        else if (s.busy) s.cancel();
        return;
      case "ctrl+t":
      case "f2":
        this.#showTrace = !this.#showTrace;
        return;
      case "ctrl+l":
        return this.#renderer.invalidate();
      case "ctrl+f":
      case "super+f": // cmd+f, when the terminal passes it on (Ghostty: keybind = super+f=unbind)
        return this.#openSearch();
      case "down":
        // Below an empty input there is nothing to move to but the tasks.
        if (!e.text && !e.browsingHistory && (s.agents.length || s.shells().length)) return this.#openTasks();
        break;
      case "pageup":
        return s.chat.scrollBy(s.chat.pageSize);
      case "pagedown":
        return s.chat.scrollBy(-s.chat.pageSize);
    }
    e.key(id, this.#inputWidth);
  }

  #tabAt(x: number, y: number): TabHit | undefined {
    return this.#tabHits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1);
  }

  #setHover(index: number | null): void {
    if (index === this.#hover) return;
    this.#hover = index;
    this.#hoverStarted = performance.now();
    this.#tick(this.#busy);
  }

  #handleMouse(ev: MouseInput): void {
    const p = { x: ev.x, y: ev.y };
    // An input drag owns motion/release even outside the box. Its saved rows
    // keep endpoints stable while the cursor moves or a command menu closes.
    if (this.#inputDrag && !this.#list && !this.#docked) {
      if ((ev.action === "drag" || ev.action === "release") && ev.button === 0) {
        this.#moveInputPointer(this.#inputDrag, ev.x, ev.y, true);
        if (ev.action === "release") {
          this.#inputDrag = null;
          this.#copyInputSelection();
        }
        return;
      }
    }
    if (ev.action === "press" && ev.button === 0) {
      this.#inputDrag = null;
      this.#session.editor.clearSelection();
      const hit = this.#inputHit;
      if (!this.#list && !this.#docked && hit && hit.editor === this.#session.editor && ev.x >= hit.x && ev.x < hit.x + hit.w && ev.y >= hit.y && ev.y < hit.y + hit.h) {
        this.#selection.clear();
        this.#inputDrag = hit;
        this.#moveInputPointer(hit, ev.x, ev.y, false);
        return;
      }
    }
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
    const popup = this.#docked;
    const choice = this.#choiceHits.find((h) => h.y === ev.y && ev.x >= h.x0 && ev.x < h.x1);
    if (popup && choice && (ev.action === "move" || (ev.action === "press" && ev.button === 0))) {
      if (popup.click) {
        if (ev.action === "press") popup.click(choice.index);
        return;
      }
      popup.select(choice.index);
      if (ev.action === "press") this.#handleKey("enter");
      return;
    }
    // A horizontal report belongs only to the diagram under the pointer.
    // Never reinterpret a diagonal trackpad gesture as vertical motion.
    if (ev.action === "wheel-left" || ev.action === "wheel-right") {
      if (!this.#list && !this.#docked && !this.#inputDrag && !this.#changes?.contains(ev.x, ev.y)
        && this.#session.chat.scrollDiagramAt(ev.x, ev.y, (ev.action === "wheel-left" ? -1 : 1) * this.#config.scrollSpeed)) this.#selection.clear();
      return;
    }
    const summary = this.#changesHit;
    this.#changesLit = !!summary && ev.y >= summary.y0 && ev.y < summary.y1 && ev.x >= summary.x0 && ev.x < summary.x1;
    if (this.#changesLit && ev.action === "press" && ev.button === 0) return void this.#toggleChanges(this.#session.changes);
    const tasks = this.#tasksHit;
    if (ev.action === "press" && ev.button === 0 && tasks && ev.y === this.#term.rows - 1 && ev.x >= tasks.x0 && ev.x < tasks.x1) return this.#openTasks();
    if (ev.action === "press" && ev.button === 0 && ev.y === this.#term.rows - 1 && ev.x >= this.#modeHit.x0 && ev.x < this.#modeHit.x1) {
      this.#popup = this.#popup instanceof ModePicker ? null : this.#modePicker();
      return;
    }
    // All pointer motion updates hover, just as it does for tabs. Selection
    // still handles drag separately; a motion event must not clear hover.
    this.#session.chat.hover(p);
    switch (ev.action) {
      case "move":
        return;
      case "wheel-up":
      case "wheel-down": {
        const by = ev.action === "wheel-up" ? -1 : 1;
        if (this.#changes?.contains(ev.x, ev.y)) return this.#changes.wheel(ev.y, by, this.#config.scrollSpeed);
        if (popup?.wheel && ev.y >= this.#term.rows - 1 - this.#popupRows) return popup.wheel(by);
        this.#selection.clear(); // it is in screen cells: the text under it is about to move
        if (ev.shift && this.#session.chat.scrollDiagramAt(ev.x, ev.y, by * this.#config.scrollSpeed)) return;
        return this.#session.chat.scrollBy(-this.#config.scrollSpeed * by);
      }
      case "press": {
        if (ev.button !== 0) return;
        const hit = this.#tabAt(ev.x, ev.y);
        if (hit) {
          if (hit.index === NEW_TAB) return this.#newSession();
          if (hit.index === ALL_SESSIONS) return this.#openList();
          return hit.close ? this.#closeSession(hit.index) : this.#switchTo(hit.index);
        }
        const panel = this.#changes?.contains(ev.x, ev.y) ? this.#changes.click(ev.x, ev.y) : null;
        if (panel) {
          if (panel === "close") this.#changes = null;
          return;
        }
        const card = this.#session.chat.changesAt(ev.x, ev.y);
        if (card) return void this.#toggleChanges(card);
        if (this.#session.chat.toggleAt(ev.x, ev.y)) {
          this.#selection.clear();
          return;
        }
        this.#selection.press(p, this.#session.chat.selectionBoundsAt(p.x, p.y));
        return;
      }
      case "drag":
        return this.#selection.drag(p);
      case "release":
        if (this.#selection.release(p)) this.#copySelection();
        return;
    }
  }

  #moveInputPointer(hit: InputHit, x: number, y: number, extend: boolean): void {
    const row = hit.rows[Math.max(0, Math.min(hit.rows.length - 1, y - hit.y))];
    const column = y < hit.y ? 0 : y >= hit.y + hit.h ? Infinity : x - hit.textX;
    if (row) hit.editor.moveToCell(row, column, extend);
  }

  #handleListMouse(ev: MouseInput): void {
    const list = this.#list!;
    if (ev.action === "wheel-up" || ev.action === "wheel-down") return list.move((ev.action === "wheel-up" ? -1 : 1) * this.#config.scrollSpeed);
    if (ev.action !== "press" || ev.button !== 0) return;
    // ⋯ again closes it.
    if (this.#tabAt(ev.x, ev.y)?.index === ALL_SESSIONS || list.click(ev.x, ev.y) === "close") this.#list = null;
  }

  #copySelection(): void {
    const screen = this.#renderer.screen;
    const text = screen ? this.#selection.text(screen) : "";
    if (!text.trim()) return;
    this.#copyText(text);
  }

  #copyInputSelection(): void {
    const editor = this.#session.editor;
    const range = editor.selection;
    // Read the buffer, not rendered rows: preserve whitespace and hard newlines,
    // omit soft wraps, and leave the selection available for further editing.
    if (range) this.#copyText(editor.text.slice(...range));
  }

  #copyText(text: string): void {
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

  // ---- the composer ---------------------------------------------------

  /** Whether the command menu is up (it follows the input). */
  #syncCommands(): boolean {
    if (this.#list || this.#docked) return false;
    const editor = this.#session.editor;
    if (editor.selection) return false;
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

  #submit(): void {
    const s = this.#session;
    const text = s.editor.text.trim();
    if (!text) return;
    s.editor.submit();
    s.chat.scrollToBottom();
    if (!text.startsWith("/")) return this.#send(text);
    runCommand(this.#host, text);
    this.#tick(this.#busy); // /compact starts a turn
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

  /** /diff, a click on the change summary: the diff panel on the right of the transcript. */
  #toggleChanges(changes?: ChangeSet): boolean {
    const s = this.#session;
    // /diff: the running turn's, else the last turn that changed files.
    changes ??= s.busy ? s.changes : (s.chat.messages.findLast((m) => m.changes)?.changes ?? s.changes);
    const showing = this.#changes?.changes() === changes;
    this.#changes = showing ? null : new ChangesPanel(() => changes);
    return !!this.#changes;
  }

  /** ↓, /tasks, a click on the footer's task summary: the task panel takes the input's place. */
  #openTasks(): void {
    if (this.#popup instanceof SearchBar) this.#popup.chat.endSearch(false);
    this.#popup = new TaskPanel(() => this.#session, (text) => this.#flash(text, 3000));
  }

  /** ctrl+f, /find: the search bar takes the input's place; ctrl+f in it edits the query. */
  #openSearch(query = ""): void {
    if (this.#popup instanceof SearchBar) this.#popup.chat.endSearch(false);
    this.#popup = new SearchBar(this.#session.chat, query);
  }

  // ---- permission modes and models ------------------------------------

  #modePicker(): ModePicker {
    return new ModePicker(
      () => this.#mode,
      (mode) => this.#setMode(mode),
    );
  }

  #setMode(mode: PermissionMode): void {
    this.#mode = mode;
    for (const s of this.#tabs.sessions) s.recheck(); // waiting requests the new mode allows go ahead
    this.#flash(MODES.find((x) => x.id === mode)!.description, 3000); // the footer names the mode already
  }

  /** shift+tab: ask → auto → full → ask. */
  #cycleMode(): void {
    const i = MODES.findIndex((m) => m.id === this.#mode);
    this.#setMode(MODES[step(i, 1, MODES.length)]!.id);
    if (this.#popup instanceof ModePicker) this.#popup.follow();
  }

  #openModels(): void {
    const picker = new ModelPicker(this.#session.model, this.#tabs.store?.recentModels() ?? [], (id) => this.#useModel(id));
    this.#popup = picker;
    this.#fetchModels()
      .then((models) => picker.setModels(models))
      .catch((err: Error) => {
        this.#modelList = null; // ask again next time
        picker.setError(err.message);
      })
      .finally(() => this.#scheduleRender());
  }

  #effortPicker(): EffortPicker {
    const s = this.#session;
    return new EffortPicker(s.effort, s.model, (effort) => this.#setEffort(effort));
  }

  /** Sets this session's reasoning effort and makes it the one new sessions start with. */
  #setEffort(effort: Effort): void {
    const s = this.#session;
    this.#config.effort = effort; // sessions already open keep theirs
    if (effort === s.effort) return this.#flash(`already on ${effort ? effortLabel(effort).toLowerCase() : "the model's default"} effort`);
    s.setEffort(effort);
    s.chat.add({ role: "info", text: `effort = ${effort ? effortLabel(effort).toLowerCase() : "default: the model decides"} (from the next turn)` });
  }

  /** The endpoint's models, asked for once (again after a failure). */
  #fetchModels(): Promise<ModelInfo[]> {
    this.#modelList ??= listModels(this.#config).then(
      (models) => {
        this.#models = models;
        for (const s of this.#tabs.sessions) this.#sizeContext(s);
        this.#scheduleRender();
        return models;
      },
      (err: Error) => {
        this.#modelList = null;
        throw err;
      },
    );
    return this.#modelList;
  }

  /** Gives a session its model's window, which sizes automatic compaction. */
  #sizeContext(s: Session): void {
    s.setModelWindow(this.#models.find((m) => m.id === s.model)?.context ?? 0);
  }

  /** Switches this session's model and makes it the one new sessions start with. */
  #useModel(id: string): void {
    const s = this.#session;
    const store = this.#tabs.store;
    this.#config.model = id; // sessions already open keep theirs
    if (s.model && s.model !== id) store?.usedModel(s.model, Date.now() - 1); // so it is in Recent to go back to
    store?.usedModel(id);
    if (id === s.model) return this.#flash(`already on ${id}`);
    s.setOption("model", id);
    this.#sizeContext(s);
    s.chat.add({ role: "info", text: `model = ${id} (from the next turn)` });
  }

  // ---- rendering ------------------------------------------------------

  /** Slow border breathing only keeps the timer alive while its bubble is visible. */
  #tick(on: boolean): void {
    const fast = on || (this.#hover !== null && this.#hover >= 0);
    const shells = this.#tabs.sessions.some((s) => s.shells().some((sh) => sh.running));
    const interval = this.#quitting ? 0 : fast ? TICK_MS : this.#session.chat.hasVisibleAnimation ? 100 : shells ? SHELL_TICK_MS : 0;
    if (interval === this.#tickInterval) return;
    if (this.#ticker) clearInterval(this.#ticker);
    this.#tickInterval = interval;
    this.#ticker = interval ? setInterval(() => this.#scheduleRender(), interval) : null;
  }

  #scheduleRender(): void {
    if (!this.#quitting) this.#frames.request();
  }

  #render(): void {
    const t0 = performance.now();
    const cols = this.#term.cols;
    const H = this.#term.rows;
    const buf = this.#renderer.begin(cols, H);
    this.#commandHits = [];
    this.#commandBounds = null;
    this.#changesHit = null;
    this.#inputHit = null;
    const s = this.#session;

    // The diff panel takes the right half and everything else fits in the left;
    // on a narrow terminal it takes the whole screen.
    const panelW = this.#changes ? (cols >= 80 ? Math.floor(cols / 2) : cols) : 0;
    const W = cols - panelW;
    if (this.#changes && W < 24) {
      s.chat.resetInteractions();
      this.#renderer.image = null;
      this.#renderer.cursor = { x: 0, y: 0, visible: false };
      this.#changes.render(buf, { x: PAD, y: 1, w: cols - 2 * PAD, h: H - 2 }, this.#colors);
      this.#renderer.end();
      this.#tick(this.#busy);
      return;
    }
    if (this.#changes) {
      for (let y = 0; y < H; y++) buf.text(W, y, "│", { fg: palette.faint });
      this.#changes.render(buf, { x: W + 2, y: 1, w: panelW - 2 - PAD, h: H - 2 }, this.#colors);
    }

    if (W < 24 || H < 10) {
      s.chat.resetInteractions();
      this.#tick(this.#busy);
      buf.text(0, 0, "terminal too small", { fg: palette.muted });
      this.#renderer.end();
      return;
    }

    const inner = W - PAD * 2;
    const promptWidth = stringWidth(PROMPT);
    this.#inputWidth = inner - 4 - promptWidth;
    const layout = s.editor.layout(this.#inputWidth);
    // A popup takes the input's place, its box where the two rules were.
    const popup = this.#docked;
    if (popup || this.#list) this.#inputDrag = null;
    // Between the transcript and the input: a blank row, then while a turn
    // runs the status and the tip below it, its change summary beside both.
    const band = s.busy ? 1 + METEOR_ROWS + 1 : 1;
    const bodyY = TAB_ROWS + 1; // one blank row between the tab bar and the content
    const room = H - bodyY - 2 - band - 2 - 1; // header, transcript, band, box edges, footer
    const inputRows = popup ? popup.height(room) : this.#inputDrag?.h ?? Math.max(1, Math.min(MAX_INPUT_ROWS, room, layout.rows.length));
    this.#popupRows = popup ? inputRows + 2 : 0;

    const footerY = H - 1;
    const ruleBottomY = footerY - 1;
    const inputY = ruleBottomY - inputRows;
    const ruleTopY = inputY - 1;
    const bandY = ruleTopY - band;
    const statusY = bandY + 1;
    const bodyH = Math.max(1, bandY - bodyY); // the band starts with a blank row

    const tabGraphics = this.#term.graphics.supported && this.#term.cellSize
      ? { cell: this.#term.cellSize, images: this.#renderer.images } : undefined;
    this.#tabHits = drawTabs(buf, PAD, 0, inner, this.#tabInfo(), this.#tabs.active, this.#dir, this.#hover, t0 - this.#hoverStarted, this.#colors, tabGraphics);
    this.#drawBody(buf, { x: PAD, y: bodyY, w: inner, h: bodyH }, t0, tabGraphics);
    if (s.busy) {
      // Its right edge over the input box's.
      const lit = this.#changesLit || this.#changes?.changes() === s.changes;
      this.#changesHit = drawChangeSummary(buf, PAD, PAD + inner, statusY, s.changes, lit, this.#colors, tabGraphics);
      this.#drawStatus(buf, statusY, this.#changesHit ? this.#changesHit.x0 - 2 - PAD : inner, t0);
    }
    this.#choiceHits = [];
    if (popup) {
      const box = drawBox(buf, PAD, ruleTopY, inner, inputRows + 2, popup.color, popup.title, popup.hints);
      const frame = popup.render(buf, box.x, inputY, box.w, inputRows, this.#colors);
      this.#choiceHits = frame.hits;
      this.#renderer.cursor = frame.cursor ? { ...frame.cursor, visible: true } : { x: 0, y: 0, visible: false };
    } else {
      drawBox(buf, PAD, ruleTopY, inner, inputRows + 2, palette.faint);
      this.#drawInput(buf, inputY, inputRows, layout, promptWidth);
    }
    this.#drawFooter(buf, footerY, inner, t0);
    if (this.#list) {
      s.chat.resetInteractions();
      this.#renderer.image = null;
      this.#list.render(buf, { x: PAD, y: bodyY, w: inner, h: H - bodyY - 1 }, this.#colors);
      this.#renderer.cursor = { x: 0, y: 0, visible: false };
    }
    this.#selection.validateBounds(p => s.chat.selectionBoundsAt(p.x, p.y));
    this.#selection.highlight(buf);
    if (this.#syncCommands()) {
      const h = this.#commands.height(ruleTopY - bodyY);
      if (h) {
        const y = ruleTopY - h;
        this.#commandBounds = { x: PAD, y, w: inner, h };
        this.#commandHits = this.#commands.render(buf, PAD, y, inner, h);
        // The menu covers the status area; remove the pixel overlay beneath it.
        this.#renderer.image = null;
      }
    }

    const bytes = this.#renderer.end();
    this.#tick(this.#busy);
    this.#frame = { ms: performance.now() - t0, bytes };
  }

  #tabInfo(): TabInfo[] {
    return this.#tabs.sessions.map((s) => ({
      title: s.title,
      state: s.approvals.length ? "waiting" : s.busy ? "busy" : s.unread ? "unread" : "idle",
    }));
  }

  #drawBody(buf: CellBuffer, r: { x: number; y: number; w: number; h: number }, now: number, graphics?: Graphics): void {
    const { chat, trace } = this.#session;
    const spin = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length]!;
    const open = this.#changes?.changes(); // its summary stays lit
    if (!this.#showTrace) return chat.render(buf, r, spin, now, this.#colors, open, graphics);

    const stats = `${trace.count} · ${this.#frame.ms.toFixed(1)}ms ${this.#frame.bytes}B`;
    if (r.w >= 100) {
      const traceW = Math.min(64, Math.floor(r.w * 0.42));
      const chatW = r.w - traceW - 3;
      chat.render(buf, { ...r, w: chatW }, spin, now, this.#colors, open, graphics);
      for (let y = r.y; y < r.y + r.h; y++) buf.text(r.x + chatW + 1, y, "│", { fg: palette.faint });
      trace.render(buf, { x: r.x + chatW + 3, y: r.y, w: traceW, h: r.h }, stats);
    } else {
      const traceH = Math.max(3, Math.floor(r.h * 0.45));
      const chatH = r.h - traceH - 1;
      chat.render(buf, { ...r, h: chatH }, spin, now, this.#colors, open, graphics);
      buf.text(r.x, r.y + chatH, "┄".repeat(r.w), { fg: palette.faint });
      trace.render(buf, { x: r.x, y: r.y + chatH + 1, w: r.w, h: traceH }, stats);
    }
  }

  /** The status in `width` cells of row y, the tip in the row below. */
  #drawStatus(buf: CellBuffer, y: number, width: number, now: number): void {
    const s = this.#session;
    const elapsedMs = now - s.turnStarted;
    const activity = s.activity();
    const pixel = this.#term.graphics.supported;
    if (pixel) this.#renderer.image = pixelMeteor(PAD, y, activity.color, now);
    drawStatus(buf, PAD, y, width, { ...activity, elapsedMs, rate: s.rate.rate(now) }, now, pixel);
    drawTip(buf, PAD, y + METEOR_ROWS, width, tipAt(elapsedMs, s.turnCount));
  }

  #drawInput(buf: CellBuffer, y: number, rows: number, layout: ReturnType<Editor["layout"]>, promptWidth: number): void {
    const editor = this.#session.editor;
    const x = PAD + 2 + promptWidth;
    // Retain the viewport while the cursor stays visible, including after a click.
    const scroll = Math.max(0, Math.min(this.#inputScroll, layout.rows.length - rows, layout.cursorRow));
    if (!this.#inputDrag) this.#inputScroll = Math.max(scroll, layout.cursorRow - rows + 1);
    const visibleRows = this.#inputDrag?.rows ?? layout.rows.slice(this.#inputScroll, this.#inputScroll + rows);
    this.#inputHit = { x: PAD + 1, y, w: this.#inputWidth + promptWidth + 2, h: rows, textX: x, editor, rows: visibleRows };
    buf.text(PAD + 2, y, PROMPT, { fg: palette.accent, bold: true });

    if (!editor.text) {
      const placeholder = this.#session.provider === "mock" ? "Message sope…  try !echo hi, !agent a | b, or /help" : "Message sope…  /help for commands";
      buf.text(x, y, placeholder, { fg: palette.faint }, x + this.#inputWidth);
    } else {
      for (let i = 0; i < rows; i++) {
        const row = visibleRows[i];
        if (!row) continue;
        buf.text(x, y + i, editor.text.slice(row.start, row.end), {}, x + this.#inputWidth);
        const range = editor.selection;
        if (range && range[0] <= row.end && range[1] > row.start) {
          const start = Math.max(row.start, range[0]);
          const end = Math.min(row.end, range[1]);
          const x0 = x + stringWidth(editor.text.slice(row.start, start));
          // A selected hard newline gets one highlighted blank cell.
          const newline = range[1] > row.end && editor.text[row.end] === "\n" ? 1 : 0;
          const x1 = Math.min(x + this.#inputWidth, x + stringWidth(editor.text.slice(row.start, end)) + newline);
          for (let col = x0; col < x1; col++) buf.attr[(y + i) * buf.width + col]! |= INVERSE;
        }
      }
    }
    // The real cursor sits in the input so IME candidate windows appear in the right place.
    this.#renderer.cursor = { x: x + layout.cursorCol, y: y + layout.cursorRow - this.#inputScroll, visible: true };
  }

  /** The permission mode, what runs in the background, then a notice when there is one; on the right, the model and how full the context is. */
  #drawFooter(buf: CellBuffer, y: number, inner: number, now: number): void {
    const s = this.#session;
    const left = PAD + 2;
    const usage = s.context ? `${formatTokens(s.context)}${s.contextWindow ? ` / ${formatTokens(s.contextWindow)}` : ""}` : "";
    const sep = s.model && usage ? " · " : "";
    const width = stringWidth(s.model) + sep.length + stringWidth(usage);
    const right = PAD + inner - 2 - width; // under the input box's right edge, as the mode is under its left
    let end = PAD + inner;
    if (width && right > left + 24) {
      let x = buf.text(right, y, s.model, { fg: palette.muted });
      x = buf.text(x, y, sep, { fg: palette.faint });
      buf.text(x, y, usage, { fg: palette.muted });
      end = right - 2;
    }
    let x = buf.text(left, y, `${MODE_ICON[this.#mode]} `, { fg: MODE_COLOR[this.#mode] }, end);
    x = buf.text(x, y, modeLabel(this.#mode), { fg: MODE_COLOR[this.#mode] }, end);
    this.#modeHit = { x0: left, x1: x };
    const spin = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length]!;
    this.#tasksHit = drawTaskSummary(buf, x, y, end, s, spin, now);
    if (this.#tasksHit) x = this.#tasksHit.x1;
    if (this.#notice && end - x - 2 > 0) buf.text(x + 2, y, truncate(this.#notice, end - x - 2), { fg: palette.tool });
  }
}
