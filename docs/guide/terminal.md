# The terminal workspace

[Documentation](../README.md) · [Project overview](../../README.md)

The `sope` executable is a full-screen coding assistant built on the same C ABI available to every embedding application. It keeps conversations, tools, and approvals together in your terminal.

## Images

Send screenshots and diagrams directly to the model: press `ctrl+v` to paste an image from the clipboard (using osascript on macOS, or wl-paste or xclip on Linux), or drag an image file into the terminal to attach it automatically. Attachments appear as `[Image #1]` in the input box and are included when you send the message. From the command line, use `sope --image shot.png "What is wrong here?"` (also works in `-p` mode). The model can also inspect images itself: `read` passes image files to the model, and `web_fetch` does the same for image URLs. The default glm-5.3 model is text-only, so as soon as the conversation contains an image, sope switches to `SOPE_IMAGE_MODEL` (default: `kimi-k3`).

## Approval previews

The approval dialog for `write` / `edit` shows a diff against the current file, with line numbers, background colors for additions and deletions, and syntax highlighting by file type (C/C++, JS/TS, Python, Go, Rust, Java, Shell, and JSON).

## Sessions

The top bar shows recently used sessions (up to 5). The tab bar occupies two rows. Each tab uses a thin rounded image outline, is 20 columns wide (narrower in very small windows), and is separated from the next by one column. Titles are rendered into the image, vertically centered with space above and below; long titles are truncated and slowly scroll back and forth on hover. All tab titles use regular weight; the active session has a white outline. Image tabs require Kitty graphics support, a terminal cell-size response, and the text rasterizer; otherwise tabs use native text with subtle background colors. Set `SOPE_GRAPHICS=0` to use the text fallback. The `⋯` button on the right (or `/sessions`) lists all saved sessions for the current directory: type to filter and press Enter to open one. Each tab is an independent agent that continues running in the background when you switch away. Sessions are stored in SQLite (`~/.local/share/sope/sope.db`, configurable with `SOPE_DB`). Execution state is stored by the native library under `<database path>.executions/<session id>/`; the UI database keeps the displayed conversation and a history cache. On reopening, the execution journal is authoritative, including results committed during a turn. Old transcript-only sessions are not automatically migrated.

Click `+`, press `alt+n`, or use `/new` to create a session. Click a tab or press `alt+1…9` to switch sessions. Hover over a tab to reveal `×`, then click it (or use `alt+w` or `/close`) to close the session. Closing only hides it from the bar; its data remains in the database. A `?` on a tab means the session is waiting for approval; `•` means it has finished running in the background.

The TUI captures mouse input: drag to select text and release to copy it to the clipboard (the bottom bar shows “copied N characters”). To use the terminal's own selection, hold Shift (Option in iTerm2) while dragging, or use `/mouse` to disable mouse capture. Set `SOPE_MOUSE=0` to disable it by default.

The status bar's pixel meteor travels around a small square once every 3 seconds, occupying one row and two columns. On startup, sope probes for the Kitty graphics protocol and enables the effect only after a successful response. Unsupported terminals and tmux/screen/Zellij use a single-row Braille animation instead. Set `SOPE_GRAPHICS=0` to disable the pixel effect. For a standalone preview without a model call, run `bun scripts/preview-meteor.ts`.

Typing `/` opens a command list above the input box; keep typing to filter it. Use `↑`/`↓` to select, `Enter` to use a command, `Tab` to complete it without executing, and `Esc` to dismiss the list. Mouse selection and scrolling are also supported. Commands that require arguments are first completed into the input box.

## Tools and permissions

All tools are built into libsope (see [the built-in tool reference](../abi.md#6-built-in-tools) for details); `sope` handles display and approval:

| Tool | Purpose | Approval required |
|---|---|---|
| `read`, `glob`, `grep` | Read files with line numbers, find files by pattern, and search with regular expressions (skipping files ignored by `.gitignore`) | No |
| `write`, `edit` | Create or overwrite files, or replace exact text; existing files must have been read and must not have changed since | Depends on permission mode; shows a change preview |
| `bash` | Run a command in the current directory (no terminal or input, 2-minute timeout by default); supports background execution | Depends on permission mode; shows the command |
| `bash_output`, `bash_kill` | Inspect or stop background commands | No |
| `web_fetch` | Fetch a web page and convert it to text | Depends on permission mode; shows the URL |
| `todo_write` | Maintain a task list displayed in the conversation | No |

The permission mode determines who approves actions. The current mode appears on the left of the bottom bar. Press `shift+tab` to cycle modes, or use `/permissions` or click the mode name to open the picker (`↑`/`↓` to select, Enter to confirm):

| Mode | Behavior |
|---|---|
| Ask for approval (`ask`) | Always asks for confirmation for tools marked “Depends on permission mode” above |
| Approve for me (`auto`, default) | Allows most actions and asks only for significant operations: deleting or changing files outside the working directory (except temporary directories), deleting the entire working directory or `.git`, `git push` and other publishing operations (`npm publish`, write operations through `gh`), discarding uncommitted Git changes (`reset --hard`, `clean -f`, `checkout -- file`), system changes such as `sudo`, global installs (`npm -g`, `brew install`), remote operations through `ssh`/`scp`, sending data out with `curl`, and piping downloaded scripts directly into a shell. The dialog explains why approval is needed |
| Full access (`full`) | Executes everything immediately |

“Approve for me” parses commands like a shell, inspecting pipelines, `&&`, `$( )`, and commands inside `sh -c`, `find -exec`, and `xargs`. It protects against mistakes, not malicious code: approved scripts and programs (such as tests or `python x.py`) can themselves do anything, and web fetches are approved directly. When running in `/` or the home directory, the working directory is too broad, so deletions and writes outside temporary directories always require approval.

In the approval dialog, select with `↑`/`↓` and confirm with Enter. You can also press `1`–`4`, click an option, or use shortcuts: `y` to allow once, `a` to stop asking for this tool in the current session, `n` to deny (the model receives the denial and can change its approach), or `esc` to deny and stop the entire turn. Pending requests are automatically approved when you switch to a more permissive mode. `--permissions ask|auto|full` (or `SOPE_PERMISSIONS`) sets the initial mode; `--allow-all` is equivalent to `full`. In `-p` mode, interactive confirmation is unavailable: the selected mode is applied, and any action that would require a prompt is denied with an explanation sent to the model.

## Keys and commands

Sent user messages appear in right-aligned rounded character boxes. Only the latest user message has a breathing border: gray to white and back over six seconds. Older borders stay gray; the idle animation updates at 10 fps and stops when that message is offscreen or covered by the session list.

The rounded input box grows with explicit newlines and wrapped text, up to eight content rows (fewer in short windows), then scrolls to keep the cursor visible. Enter sends the message; Ctrl+J is the fallback newline shortcut when a terminal cannot distinguish Shift+Enter.

| Key | Action |
|---|---|
| `enter` | Send |
| `shift+enter` / `ctrl+j` / `alt+enter` | Insert a newline (`shift+enter` requires enhanced keyboard support) |
| `esc` | Cancel the current turn, including subagents |
| `shift+tab` | Cycle permission modes |
| `alt+n` / `alt+w` | Create / close a session |
| `alt+m` | Select a model |
| `alt+1` … `alt+9` | Switch to the Nth session |
| `ctrl+t` / `F2` | Toggle the ABI trace panel: `→` marks calls from the TUI into the library; `←` marks events returned by `sope_poll` |
| `pgup` / `pgdn` | Scroll the conversation |
| Hover over / click a long tool output block | Hover anywhere in the block to turn its connector and `… N more lines` white; click anywhere to expand, then click the expanded block to collapse |
| `↑` / `↓` | Move within multiline input; browse input history at its boundaries |
| `ctrl+a/e`, `alt+b/f`, `ctrl+w/u/k` | Emacs-style editing (word movement supports Chinese word segmentation) |
| `ctrl+c` | Cancel a running turn, clear nonempty input, or otherwise exit |

Commands: `/recover [resume|resolve <id> <ok|error> <outcome>]`, `/help`, `/new`, `/close`, `/clear` (also clears conversation history), `/compact [focus]`, `/model [name]` (opens the model picker without an argument), `/thinking` (expand/collapse reasoning), `/permissions [ask|auto|full]`, `/trace`, `/mouse`, `/set <key> [value]`, and `/quit`.

`/model` or `alt+m` opens the model picker. It lists chat models and context sizes from the endpoint (`GET /models`), with recently used models first. Type to search, select with `↑`/`↓`, and press Enter to use a model; you can also enter a name that the endpoint does not list. The selected model takes effect on the next turn in the current session and becomes the default for new sessions.

When context exceeds `SOPE_COMPACT_THRESHOLD` (default: 100000 tokens), history is automatically compacted into a summary. Use `/compact` to compact it manually at any time. The displayed conversation stays intact; the model receives a summary of older history plus recent original messages retained within budget. Restored history, new input and tool results are counted before each request.

See [configuration](configuration.md) for environment variables and [demos](demos.md) for reproducible English examples.


After a process crash, use `/recover` to inspect unfinished work. Completed tool results are reused. Calls with unknown outcomes stay paused: inspect the files, command state or external service, then record the verified outcome with `/recover resolve <call-id> <ok|error> <observed outcome>`. This command does not run the tool. Once every unknown call is reconciled, `/recover resume` continues the original task. If an outcome cannot be verified, leave it paused. Closing an inspected, unresumed session preserves its recovery state.

Long tool outputs include a path to the complete archive. The agent can retrieve omitted content with `artifact_read`, or search the file with shell tools. These files remain after the agent closes; retention is controlled by the host. `/clear` commits immediately for an idle durable session and refuses to erase running or unresolved work.
