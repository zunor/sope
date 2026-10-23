// SPDX-License-Identifier: MIT
// The sope TUI: wires the terminal, input decoding and the sessions together,
// and lays out each frame. Each tab is a session (session.ts) with its own
// agent; input and commands go to the one on screen. Sessions are saved
// per directory (store.ts); the most recent few come back as tabs on start,
// and ⋯ (or /sessions) lists them all.
//
//   [ explain thread pools ▒][ fix grep × ▒] +              ~/src/app  ⋯
//
//   › user message
//
//   ✻ Thought for 2.1s
//   ● assistant reply …
//   ◆ agent · general-purpose  explain thread pools
//     ● read  src/pool.c
//     ⎿ report …
//
//   ──━━✦ Thinking… (1m 4s · 38 tok/s · tip: …)    (while a turn runs)
//   ──────────────────────────────────────────────────────────────────────
//   › input                         (or a permission prompt for
//   ───────────────────────────────  write / edit / bash / web_fetch)
//   enter send · ctrl+j newline · esc cancel …          glm-5.3 · ctx 8.1k

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { version, type SopeEvent } from "sope";
import { clipboardImage, describeImage, imageRefs, pastedImagePath, readImageFile, type ImageFile } from "./agent/images";
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
import type { Editor } from "./ui/editor";
import { copyToClipboard, Selection } from "./ui/selection";
import { drawStatus, tipAt } from "./ui/status";
import { ALL_SESSIONS, drawTabs, NEW_TAB, type TabHit, type TabInfo } from "./ui/tabs";
import { stringWidth, truncate } from "./unicode/width";

const PAD = 1;
const PROMPT = "› ";
const MAX_INPUT_ROWS = 8;
const ESC_TIMEOUT_MS = 25;
const TICK_MS = 50; // animation frame rate while anything runs
const MAX_TABS = 5; // sessions shown as tabs; the rest are a click on ⋯ away
const HINTS: Array<[string, string]> = [
  ["enter", "send"],
  ["ctrl+j", "newline"],
  ["esc", "cancel"],
  ["alt+n", "new session"],
  ["ctrl+v", "paste image"],
  ["ctrl+t", "trace"],
  ["pgup/pgdn", "scroll"],
  ["ctrl+c", "quit"],
];
const HELP = (hostTools: HostTool[]) => [
  `sope ${version()}. Commands:`,
  "  /help              show this help",
  "  /new               open a new session in a tab (alt+n, or click +)",
  "  /close             close this session (alt+w, or × on its tab); it is no longer listed",
  "  /sessions          list every saved session of this directory (or click ⋯)",
  "  /clear             clear the transcript and the conversation history",
  "  /compact [focus]   summarize the conversation to free context (also automatic)",
  "  /model <name>      switch model (next turn)",
  "  /thinking          show or hide the model's full reasoning",
  "  /trace             toggle the ABI trace panel (ctrl+t)",
  "  /mouse             toggle mouse capture (wheel scroll, drag to copy); off gives selection back to the terminal",
  "  /set <key> [val]   sope_agent_set_option; omit val to unset",
  "  /permissions       show which tools run without asking",
  "  /quit              exit",
  "Images: ctrl+v pastes one from the clipboard, dragging an image file into the terminal attaches it, and sope --image <file> attaches one to the first message. They go to the image model (SOPE_IMAGE_MODEL).",
  "Sessions: alt+1 … alt+9 or a click switches tabs; each keeps running in the background. They are saved per directory and come back on the next start.",
  `Tools (built into libsope): ${[...READ_TOOLS, ...ASKING_TOOLS.map((t) => `${t}*`)].join(", ")}, plus \`agent\` for subagents (* asks first).`,
  ...(hostTools.length ? [`Host tools (this TUI): ${hostTools.map((t) => t.name).join(", ")}.`] : []),
  `Config: ${configPath()} or environment variables (SOPE_API_KEY, SOPE_MODEL, SOPE_BASE_URL, ...).`,
  "Mock provider: plain text streams a reply; !echo <x>, !clock, !sleep <s> call host tools; !read {\"file_path\":\"README.md\"} (any tool, JSON input); !agent t1 | t2 runs subagents; !panic fails.",
].join("\n");

const MAX_PREVIEW_ROWS = 20;

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
  /** Run edits and commands without asking. */
  allowAll?: boolean;
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

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class App {
  #term = new Terminal();
  #renderer = new Renderer((s) => this.#term.write(s), this.#term.truecolor);
  #parser = new InputParser();
  #selection = new Selection();
  #notice: string | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #config: Config;
  #allowAll: boolean;
  #initialPrompt?: string;
  #initialImages: ImageFile[];
  #dir = process.cwd().replace(homedir(), "~");
  #directory = realpathSync(process.cwd()); // the key sessions are saved under
  #store: Store | null;
  #list: SessionList | null = null; // the session list, while open

  #sessions: Session[] = [];
  #active = 0;
  #tabHits: TabHit[] = [];
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

  constructor({ config, allowAll = false, prompt, images = [] }: AppOptions) {
    this.#config = config;
    this.#allowAll = allowAll;
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
    this.#term.enter();
    this.#term.onInput((data) => this.#onInput(data));
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
    const s = new Session(this.#config, this.#allowAll, (session, events) => this.#onSessionEvents(session, events), {
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
    const s = new Session(this.#config, this.#allowAll, (session, events) => this.#onSessionEvents(session, events), persist);
    s.chat.showThinking = this.#showThinking;
    const c = this.#config;
    const hint = c.provider === "mock" && !c.apiKey ? " · set SOPE_API_KEY (or .env) to talk to a real model" : "";
    const yolo = this.#allowAll ? " · --allow-all: edits and commands run without asking" : "";
    s.chat.add({ role: "info", text: `/help for commands${hint}${yolo}` });
    this.#sessions.push(s);
    this.#switchTo(this.#sessions.length - 1);
  }

  #switchTo(index: number): void {
    if (index < 0 || index >= this.#sessions.length) return;
    this.#active = index;
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
    this.#hover = null;
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
    if (ev.type === "osc") return this.#handleOsc(ev.data);
    if (ev.type === "mouse") return this.#handleMouse(ev);
    this.#selection.clear();
    if (this.#list) {
      if (ev.type === "key") return this.#handleListKey(keyId(ev));
      return this.#list.type(ev.text);
    }
    if (this.#session.approvals.length && (ev.type === "text" || ev.type === "paste")) {
      if (ev.type === "text" && [...ev.text].length === 1) this.#handleApprovalKey(ev.text);
      return; // the input box is hidden while a permission prompt is up
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
    return y === 0 ? this.#tabHits.find((h) => x >= h.x0 && x < h.x1) : undefined;
  }

  #handleMouse(ev: MouseInput): void {
    const p = { x: ev.x, y: ev.y };
    if (ev.action === "move" || ev.action === "drag") this.#hover = this.#tabAt(ev.x, ev.y)?.index ?? null;
    if (this.#list) return this.#handleListMouse(ev);
    switch (ev.action) {
      case "move":
        return;
      case "wheel-up":
      case "wheel-down":
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

  /** Shows a short message in place of the key hints. */
  #flash(text: string, ms = 2000): void {
    this.#notice = text;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#notice = null;
      this.#scheduleRender();
    }, ms);
  }

  #handleKey(id: string): void {
    if (this.#session.approvals.length && this.#handleApprovalKey(id)) return;
    const s = this.#session;
    const e = s.editor;
    const tab = /^alt\+([1-9])$/.exec(id);
    if (tab) return this.#switchTo(Number(tab[1]) - 1);
    switch (id) {
      case "alt+n":
        return this.#newSession();
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

  #handleApprovalKey(id: string): boolean {
    const decision: Decision | undefined = (
      { y: "once", enter: "once", a: "always", n: "deny", escape: "stop", "ctrl+c": "stop" } as Record<string, Decision>
    )[id.toLowerCase()];
    if (!decision) {
      // Switching tabs still works; everything else is swallowed.
      return !["pageup", "pagedown", "ctrl+t", "f2", "ctrl+l", "alt+n", "alt+w"].includes(id) && !/^alt\+[1-9]$/.test(id);
    }
    this.#session.decide(decision);
    return true;
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
          if (this.#allowAll) return void info("--allow-all: every tool runs without asking");
          const allowed = [...s.alwaysAllowed];
          return void info(
            `Ask before: ${ASKING_TOOLS.filter((n) => !allowed.includes(n)).join(", ") || "(nothing)"}\n` +
              `Allowed for this session: ${allowed.join(", ") || "(nothing)"}\n` +
              `Never ask: ${READ_TOOLS.join(", ")}.`,
          );
        }
        case "clear":
          return s.reset();
        case "model":
          if (!args[0]) return void info(`model: ${s.model || "(provider default)"}`);
          s.setOption("model", args[0]);
          return void info(`model = ${args[0]} (from the next turn)`);
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

  /** Redraws every animation frame while any session runs. */
  #tick(on: boolean): void {
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
    const s = this.#session;

    if (W < 24 || H < 10) {
      buf.text(0, 0, "terminal too small", { fg: palette.muted });
      this.#renderer.end();
      return;
    }

    const inner = W - PAD * 2;
    const promptWidth = stringWidth(PROMPT);
    this.#inputWidth = inner - promptWidth;
    const layout = s.editor.layout(this.#inputWidth);
    const approval = s.approvals[0];
    const preview = approval ? this.#previewRows(approval, Math.min(MAX_PREVIEW_ROWS, H - 11)) : [];
    const inputRows = approval ? preview.length + 2 : Math.min(MAX_INPUT_ROWS, layout.rows.length);

    const footerY = H - 1;
    const ruleBottomY = footerY - 1;
    const inputY = ruleBottomY - inputRows;
    const ruleTopY = inputY - 1;
    const statusY = ruleTopY - 1;
    const bodyY = 2; // below the tab bar and a blank row
    const bodyH = Math.max(1, statusY - bodyY);

    this.#tabHits = drawTabs(buf, PAD, 0, inner, this.#tabs(), this.#active, this.#dir, this.#hover, this.#colors);
    this.#drawBody(buf, { x: PAD, y: bodyY, w: inner, h: bodyH }, t0);
    if (s.busy) this.#drawStatus(buf, statusY, inner, t0);
    buf.text(PAD, ruleTopY, "─".repeat(inner), { fg: palette.faint });
    if (approval) this.#drawApproval(buf, inputY, inner, approval, preview);
    else this.#drawInput(buf, inputY, inputRows, layout, promptWidth);
    buf.text(PAD, ruleBottomY, "─".repeat(inner), { fg: palette.faint });
    this.#drawHints(buf, footerY, inner);
    if (this.#list) {
      this.#list.render(buf, { x: PAD, y: bodyY, w: inner, h: H - bodyY - 1 }, this.#colors);
      this.#renderer.cursor = { x: 0, y: 0, visible: false };
    }
    this.#selection.highlight(buf);

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

  #drawApproval(buf: CellBuffer, y: number, inner: number, a: Approval, preview: PreviewLine[]): void {
    const waiting = this.#session.approvals.length;
    const who = a.subagent ? `subagent ${a.subagent} wants` : "sope wants";
    let x = buf.text(PAD, y, "? ", { fg: palette.tool, bold: true });
    x = buf.text(x, y, `${who} to run `, { fg: palette.muted });
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
      if (tint !== undefined) buf.fill(PAD + 2, ry, inner - 2, 1, { bg: tint });
      let x = PAD + 2;
      if (numWidth) x = buf.text(x, ry, `${line.no ? String(line.no).padStart(numWidth) : " ".repeat(numWidth)} `, { fg: palette.faint, bg: tint });
      x = buf.text(x, ry, `${marks[kind]} `, { fg: previewColor(line.kind), bg: tint, bold: kind === "add" || kind === "remove" });
      const text = line.text.replace(/\t/g, "  ");
      const end = PAD + inner;
      if (kind === "gap" || kind === "plain") return void buf.text(x, ry, truncate(text, end - x), { fg: palette.muted });
      if (!hl || !line.lang) return void buf.text(x, ry, truncate(text, end - x), { bg: tint });
      // Removed and added lines are both highlighted by the same pass; good enough for a preview.
      for (const tok of hl.line(text)) {
        if (x >= end) break;
        x = buf.text(x, ry, tok.text, { fg: SYNTAX[tok.kind], bg: tint, italic: tok.kind === "comment", dim: kind === "remove" && tok.kind === "plain" }, end);
      }
    });

    const options: Array<[string, string]> = [
      ["y", "allow once"],
      ["a", `always allow ${a.name}`],
      ["n", "deny"],
      ["esc", "deny and stop"],
    ];
    x = PAD + 2;
    const optY = y + 1 + preview.length;
    for (const [key, what] of options) {
      x = buf.text(x, optY, key, { fg: palette.accent, bold: true });
      x = buf.text(x + 1, optY, what, { fg: palette.muted });
      x += 3;
    }
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
    drawStatus(buf, PAD, y, inner, { ...s.activity(), elapsedMs, rate: s.rate.rate(now), tip: tipAt(elapsedMs, s.turnCount) }, now);
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

  /** Key hints on the left, the model and context size on the right. */
  #drawHints(buf: CellBuffer, y: number, inner: number): void {
    const s = this.#session;
    const parts = [s.provider === "mock" ? "mock provider" : s.model || s.provider];
    const total = s.tokens.in + s.tokens.out;
    if (s.context) parts.push(`ctx ${formatTokens(s.context)}`);
    if (total) parts.push(`${formatTokens(total)} tok`);
    const right = truncate(parts.join(" · "), Math.floor(inner / 2));
    const rightX = PAD + inner - stringWidth(right);
    buf.text(rightX, y, right, { fg: palette.muted });

    const end = rightX - 2;
    if (this.#notice) return void buf.text(PAD, y, truncate(this.#notice, end - PAD), { fg: palette.tool });
    let x = PAD;
    for (const [i, [key, what]] of HINTS.entries()) {
      const gap = i > 0 ? 2 : 0;
      if (x + gap + stringWidth(`${key} ${what}`) > end) break; // drop hints that do not fit whole
      x = buf.text(x + gap, y, key, { fg: palette.muted }, end);
      x = buf.text(x + 1, y, what, { fg: palette.faint }, end);
    }
  }
}
