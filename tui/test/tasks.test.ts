// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { CellBuffer } from "../src/render/buffer";
import { Session, type ShellTask } from "../src/session";
import { surfaces } from "../src/theme";
import { ChatView, type Message } from "../src/ui/chat";
import { drawTaskSummary, formatBytes, TaskPanel } from "../src/ui/tasks";

const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();
const rows = (buf: CellBuffer) => Array.from({ length: buf.height }, (_, y) => row(buf, y));

function agent(patch: Partial<Message>): Message {
  return { id: 1, version: 0, role: "subagent", title: "explore", detail: "find the callers", text: "", steps: [], ...patch } as Message;
}

const shell = (patch: Partial<ShellTask>): ShellTask => ({
  id: 1, command: "bun run dev", running: true, exit_code: null, stopped: false, output_bytes: 2150, tail: "ready on :3000\n", seenAt: 0, ...patch,
});

/** A stand-in for the session on screen: what the panel and strip read, and the stops they ask for. */
function fake(agents: Message[], shells: ShellTask[] = []) {
  const stops: Array<[string, number, string?]> = [];
  const session = {
    agents,
    shells: () => shells,
    busy: true,
    turnStarted: performance.now() - 92_000,
    activity: () => ({ verb: "Running 2 tools", color: 0 }),
    stopSubagent: (id: number, note: string) => (stops.push(["agent", id, note]), true),
    stopShell: (id: number) => (stops.push(["shell", id]), true),
  } as unknown as Session;
  return { session, stops };
}

test("a subagent takes one row, running or finished", () => {
  const chat = new ChatView();
  const now = performance.now();
  chat.add({
    role: "subagent", title: "explore", detail: "find the callers", text: "", streaming: true, startedAt: now - 12_400, tokens: 3100,
    steps: [{ name: "read", detail: "src/auth.ts", done: true, ok: true }, { name: "grep", detail: "verifyToken", done: false }],
  });
  chat.add({ role: "subagent", title: "general", detail: "update the changelog", text: "The user stopped this subagent.", ok: false, stopped: true, startedAt: 0, endedAt: 48_000, steps: [{ name: "read", detail: "CHANGELOG.md", done: true }] });
  const buf = new CellBuffer(80, 6);
  chat.render(buf, { x: 0, y: 0, w: 80, h: 6 }, "*");
  expect(rows(buf)).toEqual([
    expect.stringMatching(/^\* agent · explore {2}find the callers +12s · 2 tools · 3\.1k tok$/),
    "",
    expect.stringMatching(/^✕ agent · general {2}update the changelog +48s · 1 tool · stopped$/),
    "", "", "",
  ]);
  expect(chat.toggleAt(4, 0)).toBe(false); // a running one has nothing to unfold
  expect(chat.toggleAt(4, 2)).toBe(true);
  chat.render(buf, { x: 0, y: 0, w: 80, h: 6 }, "*");
  expect(row(buf, 3)).toBe("    ● read  CHANGELOG.md");
  expect(row(buf, 4)).toBe("  ⎿ The user stopped this subagent.");
});

test("the footer summary counts what runs and what finished, and is absent when nothing runs", () => {
  const { session } = fake([agent({ streaming: true }), agent({ streaming: true }), agent({ ok: true }), agent({ ok: false, stopped: true })], [shell({}), shell({ id: 2, running: false, exit_code: 0 })]);
  const buf = new CellBuffer(70, 1);
  const hit = drawTaskSummary(buf, 4, 0, 70, session, "*");
  expect(row(buf, 0)).toBe("     · * 2 agents · ✓ 1 · ✕ 1 · ◑ 1 shell");
  expect(hit).toEqual({ x0: 4, x1: 41 });
  const idle = fake([agent({ ok: true })], [shell({ running: false, exit_code: 0 })]).session;
  expect(drawTaskSummary(new CellBuffer(70, 1), 0, 0, 70, idle, "*")).toBeNull();
});

test("the panel draws the tree with the selected task opened", () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ name: "read", detail: `file${i}`, done: true, ok: true }));
  const { session } = fake([agent({ agentId: 7, streaming: true, startedAt: performance.now() - 1000, steps }), agent({ agentId: 9, title: "general", detail: "tests", ok: true, startedAt: 0, endedAt: 3000 })], [shell({})]);
  const panel = new TaskPanel(() => session);
  const h = panel.height(30);
  const buf = new CellBuffer(72, h);
  const { hits } = panel.render(buf, 0, 0, 72, h, surfaces(null));
  const text = rows(buf);
  expect(text[0]).toMatch(/^. sope {2}Running 2 tools +1m 32s$/);
  expect(text[1]).toMatch(/^├ . explore {2}find the callers +1s · 8 tools$/);
  expect(text[2]).toBe("│   ├ … 2 earlier tool calls");
  expect(text[3]).toBe("│   ├ ● read  file2");
  expect(text[8]).toBe("│   └ ● read  file7");
  expect(text[9]).toMatch(/^├ ● general {2}tests +3s$/);
  expect(text[10]).toMatch(/^└ ◑ shell 1 {2}bun run dev +\d+.* · 2\.1 KB$/);
  expect(hits.map((h) => h.index)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);

  panel.key("down");
  panel.key("down");
  const buf2 = new CellBuffer(72, panel.height(30));
  panel.render(buf2, 0, 0, 72, buf2.height, surfaces(null));
  expect(rows(buf2).join("\n")).toContain("    └ │ ready on :3000");
  expect(rows(buf2).join("\n")).not.toContain("file7");
});

test("x stops a shell at once, and a subagent after asking for a note", () => {
  const { session, stops } = fake([agent({ agentId: 7, streaming: true }), agent({ agentId: 9, ok: true })], [shell({ id: 4 })]);
  const notices: string[] = [];
  const panel = new TaskPanel(() => session, (t) => notices.push(t));
  expect(panel.hints.map(([k]) => k)).toContain("x");
  expect(panel.type("x")).toBe("handled");
  expect(panel.hints).toEqual([["enter", "stop"], ["esc", "keep running"]]);
  panel.type("look in ");
  panel.type("src/");
  panel.key("backspace");
  const buf = new CellBuffer(72, panel.height(30));
  const frame = panel.render(buf, 0, 0, 72, buf.height, surfaces(null));
  expect(rows(buf).at(-2)).toContain("Stop explore?");
  expect(rows(buf).at(-1)).toBe("› look in src");
  expect(frame.cursor).toEqual({ x: 13, y: buf.height - 1 }); // after "› look in src"
  panel.key("enter");
  expect(stops).toEqual([["agent", 7, "look in src"]]);

  panel.key("down"); // the finished one cannot be stopped
  expect(panel.hints.map(([k]) => k)).not.toContain("x");
  panel.key("x");
  expect(notices.at(-1)).toContain("already finished");
  panel.key("down");
  panel.key("x");
  expect(stops.at(-1)).toEqual(["shell", 4]);
  expect(panel.key("pageup")).toBe("ignored");
  expect(panel.key("escape")).toBe("close");
});

test("escape in the note leaves the subagent running", () => {
  const { session, stops } = fake([agent({ agentId: 7, streaming: true })]);
  const panel = new TaskPanel(() => session);
  panel.key("x");
  expect(panel.key("escape")).toBe("handled");
  expect(stops).toEqual([]);
  expect(panel.key("escape")).toBe("close");
});

test("byte counts read like file sizes", () => {
  expect([formatBytes(512), formatBytes(2150), formatBytes(3 * 1024 * 1024)]).toEqual(["512 B", "2.1 KB", "3.0 MB"]);
});

test("a session stops one subagent and the turn goes on with its sibling", async () => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let stopped = false;
  const session: Session = new Session(loadConfig({ provider: "mock" }, {}, {}), () => "full", (s, events) => {
    // Stop the long sleeper as soon as both children are under way.
    if (!stopped && s.agents.length === 2 && s.agents.every((m) => m.steps?.length)) {
      const slow = s.agents.find((m) => m.steps![0]!.detail.includes("5"))!;
      stopped = s.stopSubagent(slow.agentId!, "not needed");
    }
    if (events.some((e) => e.type === "turn_end" && !e.agentId)) finish();
  });
  try {
    session.setOption("mock.delay_ms", "0");
    session.send("!agent !sleep 5 | !sleep 0.05");
    const finished = await Promise.race([done.then(() => true), Bun.sleep(3000).then(() => false)]);
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    const [slow, quick] = [...session.agents].sort((a, b) => Number(b.stopped ?? false) - Number(a.stopped ?? false));
    expect(slow).toMatchObject({ stopped: true, ok: false, streaming: false });
    expect(slow!.text).toContain("Their note: not needed");
    expect(quick).toMatchObject({ ok: true, streaming: false });
    expect(session.stopSubagent(slow!.agentId!)).toBe(false);
  } finally {
    await session.shutdown();
  }
}, 6000);

test("a session lists its background shells and stops one", async () => {
  let turns = 0;
  const session = new Session(loadConfig({ provider: "mock" }, {}, {}), () => "full", (_s, events) => {
    turns += events.filter((e) => e.type === "turn_end" && !e.agentId).length;
  });
  try {
    session.setOption("mock.delay_ms", "0");
    expect(session.shells()).toEqual([]); // nothing went to the background: libsope is not asked
    session.send('!bash {"command":"echo up; sleep 30","run_in_background":true}');
    for (let i = 0; i < 100 && !turns; i++) await Bun.sleep(20);
    let t = performance.now();
    const later = () => (t += 1000); // past the poll interval at every call
    let list = session.shells(later());
    for (let i = 0; i < 50 && !list[0]?.output_bytes; i++) { await Bun.sleep(20); list = session.shells(later()); }
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, command: "echo up; sleep 30", running: true, tail: "up\n" });
    expect(session.stopShell(1)).toBe(true);
    for (let i = 0; i < 100 && session.shells(later())[0]?.running; i++) await Bun.sleep(20);
    expect(session.shells(later())[0]).toMatchObject({ running: false, stopped: true });
    expect(session.stopShell(9)).toBe(false);
  } finally {
    await session.shutdown();
  }
}, 8000);

test("a short panel scrolls to keep the selected task in view", () => {
  const many = Array.from({ length: 6 }, (_, i) => agent({ agentId: i + 1, title: `t${i + 1}`, ok: true, steps: [{ name: "read", detail: `f${i}`, done: true }] }));
  const { session } = fake(many);
  const panel = new TaskPanel(() => session);
  for (let i = 0; i < 5; i++) panel.key("down");
  const buf = new CellBuffer(60, 3);
  const { hits } = panel.render(buf, 0, 0, 60, 3, surfaces(null));
  expect(rows(buf)).toEqual([expect.stringContaining("t5"), expect.stringMatching(/^└ ● t6/), "    └ ● read  f5"]);
  expect(hits.map((h) => h.index)).toEqual([4, 5, 5]);
  const narrow = new CellBuffer(24, panel.height(30));
  panel.render(narrow, 0, 0, 24, narrow.height, surfaces(null)); // nothing spills past its width
  expect(rows(narrow).every((r) => r.length <= 24)).toBe(true);
});

test("a search hit in a folded subagent's report unfolds it", () => {
  const chat = new ChatView();
  chat.add({ role: "subagent", title: "general", text: "found the needle", ok: true, startedAt: 0, endedAt: 1000, steps: [{ name: "grep", detail: "hay", done: true }] });
  const buf = new CellBuffer(60, 6);
  chat.render(buf, { x: 0, y: 0, w: 60, h: 6 }, "*");
  expect(rows(buf).join("\n")).not.toContain("needle");
  chat.startSearch();
  chat.setQuery("needle");
  chat.render(buf, { x: 0, y: 0, w: 60, h: 6 }, "*");
  expect(chat.searchStatus).toEqual({ index: 1, total: 1 });
  expect(rows(buf).join("\n")).toContain("⎿ found the needle");
});
