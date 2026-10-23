# TUI captures

The root README shows the TUI in its middle section, **A place to work**:

| File | Capture |
|---|---|
| `tui-edit.png` | User-provided Ghostty screenshot with four session tabs, live GLM 5.3 file edits, test output, and the model name in the bottom bar |

`tui-edit.png` is the original, unmodified screenshot captured at **02:22:54 on 2026-10-24 (Asia/Shanghai)**, provided by the user. It preserves the full **2666 × 2242** resolution. The README links to the image for full-resolution viewing.

The active **Bound the backoff** conversation comes from `bun run demo edit` with a configured API key, using real GLM 5.3 responses and libsope tools in the disposable Lumen workspace. The three other tabs contain prepared, scripted notes. At capture time, file edits and individual passing test results are visible, but the TUI is still waiting for the model's final response; the complete test summary is folded out of view.

To reproduce, configure the endpoint and API key, then run `bun run demo edit` in Ghostty. Include the session tabs, input area, and bottom model bar. A dark background and 15–17 pt monospace text work well. See [the demo guide](../guide/demos.md) for the exact steps. Label terminal-rendered previews as such; do not present them as Ghostty screenshots.
