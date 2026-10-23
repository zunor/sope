// SPDX-License-Identifier: MIT
// Line diffs for previews: the longest common subsequence of the lines that
// differ (after trimming the common start and end), grouped into hunks with
// a few lines of context.

export interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
  /** Line number in the old (remove, context) or new (add) text, from 1. */
  no: number;
}

export type HunkLine = DiffLine | { kind: "gap"; skipped: number };

const MAX_CELLS = 250_000; // LCS table size beyond which changes show as one block

export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "context", text: a[i]!, no: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n * m <= MAX_CELLS) {
    // lcs[i][j]: common lines of a[start+i..endA) and b[start+j..endB)
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] = a[start + i] === b[start + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ kind: "context", text: a[start + i]!, no: start + i + 1 });
        i++, j++;
      } else if (j < m && (i === n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
        out.push({ kind: "add", text: b[start + j]!, no: start + j + 1 });
        j++;
      } else {
        out.push({ kind: "remove", text: a[start + i]!, no: start + i + 1 });
        i++;
      }
    }
    // Show removals before the additions that replace them.
    for (let k = 1; k < out.length; k++) {
      let r = k;
      while (r > 0 && out[r]!.kind === "remove" && out[r - 1]!.kind === "add") {
        [out[r - 1], out[r]] = [out[r]!, out[r - 1]!];
        r--;
      }
    }
  } else {
    for (let i = start; i < endA; i++) out.push({ kind: "remove", text: a[i]!, no: i + 1 });
    for (let j = start; j < endB; j++) out.push({ kind: "add", text: b[j]!, no: j + 1 });
  }
  for (let i = endA; i < a.length; i++) out.push({ kind: "context", text: a[i]!, no: i + 1 });
  return out;
}

/** The changes with `context` lines around each; runs of unchanged lines between become gaps. */
export function hunks(lines: DiffLine[], context = 3): HunkLine[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true;
  });
  const out: HunkLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (near[i]) {
      if (skipped) out.push({ kind: "gap", skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "gap", skipped });
  return out;
}

/** Splits text into lines; a final newline does not start another line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}
