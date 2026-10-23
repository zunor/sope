// SPDX-License-Identifier: MIT
// Reads a shell command line the way bash would, far enough to judge it:
// the simple commands in it (split at ; && || | & and newlines, nested
// $( ), ` ` and <( ) included), each command's words after quoting, and the
// files its redirections write. Heredoc bodies are data and are skipped.
// "Approve for me" (permissions.ts) judges what comes out.

export interface SimpleCommand {
  words: string[];
  /** Files written by > and >> (fd duplications like 2>&1 are left out). */
  writes: string[];
  /** Its input comes from the command before it (|). */
  piped: boolean;
}

/** The ) that closes a group opened just before `from` (quotes skipped); -1 if none. */
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
export function splitCommand(cmd: string): { commands: SimpleCommand[] } | { unsafe: string } {
  const commands: SimpleCommand[] = [];
  const nested: SimpleCommand[] = [];
  let cur: SimpleCommand = { words: [], writes: [], piped: false };
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
