# Configuration

[Documentation](../README.md) · [Project overview](../../README.md)

Precedence, from lowest to highest: `~/.config/sope/config` (`KEY=VALUE` format) < environment variables < command-line arguments.

| Variable | Argument | Default |
|---|---|---|
| `SOPE_API_KEY` | | When set, selects the `openai` provider by default |
| `SOPE_MODEL` | `-m`, `--model` | `glm-5.3` |
| `SOPE_IMAGE_MODEL` | | `kimi-k3` on the default endpoint (glm-5.3 cannot process images); `off` sends images to `SOPE_MODEL` as well |
| `SOPE_DB` | | `~/.local/share/sope/sope.db` (session database) |
| `SOPE_BASE_URL` | `--base-url` | `https://api-taas.moi.matrixorigin.cn/v1` |
| `SOPE_PROVIDER` | `--provider` | `openai` when a key is set, otherwise `mock` |
| `SOPE_PERMISSIONS` | `--permissions`, `--allow-all` | `auto` (Approve for me); also supports `ask` and `full` |
| `SOPE_COMPACT_THRESHOLD` | | `100000` (`0` disables automatic compaction) |
| `SOPE_CONTEXT_WINDOW` | | `0` (unknown); set to the full token window of the model used |
| `SOPE_LIB` | | Load a different libsope instead of the embedded copy |
| `SOPE_MOUSE` | | `1`; `0` leaves mouse input to the terminal (the wheel becomes ↑/↓) |
| `SOPE_GRAPHICS` | | Automatically probes for the Kitty graphics protocol; `0` disables image tabs and the pixel meteor |
| `SOPE_TRUECOLOR` | | Automatically detected; `0`/`1` forces 256 colors / true color |

Context is checked before each model request, including restored sessions and newly added tool results. Set `SOPE_CONTEXT_WINDOW` for the model actually used (use the smaller capacity if switching between text and image models). The default output reservation is 4096 tokens. In the TUI, `/set context.window 128000` changes the window from the next turn; `/set context.reserve 8192` increases the normal output allowance. A window value of zero leaves the model capacity unknown.

`/compact [focus]` summarizes older messages while retaining recent originals within budget. `/set compact.retain_tokens 8000`, `/set compact.max_tokens 2048` and `/set compact.input_tokens 64000` control retention, summary output and summary input respectively. See the [ABI compaction contract](../abi.md#51-history-compaction) for failure behavior and estimation limits.

Native options are also available through `/set`. `/set openai.wire_api responses` selects stateless Responses requests on endpoints that support that protocol; the default is `chat`. `/set reasoning.effort high` sets the model's reasoning effort. Supported effort values depend on the model. These options take effect on the next turn; see the [ABI options table](../abi.md#9-options-and-providers) for the complete list.
