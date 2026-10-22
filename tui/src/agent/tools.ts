// Tools the TUI registers with the agent (and so offers to its subagents).
// They run on the UI thread's event loop; results go back through
// sope_tool_result. File tools are read-only and confined to the working
// directory.

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run(input: Record<string, unknown>): Promise<string> | string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;

const stringInput = (description: string) => ({
  type: "object",
  properties: { input: { type: "string", description } },
});

const pathInput = (description: string) => ({
  type: "object",
  properties: { path: { type: "string", description } },
  required: ["path"],
});

/** Resolves a path inside the working directory, or throws. */
function confined(path: unknown): string {
  const root = process.cwd();
  const full = resolve(root, typeof path === "string" && path ? path : ".");
  const rel = relative(root, full);
  if (rel.startsWith("..") || resolve(rel) !== full) throw new Error(`${String(path)} is outside the working directory`);
  return full;
}

export const tools: Tool[] = [
  {
    name: "echo",
    description: "Returns its input unchanged.",
    inputSchema: stringInput("Text to echo"),
    run: ({ input }) => String(input ?? ""),
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
    run: async ({ input }) => {
      const seconds = Math.min(60, Number(input) || 2);
      await Bun.sleep(seconds * 1000);
      return `slept ${seconds}s`;
    },
  },
  {
    name: "list_files",
    description: "Lists a directory inside the working directory. Directories end with '/'.",
    inputSchema: pathInput("Directory path relative to the working directory, e.g. '.' or 'src'"),
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
    description: "Reads a UTF-8 text file inside the working directory (first 64 KB).",
    inputSchema: pathInput("File path relative to the working directory"),
    run: async ({ path }) => {
      const file = confined(path);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${String(path)} is not a file`);
      const data = await readFile(file);
      const text = data.subarray(0, MAX_FILE_BYTES).toString("utf8");
      return data.length > MAX_FILE_BYTES ? `${text}\n… truncated (${data.length} bytes total)` : text;
    },
  },
];
