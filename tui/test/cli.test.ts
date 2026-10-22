// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { describeCall, formatTodos, previewFor, todosOf } from "../src/agent/tools";
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

test("describes calls and previews the ones that ask", () => {
  expect(describeCall("read", { file_path: "src/a.c" })).toBe("src/a.c");
  expect(describeCall("grep", { pattern: "TODO", path: "src", glob: "*.c" })).toBe("TODO in src (*.c)");
  expect(describeCall("bash", { command: "make", run_in_background: true })).toBe("[background] make");
  expect(describeCall("echo", { input: "hi" })).toBe("hi");
  expect(previewFor("edit", { file_path: "a.c", old_string: "x", new_string: "y" })).toEqual([
    { text: "a.c", kind: "plain" },
    { text: "x", kind: "remove" },
    { text: "y", kind: "add" },
  ]);
  expect(previewFor("bash", { command: "rm -rf build", description: "Clean" })).toEqual([
    { text: "Clean", kind: "plain" },
    { text: "rm -rf build", kind: "command" },
  ]);
  expect(previewFor("write", { file_path: "f", content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" }).at(-1)).toEqual({
    text: "… 2 more lines",
    kind: "plain",
  });
});

test("shows todo lists", () => {
  const todos = todosOf({
    todos: [
      { content: "Write tests", activeForm: "Writing tests", status: "completed" },
      { content: "Fix bug", activeForm: "Fixing the bug", status: "in_progress" },
      { content: "Release", status: "pending" },
    ],
  })!;
  expect(formatTodos(todos)).toBe("☒ Write tests\n◐ Fixing the bug\n☐ Release");
  expect(todosOf({})).toBeNull();
});

test("permission mode reaches the agent", () => {
  const mock = loadConfig({}, {}, {});
  expect(agentOptions(mock).permissions).toBe("ask");
  expect(agentOptions(mock, "deny").permissions).toBe("deny");
});
