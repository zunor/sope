# Development

[Documentation](README.md) · [Project overview](../README.md)

Requirements: CMake ≥ 3.20, a C11 compiler, libcurl (included with macOS), and Bun ≥ 1.3.

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

## Directory layout

```
include/sope.h        Public header: the ABI itself
src/
  agent.c            Public API, event queue, readable fd, lifecycle
  loop.c             Turn state machine (agent loop), subagents, compaction
  compact.c          Compaction prompts and conversation transcripts
  tools.c            Built-in tools: registry, execution tasks, permissions, read/write/edit, bash, todo_write
  search.c, web.c    glob/grep (.gitignore, glob patterns, regex rewriting), web_fetch (HTML to text)
  pool.c             Shared thread pool and timers
  http.c             libcurl multi I/O thread (the only file that uses libcurl)
  proc.c             Child processes: new sessions, merged output, reaper thread
  provider_openai.c  OpenAI-compatible streaming Chat Completions
  provider_mock.c    Offline mock model
  json.c, util.c     JSON parsing, strings, and buffers
cmake/BundledCurl.cmake  SOPE_CURL=bundled: build curl and mbedTLS statically
docs/                Documentation index, user guides, ABI reference, releases, and assets
tests/               C tests: ABI behavior, built-in tools, internals (all exercised under TSan/ASan)
examples/            hello.c (minimal host), multiplex.c (fd multiplexing)
bindings/js/         bun:ffi bindings (typed API and tests, including offline tests with a fake OpenAI server)
tui/src/
  main.ts, cli.ts    sope executable entry point and argument parsing
  app.ts, print.ts   Full-screen TUI and -p mode
  session.ts store.ts  Session (tab) state; SQLite persistence and restoration
  agent/permissions.ts  Permission modes; how “Approve for me” evaluates commands and files
  agent/models.ts    Endpoint model list for the model picker
  agent/             Worker polling thread, bridge, tool display and previews, host tools for the mock
  term/ render/      Raw mode, input decoding, cell buffer, diff renderer
  unicode/ ui/       Graphemes and column widths, wrapping, Markdown, editor, chat view, tabs, status line, dialogs, model picker, trace panel
scripts/             demo.ts (offline demos), release.sh (build and package), install.sh
```

## Documentation

Keep the root README focused on the project overview and first steps. Put usage details in `docs/guide/`, technical contracts in `abi.md`, and release policy in `release.md`. Store README images in `docs/assets/`. Use English throughout. When changing a heading or moving a file, update incoming links and the release scripts that package or update it.
