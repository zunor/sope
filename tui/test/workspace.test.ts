// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { COMMANDS, helpText, runCommand, type CommandHost } from "../src/commands";
import type { Session } from "../src/session";
import { Workspace } from "../src/workspace";

let clock = 0;

/** What Workspace and the commands touch of a session. */
function fakeSession(title: string) {
  const s = {
    title,
    id: title,
    busy: false,
    approvals: [] as unknown[],
    unread: true,
    lastUsed: 0,
    stopped: false,
    deleted: false,
    messages: [] as Array<{ role: string; text: string }>,
    options: [] as Array<[string, string | null]>,
    hostTools: [],
    alwaysAllowed: new Set<string>(),
    chat: { add: (m: { role: string; text: string }) => s.messages.push(m) },
    shutdown: async () => void (s.stopped = true),
    delete: () => void (s.deleted = true),
    setOption: (key: string, value: string | null) => s.options.push([key, value]),
  };
  return s;
}

function workspace(max = 3) {
  let n = 0;
  const w = new Workspace(null, "/w", max, () => fakeSession(`s${++n}`) as unknown as Session);
  const realNow = performance.now;
  performance.now = () => ++clock;
  return { w, restore: () => (performance.now = realNow) };
}

test("tabs: a new session goes on screen, and one too many puts away the least recently used idle one", () => {
  const { w, restore } = workspace();
  try {
    w.add();
    w.add();
    w.add();
    expect(w.sessions.map((s) => s.title)).toEqual(["s1", "s2", "s3"]);
    w.switchTo(0); // s1 used last, s2 longest ago
    (w.sessions[2] as unknown as { busy: boolean }).busy = true;
    w.add();
    expect(w.sessions.map((s) => s.title)).toEqual(["s1", "s3", "s4"]);
    expect(w.current.title).toBe("s4");
    expect(w.current.unread).toBe(false);
  } finally {
    restore();
  }
});

test("tabs: closing keeps the tab on screen when it can, and reports when none is left", async () => {
  const { w, restore } = workspace(5);
  try {
    w.add();
    w.add();
    w.add();
    w.switchTo(1);
    expect(w.close(0)).toBe(true);
    expect(w.current.title).toBe("s2");
    const closed = w.current as unknown as ReturnType<typeof fakeSession>;
    w.close();
    expect(w.sessions.map((s) => s.title)).toEqual(["s3"]);
    await new Promise((r) => setTimeout(r, 0)); // after shutdown()
    expect(closed.deleted).toBe(true);
    w.close();
    expect(w.sessions).toHaveLength(0);
    expect(w.close()).toBe(false);
    expect(w.open("nope")).toBe(false);
  } finally {
    restore();
  }
});

test("commands run through the host, and problems go to the transcript", () => {
  const session = fakeSession("s");
  const calls: string[] = [];
  const host = {
    session: session as unknown as Session,
    setMode: (m: string) => calls.push(`mode ${m}`),
    openModes: () => calls.push("modes"),
    useModel: (id: string) => calls.push(`model ${id}`),
    openModels: () => calls.push("models"),
    quit: () => calls.push("quit"),
  } as unknown as CommandHost;

  runCommand(host, "/permissions full access");
  runCommand(host, "/permissions");
  runCommand(host, "/model glm-5.3");
  runCommand(host, "/model");
  runCommand(host, "/exit");
  expect(calls).toEqual(["mode full", "modes", "model glm-5.3", "models", "quit"]);

  runCommand(host, "/set api_key secret");
  runCommand(host, "/set");
  runCommand(host, "/permissions sometimes");
  runCommand(host, "/frobnicate");
  expect(session.options).toEqual([["api_key", "secret"]]);
  expect(session.messages).toEqual([
    { role: "info", text: "api_key = ***" },
    { role: "error", text: "usage: /set <key> [value]" },
    { role: "error", text: "usage: /permissions [ask|auto|full]" },
    { role: "error", text: "unknown command /frobnicate (try /help)" },
  ]);
});

test("help lists every command with its arguments and shortcut", () => {
  const help = helpText([]);
  for (const c of COMMANDS) expect(help).toContain(`/${c.name}`);
  expect(help).toMatch(/\/model \[name\] +Choose the model.*\(alt\+m\)/);
});
