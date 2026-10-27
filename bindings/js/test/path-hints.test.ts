// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sope-path-hints-")));
  const agent = Agent.create({ provider: "mock", cwd: root, permissions: "allow", "mock.delay_ms": "0" });
  const run = (name: string, input: unknown) => {
    agent.send(`!${name} ${JSON.stringify(input)}`);
    let result: Extract<SopeEvent, { type: "tool_end" }> | undefined;
    for (;;) {
      const event = agent.poll(5000);
      if (!event) throw new Error("Timed out waiting for path hint result");
      if (event.type === "tool_end") result = event;
      if (event.type === "turn_end" && !event.agentId) break;
    }
    return result!;
  };
  return { root, run, close() { agent.free(); rmSync(root, { recursive: true, force: true }); } };
}

test("missing reads suggest same-directory names for casing, suffixes and small typos", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "docs"));
    writeFileSync(join(f.root, "docs/README.md"), "PRIVATE CONTENT");
    for (const name of ["readme.md.bak", 'README.md""', "REAME.md"]) {
      const result = f.run("read", { file_path: `docs/${name}` });
      expect(result.isError).toBe(true);
      expect(result.result).toContain(`Working directory: ${JSON.stringify(f.root)}`);
      expect(result.result).toContain(`Resolved path: ${JSON.stringify(join(f.root, "docs", name))}`);
      expect(result.result).toContain(`\n  ${JSON.stringify(join(f.root, "docs/README.md"))}`);
      expect(result.result).not.toContain("PRIVATE CONTENT");
    }
    const edit = f.run("edit", { file_path: "docs/README.md", old_string: "PRIVATE", new_string: "CHANGED" });
    expect(edit.isError).toBe(true);
    expect(edit.result).toContain("has not been read");
  } finally { f.close(); }
});

test("a nonexistent parent falls back to candidates in the actual session root", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "README.md"), "ROOT CONTENT");
    const path = join(f.root, 'invented/parent/README.md""');
    const result = f.run("read", { file_path: path });
    expect(result.isError).toBe(true);
    expect(result.result).toContain(`Resolved path: ${JSON.stringify(path)}`);
    expect(result.result).toContain(`\n  ${JSON.stringify(join(f.root, "README.md"))}`);
    expect(result.result).not.toContain("ROOT CONTENT");
    expect(f.run("read", { file_path: "README.md" })).toMatchObject({ isError: false, result: expect.stringContaining("ROOT CONTENT") });
  } finally { f.close(); }
});

test("suggestions are bounded, deterministic, nonrecursive and omit unrelated hidden names", () => {
  const f = fixture();
  try {
    for (const name of ["README-z.md", "README-c.md", "README-b.md", "README-a.md", ".README-private"]) writeFileSync(join(f.root, name), "x");
    mkdirSync(join(f.root, "README-directory"));
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, "nested/README.md"), "nested");
    const result = f.run("read", { file_path: "README" });
    const hints = result.result.split("\n").filter(line => line.startsWith('  "')).map(line => JSON.parse(line.trim()));
    expect(hints).toEqual(["README-a.md", "README-b.md", "README-c.md"].map(name => join(f.root, name)));
    expect(f.run("read", { file_path: "zzzz-unrelated" }).result).not.toContain("Did you mean");
    expect(f.run("read", { file_path: "nested/unknown" }).result).not.toContain("README-a.md");
  } finally { f.close(); }
});

test("real quoted and Unicode filenames are read literally and hints preserve their spelling", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'README.md""'), "QUOTED FILE");
    writeFileSync(join(f.root, "ＡＢ.md"), "WIDE FILE");
    expect(f.run("read", { file_path: 'README.md""' })).toMatchObject({ isError: false, result: expect.stringContaining("QUOTED FILE") });
    expect(f.run("read", { file_path: "ＡＢ.md.bak" }).result).toContain(`\n  ${JSON.stringify(join(f.root, "ＡＢ.md"))}`);
    expect(f.run("read", { file_path: "ＡＢ.md" }).isError).toBe(false);
  } finally { f.close(); }
});
