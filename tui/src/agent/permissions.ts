// SPDX-License-Identifier: MIT
// Permission modes: who answers when a built-in tool asks to change files,
// run a command or use the network (SOPE_EVENT_PERMISSION).
//
//   ask    Ask for approval  every such call waits for the user
//   auto   Approve for me    almost everything runs; only steps that are
//                            hard to undo or reach beyond the project ask
//                            (the default)
//   full   Full access       everything runs
//
// "Approve for me" lets work flow and stops for what matters: changing or
// deleting files outside the working directory (temporary directories
// excepted), deleting the whole directory or its .git, publishing (git
// push, npm publish, gh writes), throwing away uncommitted git work, sudo
// and system changes, global installs, remote machines (ssh), uploading
// data with curl, and piping a download into a shell. It reads commands the
// way a shell would, nested ones included, but it guards against mistakes,
// not against a hostile model: a script it lets run can still do anything.

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export type PermissionMode = "ask" | "auto" | "full";

export const MODES: Array<{ id: PermissionMode; label: string; description: string }> = [
  { id: "ask", label: "Ask for approval", description: "edits, commands and fetches wait for you" },
  { id: "auto", label: "Approve for me", description: "only risky steps ask: deleting outside this directory, git push, sudo…" },
  { id: "full", label: "Full access", description: "everything runs without asking" },
];

export const DEFAULT_MODE: PermissionMode = "auto";

export const modeLabel = (m: PermissionMode) => MODES.find((x) => x.id === m)!.label;

/** ask / auto / full, or a label ("full access", "approve-for-me"); null if neither. */
export function parseMode(text: string): PermissionMode | null {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  for (const m of MODES) if (t === m.id || t === m.label.toLowerCase()) return m.id;
  return ({ approve: "auto", "approve for me": "auto", allow: "full", "allow all": "full", prompt: "ask" } as Record<string, PermissionMode>)[t] ?? null;
}

/** Whether a call may run without asking, and why (shown in the trace, or in the prompt when it asks). */
export interface Verdict {
  allow: boolean;
  reason: string;
}

const yes = (reason: string): Verdict => ({ allow: true, reason });
const no = (reason: string): Verdict => ({ allow: false, reason });

/** Whether a call runs without asking in `mode`. */
export function judge(mode: PermissionMode, name: string, input: Record<string, unknown>, root = process.cwd()): Verdict {
  if (mode === "full") return yes("full access");
  if (mode === "ask") return no("every call asks");
  return assess(name, input, root);
}

/** What "Approve for me" says about one call. `root` is the working directory. */
export function assess(name: string, input: Record<string, unknown>, root = process.cwd()): Verdict {
  const v = assessIn(name, input, realRoot(root));
  if (v.allow || !BROAD.has(realRoot(root)) || !/outside|whole working/.test(v.reason)) return v;
  return no(`${v.reason}; sope runs in ${realRoot(root)}, too broad to count as a project`);
}

/** / and the home directory hold everything: as a working directory, nothing in them counts as inside. */
const BROAD = new Set(["/", realRoot(homedir())]);

function assessIn(name: string, input: Record<string, unknown>, root: string): Verdict {
  const base = BROAD.has(root) ? "\0no project" : root;
  switch (name) {
    case "write":
    case "edit": {
      const path = String(input.file_path ?? "");
      if (!path) return yes("no file given");
      return writable(path, base, base) ? yes("a file in the working directory") : no(`it writes outside the working directory (${path})`);
    }
    case "web_fetch":
      return yes("fetching a web page changes nothing here");
    case "bash":
      return assessCommand(String(input.command ?? ""), base, root);
    default:
      return yes(`${name} is not one sope checks`);
  }
}

// ---- shell commands -------------------------------------------------------

/** Programs that always ask, and why. */
const RISKY: Record<string, string> = {
  sudo: "it runs as root (sudo)",
  su: "it runs as another user (su)",
  doas: "it runs as root (doas)",
  dd: "dd writes raw data to devices",
  mkfs: "it formats a disk",
  diskutil: "it changes disks",
  fdisk: "it changes disk partitions",
  shutdown: "it shuts the machine down",
  reboot: "it restarts the machine",
  halt: "it stops the machine",
  chown: "chown changes who owns files",
  chgrp: "chgrp changes who owns files",
  killall: "killall stops every process with that name",
  launchctl: "it changes system services",
  systemctl: "it changes system services",
  crontab: "it changes scheduled jobs",
  osascript: "it scripts other applications",
  ssh: "it runs commands on another machine (ssh)",
  scp: "it copies to or from another machine (scp)",
  sftp: "it copies to or from another machine (sftp)",
  apt: "it installs system software (apt)",
  "apt-get": "it installs system software (apt-get)",
  yum: "it installs system software (yum)",
  dnf: "it installs system software (dnf)",
  pacman: "it installs system software (pacman)",
};

/** Programs that wrap another command: the wrapped one is what counts. */
const WRAPPERS = new Set(["time", "nice", "nohup", "env", "timeout", "xargs", "command", "builtin", "stdbuf", "exec", "caffeinate"]);

/** Reads a script from standard input when given no file. */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "python", "python3", "node", "ruby", "perl", "php", "bun", "deno"]);

/** Programs that write the files they are given. */
const WRITERS = new Set(["mkdir", "touch", "cp", "mv", "ln", "tee", "chmod", "install", "truncate"]);

interface Simple {
  words: string[];
  /** Files written by > and >> (fd duplications like 2>&1 are left out). */
  writes: string[];
  /** Its input comes from the command before it (|). */
  piped: boolean;
}

/** Commands nested in $( ), ` ` and <( ) are judged as commands of their own. */
function closing(cmd: string, from: number): number {
  let depth = 1;
  for (let j = from; j < cmd.length; j++) {
    const c = cmd[j]!;
    if (c === "\\") j++;
    else if (c === "'") {
      const end = cmd.indexOf("'", j + 1);
      if (end < 0) return -1;
      j = end;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

/** Splits a command line into simple commands; a reason instead when it cannot be read. */
export function splitCommand(cmd: string): { commands: Simple[] } | { unsafe: string } {
  const commands: Simple[] = [];
  const nested: Simple[] = [];
  let cur: Simple = { words: [], writes: [], piped: false };
  let word = "";
  let inWord = false; // "" is a word too
  let target: "write" | "read" | "heredoc" | null = null;
  const heredocs: Array<{ tag: string; strip: boolean }> = [];
  let strip = false;

  const endWord = () => {
    if (!inWord) return;
    if (target === "write") cur.writes.push(word);
    else if (target === "heredoc") heredocs.push({ tag: word, strip });
    else if (target === null) cur.words.push(word);
    target = null;
    word = "";
    inWord = false;
  };
  const endCommand = (piped = false) => {
    endWord();
    if (cur.words.length || cur.writes.length) commands.push(cur);
    cur = { words: [], writes: [], piped };
  };
  /** A nested command from `from` to `end` (exclusive): its commands are judged too; it reads as one word here. */
  const nest = (from: number, end: number): string | null => {
    const inner = splitCommand(cmd.slice(from, end));
    if ("unsafe" in inner) return inner.unsafe;
    nested.push(...inner.commands);
    word += "_";
    inWord = true;
    return null;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (c === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) return { unsafe: "sope could not read the command (a quote is not closed)" };
      word += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) word += cmd[++j];
        else if (cmd[j] === "$" && cmd[j + 1] === "(") {
          const end = closing(cmd, j + 2);
          if (end < 0) return { unsafe: "sope could not read the command" };
          const bad = nest(j + 2, end);
          if (bad) return { unsafe: bad };
          j = end;
        } else if (cmd[j] === "`") {
          const end = cmd.indexOf("`", j + 1);
          if (end < 0) return { unsafe: "sope could not read the command" };
          const bad = nest(j + 1, end);
          if (bad) return { unsafe: bad };
          j = end;
        } else word += cmd[j];
      }
      if (j >= cmd.length) return { unsafe: "sope could not read the command (a quote is not closed)" };
      inWord = true;
      i = j;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const end = closing(cmd, i + 2);
      if (end < 0) return { unsafe: "sope could not read the command" };
      if (c !== "$") endWord(); // <(cmd) and >(cmd) stand for a file
      const bad = nest(i + 2, end);
      if (bad) return { unsafe: bad };
      i = end;
      continue;
    }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end < 0) return { unsafe: "sope could not read the command" };
      const bad = nest(i + 1, end);
      if (bad) return { unsafe: bad };
      i = end;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "&" && next === ">") {
      // &> file and &>> file: both streams to a file
      endWord();
      i += cmd[i + 2] === ">" ? 2 : 1;
      target = "write";
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "{" || c === "}") {
      if ((c === "{" || c === "}") && inWord) {
        word += c; // a{b,c} and ${x} are words
        continue;
      }
      const pipe = c === "|" && next !== "|";
      if (c === "|" && next === "&") i++;
      endCommand(pipe);
      if (c === "\n" && heredocs.length) {
        // Skip each heredoc's body: it is data, not commands.
        for (const h of heredocs.splice(0)) {
          for (;;) {
            const lineEnd = cmd.indexOf("\n", i + 1);
            const line = cmd.slice(i + 1, lineEnd < 0 ? cmd.length : lineEnd);
            i = lineEnd < 0 ? cmd.length : lineEnd;
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag || lineEnd < 0) break;
          }
        }
      }
      continue;
    }
    if (c === ">" || c === "<") {
      // A number right before (2>, 1>>) names the descriptor, it is not a word.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (c === "<") {
        if (next === "<" && cmd[i + 2] === "<") {
          i += 2; // <<< word: a string as input
          target = "read";
        } else if (next === "<") {
          i++;
          strip = cmd[i + 1] === "-";
          if (strip) i++;
          target = "heredoc";
        } else target = "read";
        continue;
      }
      if (next === ">" || next === "|") i++;
      if (cmd[i + 1] === "&") {
        // >&2, 2>&1: duplicates a descriptor
        i++;
        while (/[\d-]/.test(cmd[i + 1] ?? "")) i++;
        continue;
      }
      target = "write";
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand();
  return { commands: [...commands, ...nested] };
}

/**
 * Judges a whole command line: it asks if any command in it should. `root`
 * is the project; `cwd`, where the command starts, defaults to it.
 */
export function assessCommand(cmd: string, root: string, start = root): Verdict {
  if (!cmd.trim()) return yes("an empty command");
  const split = splitCommand(cmd);
  if ("unsafe" in split) return no(split.unsafe);
  let cwd = start;
  let prev: string[] = [];
  for (const c of split.commands) {
    const words = strip(c.words);
    if (c.piped && words.length && INTERPRETERS.has(base(words[0]!)) && words.length === 1 && ["curl", "wget"].includes(base(prev[0] ?? "")))
      return no("it runs a script downloaded from the network");
    const v = assessSimple(c, words, root, cwd);
    if (!v.allow) return v;
    if (v.cd) cwd = v.cd;
    prev = words;
  }
  return yes("nothing risky");
}

const base = (program: string) => program.slice(program.lastIndexOf("/") + 1);

/** Without assignments in front and the keywords around commands. */
function strip(words: string[]): string[] {
  const out = [...words];
  for (;;) {
    if (out.length && /^[A-Za-z_]\w*=/.test(out[0]!)) out.shift();
    else if (out.length && ["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "case", "esac", "in", ";;"].includes(out[0]!)) out.shift();
    else return out;
  }
}

function assessSimple(c: Simple, words: string[], root: string, cwd: string): Verdict & { cd?: string } {
  for (const w of c.writes) {
    if (!w.startsWith("/dev/") && !writable(w, root, cwd)) return no(`it writes outside the working directory (${w})`);
  }
  return words.length ? assessProgram(words, root, cwd) : yes("nothing to run");
}

function assessProgram(words: string[], root: string, cwd: string): Verdict & { cd?: string } {
  const [program, ...args] = words as [string, ...string[]];
  const name = base(program);
  const operands = args.filter((a) => !a.startsWith("-"));
  const has = (...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
  const outside = (paths: string[]) => paths.find((p) => !writable(p, root, cwd));

  if (name in RISKY) return no(RISKY[name]!);
  if (name.startsWith("mkfs")) return no("it formats a disk");
  if (WRAPPERS.has(name)) return unwrap(name, args, root, cwd);

  switch (name) {
    case "cd": {
      // Later relative paths are judged from the new directory.
      const to = operands[0] ?? "~";
      return { ...yes("cd"), cd: resolve(cwd, to.startsWith("~") ? homedir() + to.slice(1) : to) };
    }
    case "rm":
    case "unlink":
    case "shred":
    case "rmdir": {
      const out = outside(operands);
      if (out) return no(`it deletes outside the working directory (${out})`);
      for (const p of operands) {
        const abs = within(p, root, cwd);
        if (abs === root || (/^(\.\/)?\*$/.test(p) && resolve(cwd) === root)) return no("it deletes the whole working directory");
        if (abs && /(^|\/)\.git$/.test(abs)) return no("it deletes the repository's history (.git)");
      }
      return yes(name);
    }
    case "find": {
      // -exec runs a command of its own; -delete deletes under the starting points.
      const at = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
      if (at >= 0) {
        let end = args.findIndex((a, k) => k > at && (a === ";" || a === "+"));
        if (end < 0) end = args.length;
        const v = assessProgram(args.slice(at + 1, end).map((a) => (a === "{}" ? "." : a)), root, cwd);
        if (!v.allow) return v;
      }
      if (has("-delete")) {
        const first = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
        const starts = first < 0 ? args : args.slice(0, first);
        const out = outside(starts.length ? starts : ["."]);
        if (out) return no(`find -delete deletes outside the working directory (${out})`);
      }
      return yes("find");
    }
    case "sed":
    case "gsed":
      if (args.some((a) => a.startsWith("-i") || a.startsWith("--in-place"))) {
        const out = outside(operands.slice(1));
        if (out) return no(`it edits a file outside the working directory (${out})`);
      }
      return yes("sed");
    case "cp":
    case "mv":
    case "ln":
    case "install": {
      // Only where it writes counts (the last operand); mv also removes its sources.
      const targets = name === "mv" ? operands : operands.slice(-1);
      const out = outside(targets);
      return out ? no(`${name} changes files outside the working directory (${out})`) : yes(name);
    }
    case "rsync": {
      if (operands.some((p) => /^[^/]*:/.test(p))) return no("it copies to or from another machine (rsync)");
      const out = outside(operands.slice(-1));
      return out ? no(`rsync changes files outside the working directory (${out})`) : yes("rsync");
    }
    case "eval":
      return assessCommand(args.join(" "), root, cwd);
    case "curl":
      if (has("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "-T", "--upload-file"))
        return no("it sends data to the network (curl)");
      if (args.some((a, k) => (a === "-X" || a === "--request") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[k + 1] ?? "")) || args.some((a) => /^-X(POST|PUT|PATCH|DELETE)$/i.test(a)))
        return no("it sends a request that changes something (curl)");
      return curlOutput(args, root, cwd);
    case "wget":
      if (has("--post-data", "--post-file", "--method", "--body-data", "--body-file")) return no("it sends data to the network (wget)");
      return yes("wget");
    case "git":
      return assessGit(args);
    case "gh": {
      const [group = "", action = ""] = operands;
      if (group === "api") return has("-X", "--method", "-f", "-F", "--field", "--raw-field", "--input") ? no("it changes something on GitHub (gh api)") : yes("gh api");
      if (["auth", "status", "search", "browse", "help", "version", "completion"].includes(group)) return yes("gh");
      return ["view", "list", "status", "diff", "checks", "", "--help"].includes(action) ? yes("gh") : no(`gh ${group} ${action} changes something on GitHub`);
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const sub = operands[0] ?? "";
      if (sub === "publish") return no(`${name} publish publishes a package`);
      if (has("-g", "--global") || (name === "yarn" && sub === "global")) return no(`it installs packages globally (${name} -g)`);
      return yes(name);
    }
    case "cargo":
      if (operands[0] === "publish") return no("cargo publish publishes a crate");
      return operands[0] === "install" ? no("cargo install installs a program for the whole user") : yes("cargo");
    case "go":
      return operands[0] === "install" ? no("go install installs a program for the whole user") : yes("go");
    case "pip":
    case "pip3":
      return has("--user", "--break-system-packages") ? no("it installs packages for the whole user") : yes(name);
    case "brew":
      return ["install", "uninstall", "remove", "rm", "upgrade", "reinstall", "tap", "untap", "services", "link", "unlink", "cleanup", "autoremove"].includes(operands[0] ?? "")
        ? no(`brew ${operands[0]} changes installed software`)
        : yes("brew");
    case "kubectl":
    case "helm":
    case "terraform":
    case "tofu":
    case "pulumi": {
      const sub = operands[0] ?? "";
      return ["get", "describe", "logs", "version", "plan", "show", "list", "ls", "status", "explain", "top", "validate", "fmt", "init", "preview", "template", "lint", "search", "config", "output", ""].includes(sub)
        ? yes(name)
        : no(`${name} ${sub} changes live infrastructure`);
    }
    case "docker":
    case "podman":
      return operands[0] === "system" && operands[1] === "prune" ? no("it deletes images and volumes") : yes(name);
  }
  if (WRITERS.has(name)) {
    const out = outside(operands.filter((p, k) => !(name === "chmod" && k === 0) && !(name === "truncate" && /^\d/.test(p))));
    return out ? no(`${name} changes files outside the working directory (${out})`) : yes(name);
  }
  if ((name === "sh" || name === "bash" || name === "zsh") && args.includes("-c")) return assessCommand(args[args.indexOf("-c") + 1] ?? "", root, cwd);
  return yes(name);
}

/** curl -o / --output writes a file. */
function curlOutput(args: string[], root: string, cwd: string): Verdict {
  for (let k = 0; k < args.length; k++) {
    if ((args[k] === "-o" || args[k] === "--output") && args[k + 1] && args[k + 1] !== "-" && !writable(args[k + 1]!, root, cwd))
      return no(`it writes outside the working directory (${args[k + 1]})`);
  }
  return yes("curl");
}

function unwrap(name: string, args: string[], root: string, cwd: string): Verdict {
  const rest = [...args];
  const take = (withValue: string[]) => {
    while (rest.length && rest[0]!.startsWith("-")) {
      const opt = rest.shift()!;
      if (withValue.includes(opt)) rest.shift();
    }
  };
  if (name === "env") {
    take(["-u", "-S", "-C"]);
    while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0]!)) rest.shift();
  } else if (name === "timeout") {
    take(["-s", "-k", "--signal", "--kill-after"]);
    rest.shift(); // the duration
  } else if (name === "xargs") take(["-n", "-I", "-i", "-P", "-L", "-l", "-d", "-s", "-E", "-a"]);
  else if (name === "nice") take(["-n"]);
  else take([]);
  return rest.length ? assessProgram(rest, root, cwd) : yes(name);
}

function assessGit(args: string[]): Verdict {
  const rest = [...args];
  while (rest.length && rest[0]!.startsWith("-")) {
    const opt = rest.shift()!;
    if (opt === "-C" || opt === "-c") rest.shift();
  }
  const [sub = "", ...more] = rest;
  const has = (...f: string[]) => more.some((x) => f.includes(x) || f.some((g) => g.startsWith("--") && x.startsWith(`${g}=`)));
  switch (sub) {
    case "push":
      return no("git push publishes commits");
    case "reset":
      return has("--hard", "--merge", "--keep") ? no(`git reset ${more.find((m) => m.startsWith("--"))} throws away uncommitted changes`) : yes("git reset");
    case "clean":
      return more.some((m) => /^-[a-zA-Z]*f/.test(m) || m === "--force") ? no("git clean deletes untracked files") : yes("git clean");
    case "checkout":
      return more.includes("--") || more.includes(".") || has("-f", "--force", "-p", "--patch") ? no("git checkout throws away changes to files") : yes("git checkout");
    case "restore":
      return more.every((m) => m !== "--worktree" && m !== "-W") && has("--staged", "-S") ? yes("git restore --staged") : no("git restore throws away changes to files");
    case "switch":
      return has("--discard-changes", "-f", "--force") ? no("it throws away changes to files") : yes("git switch");
    case "branch":
      return has("-D", "--force") || (has("-d", "--delete") && has("-f")) ? no("it deletes a branch that may not be merged") : yes("git branch");
    case "stash":
      return more[0] === "drop" || more[0] === "clear" ? no(`git stash ${more[0]} deletes stashed work`) : yes("git stash");
    case "filter-branch":
    case "filter-repo":
      return no(`git ${sub} rewrites the whole history`);
    case "reflog":
      return more[0] === "expire" || more[0] === "delete" ? no("it deletes the reflog, the way back to lost commits") : yes("git reflog");
    case "gc":
      return more.some((m) => m.startsWith("--prune")) ? no("it can delete unreachable commits for good") : yes("git gc");
    case "update-ref":
      return has("-d") ? no("it deletes a ref") : yes("git update-ref");
    default:
      return yes(`git ${sub}`);
  }
}

/** Where commands may write freely besides the working directory. */
const TEMP = (() => {
  const dirs = new Set<string>();
  for (const d of [tmpdir(), "/tmp", "/var/tmp", "/private/tmp"]) {
    try {
      dirs.add(realpathSync(d));
    } catch {
      // not on this system
    }
  }
  return [...dirs];
})();

/** Inside the working directory, or a temporary directory. */
export function writable(path: string, root: string, cwd: string): boolean {
  return within(path, root, cwd) !== null || TEMP.some((t) => within(path, t, cwd) !== null);
}

// ---- paths ------------------------------------------------------------------

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * The absolute path of `path` (relative to `cwd`) if it is inside `root`,
 * else null. ~ counts as outside. Symlinks are followed as far as the path
 * exists, so a link pointing out of the directory is caught.
 */
export function within(path: string, root: string, cwd: string): string | null {
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  else if (path.startsWith("~")) return null; // ~user: someone else's home
  let abs = resolve(cwd, path);
  // Follow links in the part that exists.
  let existing = abs;
  let tail = "";
  for (;;) {
    try {
      const real = realpathSync(existing);
      abs = tail ? `${real}/${tail}` : real;
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      tail = tail ? `${existing.slice(parent.length + 1)}/${tail}` : existing.slice(parent.length + 1);
      existing = parent;
    }
  }
  return abs === root || abs.startsWith(root.endsWith("/") ? root : `${root}/`) ? abs : null;
}
