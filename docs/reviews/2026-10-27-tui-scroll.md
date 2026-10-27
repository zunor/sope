# Trackpad scrolling: local fix and validation

Validated on macOS arm64, 2026-10-27. This is an **unreleased validation build**
from dirty base `32b78b26fb041e3723a2d2fd9b603f9108a4e7bb`, with embedded version
0.6.0. It includes the existing working-tree changes, including the previously
validated native recovery fixes. No version bump or installation was performed.

## Cause and changes

- SGR wheel buttons 66 and 67 (left/right) were decoded as `wheel-down`.
  The parser now distinguishes all four directions, including modifiers and
  sequences split across reads. Vertical panes ignore horizontal wheel events
  before dispatching to chat, popups, the session list or the diff panel.
- Wheel reports previously jumped three rows each. The default is now one row,
  keeping small trackpad movements precise. `SOPE_SCROLL_SPEED` accepts a positive
  integer; `3` restores the old speed. Chat, session lists and diff text use the
  configured speed; individual popup/file choices keep their one-item steps.
- Replaced the fixed eight-millisecond delay after input with a scheduler targeting
  60 Hz. The first frame after idle can run immediately; later input coalesces at
  the next frame deadline without restarting the timer. Input updates position
  immediately, so reversing, stopping and hitting an edge leave no queued motion.
- When stdout needs to drain, retain one dirty frame and keep updating state.
  Resume with the latest state on drain, rather than queuing obsolete frames.
  Resize and startup use the same scheduler; exit cancels pending frames.

Reference: the local OpenCode checkout uses a 60 FPS target in
`packages/tui/src/app.tsx` and configurable speed in `packages/tui/src/util/scroll.ts`.
Its default remains three rows. OpenTUI's
[ScrollBox implementation](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/ScrollBox.ts)
handles each axis separately and resets fractional remainder on reversal or
clamping. sope uses integer steps and no additional inertia; it does not copy
OpenTUI's optional acceleration curve.

## Evidence

The installed `/Users/linjunhong/.local/bin/sope` identifies itself as 0.4.0.
Running the same throwaway saved-transcript PTY scenario against it reproduced
the error: eight horizontal reports moved the top visible row from 507 to 531
(24 rows downward). The new executable passes that assertion.

| Check | Result |
| --- | --- |
| Full TUI suite | 197 passed, 0 failed, 31 files |
| TypeScript and metadata | Passed; version 0.6.0 |
| `git diff --check` | Passed |
| Existing PTY smoke | Mock conversation, `/context`, `/effort`, clean exit passed |
| Compiled PTY, text mode, speed 1 | 125 events in one second, 57 frames; reversal observed in 13.80 ms |
| Compiled PTY, graphics enabled, speed 1 | 57 frames; reversal observed in 16.41 ms |
| Compiled PTY, text mode, speed 3 | 57 frames; reversal observed in 17.92 ms |
| Source PTY, graphics enabled | 57 frames; reversal observed in 15.77 ms |

PTY checks cover horizontal input, diagonal gestures with a split escape sequence,
continuous upward motion with no backward frames, reversal, no drift after release,
top/bottom clamping, immediate reversal at edges, session-list routing and clean exit.
Scheduler unit tests additionally cover 250 Hz input, output backpressure arriving
before/after scheduling, latest-state delivery, slow rendering, cancellation and
the real default clock. Diff-panel tests cover precise steps, speed overrides and
edge reversal. The PTY regressions are wired into Nightly in text and graphics modes.

These are behavioral tests through a real PTY. Graphics mode negotiates the Kitty
protocol and exercises overlay output; pyte checks text cells. It does **not**
measure Ghostty's pixel compositor or physically replay a Mac trackpad gesture.
Timing figures are observations, not portable performance guarantees.

## Artifact and reproduction

Executable: `/Users/linjunhong/workspace/sope/build-scroll-fix/sope`

SHA-256: `790293a0d2cd5c25c1eaa67ae8ea7e2e77396c01a2eb2739970b80a8a9147424`

Embedded library reused from the prior native validation:
`build-hunt-fix/libsope.dylib`, SHA-256
`e78bdf56afce28de03910c9eba898232e2c835198cccf88eeef84726adfc84ad`.
This task changes no native or binding implementation; previous native/Go/JS
validation is recorded in [the recovery review](2026-10-27-hunt-recovery.md).

Build:

```sh
bun build --compile --root . --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile build-scroll-fix/sope tui/src/main.ts tui/src/agent/poller.ts \
  build-hunt-fix/libsope.dylib
```

Regression (Python environment requires `pyte==0.8.2`):

```sh
python scripts/ci/tui-scroll.py --executable "$PWD/build-scroll-fix/sope"
python scripts/ci/tui-scroll.py --executable "$PWD/build-scroll-fix/sope" --graphics
python scripts/ci/tui-scroll.py --executable "$PWD/build-scroll-fix/sope" --speed 3
```

Source hashes, dirty state, artifact hashes and logs are recorded in
`build-scroll-fix/validation/manifest.json`. The initial snapshot is retained in
`/tmp/sope-scroll-fix-20261027/`. Pre-existing changes outside the overlapping app,
diff-panel, changelog and configuration-documentation edits remain byte-identical.
