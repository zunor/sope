// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellBuffer } from "../src/render/buffer";
import { surfaces } from "../src/theme";
import { ApprovalPrompt } from "../src/ui/approval";
import { readCurrent } from "../src/agent/tools";
import { Session } from "../src/session";
import { Store } from "../src/store";
import { agentOptions, loadConfig } from "../src/config";

const config = loadConfig({ provider: "mock" }, {}, {});

test("sessions bind cwd before lazy agent creation and preserve it on durable reopen", async () => {
  const previous = process.cwd();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sope-session-directory-")));
  const first = join(root, "first"), second = join(root, "second");
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, "location.txt"), "FIRST WORKSPACE");
  writeFileSync(join(second, "location.txt"), "SECOND WORKSPACE");
  const store = new Store(join(root, "ui.db"));
  const sessions: Session[] = [];
  const completions = new Map<Session, () => void>();
  const events = (session: Session, batch: Array<{ type: string; agentId?: number }>) => {
    if (batch.some(e => e.type === "turn_end" && !e.agentId)) completions.get(session)?.();
  };
  const read = async (session: Session, expected: string) => {
    const done = new Promise<void>(resolve => completions.set(session, resolve));
    session.send('!read {"file_path":"location.txt"}');
    await done;
    expect(session.chat.messages.findLast(m => m.role === "tool")?.text).toContain(expected);
  };
  try {
    process.chdir(first);
    const transient = new Session(config, () => "full", events);
    sessions.push(transient);
    process.chdir(second);
    // Persistence has a workspace directory distinct from both process cwd and the journal path.
    const durable = new Session(config, () => "auto", events, { store, directory: first });
    const other = new Session(config, () => "full", events);
    sessions.push(durable, other);
    expect(transient.directory).toBe(first);
    expect(durable.directory).toBe(first);
    expect(other.directory).toBe(second);
    expect(() => transient.setOption("cwd", second)).toThrow("working directory is fixed");
    const options = agentOptions(config, durable.directory);
    expect(options.cwd).toBe(first);
    expect(options.system).toContain(`Working directory: ${first}`);
    for (const session of sessions) session.setOption("mock.delay_ms", "0");
    await read(transient, "FIRST WORKSPACE");
    await read(durable, "FIRST WORKSPACE");
    await read(other, "SECOND WORKSPACE");
    durable.approvals.push({ callId: 999, turnId: 1, name: "write", input: { file_path: "location.txt", content: "NEW CONTENT" } });
    const preview = new CellBuffer(80, 20);
    new ApprovalPrompt(() => durable).render(preview, 0, 0, 80, 20, surfaces(null));
    expect(preview.chars.join("")).toContain("FIRST WORKSPACE");
    expect(preview.chars.join("")).not.toContain("SECOND WORKSPACE");
    durable.approvals.pop();
    const wrote = new Promise<void>(resolve => completions.set(durable, resolve));
    durable.send(`!write ${JSON.stringify({ file_path: join(first, "bound.txt"), content: "BOUND WRITE" })}`);
    await wrote;
    expect(durable.approvals).toHaveLength(0);
    expect(readCurrent("bound.txt", durable.directory)).toBe("BOUND WRITE");
    durable.changes.reset();
    durable.changes.track("location.txt");
    writeFileSync(join(first, "location.txt"), "UPDATED FIRST WORKSPACE");
    durable.changes.refresh();
    expect(durable.changes.files.map(f => f.path)).toEqual(["location.txt"]);
    await durable.shutdown();
    sessions.splice(sessions.indexOf(durable), 1);
    const reopened = new Session(config, () => "full", events, { store, directory: first, stored: store.get(durable.id!)! });
    sessions.push(reopened);
    reopened.setOption("mock.delay_ms", "0");
    await read(reopened, "UPDATED FIRST WORKSPACE");
  } finally {
    for (const session of sessions) await session.shutdown();
    store.close(); process.chdir(previous); rmSync(root, { recursive: true, force: true });
  }
}, 10000);
