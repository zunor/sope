// SPDX-License-Identifier: MIT
// The files sope changed in a turn, by any tool. Every such tool asks
// first (SOPE_EVENT_PERMISSION) and libsope waits for the answer, so when
// the session allows a call the files are still as they were:
//
//   write, edit   keep the file the call names
//   bash, check   keep the working tree: each file's stat and text, read
//                 again only when its stat changed since the last time
//
// After the call, a file that differs from what was kept has its old text
// kept as its baseline, once; each change is a diff of the baseline against
// the file as it is now. No git needed (it only lists the working tree's
// files when there is a repository, so .gitignore is honored).

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { diffLines, hunks, splitLines, type HunkLine } from "../ui/diff";
import { langFor } from "../ui/highlight";
import { readCurrent } from "./tools";

/** Tools that change the file they name. */
export const EDIT_TOOLS = new Set(["write", "edit"]);
/** Tools that run commands, which may change any file. */
export const COMMAND_TOOLS = new Set(["bash", "check"]);

const CONTEXT = 3;
const MAX_FILES = 20_000; // a working tree beyond this is only partly watched
const MAX_FILE = 1 << 20; // larger files are watched by their stat only
const MAX_TOTAL = 64 << 20; // text kept for the whole tree
/** Never descended into when there is no git to say what is ignored. */
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", ".next", ".cache"]);

export interface FileChange {
  /** As shown: relative to the working directory when inside it. */
  path: string;
  lang: string;
  lines: HunkLine[];
  added: number;
  removed: number;
}

/** What a turn changed: kept in the transcript when it ends (ui/chat.ts). */
export interface ChangeSet {
  files: readonly FileChange[];
  added: number;
  removed: number;
}

interface Kept {
  mtimeMs: number;
  size: number;
  /** undefined: too large, binary or over the budget; such a file's change cannot be shown. */
  text: string | null | undefined;
}

/** The file's text, or null when it is missing, too large or binary. */
export function readText(path: string): string | null {
  const text = readCurrent(path);
  return text === null || text.slice(0, 8192).includes("\0") ? null : text;
}

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(file);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

/** The working tree's files: git's view of it (tracked and untracked, not ignored), else a walk. */
export function listFiles(root = process.cwd(), max = MAX_FILES): string[] {
  try {
    const git = Bun.spawnSync(["git", "ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    if (git.success) return git.stdout.toString().split("\0").filter(Boolean).slice(0, max).map((p) => resolve(root, p));
  } catch {
    // no git
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith("build")) walk(join(dir, e.name));
      } else if (e.isFile()) out.push(join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

export class ChangeTracker implements ChangeSet {
  /** Absolute path → the text before sope's first change (null: no such file). */
  #before = new Map<string, string | null>();
  /** The working tree as last kept, once a command was allowed; also a cache of the text read. */
  #tree: Map<string, Kept> | null = null;
  #armed = false; // #tree is this turn's baseline
  #files: FileChange[] = [];
  #read: (path: string) => string | null;
  #list: () => string[];

  constructor(read = readText, list: (() => string[]) | undefined = undefined, private readonly directory = process.cwd()) {
    this.#read = read;
    this.#list = list ?? (() => listFiles(this.directory));
  }

  get files(): readonly FileChange[] {
    return this.#files;
  }

  get added(): number {
    return this.#files.reduce((n, f) => n + f.added, 0);
  }

  get removed(): number {
    return this.#files.reduce((n, f) => n + f.removed, 0);
  }

  /** A turn starts: forget what the last one changed. */
  reset(): void {
    this.#before.clear();
    this.#files = [];
    this.#armed = false;
  }

  /** What changed so far, as it stays. */
  toSet(): ChangeSet {
    return { files: [...this.#files], added: this.added, removed: this.removed };
  }

  /** Before write or edit: keeps the file as it is now, unless it already has a baseline. */
  track(path: string): void {
    if (!path) return;
    const file = resolve(this.directory, path);
    if (!this.#before.has(file)) this.#before.set(file, this.#read(file));
  }

  /** Before a command: keeps the working tree as it is now. */
  snapshot(): void {
    const next = new Map<string, Kept>();
    let budget = MAX_TOTAL;
    for (const file of this.#list()) {
      const st = statOf(file);
      if (!st) continue;
      const old = this.#tree?.get(file);
      const same = old && old.mtimeMs === st.mtimeMs && old.size === st.size;
      const text = same ? old.text : st.size <= MAX_FILE && budget > 0 ? this.#read(file) : undefined;
      budget -= text?.length ?? 0;
      next.set(file, { ...st, text: budget >= 0 ? text : undefined });
    }
    this.#tree = next;
    this.#armed = true;
  }

  /** After a command: the files that changed since the snapshot get their old text as baseline. */
  detect(): void {
    const tree = this.#tree;
    if (!tree || !this.#armed) return;
    const listed = new Set(this.#list());
    for (const file of listed) {
      if (this.#before.has(file)) continue;
      const old = tree.get(file);
      const st = statOf(file);
      if (!old) {
        if (st) this.#before.set(file, null); // created
      } else if ((!st || st.mtimeMs !== old.mtimeMs || st.size !== old.size) && old.text !== undefined) {
        this.#before.set(file, old.text);
      }
    }
    // Gone from the listing: deleted (or now ignored, which reads as unchanged below).
    for (const [file, old] of tree) {
      if (!listed.has(file) && !this.#before.has(file) && old.text !== undefined && !statOf(file)) this.#before.set(file, old.text);
    }
    this.refresh();
  }

  /** Diffs every file with a baseline against its current text; unchanged ones are left out. */
  refresh(): void {
    const files: FileChange[] = [];
    for (const [file, before] of this.#before) {
      const after = this.#read(file);
      if (after === before) continue;
      const diff = diffLines(splitLines(before ?? ""), splitLines(after ?? ""));
      let added = 0;
      let removed = 0;
      for (const l of diff) {
        if (l.kind === "add") added++;
        else if (l.kind === "remove") removed++;
      }
      if (!added && !removed) continue;
      files.push({ path: shown(file, this.directory), lang: langFor(file), lines: hunks(diff, CONTEXT), added, removed });
    }
    this.#files = files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function shown(file: string, directory: string): string {
  const rel = relative(directory, file);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  const home = homedir();
  return file.startsWith(home + "/") ? `~${file.slice(home.length)}` : file;
}
