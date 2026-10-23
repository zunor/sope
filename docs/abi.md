# sope C ABI

`include/sope.h` 是 ABI 的唯一事实来源。本文解释头文件注释里放不下的东西：线程模型、生命周期、回合与子 agent 语义、所有权，以及给语言绑定作者的说明。

> 当前版本 0.3.0（ABI 0.3）。兼容规则（`sope_version_number()` 返回运行时实际加载的版本）：
> - 1.0 之后按语义化版本：针对 X.Y 编译的宿主，可以使用任何 X.Z（Z ≥ Y）的库；破坏性变更只出现在主版本号。
> - 1.0 之前，次版本号变化就可能破坏 ABI：宿主要求主、次版本号都相同，修订号可以不同。
>
> 绑定层应该在加载库时检查版本（JS 绑定已经这样做）。发布与版本策略见 [release.md](release.md)。

## 1. 基本约定

| 约定 | 说明 |
|---|---|
| 返回值 | `int` 返回 `SOPE_OK`(0) 或正数表示成功，负数为 `SOPE_E*` 错误码 |
| 错误信息 | 失败后调用 `sope_last_error()` 取得描述。它是 **线程局部** 的（类似 `errno`），并发调用互不干扰 |
| 字符串 | 一律 UTF-8。带长度参数的输入不要求 NUL 结尾；库返回的字符串总是 NUL 结尾 |
| 所有权 | 库从不接管调用方内存，所有输入在调用返回前复制完毕 |
| 句柄 | `sope_agent_t*` 是不透明指针，不要假设其布局 |

### 错误码

| 码 | 值 | 含义 |
|---|---|---|
| `SOPE_OK` | 0 | 成功 |
| `SOPE_ERROR` | -1 | 未分类错误 |
| `SOPE_EINVAL` | -2 | 参数非法 |
| `SOPE_ENOMEM` | -3 | 内存不足 |
| `SOPE_ENOTFOUND` | -4 | 对象不存在（工具调用 id、provider 等） |
| `SOPE_ECLOSED` | -5 | agent 已关闭 |
| `SOPE_ECANCELLED` | -6 | 操作被取消 |
| `SOPE_EBUSY` | -7 | 当前状态下不允许（如线程池已启动后再设置线程数） |

## 2. 架构与线程模型

```
  宿主                                    libsope
 ┌───────────────┐ send / cancel /    ┌───────────────────────────────────────────┐
 │ UI / 业务线程  │─ tool_result ─────▶│ agent A ─┬─ 子 agent A1    ┐              │
 │               │                    │ agent B  └─ 子 agent A2    ├─▶ 共享线程池  │
 │ 事件循环       │◀─ fd 可读 ─────────│ agent C                    ┘   (N 个线程) │
 │ (poll/epoll)  │◀─ sope_poll ───────│ 内置工具调用（每次调用一个任务）  ▲          │
 └───────────────┘                    │  HTTP I/O 线程 (libcurl multi) ─┤ 唤醒     │
                                      │  进程回收线程 (bash 子进程) ─────┘          │
                                      └───────────────────────────────────────────┘
```

- **agent 不占线程。** 所有 agent（包括子 agent）由一个进程级共享线程池执行，创建 agent 只花内存。
- **同一 agent 的回合严格串行、按顺序执行**；不同 agent、同一回合里的多个子 agent 之间并行。
- **线程池线程从不阻塞。** 回合是状态机：等工具结果、等子 agent、等模型的下一块流式输出时，回合挂起并让出线程。网络由一个 HTTP I/O 线程统一驱动（libcurl multi），收到数据就唤醒对应的回合；`bash` 启动的子进程由一个回收线程统一读取输出、回收退出状态，同样只在有动静时唤醒。
- **内置工具的每次调用是一个独立任务**，所以模型在一次回复里并行请求的多个工具真的并行执行。读文件、搜索这类调用直接在线程池里完成；等命令、等下载时不占线程。
- `sope_set_threads(n)` 设置线程数，必须在第一个 `sope_agent_new` 之前（或 `sope_shutdown` 之后），否则 `SOPE_EBUSY`。`0` 为默认值（CPU 数，限制在 2–8）。
- `sope_shutdown()` 停止并 join 线程池、HTTP 线程和进程回收线程，要求所有 agent 已释放。可选，用于卸载动态库前或获得干净的泄漏检测报告；下次 `sope_agent_new` 自动重启。

### 哪些函数可以从哪些线程调用

| 函数 | 规则 |
|---|---|
| 除下面两个以外的所有函数 | 任意线程、可并发 |
| `sope_poll` | 任意线程，但同一 agent **同一时刻只能有一个线程在 poll**（单消费者） |
| `sope_agent_free` | 不得与同一 agent 上的任何其他调用并发 |

## 3. 等待事件：阻塞 poll 或可读 fd

两种方式任选：

1. **阻塞 poll**：`sope_poll(agent, &ev, timeout_ms)`。适合每个 agent 一个轮询线程（或 Worker）的宿主。
2. **可读 fd**：`sope_agent_fd(agent)` 返回一个文件描述符，**当且仅当** `sope_poll` 不会阻塞时（有事件排队，或 agent 已关闭）可读。把它交给 `poll`/`epoll`/`kqueue`/libuv/asyncio 等事件循环，一个线程就能等待成千上万个 agent；可读后用 `sope_poll(agent, &ev, 0)` 把事件取完即可。

fd 由 agent 拥有：**不要读、写或关闭它**。它在第一次调用时创建（每个 agent 占 2 个 fd），在 `sope_agent_free` 时关闭。目前仅支持 POSIX。示例见 `examples/multiplex.c`。

## 4. 生命周期

```
sope_agent_new ─▶ sope_agent_set_option / sope_tool_register / sope_subagent_register
              ─▶ sope_send ──┐
                             ▼
               ┌──── 等事件（sope_poll 或 fd）◀──────────────────┐
               │  TOOL_CALL → 执行工具 → sope_tool_result          │
               │  TURN_END  → 一个回合结束                          │
               └───────────────────────────────────────────────────┘
sope_agent_close ─▶ 继续取事件直到 SOPE_ECLOSED ─▶ sope_agent_free
```

- `sope_agent_close` 幂等：取消运行中的回合（连同其子 agent），把排队中的回合以 `cancelled` 结束，之后 `sope_send` 返回 `SOPE_ECLOSED`。剩余事件取完后 `sope_poll` 返回 `SOPE_ECLOSED`。
- `sope_agent_free` 会在需要时先 close，等线程池处理完该 agent **及其所有子 agent**，再释放内存。
- `sope_agent_reset` 清空对话历史，在下一个回合开始时生效。
- **保存与恢复会话**：`sope_agent_history(agent, &json, &len)` 把对话历史导出为 JSON 数组，`sope_agent_load_history(agent, json, len)` 把它装回（可以是另一个进程里的新 agent）。两者都只能在回合之间调用，回合运行或排队时返回 `SOPE_EBUSY`，所以在 `SOPE_EVENT_TURN_END` 时导出最合适。导出的指针在下一次 `sope_agent_history` 或 `sope_agent_free` 之前有效，不需要宿主释放。库不管存储，存在哪由宿主决定（sope TUI 用 SQLite）。

  ```json
  [{"role":"user","content":"修一下这个 bug"},
   {"role":"assistant","content":"我先看看。",
    "tool_uses":[{"id":"call_1","name":"read","input":"{\"file_path\":\"a.c\"}"}]},
   {"role":"tool","tool_use_id":"call_1","name":"read","content":"…","is_error":false},
   {"role":"assistant","content":"改好了。"}]
  ```

  `input` 是工具输入 JSON 的字符串形式。带图片的 user 和 tool 消息另有 `"images":[{"media_type":"image/png","data":"<base64>"}]`。压缩过的历史以摘要（一条 user 消息）开头；推理过程不保存。装回时，结尾没有回答的工具调用会补上“cancelled”结果；agent 会忘记读过哪些文件，所以恢复后修改文件前要先重新读。格式不对返回 `SOPE_EINVAL`，`sope_last_error()` 说明是哪条消息。

- **图片**：`sope_attach_image(agent, media_type, data, len)` 把一张图片（PNG、JPEG、GIF、WebP 的原始字节，最多 10 MiB，库会复制）挂到下一次 `sope_send` 的消息上；一条消息带走此前附加的全部图片，`sope_compact` 不会带走。`media_type` 传 NULL 时按文件头识别。内置工具也会产生图片：`read` 读到图片文件、`web_fetch` 抓到图片 URL 时，结果附带图片给模型看。`openai` provider 把图片作为 `image_url`（data URL）内容块发送；tool 消息只能放文字，所以一轮工具结果里的图片紧跟着用一条 user 消息补发。模型要能看图：只认文字的模型（如 glm-5.3，服务端会返回 400）可以设置选项 `image_model`，对话里一出现图片，之后的请求就改用它。

## 5. 回合（turn）与 agent 循环

每次成功的 `sope_send` 产生一个回合，返回其 `turn_id`（每个 agent 从 1 递增）。一个回合内部是 agent 循环：

```
调用模型 ──(模型请求工具)──▶ 运行内置工具 / 发出 TOOL_CALL / 启动子 agent ──(结果全部到齐)──▶ 再调用模型 ──▶ …
   └──(模型直接回答，不调工具)──▶ TURN_END(end_turn)
```

- 一次模型调用可以并行请求多个工具。内置工具由库并行执行（见第 6 节）；宿主工具的 `TOOL_CALL` 依次发出，宿主可以并行执行。全部结果到齐后才进入下一轮。
- 每个回合最多调用模型 `max_rounds` 次（默认 32），超出则以 `ERROR` + `TURN_END(error)` 结束。
- 模型调用了未提供的工具时，库直接以错误结果回给模型，不会打扰宿主。
- 对话历史（用户消息、助手消息与工具调用、工具结果）由 agent 保存，跨回合累积。回合被取消时，没有结果的工具调用会补上 `cancelled` 结果，保证历史对模型 API 始终合法。
- 历史过长时可以压缩，见第 5.1 节。

库保证的不变式：

1. **每个被接受的回合恰好产生一个 `TURN_END`**，即使它在开始前就被 close 丢弃。
2. 回合真正开始执行时先产生 `TURN_START`；开始前就被丢弃的回合只有 `TURN_END`。
3. 一个回合的所有事件（包括其子 agent 的事件）都在它的 `TURN_END` 之前。
4. `TOOL_CALL` 之后，回合会一直等到 `sope_tool_result`；`PERMISSION` 之后，会一直等到 `sope_permit`；或者被取消。
5. 宿主看到"打开"的每个工具调用（宿主工具的 `TOOL_CALL`、内置工具的 `TOOL_START`）都会以同一个 `call_id` 的 `TOOL_END` 结束，并且在 `TURN_END` 之前，回合被取消时也一样（结果为 `Cancelled.`）。
6. 回合结束后，它未完成的工具调用全部失效；迟到的 `sope_tool_result` / `sope_permit` 返回 `SOPE_ENOTFOUND`。

`sope_cancel` 会杀掉正在运行的命令（整个进程组）、中止正在进行的下载，然后结束回合。

`sope_cancel` 只取消**正在运行**的回合（连同其子 agent），不影响排队的回合。

### 5.1 历史压缩

长对话会撑满模型的上下文窗口。压缩就是让模型把历史总结成一段摘要，再用这段摘要（作为一条用户消息）替换整个历史。

- **自动**：设置选项 `compact.threshold`（token 数）。某次模型调用报告的 `input_tokens + output_tokens` 达到阈值后，下一次调用模型之前先压缩。
  - 在回合开头触发时，压缩的是之前的历史，新的用户消息原样保留在摘要之后。
  - 在回合中途触发时（例如工具循环很长），压缩全部历史，摘要末尾提示模型继续当前任务。
  - 未设置或设为 0 时，库从不自行压缩。嵌入式库不应在宿主不知情时额外调用模型，所以默认关闭；`sope` 命令行默认阈值为 100000。
- **手动**：`sope_compact(agent, instructions, len, &turn_id)` 排入一个压缩回合，和 `sope_send` 一样按顺序执行。`instructions` 可选，用来引导摘要，例如 "保留测试失败的细节"。历史为空时直接以 `end_turn` 结束。
- 压缩调用本身不带工具，也不产生 `TEXT_DELTA` 和 `THINKING_DELTA`。它照常产生 `USAGE`（token 确实消耗了），完成后产生 `SOPE_EVENT_COMPACT`：`name` 是 `"auto"` 或 `"manual"`，`data` 是摘要全文。
- 压缩失败时历史保持不变：手动压缩以 `TURN_END(error)` 结束；自动压缩产生 `ERROR` 事件后继续用完整历史调用模型。取消压缩同样不改动历史。
- 模型看到的是一份纯文本对话记录，不是原始的消息结构。单个工具结果在记录中截断到 2000 字节，以免压缩请求本身超出上下文。提示词在 `src/compact.c`。

## 6. 内置工具

每个 agent 自带一组工具，库自己执行，宿主不用写任何代码。工具集参考了 soren（Claude Code 的工具设计）里最常用的几个：

| 工具 | 作用 | 需要许可 |
|---|---|---|
| `read` | 读文件，`cat -n` 格式带行号；`offset`/`limit` 分段，默认 2000 行；图片文件（PNG、JPEG、GIF、WebP）直接交给模型看；其他二进制文件和目录会报错 | 否 |
| `glob` | 按路径模式找文件（`**/*.ts`、`src/**/test_*.{c,h}`），按修改时间新→旧，最多 100 个 | 否 |
| `grep` | 按正则搜索内容；`output_mode` = `files_with_matches`（默认）/ `content` / `count`，支持 `glob`、`case_insensitive`、`context`、`head_limit` | 否 |
| `write` | 写文件（自动创建父目录） | 是 |
| `edit` | 精确替换文本；`old_string` 不唯一时报错，除非 `replace_all`；`old_string` 为空表示新建文件 | 是 |
| `bash` | `bash -c` 执行命令，返回合并的 stdout/stderr 和退出码；`timeout` 默认 2 分钟、最长 10 分钟；`run_in_background` 后台运行 | 是 |
| `bash_output` | 读后台命令自上次以来的新输出，以及是否还在运行 | 否 |
| `bash_kill` | 停止后台命令及其所有子进程 | 否 |
| `web_fetch` | 抓取 http(s) URL：HTML 转成带标题、列表、链接的文本（页面里的图片写成 `![alt](url)`），文本和 JSON 原样返回，图片 URL 直接把图片给模型；跟随重定向，长页面用 `offset` 分段（每段约 4 万字节） | 是 |
| `todo_write` | 维护任务清单：每次提交完整列表，每项有 `content`、`activeForm`、`status` | 否 |

工具的完整描述和 JSON Schema 在 `src/tools.c`，模型看到的就是这些。

**事件。** 每次内置工具调用先产生 `TOOL_START`（`data` 是 JSON 输入，宿主可以据此显示，例如把 `todo_write` 的列表画出来），最后产生 `TOOL_END`（`code` 为 1 表示失败，`data` 是模型看到的结果）。宿主工具调用结束时同样会有 `TOOL_END`，所以宿主可以只在一个地方显示所有工具的结果。

**许可。** 会改文件、执行命令或访问网络的工具（上表"是"）在执行前产生 `PERMISSION` 事件并等待：

```c
case SOPE_EVENT_PERMISSION:
    /* ev.name: 工具名，ev.data: JSON 输入；问用户，或按宿主自己的策略 */
    sope_permit(agent, ev.call_id, user_said_yes, reason, reason_len);
```

拒绝时可以附一句话（`message`），它会连同拒绝一起交给模型，比如"改用 edit"。选项 `permissions` 设置整体策略：`ask`（默认）、`allow`（不问，直接执行）、`deny`（直接拒绝，适合只读场景）。"本次会话总是允许某个工具"这类策略留在宿主：收到 `PERMISSION` 后立即 `sope_permit` 即可。

**工作目录。** 选项 `cwd` 设置相对路径的起点和命令的工作目录，默认是进程的当前目录。工具接受绝对路径，`~/` 展开为 `$HOME`。

**读后再改。** agent 记录模型读过（或写过）的每个文件的修改时间和大小。`write` 和 `edit` 拒绝修改模型没读过的已有文件，也拒绝修改读过之后又被别人改过的文件，要求先重新读，避免模型基于过时的内容覆盖别人的改动。`sope_agent_reset` 清空这份记录；子 agent 有自己的记录。

**搜索的规则。** `glob` 和 `grep` 跳过隐藏文件、`node_modules`，以及 `.gitignore`（从仓库根目录到搜索目录的每一层）忽略的路径。不带 `/` 的模式（如 `*.c`）只匹配搜索目录这一层，`**/*.c` 才递归。`grep` 使用 POSIX 扩展正则，并把模型常写的 `\d`、`\w`、`\s`（及大写形式）、`(?i)`、`(?:...)`、惰性量词改写成等价写法；超过 20 MB 的文件和二进制文件不搜索。

**命令的环境。** `bash` 的命令在新会话里运行（没有控制终端，可以整组杀掉），stdin 是 `/dev/null`，继承宿主进程的环境变量，并设置 `PAGER=cat`、`GIT_PAGER=cat`、`GIT_TERMINAL_PROMPT=0`、`TERM=dumb`、`NO_COLOR=1`。每次调用都是新的 shell，`cd` 不会保留。输出超过 3 万字节时保留开头和结尾；结果去掉 ANSI 转义序列，并保证是合法的 UTF-8。后台命令属于根 agent，`sope_agent_free` 时全部杀掉。

**替换内置工具。** 用 `sope_tool_register` 注册同名的宿主工具，就会替换掉对应的内置工具（例如宿主想在沙箱里执行 `bash`）。

## 7. 子 agent

设计参考 soren 的 AgentTool：

- 只要注册了子 agent 类型（内置一个 `general-purpose`），模型就会看到内置工具 `agent`，输入为 `{description, prompt, subagent_type?}`。选项 `subagents=off` 可以隐藏它。
- 模型调用 `agent` 时，库创建一个**子 agent**：全新的对话历史、该类型的系统提示词、按类型过滤后的工具集（内置工具和宿主工具）（**永远不含 `agent` 本身，所以不会递归**）、可选的独立模型。它作为独立任务跑在线程池上，所以模型在一次回复中启动的多个子 agent 是**并行**执行的。
- 子 agent 跑完一个回合后自动关闭，它的**最后一条消息**作为 `agent` 工具的结果返回给父 agent。被取消或失败时，结果会标记为错误并附上部分输出。
- 子 agent 的事件进入**同一个事件队列**（同一个 fd），`agent_id` = 启动它的那次调用的 `call_id`。子 agent 请求的宿主工具同样以 `TOOL_CALL` 出现，需要许可的内置工具同样以 `PERMISSION` 出现，宿主照常用根 agent 句柄调用 `sope_tool_result` / `sope_permit` 即可。

注册子 agent 类型：

```c
static const char def[] =
    "{\"name\":\"reviewer\",\"description\":\"Reviews a diff for bugs.\","
    "\"system_prompt\":\"You are a careful code reviewer...\","
    "\"tools\":[\"read\",\"grep\",\"glob\"],\"model\":\"glm-5.3\",\"max_rounds\":8}";
sope_subagent_register(agent, def, sizeof def - 1);
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 1–64 个 `[A-Za-z0-9_-]` 字符，同名覆盖 |
| `description` | 是 | 何时使用它，会展示给模型 |
| `system_prompt` | 是 | 子 agent 的系统提示词 |
| `tools` | 否 | 工具名数组（内置或宿主工具），或 `"*"`（默认，全部） |
| `model` | 否 | 覆盖父 agent 的模型 |
| `max_rounds` | 否 | 覆盖父 agent 的 `max_rounds` |

## 8. 事件

调用方每次 `sope_poll` 前把 `ev.size` 设为 `sizeof(sope_event_t)`。`name`/`data` 永不为 NULL，有效期到同一 agent 的下一次 `sope_poll` 或 `sope_agent_free`；需要保留请自行复制。`agent_id` 为 0 表示 agent 自身的事件，否则是某个子 agent 的事件。

| type | 值 | 字段 |
|---|---|---|
| `TURN_START` | 1 | `turn_id` |
| `TEXT_DELTA` | 2 | `data`：一段助手输出文本 |
| `TOOL_CALL` | 3 | `call_id`，`name`：工具名，`data`：JSON 输入。需要用 `sope_tool_result` 回复 |
| `TURN_END` | 4 | `code`：`SOPE_STOP_END_TURN`(0) / `CANCELLED`(1) / `ERROR`(2) |
| `ERROR` | 5 | `code`：`SOPE_E*`，`data`：错误描述；之后通常跟着 `TURN_END(error)` |
| `LOG` | 6 | `code`：`SOPE_LOG_DEBUG..ERROR`(0–3)，`data`：日志 |
| `THINKING_DELTA` | 7 | `data`：一段模型推理内容（如 GLM 的 `reasoning_content`） |
| `USAGE` | 8 | `data`：`{"input_tokens":N,"output_tokens":N}`，每次模型调用一条 |
| `SUBAGENT_START` | 9 | `call_id`，`name`：子 agent 类型，`data`：JSON 输入 |
| `SUBAGENT_END` | 10 | `call_id`，`code`：`SOPE_STOP_*`，`data`：子 agent 的最终报告 |
| `COMPACT` | 11 | `name`：`auto` / `manual`，`data`：替换了历史的摘要（见 5.1） |
| `TOOL_START` | 12 | `call_id`，`name`：内置工具名，`data`：JSON 输入。库自己执行（见第 6 节） |
| `TOOL_END` | 13 | `call_id`，`name`，`code`：1 表示失败，`data`：模型看到的结果。所有工具调用（宿主和内置）都有 |
| `PERMISSION` | 14 | `call_id`，`name`，`data`：JSON 输入。需要用 `sope_permit` 回复 |

**宿主必须忽略未知的事件类型**，以便兼容新版本库。

### 64 位平台上的内存布局（FFI 用）

`src/agent.c` 中有静态断言保证这个布局。

| 偏移 | 字段 | 类型 |
|---|---|---|
| 0 | `size` | u32 |
| 4 | `type` | u32 |
| 8 | `turn_id` | u64 |
| 16 | `call_id` | u64 |
| 24 | `agent_id` | u64 |
| 32 | `name` | ptr |
| 40 | `name_len` | u64 |
| 48 | `data` | ptr |
| 56 | `data_len` | u64 |
| 64 | `code` | i32 |
| 68 | `reserved` | u32 |
| | 总计 | 72 字节 |

## 9. 选项与 provider

`sope_agent_set_option(agent, key, value)`；`value == NULL` 表示删除。选项在回合开始时读取，修改从下一个回合起生效。子 agent 继承父 agent 的全部选项。

| key | 说明 | 默认 |
|---|---|---|
| `provider` | `mock`（离线）或 `openai`（任何 OpenAI 兼容服务） | `mock` |
| `model` | 模型名，如 `glm-5.3`；`openai` 必填 | — |
| `image_model` | 对话里出现图片后改用的模型（`model` 不能看图时用） | 用 `model` |
| `system` | 系统提示词 | 内置的简短提示词 |
| `max_rounds` | 每个回合最多调用模型的次数 | `32` |
| `cwd` | 内置工具的工作目录 | 进程当前目录 |
| `permissions` | `ask`：需要许可的内置工具先发 `PERMISSION`；`allow`：直接执行；`deny`：直接拒绝 | `ask` |
| `subagents` | `off` 隐藏内置 `agent` 工具 | — |
| `compact.threshold` | 自动压缩历史的 token 阈值（见 5.1），`0` 表示关闭 | 关闭 |
| `openai.base_url` | 服务地址 | `https://api.openai.com/v1` |
| `openai.api_key` | 以 Bearer token 发送 | — |
| `openai.max_tokens` | 输出上限 | — |
| `tls.ca_file` | 受信任 CA 的 PEM 文件，仅 bundled 构建需要（见第 12 节）；模型调用和 `web_fetch` 都用它 | `$SSL_CERT_FILE`，否则系统证书文件 |
| `mock.delay_ms` | mock 每块输出间隔 | `25` |

### openai provider

调用 `POST {base_url}/chat/completions`（`stream: true`），兼容 OpenAI、GLM、DeepSeek、Qwen、vLLM 等。支持流式文本、`reasoning_content`（→ `THINKING_DELTA`）、按 `index` 拼装的并行工具调用、最后的 usage 块。连接失败、429、5xx 在**尚未有任何输出交给宿主时**自动重试（最多 3 次，退避 1s、2s），以 `LOG(warn)` 记录。

网络依赖：libcurl。只有 `src/http.c` 接触 libcurl，见第 12 节。

### mock provider

离线、确定性，驱动与真实模型完全相同的 agent 循环：

| 输入 | 行为 |
|---|---|
| 普通文本 | 流式回复一段引用输入的固定文本 |
| `!<tool> [arg]` | 以 `{"input": arg}` 调用工具，下一轮报告结果 |
| `!<tool> {json}` | 以这段 JSON 作为输入调用工具，例如 `!read {"file_path":"a.c"}` |
| `!<t1> … ;; !<t2> …` | 一次回复里调用多个工具 |
| `!agent[:type] 任务1 \| 任务2 …` | 每个任务启动一个子 agent（并行） |
| `!history` | 报告当前历史条数 |
| `!panic` | 模型调用失败，回合以 `error` 结束 |
| （压缩请求） | 回复一份列出所有用户消息的摘要 |

## 10. 最小示例

```c
#include <sope.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    sope_agent_t *agent;
    sope_event_t ev;
    if (sope_agent_new(&agent) != SOPE_OK) return 1;
    sope_agent_set_option(agent, "provider", "openai");
    sope_agent_set_option(agent, "model", "glm-5.3");
    sope_agent_set_option(agent, "openai.base_url", "https://api-taas.moi.matrixorigin.cn/v1");
    sope_agent_set_option(agent, "openai.api_key", getenv("SOPE_API_KEY"));
    sope_send(agent, "hello", 5, NULL);
    for (;;) {
        ev.size = sizeof ev;
        if (sope_poll(agent, &ev, -1) != 1) break;
        if (ev.type == SOPE_EVENT_TEXT_DELTA && !ev.agent_id) fwrite(ev.data, 1, ev.data_len, stdout);
        if (ev.type == SOPE_EVENT_TURN_END && !ev.agent_id) break;
    }
    sope_agent_free(agent);
    return 0;
}
```

更多：`examples/hello.c`（最小宿主）、`examples/multiplex.c`（一个线程用 fd 驱动多个 agent）。

## 11. 给语言绑定作者

- **不要在 UI 或事件循环线程上阻塞调用 `sope_poll`。** 要么把 `sope_agent_fd` 接入宿主事件循环，要么开一个轮询线程（Bun/Node 用 Worker）阻塞 poll、批量转发事件。其他函数都不阻塞，可以直接在主线程调用。参考 `bindings/js/` 和 `tui/src/agent/`。
- 目前只支持 64 位平台，`size_t` 按 u64 处理。
- `sope_last_error()` 是线程局部的：必须在**同一线程**、紧接着失败的调用去读。
- 事件字符串在下一次 poll 时失效，绑定层应立即复制。
- 按 `agent_id` 区分根 agent 与子 agent 的事件；判断"回合结束"时只看 `agent_id == 0` 的 `TURN_END`。
- `PERMISSION` 必须得到回答（或者取消回合），否则回合会一直等。没有交互界面的宿主应该设置 `permissions` 为 `allow` 或 `deny`。

## 12. 构建与依赖

CMake 选项 `SOPE_CURL` 决定 HTTP 实现：

| 值 | 含义 | 适用 |
|---|---|---|
| `system`（默认） | 链接系统的 libcurl | macOS（libcurl 是系统自带的一部分，TLS 走系统钥匙串）；装了 `libcurl-dev` 的 Linux |
| `bundled` | 构建时下载 curl 8.23.0 + mbedTLS 3.6.7（固定 SHA-256），静态编进 libsope，只开启 HTTP(S) | Linux 发布版；任何不想依赖系统 libcurl 的场合 |
| `off` | 不带网络，零依赖，只有 `mock` provider | 测试、离线嵌入 |

- 共享库只导出公开的 `sope_*` 函数（23 个）。内部符号（`sope__*`）和打包进来的 curl、mbedTLS 都是隐藏的，不会和宿主自己的 curl 或 OpenSSL 冲突。
- bundled 模式额外生成 `libsope-bundled.a`：sope、curl、mbedTLS 合并成一个目标文件，只有 `sope_*` 是全局符号，可以直接静态链接（macOS 还需 `-framework SystemConfiguration -framework CoreFoundation -framework CoreServices`）。`system` 模式下的 `libsope.a` 需要宿主自己链接 `-lcurl`。
- 离线构建：把 `SOPE_CURL_URL` / `SOPE_MBEDTLS_URL` 指向本地的源码包。

**bundled 模式的证书。** mbedTLS 读不了 macOS 钥匙串和 Windows 证书库，只能读 PEM 证书文件。查找顺序：

1. 选项 `tls.ca_file`
2. 环境变量 `SSL_CERT_FILE`
3. 系统证书文件：`/etc/ssl/cert.pem`（macOS、Alpine、BSD）、`/etc/ssl/certs/ca-certificates.crt`（Debian/Ubuntu）、`/etc/pki/tls/certs/ca-bundle.crt`（Fedora/RHEL）等

在 Linux 上，公司根证书通常由管理员装进系统证书文件，所以能直接读到。在 macOS 上，只装在钥匙串里的公司证书或 HTTPS 代理证书读不到。这也是 macOS 发布版选用 `system` 模式的原因；确实要在 macOS 上用 bundled 时，导出证书后用 `tls.ca_file` 指定。

## 13. 已知限制与路线图

- 事件队列无上限：宿主长期不取事件时内存会持续增长，后续会加背压。
- 定时器基于 `CLOCK_REALTIME`，系统时间跳变会影响 mock 的输出节奏和重试退避。
- fd 与线程实现目前只有 POSIX（macOS/Linux）；Windows 计划用 event handle。
- 库本身不持久化：保存什么、存在哪由宿主用 `sope_agent_history` / `sope_agent_load_history` 决定。回合进行中无法导出，进程在回合中途崩溃会丢掉这个回合。
- 压缩用的 token 数来自 provider 报告的 usage；不报告 usage 的服务不会触发自动压缩。
- 内置工具没有沙箱：许可是唯一的防线。需要隔离的宿主可以用同名宿主工具替换 `bash`，或设置 `permissions=deny`。
- `grep` 用的是 POSIX 正则（加上常见写法的改写），不是 ripgrep：没有多行匹配，也不支持回溯引用以外的 Perl 扩展。
- `web_fetch` 只返回页面文本，不执行脚本；靠脚本生成内容的页面会缺内容。
- 图片原样以 base64 发送，不缩放也不压缩；一旦进入对话就留在历史里，之后每次请求都会带上（直到压缩），大图会明显增加请求体积。宿主工具（`sope_tool_result`）还不能返回图片。
