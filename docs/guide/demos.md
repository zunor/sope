# English demos

[Documentation](../README.md) · [Project overview](../../README.md)

Three small scenarios show the real libsope agent loop, tools, and TUI in a disposable project named **Lumen**, a tiny retry policy with a test suite.

## Choose a model

With `SOPE_API_KEY` configured in `.env`, your environment, or your sope config, the demos use **GLM 5.3** at your configured `SOPE_BASE_URL`. The bottom bar shows `glm-5.3` and its context usage. These runs make real API calls and may incur usage charges. Responses and the number of tests added can vary.

Without an API key, the demo uses a scripted OpenAI-compatible server listening only on loopback. Add `--offline` to force this deterministic mode even when credentials are configured. Its bottom bar says `sope-demo`; it does not claim to be a real model. Add `--live` to require GLM 5.3 and report a missing key instead of falling back.

```sh
bun install
bun run build:native
bun run demo edit            # GLM 5.3 if configured; otherwise offline
bun run demo edit --live     # Require the configured live endpoint and API key
bun run demo edit --offline  # No API key or external service
```

Each run uses a separate session database and configuration directory, then removes its temporary workspace on exit. Your normal sessions and project files are untouched. The retry fixture itself makes no network requests.

## Run in Ghostty

Run the demo from the repository root in a Ghostty window. For a readable capture, use roughly **110 columns × 40 rows**, a dark background, and a 15–17 pt monospace font. The TUI adapts to the terminal's own background; no theme changes are required. Capture just the demo window, including the tabs and bottom model bar.

Use `/quit` to leave. Each new run starts from the original fixture. `--print` runs without the full-screen interface and automatically approves ordinary fixture edits and tests. `--auto` enables the same approval mode in the interactive TUI.

Interactive runs open **four tabs**: three prepared conversations (**Project notes**, **Test strategy**, and **Release checklist**) plus the selected demo. The three prepared conversations contain scripted notes and plans in both modes, not tool execution records. Click a tab or use `Alt+1` through `Alt+4`; the selected demo starts in the fourth tab.

## 01 · Understand the shape

```sh
bun run demo tour
```

> Give me a concise tour of this project.

The agent discovers the files, reads the retry function, and explains the implementation, tests, and documentation. No files need to change.

## 02 · Make a considered change

```sh
bun run demo edit
```

> Cap the retry delay at two seconds, then verify the change.

The agent reads the source and tests before proposing an edit. Pause at the first approval dialog to inspect or capture the diff. Press `y` to approve each edit and the test command, or `a` to approve subsequent file edits in the session. The agent adds regression coverage and runs `bun test`.

The offline version adds exactly one regression test and reports success only when the command output contains four passing tests and exit code zero. A failed verification prints the command output and returns a nonzero exit code in `--print` mode. The live model chooses its own focused changes and reports the actual test results.

Press `n` to deny an action. The offline script acknowledges the denial and stops; the live model can explain another approach. Choose **No, and stop** to end the turn immediately.

## 03 · Look from two angles

```sh
bun run demo review
```

> Review the retry policy from two independent angles.

In the offline scenario, two subagents inspect behavior and test coverage in parallel, using the real `read` tool and returning concise reports. The live model chooses how to organize its review. No files need to change.

## Captures

Keep images in `docs/assets/` and reference them from the root README with relative paths. Captions must identify whether the active conversation used the live model or scripted responses; the three prepared tabs are always scripted. A Ghostty screenshot must come from an actual Ghostty window. Label terminal-rendered previews as such.

For a GLM 5.3 README capture, configure your API key, run `bun run demo edit`, approve the edits and test command, and wait for the final result. Verify `glm-5.3` is visible in the bottom bar before capturing. See [the capture inventory](../assets/README.md) for the current README image.
