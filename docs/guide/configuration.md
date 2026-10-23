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
| `SOPE_LIB` | | Load a different libsope instead of the embedded copy |
| `SOPE_MOUSE` | | `1`; `0` leaves mouse input to the terminal (the wheel becomes ↑/↓) |
| `SOPE_GRAPHICS` | | Automatically probes for the Kitty graphics protocol; `0` disables the pixel meteor |
| `SOPE_TRUECOLOR` | | Automatically detected; `0`/`1` forces 256 colors / true color |
