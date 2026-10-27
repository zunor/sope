# The terminal workspace

[Documentation](../README.md) · [Project overview](../../README.md)

The `sope` executable is a full-screen coding assistant built on the same C ABI available to every embedding application. It keeps conversations, tools, and approvals together in your terminal.

## Images

Send screenshots and diagrams directly to the model: press `ctrl+v` to paste an image from the clipboard (using osascript on macOS, or wl-paste or xclip on Linux), or drag an image file into the terminal to attach it automatically. Attachments appear as `[Image #1]` in the input box and are included when you send the message. From the command line, use `sope --image shot.png "What is wrong here?"` (also works in `-p` mode). The model can also inspect images itself: `read` passes image files to the model, and `web_fetch` does the same for image URLs. The default glm-5.3 model is text-only, so as soon as the conversation contains an image, sope switches to `SOPE_IMAGE_MODEL` (default: `kimi-k3`).

## Approval previews

The approval dialog for `write` / `edit` shows a diff against the current file, with line numbers, background colors for additions and deletions, and syntax highlighting by file type (C/C++, JS/TS, Python, Go, Rust, Java, Shell, and JSON).

In the Changes panel, click a filename to open its diff. Click the open file again to collapse it; another click expands it at the same scroll position. The `▾` / `▸` arrows show which file is expanded or collapsed.

## Sessions

The top bar shows recently used sessions (up to 5). The tab bar occupies two rows. Each tab uses a thin rounded image outline, is 20 columns wide (narrower in very small windows), and is separated from the next by one column. Titles are rendered into the image, vertically centered with space above and below; long titles are truncated and slowly scroll back and forth on hover. All tab titles use regular weight; the active session has a white outline. Image tabs require Kitty graphics support, a terminal cell-size response, and the text rasterizer; otherwise tabs use native text with subtle background colors. Set `SOPE_GRAPHICS=0` to use the text fallback. The `⋯` button on the right (or `/sessions`) lists all saved sessions for the current directory: type to filter and press Enter to open one. Each tab is an independent agent that continues running in the background when you switch away. Sessions are stored in SQLite (`~/.local/share/sope/sope.db`, configurable with `SOPE_DB`). Execution state is stored by the native library under `<database path>.executions/<session id>/`; the UI database keeps the displayed conversation and a history cache. On reopening, the execution journal is authoritative, including results committed during a turn. Old transcript-only sessions are not automatically migrated.

Click `+`, press `alt+n`, or use `/new` to create a session. Click a tab or press `alt+1…9` to switch sessions. Hover over a tab to reveal `×`, then click it (or use `alt+w` or `/close`) to close the session. Closing only hides it from the bar; its data remains in the database. A `?` on a tab means the session is waiting for approval; `•` means it has finished running in the background.

The TUI captures mouse input: click inside the message input to place the cursor, including on wrapped lines; click after a line's text to move to its end. Drag inside the input to select text, then press `Backspace` or `Delete` to delete the selection. Typing or pasting replaces it; `Esc` clears the selection. In the conversation, drag to select text and release to copy it to the clipboard (the bottom bar shows “copied N characters”). To use the terminal's own selection, hold Shift (Option in iTerm2) while dragging, or use `/mouse` to disable mouse capture. Set `SOPE_MOUSE=0` to disable it by default.

The status bar's pixel meteor travels around a small square once every 3 seconds, occupying one row and two columns. On startup, sope probes for the Kitty graphics protocol and enables the effect only after a successful response. Unsupported terminals and tmux/screen/Zellij use a single-row Braille animation instead. Set `SOPE_GRAPHICS=0` to disable the pixel effect. For a standalone preview without a model call, run `bun scripts/preview-meteor.ts`.

Typing `/` opens a command list above the input box; keep typing to filter it. Use `↑`/`↓` to select, `Enter` to use a command, `Tab` to complete it without executing, and `Esc` to dismiss the list. Mouse selection and scrolling are also supported. Commands that require arguments are first completed into the input box.

## Text diagrams

Recognized ASCII and Unicode box diagrams use a separate horizontal viewport:
rows never wrap when the terminal narrows. Move the pointer over a diagram and
scroll horizontally, use Shift+wheel, or click its footer arrows. Vertical wheel
input still scrolls the conversation. Each diagram remembers its own horizontal
position. Search can reveal labels outside the visible columns.

The display conservatively aligns walls within two cells of matching corners
and fills isolated gaps in horizontal borders. It preserves label positions,
skips ambiguous or connected edges, and rejects repairs that would keep changing
on a second pass. Large diagrams (over 256 rows or 512 columns) remain unmodified.
Click the middle of a repaired diagram's footer to switch between original and
repaired text; drag its text to select and copy the visible presentation.

During streaming, recognized diagrams append complete rows without wrapping or
repairing partial lines. Repair runs after the fence closes, an unfenced block
ends, or the response completes. Message history and model input always retain
the original text. Diagrams can be unfenced, or inside an unlabeled, `text`,
`plaintext`, `ascii`, or `diagram` fence; other code fences remain ordinary code.

## Tools and permissions

All tools are built into libsope (see [the built-in tool reference](../abi.md#6-built-in-tools) for details); `sope` handles display and approval:

| Tool | Purpose | Approval required |
|---|---|---|
| `read`, `glob`, `grep` | Read files with line numbers, find files by pattern, and search with regular expressions (skipping files ignored by `.gitignore`) | No |
| `write`, `edit` | Create or overwrite files, or replace exact text; existing files must have been read and must not have changed since | Depends on permission mode; shows a change preview |
| `bash` | Run a command with `/bin/bash -o pipefail -c` in the current directory (no terminal or input, 2-minute timeout by default); supports background execution | Depends on permission mode; shows the command |
| `check` | Run a test/build command with literal arguments and retain its execution receipt | Yes |
| `evidence` | Read recent execution facts after compaction or reopening | No |
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
| `ctrl+f` | Search the conversation (see [Searching the conversation](#searching-the-conversation)) |
| Hover over / click a long tool output block | Hover anywhere in the block to turn its connector and `… N more lines` white; click anywhere to expand, then click the expanded block to collapse |
| `↑` / `↓` | Move within multiline input; browse input history at its boundaries |
| `ctrl+a/e`, `alt+b/f`, `ctrl+w/u/k` | Emacs-style editing (word movement supports Chinese word segmentation) |
| `ctrl+c` | Cancel a running turn, clear nonempty input, or otherwise exit |

Commands: `/recover [resume|resolve <id> <ok|error> <outcome>]`, `/help`, `/find [text]` (search the conversation), `/new`, `/close`, `/clear` (also clears conversation history), `/context` (what fills the context window), `/compact [focus]`, `/effort [level]` (how long the model thinks), `/model [name]` (opens the model picker without an argument), `/thinking` (expand/collapse reasoning), `/permissions [ask|auto|full]`, `/trace`, `/mouse`, `/set <key> [value]`, and `/quit`.

### Searching the conversation

`ctrl+f` (or `/find`) replaces the input box with a one-line search bar; the conversation above stays in view. Typing highlights matches as you go and selects the one nearest the current view. The counter numbers matches from the newest, so `1/17` is the most recent. Matching ignores case unless the query contains a capital letter. The search covers the visible text of user messages, replies, tool names and inputs, tool output, and errors; it includes reasoning only while `/thinking` shows it. A match inside a collapsed tool output expands that output when you move to it. `cmd+f` also opens the bar if the terminal passes it on. Ghostty uses `cmd+f` for its own scrollback search, and a full-screen app has no scrollback to search. To send `cmd+f` to sope instead, add `keybind = super+f=unbind` to the Ghostty config. This applies in every Ghostty window, not only in sope.

`Enter` moves to the next (older) match and wraps from the oldest back to the newest; `shift+enter` moves the other way where the terminal reports it. `↑`/`↓` and the `↑` `↓` buttons at the right of the search bar (click them) also move to an older or newer match, wrapping at the ends. After the first `enter`, the bar is in browse mode: `n`/`N` move to an older or newer match, `o` (or `tab`) collapses or expands the output that contains the current match, and `q` closes the bar and stays on the match. In browse mode, typing any other character, `backspace`, `/` or `ctrl+f` returns to editing the query. `Esc` closes the bar and returns to where you were before searching. `pgup`/`pgdn` and the mouse wheel still scroll. `/find <text>` opens the bar already in browse mode for `<text>`. Switching sessions closes the search.

`/model` or `alt+m` opens the model picker. It lists chat models and context sizes from the endpoint (`GET /models`), with recently used models first. Type to search, select with `↑`/`↓`, and press Enter to use a model; you can also enter a name that the endpoint does not list. The selected model takes effect on the next turn in the current session and becomes the default for new sessions.

`/effort` opens a slider of reasoning effort levels: Default (the model decides), Low, Medium, High and Extra high. Move it with `←`/`→` (or the wheel), press Enter or a number `1`–`5` to choose, or click a level. `/effort high` sets a level directly, `/effort minimal` and `/effort none` reach the levels the slider leaves out, and `/effort default` stops sending one. The level applies to the current session from its next turn and becomes the default for new sessions; `--effort` or `SOPE_REASONING_EFFORT` sets it at startup. Which levels a model accepts depends on the model: when the endpoint rejects one, sope says so under the error.

The right end of the bottom bar shows the session's model and how full the context is, such as `glm-5.3 · 42.1k / 200k`: the tokens the next request starts from, out of the model's window (only the first number when the window is unknown). `/context` adds a breakdown to the conversation: a bar over the window with a tick where automatic compaction starts, the share of the system prompt, tool definitions, summary, messages, tool results and images, the free space and output reserve, and the three largest tool results. While a turn runs, it describes that turn's last request.

When context exceeds the automatic compaction threshold, history is automatically compacted into a summary. The threshold is 80% of the model's window when the endpoint's `/models` list reports it (or `SOPE_CONTEXT_WINDOW` sets it), 100000 tokens otherwise, and `SOPE_COMPACT_THRESHOLD` overrides both. Use `/compact` to compact it manually at any time. The displayed conversation stays intact; the model receives a summary of older history plus recent original messages retained within budget. Restored history, new input and tool results are counted before each request.

See [configuration](configuration.md) for environment variables and [demos](demos.md) for reproducible English examples.


After a process crash, use `/recover` to inspect unfinished work. Completed tool results are reused. Calls with unknown outcomes stay paused: inspect the files, command state or external service, then record the verified outcome with `/recover resolve <call-id> <ok|error> <observed outcome>`. This command does not run the tool. Once every unknown call is reconciled, `/recover resume` continues the original task. If an outcome cannot be verified, leave it paused. Closing an inspected, unresumed session preserves its recovery state.

Long tool outputs include a path to the complete archive. The agent can retrieve omitted content with `artifact_read`, or search the file with shell tools. These files remain after the agent closes; retention is controlled by the host. `/clear` commits immediately for an idle durable session and refuses to erase running or unresolved work.


Repeated identical reads and failed operations have native execution budgets;
a blocked call reports the earlier admission ID and does not run. Three blocked
calls end that turn as an error. A new user request opens a new budget. Context
compaction and session recovery cannot silently reset the current budget.

Completed checks and foreground shell commands retain execution receipts. The
final execution footer is generated by sope, while the analysis above it is
model-authored. A zero process exit is not a claim that tests ran, assertions
were sound, or all bugs were excluded. Use `evidence` and the linked raw output
to verify such claims. See [execution budgets and evidence](../abi.md#execution-budgets-and-evidence).
