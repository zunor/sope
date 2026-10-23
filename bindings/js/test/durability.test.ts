import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, statSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src";

function agent(directory: string) {
  return Agent.create({ "mock.delay_ms": "0", permissions: "allow", cwd: directory });
}

function finish(a: Agent) {
  const results: Extract<SopeEvent, { type: "tool_end" }>[] = [];
  for (;;) {
    const ev = a.poll(10000);
    if (!ev) throw new Error("turn stalled");
    if (ev.type === "error") throw new Error(ev.message);
    if (ev.type === "tool_end") results.push(ev);
    if (ev.type === "turn_end") { expect(ev.stopReason).toBe("end_turn"); return results; }
  }
}

function run(a: Agent, command: string) { a.send(command); return finish(a); }
function tool(name: string, input: object) { return `!${name} ${JSON.stringify(input)}`; }
function archive(result: string) {
  const match = /Full output: (\/[^;\n]+);/.exec(result) ?? /Full output: (\/[^\n]+) \(\d+ bytes\)/.exec(result);
  if (!match) throw new Error(`no archive in ${result.slice(-1000)}`);
  return match[1]!;
}

describe("file mutation isolation", () => {
  test("same-batch edits through symlink aliases cannot overwrite one another", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-files-"));
    writeFileSync(join(dir, "target"), "first=old\nsecond=old\n");
    chmodSync(join(dir, "target"), 0o755);
    symlinkSync("target", join(dir, "alias"));
    const a = agent(dir);
    try {
      run(a, tool("read", { file_path: "target" }));
      const results = run(a, `${tool("edit", { file_path: "target", old_string: "first=old", new_string: "first=new" })} ;; ${tool("edit", { file_path: "alias", old_string: "second=old", new_string: "second=new" })}`);
      expect(results.filter((r) => r.isError)).toHaveLength(1);
      expect(results.find((r) => r.isError)!.result).toContain("modified since");
      const value = readFileSync(join(dir, "target"), "utf8");
      expect(value === "first=new\nsecond=old\n" || value === "first=old\nsecond=new\n").toBe(true);
      expect(statSync(join(dir, "target")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(dir, "alias"), "utf8")).toBe(value);
      run(a, tool("read", { file_path: "alias" }));
      const remaining = value.startsWith("first=new") ? "second" : "first";
      expect(run(a, tool("edit", { file_path: "alias", old_string: `${remaining}=old`, new_string: `${remaining}=new` }))[0]!.isError).toBe(false);
      expect(readFileSync(join(dir, "target"), "utf8")).toBe("first=new\nsecond=new\n");
    } finally { a.free(); }
  });

  test("independent agents serialize mutations and reject a stale admitted revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-files-"));
    writeFileSync(join(dir, "target"), "original");
    const a = agent(dir), b = agent(dir);
    try {
      run(a, tool("read", { file_path: "target" }));
      run(b, tool("read", { file_path: "target" }));
      a.send(tool("write", { file_path: "target", content: "A".repeat(200000) }));
      b.send(tool("write", { file_path: "target", content: "B".repeat(200000) }));
      const results = [...finish(a), ...finish(b)];
      expect(results.filter((r) => r.isError)).toHaveLength(1);
      const value = readFileSync(join(dir, "target"), "utf8");
      expect(value === "A".repeat(200000) || value === "B".repeat(200000)).toBe(true);
    } finally { a.free(); b.free(); }
  });

  test("same-size external changes are detected even if mtime is restored", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-files-"));
    const file = join(dir, "target");
    writeFileSync(file, "old");
    utimesSync(file, 1000, 1000);
    const a = agent(dir);
    try {
      run(a, tool("read", { file_path: "target" }));
      writeFileSync(file, "new");
      utimesSync(file, 1000, 1000);
      const results = run(a, tool("write", { file_path: "target", content: "bad" }));
      expect(results[0]!.isError).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("new");
    } finally { a.free(); }
  });
});

describe("complete output artifacts", () => {
  test("foreground shell preserves evidence in the discarded middle and supports byte retrieval", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-output-"));
    const expected = "A".repeat(350000) + "CRITICAL_MIDDLE_EVIDENCE" + "Z".repeat(350000);
    writeFileSync(join(dir, "source"), expected);
    const a = agent(dir);
    let path = "";
    try {
      const result = run(a, tool("bash", { command: "cat source" }))[0]!;
      expect(result.isError).toBe(false);
      expect(result.result.length).toBeLessThan(32000);
      expect(result.result).not.toContain("CRITICAL_MIDDLE_EVIDENCE");
      path = archive(result.result);
      expect(readFileSync(path, "utf8")).toBe(expected);
      const retrieved = run(a, tool("artifact_read", { path, offset: 350000, limit: 24 }))[0]!;
      expect(retrieved.result).toContain("CRITICAL_MIDDLE_EVIDENCE");
    } finally { a.free(); }
    expect(readFileSync(path, "utf8")).toBe(expected);
  });

  test("background pagination never skips clipped bytes, including beyond the old tail window", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-output-"));
    const expected = Array.from({ length: 14000 }, (_, i) => `${String(i).padStart(6, "0")} evidence 1234567890\n`).join("");
    writeFileSync(join(dir, "source"), expected);
    const a = agent(dir);
    try {
      const started = run(a, tool("bash", { command: "cat source", run_in_background: true }))[0]!;
      const path = archive(started.result);
      const id = /shell (\d+)/.exec(started.result)![1]!;
      let output = "";
      for (let i = 0; i < 100; i++) {
        const result = run(a, tool("bash_output", { shell_id: id }))[0]!.result;
        const match = /Shell \d+ (?:exited with code \d+|is running)\.\n([\s\S]*)/.exec(result);
        if (!match) throw new Error(result);
        if (!match[1]!.startsWith("(no new output)")) output += match[1];
        if (output.length === expected.length) break;
      }
      expect(output).toBe(expected);
      expect(readFileSync(path, "utf8")).toBe(expected);
    } finally { a.free(); }
  });

  test("host-tool clipping archives the original result before preview and journaling", () => {
    const dir = mkdtempSync(join(tmpdir(), "sope-output-"));
    const a = Agent.open(join(dir, "session"), { "mock.delay_ms": "0" });
    const expected = "start\n" + "x".repeat(600000) + "\nlast evidence";
    a.registerTool({ name: "evidence" });
    try {
      a.send("!evidence {}");
      let path = "";
      for (;;) {
        const ev = a.poll(10000);
        if (!ev) throw new Error("stalled");
        if (ev.type === "tool_call") a.toolResult(ev.callId, expected);
        if (ev.type === "tool_end") { path = archive(ev.result); expect(ev.result.length).toBeLessThan(525000); }
        if (ev.type === "turn_end") break;
      }
      expect(readFileSync(path, "utf8")).toBe(expected);
      expect(a.history()).toContain(path);
    } finally { a.free(); }
  });
});

test("file and grep previews preserve evidence from long lines in an archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-output-"));
  const expected = "x".repeat(300000) + "MATCH_MIDDLE_EVIDENCE" + "y".repeat(300000);
  writeFileSync(join(dir, "source"), expected);
  const a = agent(dir);
  try {
    const read = run(a, tool("read", { file_path: "source" }))[0]!;
    expect(read.result).not.toContain("MATCH_MIDDLE_EVIDENCE");
    expect(readFileSync(archive(read.result), "utf8")).toBe(expected);
    const grep = run(a, tool("grep", { pattern: "MATCH_MIDDLE_EVIDENCE", path: "source", output_mode: "content" }))[0]!;
    expect(grep.isError).toBe(false);
    expect(readFileSync(archive(grep.result), "utf8")).toContain(expected);
  } finally { a.free(); }
});
