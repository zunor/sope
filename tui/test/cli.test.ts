// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreTools, clip } from "../src/agent/tools";
import { CliError, parseArgs } from "../src/cli";
import { agentOptions, loadConfig, parseEnvFile } from "../src/config";

test("parses flags and the prompt", () => {
  expect(parseArgs([])).toEqual({ print: false, allowAll: false, version: false, help: false });
  const o = parseArgs(["-p", "--model=glm-4", "--allow-all", "fix", "the", "bug"]);
  expect(o).toMatchObject({ print: true, model: "glm-4", allowAll: true, prompt: "fix the bug" });
  expect(parseArgs(["--", "-p", "is", "text"]).prompt).toBe("-p is text");
  expect(() => parseArgs(["--model"])).toThrow(CliError);
  expect(() => parseArgs(["--nope"])).toThrow(CliError);
  expect(() => parseArgs(["--provider", "x"])).toThrow(CliError);
});

test("reads config files like .env", () => {
  expect(parseEnvFile('# c\nexport SOPE_MODEL="glm-5.3"\nSOPE_API_KEY=abc # note\nBAD\n')).toEqual({
    SOPE_MODEL: "glm-5.3",
    SOPE_API_KEY: "abc",
  });
});

test("layers config: file < env < flags", () => {
  const file = { SOPE_API_KEY: "k", SOPE_MODEL: "from-file", SOPE_COMPACT_THRESHOLD: "5000" };
  const c = loadConfig({}, { SOPE_MODEL: "from-env" }, file);
  expect(c).toMatchObject({ provider: "openai", model: "from-env", apiKey: "k", compactThreshold: 5000 });
  expect(loadConfig({ model: "flag" }, { SOPE_MODEL: "from-env" }, file).model).toBe("flag");
  const mock = loadConfig({}, {}, {});
  expect(mock.provider).toBe("mock");
  expect(agentOptions(mock)["compact.threshold"]).toBe("100000");
  expect(agentOptions(mock)["openai.api_key"]).toBeUndefined();
});

test("clips long output in the middle", () => {
  expect(clip("short", 10)).toBe("short");
  const out = clip("a".repeat(50) + "b".repeat(50), 20);
  expect(out.startsWith("a".repeat(10)) && out.endsWith("b".repeat(10))).toBe(true);
  expect(out).toContain("80 characters omitted");
});

let dir = "";
let cwd = "";
const tool = (name: string) => coreTools.find((t) => t.name === name)!;
const ctx = { signal: new AbortController().signal };

beforeAll(async () => {
  cwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "sope-tools-"));
  process.chdir(dir);
});
afterAll(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

test("write_file and edit_file stay in the working directory", async () => {
  expect(await tool("write_file").run({ path: "a/b.txt", content: "one\ntwo\ntwo\n" }, ctx)).toBe("created a/b.txt (3 lines)");
  await expect(Promise.resolve(tool("edit_file").run({ path: "a/b.txt", old_string: "two", new_string: "2" }, ctx))).rejects.toThrow("occurs 2 times");
  expect(await tool("edit_file").run({ path: "a/b.txt", old_string: "two", new_string: "$&", replace_all: true }, ctx)).toContain("2 replacements");
  expect(await readFile(join(dir, "a/b.txt"), "utf8")).toBe("one\n$&\n$&\n");
  await expect(Promise.resolve(tool("write_file").run({ path: "../escape.txt", content: "x" }, ctx))).rejects.toThrow("outside");
  expect(tool("write_file").readOnly).toBeFalsy();
  expect(tool("read_file").readOnly).toBe(true);
});

test("read_file numbers lines and search finds them", async () => {
  await writeFile(join(dir, "c.txt"), "alpha\nbeta\ngamma\n");
  expect(await tool("read_file").run({ path: "c.txt", offset: 2, limit: 1 }, ctx)).toBe("2  beta\n… 2 more lines (continue with offset 3)");
  expect(await tool("search").run({ pattern: "^gam" }, ctx)).toBe("c.txt:3: gamma");
});

test("bash reports output and exit status, and can be cancelled", async () => {
  expect(await tool("bash").run({ command: "echo out; echo err >&2; exit 3" }, ctx)).toBe("out\nerr\n[exit code 3]");
  const abort = new AbortController();
  const started = performance.now();
  const run = tool("bash").run({ command: "sleep 30" }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  expect(await run).toContain("[cancelled]");
  expect(performance.now() - started).toBeLessThan(5000);
});
