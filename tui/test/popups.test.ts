// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import type { PermissionMode } from "../src/agent/permissions";
import { CellBuffer } from "../src/render/buffer";
import type { Approval, Decision, Session } from "../src/session";
import { surfaces } from "../src/theme";
import { ApprovalPrompt } from "../src/ui/approval";
import type { Effort } from "../src/agent/effort";
import { EffortPicker } from "../src/ui/effort";
import { ModePicker } from "../src/ui/modes";
import { SessionList } from "../src/ui/sessions";

const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("");

function asking(approvals: Approval[]) {
  const decided: Decision[] = [];
  const session = { approvals, decide: (d: Decision) => decided.push(d) } as unknown as Session;
  return { prompt: new ApprovalPrompt(() => session), decided };
}

test("the permission prompt answers by key, lets tab and scroll keys through, and swallows the rest", () => {
  const { prompt, decided } = asking([{ callId: 1, turnId: 1, name: "bash", input: { command: "git push" }, reason: "git push publishes commits" }]);
  expect(prompt.key("y")).toBe("handled");
  expect(prompt.key("3")).toBe("handled");
  expect(prompt.key("down")).toBe("handled");
  expect(prompt.key("enter")).toBe("handled");
  expect(prompt.key("escape")).toBe("handled");
  expect(decided).toEqual(["once", "deny", "always", "stop"]);
  expect(prompt.key("alt+2")).toBe("ignored");
  expect(prompt.key("pageup")).toBe("ignored");
  expect(prompt.key("x")).toBe("handled");
  expect(decided).toHaveLength(4);
});

test("a new request starts at Yes, and the prompt draws the command, the reason and the answers", () => {
  const approvals: Approval[] = [{ callId: 1, turnId: 1, name: "bash", input: { command: "git push" }, reason: "git push publishes commits" }];
  const { prompt, decided } = asking(approvals);
  prompt.select(2);
  approvals[0] = { callId: 2, turnId: 1, name: "edit", input: { file_path: "a.c", old_string: "x", new_string: "y" } };
  prompt.key("enter");
  expect(decided).toEqual(["once"]);

  approvals[0] = { callId: 3, turnId: 1, name: "bash", input: { command: "git push" }, reason: "git push publishes commits" };
  const h = prompt.height(30);
  const buf = new CellBuffer(70, h);
  const { hits } = prompt.render(buf, 0, 0, 70, h, surfaces(null));
  const text = Array.from({ length: h }, (_, y) => row(buf, y)).join("\n");
  expect(text).toContain("sope wants to run bash");
  expect(text).toContain("$ git push");
  expect(text).toContain("Approve for me asks because git push publishes commits.");
  expect(text).toContain("don't ask again for commands");
  expect(hits.map((hit) => hit.index)).toEqual([0, 1, 2, 3]);
});

test("the mode picker moves, picks by enter or number, and closes", () => {
  let mode: PermissionMode = "auto";
  const picked: PermissionMode[] = [];
  const picker = new ModePicker(
    () => mode,
    (m) => picked.push(m),
  );
  expect(picker.key("down")).toBe("handled");
  expect(picker.key("enter")).toBe("close");
  expect(picker.key("1")).toBe("close");
  expect(picker.key("z")).toBe("handled");
  expect(picker.key("escape")).toBe("close");
  expect(picked).toEqual(["full", "ask"]);

  mode = "ask";
  picker.follow();
  picker.key("enter");
  expect(picked.at(-1)).toBe("ask");
});

test("the session list opens what enter or a click picks, and closes on a click outside", () => {
  const opened: string[] = [];
  const list = new SessionList(
    [
      { id: "a", title: "first", updated: 1, messages: 1, open: false },
      { id: "b", title: "second", updated: 2, messages: 1, open: false },
    ],
    "~/w",
    (id) => opened.push(id),
  );
  expect(list.key("down")).toBe("handled");
  expect(list.key("enter")).toBe("close");
  const buf = new CellBuffer(90, 20);
  list.render(buf, { x: 0, y: 0, w: 90, h: 20 }, surfaces(null), 10);
  const y = Array.from({ length: 20 }, (_, i) => i).find((r) => row(buf, r).includes("second"))!;
  expect(list.click(30, y)).toBe("close");
  expect(list.click(0, 19)).toBe("close");
  expect(opened).toEqual(["a", "b"]);
});

test("the effort slider moves with arrows, clamps at its ends, and picks by enter or number", () => {
  const picked: Effort[] = [];
  const picker = new EffortPicker("high", "glm-5.3", (e) => picked.push(e));
  expect(picker.title).toBe("Reasoning effort · glm-5.3");
  expect(picker.selected).toBe("high");
  picker.key("right");
  picker.key("right"); // already at the end
  expect(picker.selected).toBe("xhigh");
  picker.key("home");
  picker.key("left");
  expect(picker.selected).toBe("");
  picker.wheel(-1);
  expect(picker.selected).toBe("low");
  expect(picker.key("x")).toBe("handled");
  expect(picker.key("enter")).toBe("close");
  expect(picker.key("3")).toBe("close");
  expect(picker.key("escape")).toBe("close");
  expect(picked).toEqual(["low", "medium"]);
  expect(new EffortPicker("minimal", "", () => {}).selected).toBe(""); // not on the slider
});

test("the effort slider draws labels over a track lit up to the selection", () => {
  const picker = new EffortPicker("medium", "m", () => {});
  picker.key("right"); // high
  const buf = new CellBuffer(60, 6);
  const { hits } = picker.render(buf, 0, 0, 60, picker.height(10));
  const text = Array.from({ length: 6 }, (_, y) => row(buf, y).trimEnd());
  expect(text[0]).toBe("");
  expect(text[1]).toMatch(/^ *Default +Low +Medium ✓ +High +Extra high$/);
  expect(text[2]).toMatch(/^ *○─+○─+○─+●─+○$/);
  expect(text[2]!.indexOf("●")).toBe(text[1]!.indexOf("High") + 2);
  expect(text[4]).toContain("Thinks longer before answering");
  expect(new Set(hits.map((h) => h.index))).toEqual(new Set([0, 1, 2, 3, 4]));
  const onHigh = hits.find((h) => h.index === 3 && h.y === 2)!;
  expect(onHigh.x0 <= text[2]!.indexOf("●") && text[2]!.indexOf("●") < onHigh.x1).toBe(true);

  const narrow = new CellBuffer(30, 6);
  picker.render(narrow, 0, 0, 30, 6);
  expect(row(narrow, 1).trim()).toBe("High"); // stops too close for every label
});
