# sope C ABI

`include/sope.h` 是 ABI 的唯一事实来源。本文解释头文件注释里放不下的东西：线程模型、生命周期、回合与子 agent 语义、所有权，以及给语言绑定作者的说明。

> 当前版本 0.2.0。1.0 之前 ABI 可能有破坏性变更，每次变更都会改 `SOPE_VERSION_MINOR`。0.2 相对 0.1 的破坏性变更：`sope_event_t` 新增 `agent_id` 字段（64 → 72 字节）。

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
 │ (poll/epoll)  │◀─ sope_poll ───────│                                ▲          │
 └───────────────┘                    │  HTTP I/O 线程 (libcurl multi) ─┘ 唤醒     │
                                      └───────────────────────────────────────────┘
```

- **agent 不占线程。** 所有 agent（包括子 agent）由一个进程级共享线程池执行，创建 agent 只花内存。
- **同一 agent 的回合严格串行、按顺序执行**；不同 agent、同一回合里的多个子 agent 之间并行。
- **线程池线程从不阻塞。** 回合是状态机：等工具结果、等子 agent、等模型的下一块流式输出时，回合挂起并让出线程。网络由一个 HTTP I/O 线程统一驱动（libcurl multi），收到数据就唤醒对应的回合。
- `sope_set_threads(n)` 设置线程数，必须在第一个 `sope_agent_new` 之前（或 `sope_shutdown` 之后），否则 `SOPE_EBUSY`。`0` 为默认值（CPU 数，限制在 2–8）。
- `sope_shutdown()` 停止并 join 线程池和 HTTP 线程，要求所有 agent 已释放。可选，用于卸载动态库前或获得干净的泄漏检测报告；下次 `sope_agent_new` 自动重启。

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

## 5. 回合（turn）与 agent 循环

每次成功的 `sope_send` 产生一个回合，返回其 `turn_id`（每个 agent 从 1 递增）。一个回合内部是 agent 循环：

```
调用模型 ──(模型请求工具)──▶ 发出 TOOL_CALL / 启动子 agent ──(结果全部到齐)──▶ 再调用模型 ──▶ …
   └──(模型直接回答，不调工具)──▶ TURN_END(end_turn)
```

- 一次模型调用可以并行请求多个工具；它们的 `TOOL_CALL` 会依次发出，宿主可以并行执行，全部 `sope_tool_result` 之后才进入下一轮。
- 每个回合最多调用模型 `max_rounds` 次（默认 32），超出则以 `ERROR` + `TURN_END(error)` 结束。
- 模型调用了未提供的工具时，库直接以错误结果回给模型，不会打扰宿主。
- 对话历史（用户消息、助手消息与工具调用、工具结果）由 agent 保存，跨回合累积。回合被取消时，没有结果的工具调用会补上 `cancelled` 结果，保证历史对模型 API 始终合法。

库保证的不变式：

1. **每个被接受的回合恰好产生一个 `TURN_END`**，即使它在开始前就被 close 丢弃。
2. 回合真正开始执行时先产生 `TURN_START`；开始前就被丢弃的回合只有 `TURN_END`。
3. 一个回合的所有事件（包括其子 agent 的事件）都在它的 `TURN_END` 之前。
4. `TOOL_CALL` 之后，回合会一直等到 `sope_tool_result`，或者被取消。
5. 回合结束后，它未完成的工具调用全部失效；迟到的 `sope_tool_result` 返回 `SOPE_ENOTFOUND`。

`sope_cancel` 只取消**正在运行**的回合（连同其子 agent），不影响排队的回合。

## 6. 子 agent

设计参考 soren 的 AgentTool：

- 只要注册了子 agent 类型（内置一个 `general-purpose`），模型就会看到内置工具 `agent`，输入为 `{description, prompt, subagent_type?}`。选项 `subagents=off` 可以隐藏它。
- 模型调用 `agent` 时，库创建一个**子 agent**：全新的对话历史、该类型的系统提示词、按类型过滤后的宿主工具集（**永远不含 `agent` 本身，所以不会递归**）、可选的独立模型。它作为独立任务跑在线程池上，所以模型在一次回复中启动的多个子 agent 是**并行**执行的。
- 子 agent 跑完一个回合后自动关闭，它的**最后一条消息**作为 `agent` 工具的结果返回给父 agent。被取消或失败时，结果会标记为错误并附上部分输出。
- 子 agent 的事件进入**同一个事件队列**（同一个 fd），`agent_id` = 启动它的那次调用的 `call_id`。子 agent 请求的宿主工具同样以 `TOOL_CALL` 出现，宿主照常用根 agent 句柄调用 `sope_tool_result` 即可。

注册子 agent 类型：

```c
static const char def[] =
    "{\"name\":\"reviewer\",\"description\":\"Reviews a diff for bugs.\","
    "\"system_prompt\":\"You are a careful code reviewer...\","
    "\"tools\":[\"read_file\"],\"model\":\"glm-5.3\",\"max_rounds\":8}";
sope_subagent_register(agent, def, sizeof def - 1);
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 1–64 个 `[A-Za-z0-9_-]` 字符，同名覆盖 |
| `description` | 是 | 何时使用它，会展示给模型 |
| `system_prompt` | 是 | 子 agent 的系统提示词 |
| `tools` | 否 | 宿主工具名数组，或 `"*"`（默认，全部） |
| `model` | 否 | 覆盖父 agent 的模型 |
| `max_rounds` | 否 | 覆盖父 agent 的 `max_rounds` |

## 7. 事件

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

## 8. 选项与 provider

`sope_agent_set_option(agent, key, value)`；`value == NULL` 表示删除。选项在回合开始时读取，修改从下一个回合起生效。子 agent 继承父 agent 的全部选项。

| key | 说明 | 默认 |
|---|---|---|
| `provider` | `mock`（离线）或 `openai`（任何 OpenAI 兼容服务） | `mock` |
| `model` | 模型名，如 `glm-5.3`；`openai` 必填 | — |
| `system` | 系统提示词 | 内置的简短提示词 |
| `max_rounds` | 每个回合最多调用模型的次数 | `32` |
| `subagents` | `off` 隐藏内置 `agent` 工具 | — |
| `openai.base_url` | 服务地址 | `https://api.openai.com/v1` |
| `openai.api_key` | 以 Bearer token 发送 | — |
| `openai.max_tokens` | 输出上限 | — |
| `mock.delay_ms` | mock 每块输出间隔 | `25` |

### openai provider

调用 `POST {base_url}/chat/completions`（`stream: true`），兼容 OpenAI、GLM、DeepSeek、Qwen、vLLM 等。支持流式文本、`reasoning_content`（→ `THINKING_DELTA`）、按 `index` 拼装的并行工具调用、最后的 usage 块。连接失败、429、5xx 在**尚未有任何输出交给宿主时**自动重试（最多 3 次，退避 1s、2s），以 `LOG(warn)` 记录。

网络依赖：libcurl（TLS 由 libcurl 所用的 TLS 库提供）。只有 `src/http.c` 接触 libcurl，见第 11 节。

### mock provider

离线、确定性，驱动与真实模型完全相同的 agent 循环：

| 输入 | 行为 |
|---|---|
| 普通文本 | 流式回复一段引用输入的固定文本 |
| `!<tool> [arg]` | 以 `{"input": arg}` 调用工具，下一轮报告结果 |
| `!agent[:type] 任务1 \| 任务2 …` | 每个任务启动一个子 agent（并行） |
| `!history` | 报告当前历史条数 |
| `!panic` | 模型调用失败，回合以 `error` 结束 |

## 9. 最小示例

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

## 10. 给语言绑定作者

- **不要在 UI 或事件循环线程上阻塞调用 `sope_poll`。** 要么把 `sope_agent_fd` 接入宿主事件循环，要么开一个轮询线程（Bun/Node 用 Worker）阻塞 poll、批量转发事件。其他函数都不阻塞，可以直接在主线程调用。参考 `bindings/js/` 和 `tui/src/agent/`。
- 目前只支持 64 位平台，`size_t` 按 u64 处理。
- `sope_last_error()` 是线程局部的：必须在**同一线程**、紧接着失败的调用去读。
- 事件字符串在下一次 poll 时失效，绑定层应立即复制。
- 按 `agent_id` 区分根 agent 与子 agent 的事件；判断"回合结束"时只看 `agent_id == 0` 的 `TURN_END`。

## 11. 构建与依赖

- CMake 选项 `SOPE_WITH_CURL`（默认 ON）：链接 libcurl，启用 `openai` provider。关闭后库零依赖，只有 `mock` 可用。
- 当前链接系统自带的 libcurl（macOS 自带；Linux 安装 `libcurl4-openssl-dev` 等）。
- 计划提供 `SOPE_CURL=bundled`：把 libcurl + TLS 库（如 mbedTLS）静态编进 `libsope`，符号隐藏，嵌入方只需一个库文件。由于只有 `src/http.c` 接触 libcurl，这只是构建层面的改动。

## 12. 已知限制与路线图

- 事件队列无上限：宿主长期不取事件时内存会持续增长，后续会加背压。
- 定时器基于 `CLOCK_REALTIME`，系统时间跳变会影响 mock 的输出节奏和重试退避。
- fd 与线程实现目前只有 POSIX（macOS/Linux）；Windows 计划用 event handle。
- 对话历史只在内存中，不做压缩/截断；长对话需要宿主适时 `sope_agent_reset`。
