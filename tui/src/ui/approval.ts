// SPDX-License-Identifier: MIT
// The permission prompt: a built-in tool asks to run (SOPE_EVENT_PERMISSION)
// and the session on screen waits for the answer. It shows what the call
// would do, a diff or the command, then the four answers.
//
//   ╭─ Permission required ───────────────────────────────────────╮
//   │ sope wants to run edit                                       │
//   │   12 - const limit = 10;                                     │
//   │   12 + const limit = 20;                                     │
//   │ Approve for me asks because it writes outside the working…   │
//   │                                                              │
//   │ › 1. Yes                                                     │
//   │   2. Yes, and don't ask again for file edits in this session │
//   │   3. No  sope is told and tries another way                  │
//   │   4. No, and stop  ends the turn                             │
//   ╰─────── ↑↓ select · enter confirm · y/a/n answer · esc stop ──╯

import { previewFor, type PreviewLine } from "../agent/tools";
import type { CellBuffer } from "../render/buffer";
import type { Approval, Decision, Session } from "../session";
import { palette, type Surfaces } from "../theme";
import { truncate } from "../unicode/width";
import { Highlighter, type TokenKind } from "./highlight";
import { drawChoices, step, type Choice, type Hints, type Popup, type PopupFrame, type Reply } from "./popup";

const MAX_PREVIEW_ROWS = 20;

/** The answers, in order (1-4). */
const DECISIONS: Decision[] = ["once", "always", "deny", "stop"];
const QUICK: Record<string, Decision> = { y: "once", a: "always", n: "deny" };

/** Keys that still reach the app while a prompt waits: scrolling, the trace, tabs. */
const PASS = new Set(["pageup", "pagedown", "ctrl+t", "f2", "ctrl+l", "alt+n", "alt+w"]);

/** What "don't ask again" covers, by tool. */
const KINDS: Record<string, string> = { bash: "commands", web_fetch: "web fetches", edit: "file edits", write: "writing files" };

const SYNTAX: Record<TokenKind, number | undefined> = {
  plain: undefined,
  keyword: 0xc678dd,
  string: 0x98c379,
  number: 0xd19a66,
  comment: 0x7f848e,
  type: 0xe5c07b,
};

const MARKS = { add: "+", remove: "-", context: " ", command: "$", gap: " ", plain: " " } as const;

const previewColor = (kind: PreviewLine["kind"]) =>
  kind === "add" ? palette.ok : kind === "remove" ? palette.error : kind === "command" ? palette.tool : palette.muted;

/** Rows besides the preview: the question, why it asks, a gap, the answers. */
const askingRows = (a: Approval) => 1 + (a.reason ? 1 : 0) + 1 + DECISIONS.length;

function previewRows(a: Approval, max: number): PreviewLine[] {
  const rows = previewFor(a.name, a.input);
  return rows.length > max ? [...rows.slice(0, max - 1), { text: `⋯ ${rows.length - max + 1} more lines`, kind: "gap" }] : rows;
}

export class ApprovalPrompt implements Popup {
  readonly title = "Permission required";
  readonly color = palette.tool;
  readonly hints: Hints = [["↑↓", "select"], ["enter", "confirm"], ["y/a/n", "answer"], ["esc", "stop"], ["shift+tab", "mode"]];
  #choice = { callId: -1, index: 0 };

  /** `session`: the session on screen; its first waiting request is the one shown. */
  constructor(readonly session: () => Session) {}

  get #approval(): Approval | undefined {
    return this.session().approvals[0];
  }

  /** The selected answer; a new request starts at "Yes". */
  get #selected(): number {
    const head = this.#approval;
    if (head && head.callId !== this.#choice.callId) this.#choice = { callId: head.callId, index: 0 };
    return this.#choice.index;
  }

  height(room: number): number {
    const a = this.#approval;
    if (!a) return 0;
    const asking = askingRows(a);
    return asking + previewRows(a, Math.max(0, Math.min(MAX_PREVIEW_ROWS, room - asking))).length;
  }

  key(id: string): Reply {
    const index = this.#selected;
    switch (id) {
      case "up":
      case "ctrl+p":
      case "k":
        this.#choice.index = step(index, -1, DECISIONS.length);
        return "handled";
      case "down":
      case "ctrl+n":
      case "j":
      case "tab":
        this.#choice.index = step(index, 1, DECISIONS.length);
        return "handled";
    }
    const decision =
      id === "enter" ? DECISIONS[index] : id === "escape" || id === "ctrl+c" ? "stop" : (DECISIONS[Number(id) - 1] ?? QUICK[id.toLowerCase()]);
    if (!decision) return PASS.has(id) || /^alt\+[1-9]$/.test(id) ? "ignored" : "handled";
    this.session().decide(decision);
    return "handled";
  }

  select(index: number): void {
    this.#choice = { callId: this.#approval?.callId ?? -1, index };
  }

  render(buf: CellBuffer, x: number, y: number, w: number, h: number, colors: Surfaces): PopupFrame {
    const a = this.#approval;
    if (!a) return { hits: [] };
    const preview = previewRows(a, h - askingRows(a));
    const waiting = this.session().approvals.length;
    const end = x + w;
    let cx = buf.text(x, y, `${a.subagent ? `subagent ${a.subagent} wants` : "sope wants"} to run `);
    cx = buf.text(cx, y, a.name, { fg: palette.tool, bold: true });
    if (waiting > 1) buf.text(cx, y, `  (+${waiting - 1} more waiting)`, { fg: palette.faint });

    // Diff lines: line number, +/- on a tinted row, highlighted code.
    const numWidth = Math.max(0, ...preview.map((l) => (l.no ? String(l.no).length : 0)));
    const code = preview.find((l) => l.lang)?.lang;
    const hl = code ? new Highlighter(code) : null;
    preview.forEach((line, i) => {
      const ry = y + 1 + i;
      const kind = line.kind ?? "plain";
      const tint = kind === "add" ? colors.added : kind === "remove" ? colors.removed : undefined;
      if (tint !== undefined) buf.fill(x + 2, ry, w - 2, 1, { bg: tint });
      let lx = x + 2;
      if (numWidth) lx = buf.text(lx, ry, `${line.no ? String(line.no).padStart(numWidth) : " ".repeat(numWidth)} `, { fg: palette.faint, bg: tint });
      lx = buf.text(lx, ry, `${MARKS[kind]} `, { fg: previewColor(line.kind), bg: tint, bold: kind === "add" || kind === "remove" });
      const text = line.text.replace(/\t/g, "  ");
      if (kind === "gap" || kind === "plain") return void buf.text(lx, ry, truncate(text, end - lx), { fg: palette.muted });
      if (!hl || !line.lang) return void buf.text(lx, ry, truncate(text, end - lx), { bg: tint });
      // Removed and added lines are both highlighted by the same pass; good enough for a preview.
      for (const tok of hl.line(text)) {
        if (lx >= end) break;
        lx = buf.text(lx, ry, tok.text, { fg: SYNTAX[tok.kind], bg: tint, italic: tok.kind === "comment", dim: kind === "remove" && tok.kind === "plain" }, end);
      }
    });

    let ry = y + 1 + preview.length;
    if (a.reason) buf.text(x, ry++, truncate(`Approve for me asks because ${a.reason}.`, w), { fg: palette.muted });
    const choices: Choice[] = [
      { label: "Yes" },
      { label: `Yes, and don't ask again for ${KINDS[a.name] ?? a.name} in this session` },
      { label: "No", detail: "sope is told and tries another way" },
      { label: "No, and stop", detail: "ends the turn" },
    ];
    return { hits: drawChoices(buf, x, ry + 1, w, choices, this.#selected) };
  }
}
