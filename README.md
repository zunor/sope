# sope

An embeddable agent runtime in C11, with a C ABI, Go and Bun/TypeScript bindings,
and a terminal UI built on the same library. MIT licensed.

Give sope a model and a task. It manages tool calls, subagents, streaming,
context compaction and durable execution; your application owns the interface
and execution policy.

## Where it fits

- **Developer tools:** add repository search, code changes and test execution to an IDE, desktop app or internal CLI.
- **Automation services:** run investigation, maintenance or batch-processing agents with durable tasks, execution records and explicit recovery after interruption.
- **Custom assistants:** expose your application's tools and approvals, stream progress into your own UI, and coordinate multiple agents from an event loop.

## Why embed sope?

- **One native core.** Link a shared or static library through a C ABI; use the included Go or Bun/TypeScript bindings. No separate agent server is required.
- **Host control.** Register tools, allowlist capabilities and route operations to your own executor or sandbox. Use an OpenAI-compatible model endpoint.
- **Durable state.** SQLite-backed sessions retain admitted tasks, tool results and execution records. Unknown effects require reconciliation before resuming.
- **Shared scheduling.** Agents use a common worker pool and release workers while waiting. An event descriptor integrates with `poll`, `epoll`, `kqueue` or `libuv`.
- **Built-in workflow.** File/search/shell tools, subagents, bounded retries and context compaction are available through the same API.

Built-in tools run with the host process's privileges; they are not an OS sandbox.
Embedding currently targets 64-bit macOS and Linux. Go hosts require cgo.

[Go integration](bindings/go/README.md) · [C examples](examples/) · [Bun / TypeScript](bindings/js/) · [C ABI reference](docs/abi.md)

## Try the terminal

From a checkout, with [Bun and native build dependencies](docs/development.md):

```sh
bun install
bun run build:native
bun run demo tour --offline
```

The offline demo needs no API key. [Configure a model](docs/guide/quickstart.md),
then run `bun run tui` in your project directory.

The TUI includes persistent session tabs, approval diffs, conversation search,
image input and diagram viewports. `/evidence` shows retained executions on demand.

## Download 0.7.0

[macOS arm64](https://github.com/zunor/sope/releases/download/v0.7.0/sope-0.7.0-darwin-arm64.tar.gz) ·
[Linux x64](https://github.com/zunor/sope/releases/download/v0.7.0/sope-0.7.0-linux-x64.tar.gz) ·
[Checksums and release notes](https://github.com/zunor/sope/releases/tag/v0.7.0)

Packages include the standalone executable, shared/static libraries, header and
Go bindings. Verify the accompanying SHA-256 checksum, extract the archive and
run `./sope-0.7.0-<platform>/install.sh` (`--lib` also installs the library).
The executable needs no Bun installation. macOS binaries are ad-hoc signed, not notarized.

**Embedding upgrade:** 0.7.0 uses C ABI 0.7. Rebuild with matching headers,
libraries and bindings. Sessions sealed under an older ABI require their matching runtime.

[Documentation](docs/README.md) · [Terminal guide](docs/guide/terminal.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)
