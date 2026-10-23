# English demos

[Documentation](../README.md) · [Project overview](../../README.md)

Three small scenarios show how sope feels in use. A scripted OpenAI-compatible server listens only on loopback, while the real libsope agent loop, tools, and TUI do the work. No external model or API key is needed.

The demo creates a disposable project named **Lumen**, a tiny retry policy with a test suite. It uses a separate session database and configuration directory, and removes the temporary workspace when you exit. Your normal sessions and project files are untouched. Responses are scripted for this fixture; this is a UI demonstration, not a general-purpose assistant or a measure of model quality.

## Run in Ghostty

From the repository root, in a Ghostty window:

```sh
bun install
bun run build:native
bun scripts/demo.ts tour
```

For a readable capture, use roughly **110 columns × 40 rows**, a dark background, and a 15–17 pt monospace font. The TUI adapts to the terminal's own background; no theme changes are required. Hide unrelated windows and capture just the demo window.

Use `/quit` to leave the demo. Each new run starts from the original fixture. `--print` runs the same scenario without a full-screen interface and automatically approves the fixture's local edits and tests.

Interactive runs open **four tabs**: three prepared conversations (**Project notes**, **Test strategy**, and **Release checklist**) plus the selected demo. The prepared conversations contain scripted notes and plans, not tool execution records. Click a tab or use `Alt+1` through `Alt+4` to explore them; the selected demo starts in the fourth tab. Keep that tab active for the edit screenshot, or switch to another tab while it waits for approval to show the waiting marker.

## 01 · Understand the shape

```sh
bun scripts/demo.ts tour
```

> Give me a concise tour of this project.

The agent discovers the files, reads the retry function, and explains the boundaries between implementation, tests, and documentation. A short code example makes the behavior concrete. No files change.

## 02 · Make a considered change

```sh
bun scripts/demo.ts edit
```

> Cap the retry delay at two seconds, then verify the change.

The agent reads the source and tests before proposing a one-line edit. Pause at the first approval dialog to inspect or capture the diff. Press `y` to approve each edit and the test command. The agent adds an upper-bound regression test and runs `bun test`; the final response reports success only when the command output contains four passing tests.

Press `n` to deny an action: the scripted model acknowledges the denial and stops. This is also a useful way to try the permission flow.

## 03 · Look from two angles

```sh
bun scripts/demo.ts review
```

> Review the retry policy from two independent angles.

Two subagents inspect behavior and test coverage in parallel. Both use the real `read` tool on the fixture, then return concise reports to the parent agent. No files change.

## Captures

Keep images in `docs/assets/` and reference them from the root README with relative paths. Captions must identify scripted demo content. A Ghostty screenshot should be captured from an actual Ghostty window; a terminal-rendered preview should be labeled as such.
