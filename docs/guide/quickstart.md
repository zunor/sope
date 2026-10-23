# Getting started

[Documentation](../README.md) · [Project overview](../../README.md)

## Install

Install from a release archive:

```sh
tar xzf sope-0.3.0-darwin-arm64.tar.gz
sope-0.3.0-darwin-arm64/install.sh         # Install sope into ~/.local/bin
sope-0.3.0-darwin-arm64/install.sh --lib   # Also install libsope and sope.h
```

Build and install from source:

```sh
bun install
bun run release        # Build, run all tests, and package into dist/
dist/sope-*/install.sh
```

Then configure the model once:

```sh
mkdir -p ~/.config/sope
cat > ~/.config/sope/config <<'EOF_CONFIG'
SOPE_API_KEY=your-api-key
# SOPE_MODEL=glm-5.3
# SOPE_BASE_URL=https://api-taas.moi.matrixorigin.cn/v1
EOF_CONFIG
chmod 600 ~/.config/sope/config
```

## Start a conversation

```sh
sope                                      # Open the TUI in the current directory
sope "Explain this project's structure"    # Open the TUI and send the first message
sope -p "Summarize the README"             # Print the answer to stdout and exit without a TUI
git diff | sope -p "Review these changes"
sope --version
```

The TUI uses the terminal's alternate screen, like vim or htop. On exit, the terminal returns to its previous state, and the conversation does not remain in scrollback. Use the mouse wheel or `pgup`/`pgdn` to browse the conversation; while you are scrolling up, new output will not pull the view back to the bottom.

For a source checkout, build with `bun install && bun run build:native`, then run `bun run tui`. Try `bun scripts/demo.ts tour` for an offline, scripted introduction. See [the demos](demos.md), [terminal guide](terminal.md), and [configuration reference](configuration.md).
