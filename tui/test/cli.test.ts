// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { effortLabel, parseEffort } from "../src/agent/effort";
import { describeCall, formatTodos, previewFor, todosOf } from "../src/agent/tools";
import { CliError, parseArgs } from "../src/cli";
import { agentOptions, contextOptions, loadConfig, parseEnvFile } from "../src/config";

test("parses flags and the prompt", () => {
  expect(parseArgs([])).toEqual({ print: false, images: [], version: false, help: false });
  expect(parseArgs(["-i", "a.png", "--image=b.jpg", "why?"])).toMatchObject({ images: ["a.png", "b.jpg"], prompt: "why?" });
  const o = parseArgs(["-p", "--model=glm-4", "--allow-all", "fix", "the", "bug"]);
  expect(o).toMatchObject({ print: true, model: "glm-4", permissions: "full", prompt: "fix the bug" });
  expect(parseArgs(["--permissions", "ask"]).permissions).toBe("ask");
  expect(parseArgs(["--permissions=auto"]).permissions).toBe("auto");
  expect(() => parseArgs(["--permissions", "maybe"])).toThrow(CliError);
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
  const none = () => null;
  expect(previewFor("edit", { file_path: "a.c", old_string: "x", new_string: "y" }, none)).toEqual([
    { text: "a.c", kind: "plain" },
    { text: "x", kind: "remove", no: undefined, lang: "c" },
    { text: "y", kind: "add", no: undefined, lang: "c" },
  ]);
  expect(previewFor("bash", { command: "rm -rf build", description: "Clean" })).toEqual([
    { text: "Clean", kind: "plain" },
    { text: "rm -rf build", kind: "command" },
  ]);
});

test("write and edit previews are diffs against the file, with line numbers", () => {
  const file = "int a;\nint b;\nint c;\nint d;\nint e;\nint f;\nint g;\n";
  const read = (p: string) => (p === "x.c" ? file : null);
  const rows = (name: string, input: Record<string, unknown>) =>
    previewFor(name, input, read).map((l) => `${l.kind}:${l.no ?? ""}:${l.text}`);

  expect(rows("edit", { file_path: "x.c", old_string: "int e;", new_string: "long e;\nlong e2;" })).toEqual([
    "plain::x.c",
    "gap::⋯ 2 unchanged lines",
    "context:3:int c;",
    "context:4:int d;",
    "remove:5:int e;",
    "add:5:long e;",
    "add:6:long e2;",
    "context:6:int f;",
    "context:7:int g;",
  ]);
  expect(rows("edit", { file_path: "x.c", old_string: "nope", new_string: "y" })[0]).toBe("plain::x.c  (the old text is not in the file)");
  expect(rows("write", { file_path: "new.py", content: "a = 1\nb = 2\n" })).toEqual([
    "plain::new.py  (new file, 2 lines)",
    "add:1:a = 1",
    "add:2:b = 2",
  ]);
  expect(rows("write", { file_path: "x.c", content: file.replace("int a;", "int A;") }).slice(0, 4)).toEqual([
    "plain::x.c",
    "remove:1:int a;",
    "add:1:int A;",
    "context:2:int b;",
  ]);
  expect(rows("write", { file_path: "x.c", content: file })).toEqual(["plain::x.c  (no change)"]);
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

test("the permission mode defaults to Approve for me; the agent always asks the host", () => {
  const mock = loadConfig({}, {}, {});
  expect(mock.permissions).toBe("auto");
  expect(loadConfig({}, { SOPE_PERMISSIONS: "full" }, {}).permissions).toBe("full");
  expect(loadConfig({ permissions: "ask" }, { SOPE_PERMISSIONS: "full" }, {}).permissions).toBe("ask");
  expect(loadConfig({}, { SOPE_PERMISSIONS: "bogus" }, {}).permissions).toBe("auto");
  expect(agentOptions(mock).permissions).toBe("ask");
});

test("passes the configured model window to the native request budget", () => {
  const config = loadConfig({}, { SOPE_CONTEXT_WINDOW: "32000", SOPE_COMPACT_THRESHOLD: "0" }, { SOPE_CONTEXT_WINDOW: "64000" });
  expect(config.contextWindow).toBe(32000);
  expect(agentOptions(config)["context.window"]).toBe("32000");
  expect(agentOptions(config)["compact.threshold"]).toBe("0");
  expect(loadConfig({}, { SOPE_CONTEXT_WINDOW: "invalid" }, {}).contextWindow).toBe(0);
  expect(loadConfig({}, { SOPE_COMPACT_THRESHOLD: "1.5" }, {}).compactThreshold).toBeNull();
});

test("compacts at 80% of the model's window unless a threshold is set", () => {
  const auto = loadConfig({}, {}, {});
  expect(contextOptions(auto)).toEqual({ "context.window": "0", "compact.threshold": "100000" });
  expect(contextOptions(auto, 200_000)).toEqual({ "context.window": "200000", "compact.threshold": "160000" });
  const set = loadConfig({}, { SOPE_COMPACT_THRESHOLD: "50000" }, {});
  expect(contextOptions(set, 200_000)["compact.threshold"]).toBe("50000");
  const window = loadConfig({}, { SOPE_CONTEXT_WINDOW: "32000" }, {});
  expect(contextOptions(window, 200_000)).toEqual({ "context.window": "32000", "compact.threshold": "25600" });
  expect(agentOptions(window)["compact.threshold"]).toBe("25600");
});

test("reasoning effort: --effort, SOPE_REASONING_EFFORT and the option sent", () => {
  expect(["high", "Extra high", "x-high", "default", "auto", "MINIMAL", "max"].map(parseEffort)).toEqual(["high", "xhigh", "xhigh", "", "", "minimal", undefined]);
  expect(parseArgs(["--effort", "xhigh"]).effort).toBe("xhigh");
  expect(parseArgs(["--effort=default"]).effort).toBe("");
  expect(() => parseArgs(["--effort", "max"])).toThrow(CliError);
  expect(loadConfig({}, {}, {}).effort).toBe("");
  expect(loadConfig({}, { SOPE_REASONING_EFFORT: "high" }, {}).effort).toBe("high");
  expect(loadConfig({}, { SOPE_REASONING_EFFORT: "bogus" }, {}).effort).toBe("");
  expect(loadConfig({ effort: "low" }, { SOPE_REASONING_EFFORT: "high" }, {}).effort).toBe("low");
  expect(agentOptions(loadConfig({ effort: "medium" }, {}, {}))["reasoning.effort"]).toBe("medium");
  expect(agentOptions(loadConfig({}, {}, {}))["reasoning.effort"]).toBeUndefined();
  expect([effortLabel("xhigh"), effortLabel(""), effortLabel("minimal")]).toEqual(["Extra high", "Default", "Minimal"]);
});
