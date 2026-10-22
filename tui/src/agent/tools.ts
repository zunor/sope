// SPDX-License-Identifier: MIT
// Tools the TUI registers with the agent (and so offers to its subagents).
// They run on the UI thread's event loop; results go back through
// sope_tool_result. File tools are confined to the working directory.
// Tools that are not readOnly change things, so they run only once the user
// approves them (see runner.ts); bash can do anything and always asks.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface ToolContext {
  signal: AbortSignal;
}

/** One line of a permission preview. */
export interface PreviewLine {
  text: string;
  kind?: "command" | "add" | "remove" | "plain";
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** Safe to run without asking: reads, never writes. */
  readOnly?: boolean;
  /** Shown when asking the user for permission. */
  preview?(input: Record<string, unknown>): PreviewLine[];
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 500;
const MAX_OUTPUT = 30_000;
const MAX_MATCHES = 200;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const PREVIEW_LINES = 8;
const SKIP_DIRS = new Set(["node_modules", "build", "dist", "target", "__pycache__"]);

const stringInput = (description: string) => ({
  type: "object",
  properties: { input: { type: "string", description } },
});

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : String(v));

/** Resolves a path inside the working directory, or throws. */
function confined(path: unknown): string {
  const root = process.cwd();
  const full = resolve(root, typeof path === "string" && path ? path : ".");
  const rel = relative(root, full);
  if (rel.startsWith("..") || resolve(rel) !== full) throw new Error(`${String(path)} is outside the working directory`);
  return full;
}

/** Keeps the head and tail of long output. */
export function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n… [${dropped} characters omitted] …\n${text.slice(-half)}`;
}

function lines(text: string, kind: PreviewLine["kind"], max = PREVIEW_LINES): PreviewLine[] {
  const all = text.replace(/\n$/, "").split("\n");
  const shown = all.slice(0, max).map((t) => ({ text: t, kind }));
  if (all.length > max) shown.push({ text: `… ${all.length - max} more lines`, kind: "plain" });
  return shown;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (signal.aborted) return;
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** Runs a shell command in its own session (no access to the TUI's terminal). */
function runCommand(command: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn("/bin/bash", ["-c", `exec 2>&1\n${command}`], {
      cwd: process.cwd(),
      detached: true, // new session: no controlling terminal, and a process group we can kill
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", TERM: "dumb" },
    });
    let head = "";
    let tail = "";
    let size = 0;
    let ended: string | null = null;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      size += chunk.length;
      if (head.length < MAX_OUTPUT) head += chunk;
      else tail = (tail + chunk).slice(-MAX_OUTPUT);
    });
    const kill = (why: string) => {
      ended ??= why;
      try {
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // already gone
          }
        }, 2000).unref();
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = () => kill("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      ended ??= err.message;
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      let out = clip(tail ? `${head}\n… [${size - head.length - tail.length} characters omitted] …\n${tail}` : head);
      out = out.replace(/\n+$/, "");
      const status = ended ? `[${ended}]` : code ? `[exit code ${code}]` : sig ? `[killed by ${sig}]` : "";
      resolvePromise([out || "(no output)", status].filter(Boolean).join("\n"));
    });
  });
}

/** The tools every session offers. */
export const coreTools: Tool[] = [
  {
    name: "list_files",
    description: "Lists a directory inside the working directory. Directories end with '/'.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the working directory, e.g. '.' or 'src'" } },
      required: ["path"],
    },
    run: async ({ path }) => {
      const dir = confined(path);
      const entries = await readdir(dir, { withFileTypes: true });
      const names = entries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      const shown = names.slice(0, MAX_ENTRIES).join("\n");
      return names.length > MAX_ENTRIES ? `${shown}\n… ${names.length - MAX_ENTRIES} more` : shown || "(empty)";
    },
  },
  {
    name: "read_file",
    description:
      "Reads a UTF-8 text file inside the working directory. Returns numbered lines; use offset/limit for large files.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        offset: { type: "number", description: "First line to return (1-based, default 1)" },
        limit: { type: "number", description: "Maximum number of lines (default 2000)" },
      },
      required: ["path"],
    },
    run: async ({ path, offset, limit }) => {
      const file = confined(path);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${str(path)} is not a file`);
      if (info.size > 8 * MAX_FILE_BYTES && offset === undefined) {
        throw new Error(`${str(path)} is ${info.size} bytes; read it in parts with offset and limit`);
      }
      const all = (await readFile(file, "utf8")).split("\n");
      const first = Math.max(1, Math.floor(Number(offset) || 1));
      const count = Math.max(1, Math.floor(Number(limit) || 2000));
      const shown = all.slice(first - 1, first - 1 + count);
      const width = String(first + shown.length).length;
      let out = shown.map((l, i) => `${String(first + i).padStart(width)}  ${l}`).join("\n");
      if (out.length > MAX_FILE_BYTES) out = `${out.slice(0, MAX_FILE_BYTES)}\n… truncated`;
      const rest = all.length - (first - 1 + shown.length);
      return rest > 0 ? `${out}\n… ${rest} more lines (continue with offset ${first + shown.length})` : out || "(empty file)";
    },
  },
  {
    name: "search",
    description:
      "Searches text files under a directory of the working directory for a regular expression (JavaScript syntax). " +
      "Returns matching lines as path:line: text. Skips hidden files, node_modules and build output.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "Directory or file to search (default '.')" },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
    },
    run: async ({ pattern, path, ignore_case }, { signal }) => {
      const re = new RegExp(str(pattern), ignore_case ? "i" : "");
      const root = confined(path);
      const files = (await stat(root)).isFile() ? [root] : walk(root, signal);
      const out: string[] = [];
      for await (const file of files) {
        if (out.length >= MAX_MATCHES || signal.aborted) break;
        const info = await stat(file);
        if (info.size > MAX_FILE_BYTES) continue;
        const data = await readFile(file);
        if (data.includes(0)) continue; // binary
        const rel = relative(process.cwd(), file);
        data
          .toString("utf8")
          .split("\n")
          .forEach((line, i) => {
            if (out.length < MAX_MATCHES && re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
          });
      }
      if (!out.length) return "no matches";
      return out.length >= MAX_MATCHES ? `${out.join("\n")}\n… stopped at ${MAX_MATCHES} matches` : out.join("\n");
    },
  },
  {
    name: "write_file",
    description:
      "Creates or overwrites a text file inside the working directory with the given content. " +
      "Prefer edit_file for changes to existing files. Requires the user's approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        content: { type: "string", description: "The complete new content" },
      },
      required: ["path", "content"],
    },
    preview: ({ path, content }) => [{ text: str(path), kind: "plain" }, ...lines(str(content), "add")],
    run: async ({ path, content }) => {
      const file = confined(path);
      const text = str(content);
      const existed = await stat(file).then(
        () => true,
        () => false,
      );
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      const n = text ? text.replace(/\n$/, "").split("\n").length : 0;
      return `${existed ? "overwrote" : "created"} ${relative(process.cwd(), file)} (${n} line${n === 1 ? "" : "s"})`;
    },
  },
  {
    name: "edit_file",
    description:
      "Replaces exact text in a file inside the working directory. old_string must match the file exactly " +
      "(including whitespace) and be unique unless replace_all is true; read the file first. Requires the user's approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        old_string: { type: "string", description: "The exact text to replace" },
        new_string: { type: "string", description: "The replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    preview: ({ path, old_string, new_string }) => [
      { text: str(path), kind: "plain" },
      ...lines(str(old_string), "remove", PREVIEW_LINES / 2),
      ...lines(str(new_string), "add", PREVIEW_LINES / 2),
    ],
    run: async ({ path, old_string, new_string, replace_all }) => {
      const file = confined(path);
      const from = str(old_string);
      if (!from) throw new Error("old_string must not be empty");
      const text = await readFile(file, "utf8");
      const n = count(text, from);
      if (n === 0) throw new Error(`old_string was not found in ${str(path)}`);
      if (n > 1 && !replace_all) throw new Error(`old_string occurs ${n} times in ${str(path)}; add context or set replace_all`);
      const to = str(new_string);
      await writeFile(file, replace_all ? text.split(from).join(to) : text.replace(from, () => to));
      return `edited ${relative(process.cwd(), file)} (${replace_all ? n : 1} replacement${replace_all && n > 1 ? "s" : ""})`;
    },
  },
  {
    name: "bash",
    description:
      "Runs a shell command with bash in the working directory and returns its combined stdout and stderr " +
      "(long output is clipped in the middle). No terminal and no stdin: avoid interactive programs. " +
      `Times out after timeout_ms (default ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s). Requires the user's approval.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["command"],
    },
    preview: ({ command }) => lines(str(command), "command", 12),
    run: ({ command, timeout_ms }, { signal }) => {
      const cmd = str(command).trim();
      if (!cmd) throw new Error("command must not be empty");
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeout_ms) || DEFAULT_TIMEOUT_MS));
      return runCommand(cmd, timeout, signal);
    },
  },
];

/** Extra tools for exercising the ABI with the mock provider (!echo, !clock, !sleep). */
export const demoTools: Tool[] = [
  {
    name: "echo",
    description: "Returns its input unchanged.",
    readOnly: true,
    inputSchema: stringInput("Text to echo"),
    run: ({ input }) => str(input),
  },
  {
    name: "clock",
    description: "Returns the current local date and time.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    run: () => new Date().toString(),
  },
  {
    name: "sleep",
    description: "Waits the given number of seconds (default 2, max 60), then returns.",
    readOnly: true,
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

export function toolsFor(provider: string): Tool[] {
  return provider === "mock" ? [...coreTools, ...demoTools] : coreTools;
}
