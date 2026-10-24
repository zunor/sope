// SPDX-License-Identifier: MIT
// What the TUI knows about tools. The real tools (read, write, edit, glob,
// grep, bash, web_fetch, ...) are built into libsope and run there; the TUI
// only shows them: a one-line summary of each call, and a preview when one
// asks for permission. The demo tools below are host tools, registered with
// the mock provider to exercise the host side of the ABI (!echo, !clock,
// !sleep).

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { diffLines, hunks, splitLines } from "../ui/diff";
import { langFor } from "../ui/highlight";

/** Built-in tools that wait for the user's permission (sope.h: "ask"). */
export const ASKING_TOOLS = ["write", "edit", "bash", "check", "web_fetch"];

/** Built-in tools that read only. */
export const READ_TOOLS = ["read", "report", "evidence", "artifact_read", "glob", "grep", "bash_output", "bash_kill", "todo_write"];

/** One line of a permission preview. */
export interface PreviewLine {
  text: string;
  /** add / remove / context are diff lines; gap stands for unchanged lines left out. */
  kind?: "command" | "add" | "remove" | "context" | "gap" | "plain";
  /** Diff lines: the line number in the file. */
  no?: number;
  /** Diff lines: the language to highlight (highlight.ts). */
  lang?: string;
}

/** A tool the host implements itself; results go back through sope_tool_result. */
export interface HostTool {
  name: string;
  description: string;
  inputSchema: object;
  run(input: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<string> | string;
}

export interface Todo {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  reason?: string;
}

const PREVIEW_LINES = 8;
const DIFF_CONTEXT = 2;

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : String(v));

export function parseInput(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lines(text: string, kind: PreviewLine["kind"], max = PREVIEW_LINES): PreviewLine[] {
  const all = text.replace(/\n$/, "").split("\n");
  const shown = all.slice(0, max).map((t) => ({ text: t, kind }));
  if (all.length > max) shown.push({ text: `… ${all.length - max} more lines`, kind: "plain" });
  return shown;
}

/** The file as it is now, or null; relative paths are against the working directory. */
export function readCurrent(path: string): string | null {
  try {
    const file = resolve(process.cwd(), path);
    return statSync(file).size > 4 << 20 ? null : readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function diffPreview(before: string, after: string, lang: string): PreviewLine[] {
  return hunks(diffLines(splitLines(before), splitLines(after)), DIFF_CONTEXT).map((l) =>
    l.kind === "gap" ? { text: `⋯ ${l.skipped} unchanged line${l.skipped > 1 ? "s" : ""}`, kind: "gap" } : { text: l.text, kind: l.kind, no: l.no, lang },
  );
}

/**
 * What the user sees before allowing a call. write and edit show a diff
 * against the file as it is now (`read` reads it), with line numbers.
 */
export function previewFor(name: string, input: Record<string, unknown>, read = readCurrent): PreviewLine[] {
  switch (name) {
    case "write": {
      const path = str(input.file_path);
      const lang = langFor(path);
      const content = str(input.content);
      const now = read(path);
      if (now === null) {
        const n = splitLines(content).length;
        return [{ text: `${path}  (new file, ${n} line${n === 1 ? "" : "s"})`, kind: "plain" }, ...diffPreview("", content, lang)];
      }
      const diff = diffPreview(now, content, lang);
      return [{ text: `${path}${diff.length ? "" : "  (no change)"}`, kind: "plain" }, ...diff];
    }
    case "edit": {
      const path = str(input.file_path);
      const lang = langFor(path);
      const [oldS, newS] = [str(input.old_string), str(input.new_string)];
      const header: PreviewLine = { text: `${path}${input.replace_all ? "  (every occurrence)" : ""}`, kind: "plain" };
      const now = read(path);
      if (now !== null && oldS && now.includes(oldS)) {
        const after = input.replace_all ? now.split(oldS).join(newS) : now.replace(oldS, () => newS);
        return [header, ...diffPreview(now, after, lang)];
      }
      // The file is unreadable or the text is not in it (the edit will fail): show the strings.
      if (now !== null) header.text += "  (the old text is not in the file)";
      return [header, ...diffPreview(oldS, newS, lang).map((l) => ({ ...l, no: undefined }))];
    }
    case "check":
      return [{ text: JSON.stringify(input.argv), kind: "command" }];
    case "bash": {
      const rows = lines(str(input.command), "command", 12);
      if (input.description) rows.unshift({ text: str(input.description), kind: "plain" });
      if (input.run_in_background) rows.push({ text: "(in the background)", kind: "plain" });
      return rows;
    }
    case "web_fetch":
      return [{ text: str(input.url), kind: "command" }];
    default:
      return [{ text: JSON.stringify(input), kind: "plain" }];
  }
}

/** One line describing a call, e.g. `src/main.c` for read or the command for bash. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  const where = (path: unknown) => (path ? ` in ${str(path)}` : "");
  switch (name) {
    case "read": {
      const range = input.offset || input.limit ? ` (from line ${str(input.offset ?? 1)})` : "";
      return `${str(input.file_path)}${range}`;
    }
    case "write":
    case "edit":
      return str(input.file_path);
    case "glob":
      return `${str(input.pattern)}${where(input.path)}`;
    case "grep":
      return `${str(input.pattern)}${where(input.path)}${input.glob ? ` (${str(input.glob)})` : ""}`;
    case "check":
      return JSON.stringify(input.argv);
    case "bash":
      return `${input.run_in_background ? "[background] " : ""}${str(input.command)}`;
    case "bash_output":
    case "bash_kill":
      return `shell ${str(input.shell_id)}`;
    case "web_fetch":
      return str(input.url);
    case "todo_write":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    default: {
      const values = Object.values(input);
      if (values.length === 1 && typeof values[0] === "string") return values[0];
      return values.length ? JSON.stringify(input) : "";
    }
  }
}

/** The todo list a todo_write call sets, or null if the input is not one. */
export function todosOf(input: Record<string, unknown>): Todo[] | null {
  if (!Array.isArray(input.todos)) return null;
  return input.todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      content: str(t.content),
      activeForm: t.activeForm ? str(t.activeForm) : undefined,
      status: t.status === "completed" || t.status === "in_progress" || t.status === "blocked" ? t.status : "pending",
      reason: t.reason ? str(t.reason) : undefined,
    }));
}

export function formatTodos(todos: Todo[]): string {
  if (!todos.length) return "(the todo list is empty)";
  const mark = { pending: "☐", in_progress: "◐", completed: "☒", blocked: "⊘" } as const;
  return todos.map((t) => `${mark[t.status]} ${t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}${t.status === "blocked" && t.reason ? ` — ${t.reason}` : ""}`).join("\n");
}

const stringInput = (description: string) => ({
  type: "object",
  properties: { input: { type: "string", description } },
});

/** Host tools for exercising the ABI with the mock provider. */
export const demoTools: HostTool[] = [
  {
    name: "echo",
    description: "Returns its input unchanged.",
    inputSchema: stringInput("Text to echo"),
    run: ({ input }) => str(input),
  },
  {
    name: "clock",
    description: "Returns the current local date and time.",
    inputSchema: { type: "object", properties: {} },
    run: () => new Date().toString(),
  },
  {
    name: "sleep",
    description: "Waits the given number of seconds (default 2, max 60), then returns.",
    inputSchema: stringInput("Seconds to wait"),
    run: async ({ input }, { signal }) => {
      const seconds = Math.min(60, Number(input) || 2);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, seconds * 1000);
        signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
      });
      return signal.aborted ? "cancelled" : `slept ${seconds}s`;
    },
  },
];

/** Host tools to register: only the demo tools, and only for the mock provider. */
export function hostToolsFor(provider: string): HostTool[] {
  return provider === "mock" ? demoTools : [];
}
