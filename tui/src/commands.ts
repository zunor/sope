// SPDX-License-Identifier: MIT
// The slash commands. One table drives what each command does, the
// suggestions menu above the input (ui/commands.ts) and /help. Commands act
// through CommandHost, the app's side of them.

import { version } from "sope";
import { parseEffort, type Effort } from "./agent/effort";
import { parseMode, type PermissionMode } from "./agent/permissions";
import { ASKING_TOOLS, READ_TOOLS, type HostTool } from "./agent/tools";
import { configPath } from "./config";
import type { Session } from "./session";
import type { SlashCommand } from "./ui/commands";

export interface CommandHost {
  /** The session on screen. */
  readonly session: Session;
  newSession(): void;
  closeSession(): void;
  openSessions(): void;
  openModels(): void;
  /** Switches this session to a model, from its next turn. */
  useModel(id: string): void;
  openModes(): void;
  openEffort(): void;
  /** Opens the search bar; with a query, browses its hits. */
  openSearch(query?: string): void;
  /** The subagents and background shells of this session. */
  openTasks(): void;
  /** This session's reasoning effort from its next turn; also the default for new sessions. */
  setEffort(effort: Effort): void;
  setMode(mode: PermissionMode): void;
  /** Each returns the new state. */
  toggleThinking(): boolean;
  toggleTrace(): boolean;
  toggleChanges(): boolean;
  toggleMouse(): boolean;
  quit(): void;
}

export interface Command extends SlashCommand {
  /** Its shortcut, shown in /help. */
  keys?: string;
  run(host: CommandHost, args: string[]): void;
}

const info = (host: CommandHost, text: string) => host.session.chat.add({ role: "info", text });
const fail = (host: CommandHost, text: string) => host.session.chat.add({ role: "error", text });

export const COMMANDS: Command[] = [
  { name: "help", description: "Show commands and keyboard shortcuts", run: (h) => info(h, helpText(h.session.hostTools)) },
  { name: "new", description: "Open a new session in a tab", keys: "alt+n, or click +", run: (h) => h.newSession() },
  { name: "sessions", description: "Browse the saved sessions of this directory", keys: "or click ⋯", run: (h) => h.openSessions() },
  {
    name: "model",
    args: "[name]",
    description: "Choose the model, or switch to <name>; from the next turn",
    keys: "alt+m",
    run: (h, [name]) => (name ? h.useModel(name) : h.openModels()),
  },
  {
    name: "effort",
    args: "[level]",
    description: "Choose how long the model thinks: default, low, medium, high, xhigh",
    run: (h, args) => {
      if (!args.length) return h.openEffort();
      const effort = parseEffort(args.join(" "));
      return effort === undefined ? fail(h, "usage: /effort [default|none|minimal|low|medium|high|xhigh]") : h.setEffort(effort);
    },
  },
  {
    name: "permissions",
    args: "[ask|auto|full]",
    description: "Choose who approves edits and commands",
    keys: "shift+tab cycles",
    run: (h, args) => {
      if (args.length) {
        const mode = parseMode(args.join(" "));
        return mode ? h.setMode(mode) : fail(h, "usage: /permissions [ask|auto|full]");
      }
      const allowed = [...h.session.alwaysAllowed];
      if (allowed.length) info(h, `Allowed for this session without asking: ${allowed.join(", ")}.`);
      h.openModes();
    },
  },
  { name: "find", args: "[text]", description: "Search this conversation; n/N step through the hits", keys: "ctrl+f", run: (h, args) => h.openSearch(args.join(" ")) },
  { name: "tasks", description: "Show subagents and background shells; stop one", keys: "↓ on an empty input", run: (h) => h.openTasks() },
  { name: "context", description: "Show what fills the model's context window", run: (h) => h.session.showContext() },
  { name: "compact", args: "[focus]", description: "Summarize the conversation to free context (also automatic)", run: (h, args) => h.session.compact(args.join(" ")) },
  { name: "recover", args: "[resume|resolve <id> <ok|error> <outcome>]", description: "Inspect and resume an interrupted task after verifying tool outcomes", run: (h, args) => h.session.recover(args) },
  { name: "thinking", description: "Show or hide the model's full reasoning", run: (h) => info(h, `full reasoning ${h.toggleThinking() ? "shown" : "collapsed"}`) },
  { name: "diff", description: "Toggle the diff of the files the last turn changed", keys: "click its change summary", run: (h) => void h.toggleChanges() },
  { name: "trace", description: "Toggle the ABI trace panel", keys: "ctrl+t", run: (h) => void h.toggleTrace() },
  { name: "mouse", description: "Toggle mouse capture (wheel scroll, drag to copy)", run: (h) => info(h, `mouse reporting ${h.toggleMouse() ? "on" : "off"}`) },
  {
    name: "set",
    args: "<key> [value]",
    required: true,
    description: "Set an agent option (sope_agent_set_option); omit value to unset",
    run: (h, [key, ...rest]) => {
      if (!key) return fail(h, "usage: /set <key> [value]");
      const value = rest.length ? rest.join(" ") : null;
      h.session.setOption(key, value);
      info(h, value === null ? `unset ${key}` : `${key} = ${key.includes("key") ? "***" : value}`);
    },
  },
  { name: "clear", description: "Clear this conversation and transcript", run: (h) => h.session.reset() },
  { name: "close", description: "Close this session; it is no longer listed", keys: "alt+w, or × on its tab", run: (h) => h.closeSession() },
  { name: "quit", description: "Exit sope", run: (h) => h.quit() },
  { name: "exit", description: "Exit sope (alias for /quit)", run: (h) => h.quit() },
];

/** Runs a line that starts with "/"; problems go to the transcript. */
export function runCommand(host: CommandHost, line: string): void {
  const [name = "", ...args] = line.slice(1).split(/\s+/);
  const command = COMMANDS.find((c) => c.name === name);
  try {
    if (command) command.run(host, args);
    else fail(host, `unknown command /${name} (try /help)`);
  } catch (err) {
    fail(host, (err as Error).message);
  }
}

const usage = (c: Command) => `/${c.name}${c.args ? ` ${c.args}` : ""}`;

export function helpText(hostTools: HostTool[]): string {
  const width = Math.max(...COMMANDS.map((c) => usage(c).length)) + 2;
  return [
    `sope ${version()}. Commands:`,
    ...COMMANDS.map((c) => `  ${usage(c).padEnd(width)}${c.description}${c.keys ? ` (${c.keys})` : ""}`),
    "Images: ctrl+v pastes one from the clipboard, dragging an image file into the terminal attaches it, and sope --image <file> attaches one to the first message. They go to the image model (SOPE_IMAGE_MODEL).",
    "Sessions: alt+1 … alt+9 or a click switches tabs; each keeps running in the background. They are saved per directory and come back on the next start.",
    `Tools (built into libsope): ${[...READ_TOOLS, ...ASKING_TOOLS.map((t) => `${t}*`)].join(", ")}, plus \`agent\` for subagents (* may ask first).`,
    "Permissions: Ask for approval asks before every * tool; Approve for me (the default) runs everything except risky steps: deleting or writing outside this directory, git push and other publishing, discarding uncommitted git work, sudo, global installs, ssh, curl uploads; Full access never asks.",
    ...(hostTools.length ? [`Host tools (this TUI): ${hostTools.map((t) => t.name).join(", ")}.`] : []),
    `Config: ${configPath()} or environment variables (SOPE_API_KEY, SOPE_MODEL, SOPE_BASE_URL, ...).`,
    "Mock provider: plain text streams a reply; !echo <x>, !clock, !sleep <s> call host tools; !read {\"file_path\":\"README.md\"} (any tool, JSON input); !agent t1 | t2 runs subagents; !panic fails.",
  ].join("\n");
}
