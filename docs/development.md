# Development

[Documentation](README.md) · [Project overview](../README.md)

Requirements: CMake ≥ 3.20, a C11 compiler, libcurl development libraries (included with macOS), and Bun ≥ 1.3.

```sh
bun install
bun run build:native   # Build build/libsope.dylib, tests, and examples
bun run test:native    # C tests
bun test               # Binding and TUI tests
bun run typecheck
cp .env.example .env   # Fill in SOPE_API_KEY (.env is excluded from Git)
bun run tui            # Run sope from source; same arguments as above, e.g. bun run tui -- -p "hi"
```

See [the build reference](abi.md#12-building-and-dependencies) for `-DSOPE_CURL=system|bundled|off`. To build with a sanitizer:

```sh
cmake -S . -B build-thread -DSOPE_SANITIZE=thread && cmake --build build-thread && ./build-thread/test_agent
```

## Live compaction evaluation

After building the native library and configuring `SOPE_API_KEY`, `SOPE_MODEL`
and `SOPE_BASE_URL` (the same configuration as the TUI), run:

```sh
bun scripts/eval-compaction.ts build/live-compaction
```

This opt-in script makes paid calls to the configured real model. It uses a
synthetic four-phase investigation with large tool logs and exact evidence at
the beginning, middle and end. It checks the original goal, four constraints,
source paths, failure/fix evidence, repeated automatic compaction, and history
restoration into a new agent midway through the task. It also removes the terminator from a real model
response and cancels a live summary request, checks history preservation, then
retries compaction and tests recall after another restore. `--quick` skips the
interruption/failure/cancellation probes. Use `--provenance` for a separate probe:
two successive compactions and restores must preserve unperformed audits despite
a conflicting assistant claim, and the final model must distinguish requirements
from verified results.

The output directory contains `report.json` with requests, real model outputs,
events and exact-match checks, plus `saved-history.json`. Credentials are not
recorded. The script exits nonzero when any check fails. These checks detect
loss of the fixture's facts; inspect the saved responses to assess their meaning.
This is a bounded semantic regression probe, not proof of lossless summarization
for arbitrary tasks. It is intentionally separate from offline `bun test`.

## Directory layout

```
include/sope.h        Public header: the ABI itself
src/
  agent.c            Public API, options, event queue, readable fd, pending calls, lifecycle
  journal.c          Durable inbox, execution facts, checkpoints and outcome reconciliation
  artifact.c         Complete output archives and byte-range retrieval
  loop.c             Turn state machine (agent loop): rounds, tool dispatch, compaction
  call.c             sope_call: a model call as a provider sees it
  subagent.c         Subagent types and the children the `agent` tool spawns
  history.c          Messages, the conversation, and its JSON form
  compact.c          Budgeted transcripts and atomic recent-message retention
  context.c          Full-request estimates, usage calibration and token budgets
  tools.c            Built-in tool registry, the run task, helpers shared by tools
  tool_*.c           One tool family each, with its descriptions and schemas: file (read/write/edit),
                     search (glob/grep, regex rewriting), bash (and background shells), web (web_fetch,
                     HTML to text), todo
  walk.c             Glob patterns, .gitignore, and the tree walk behind glob and grep
  pool.c             Shared thread pool and timers
  http.c             libcurl multi I/O thread (the only file that uses libcurl)
  proc.c             Child processes: new sessions, merged output, reaper thread
  provider_openai.c  OpenAI-compatible streaming Chat Completions
  provider_mock.c    Offline mock model
  json.c, util.c     JSON parsing, strings, and buffers
cmake/BundledCurl.cmake  SOPE_CURL=bundled: build curl and mbedTLS statically
cmake/BundledSQLite.cmake  Always embed a pinned, privately namespaced SQLite
docs/                Documentation index, user guides, ABI reference, releases, and assets
tests/               C tests: ABI behavior, built-in tools, internals (all exercised under TSan/ASan)
examples/            hello.c (minimal host), multiplex.c (fd multiplexing)
bindings/js/         bun:ffi bindings (typed API and tests, including offline tests with a fake OpenAI server)
tui/src/
  main.ts, cli.ts    sope executable entry point and argument parsing
  app.ts, print.ts   Full-screen TUI (input routing, layout, shared state) and -p mode
  commands.ts        Slash commands: one table for what runs, the suggestions menu and /help
  workspace.ts       The sessions open as tabs: restore on start, LRU put-away, open and close
  session.ts store.ts  Session (tab) state; SQLite persistence and restoration
  agent/permissions.ts  Permission modes; how “Approve for me” judges commands and files
  agent/shell.ts     Reads a shell command line into simple commands, for permissions.ts
  agent/models.ts    Endpoint model list for the model picker
  agent/             Worker polling thread, bridge, tool display and previews, host tools for the mock
  term/ render/      Raw mode, input decoding, cell buffer, diff renderer
  ui/popup.ts        Popups in the input's place; approval.ts, modes.ts, models.ts are the popups
  unicode/ ui/       Graphemes and column widths, wrapping, Markdown, editor (and its keys), chat view,
                     tabs, status line, session list, command menu, trace panel
scripts/             demo.ts (offline demos), release.sh (build and package), install.sh
```

## Documentation

Keep the root README focused on the project overview and first steps. Put usage details in `docs/guide/`, technical contracts in `abi.md`, and release policy in `release.md`. Store README images in `docs/assets/`. Use English throughout. When changing a heading or moving a file, update incoming links and the release scripts that package or update it.


## Crash, file-isolation and output tests

After building, `ctest --test-dir build --output-on-failure` includes `test_durable`. It starts fresh executables and sends actual SIGKILL signals after durable admission, after one tool result and an unacknowledged external mutation, after reconciliation, and after observing an atomic-write staging file. It also injects SQLite transaction failures and races two independent processes against the same file. These tests use the real core and filesystem with the offline provider; no paid model or credentials are required.

`bun test bindings/js/test/durability.test.ts tui/test/session-durable.test.ts` checks same-batch/independent-agent conflicts, symlink aliases, content changes with restored mtime, foreground/background logs beyond the old buffer window, host-tool archives, long lines and TUI recovery authority. The fixtures compare full archive contents and read omitted middle evidence through `artifact_read`.

Use `ctest` in `build-asan` (`-DSOPE_SANITIZE=address,undefined`) and `build-thread` (`-DSOPE_SANITIZE=thread`) to run the native suite under sanitizers. Crash tests intentionally leave their private `/tmp/sope-durable-*` evidence directories for inspection; remove those after inspecting failures. SIGKILL tests do not simulate power loss or storage hardware that ignores fsync.

SQLite is compiled into both library artifacts. A first configure downloads the pinned amalgamation; use `-DSOPE_SQLITE_URL=/path/to/sqlite-amalgamation-3540100.zip` for offline builds. `embed_shared` and `embed_static` verify durable reopen with conflicting host SQLite symbols. With Go installed, run `bash scripts/test-go-embed.sh build` to exercise both actual library files from cgo without a Go SQLite driver or `-lsqlite3`.
