# sope

可嵌入的 agent 库：C 实现，对外只暴露 C ABI，任何能做 FFI 的语言都可以使用，定位类似 SQLite。附带一个从零手写的终端 UI，用于直接使用和调试 ABI。

- **C ABI**：`include/sope.h` 是唯一事实来源，详细语义见 [`docs/abi.md`](docs/abi.md)
- **agent 循环**：模型 → 工具 → 模型……直到模型给出最终回答；支持并行工具调用
- **子 agent**：内置 `agent` 工具 + 可注册的子 agent 类型，多个子 agent 并行运行（设计参考 soren 的 AgentTool）
- **并发**：所有 agent 跑在一个共享线程池上，agent 本身不占线程；等待模型、工具、子 agent 都不占线程
- **接入方式**：阻塞 `sope_poll`，或把 `sope_agent_fd` 接入任意事件循环
- **模型**：任何 OpenAI 兼容服务（默认配置为 GLM 5.3），以及离线的 mock
- **TUI**：TypeScript + Bun，不依赖任何 TUI 框架，从 raw mode、输入解析、diff 渲染器到 Unicode 宽度表都是手写的

## 目录结构

```
include/sope.h        公开头文件，也就是 ABI 本身
src/
  agent.c             公共 API、事件队列、可读 fd、生命周期
  loop.c              回合状态机（agent 循环）与子 agent
  pool.c              共享线程池与定时器
  http.c              libcurl multi 的 I/O 线程（唯一接触 libcurl 的文件）
  provider_openai.c   OpenAI 兼容的流式 Chat Completions
  provider_mock.c     离线 mock 模型
  json.c, util.c      JSON 解析、字符串与缓冲区
docs/abi.md           ABI 文档
tests/                C 测试（含 TSan/ASan 下的并发测试）
examples/             hello.c（最小宿主）、multiplex.c（fd 多路复用）
bindings/js/          bun:ffi 绑定（类型化 API + 测试，含离线的 OpenAI 假服务器测试）
tui/src/
  term/               raw mode、终端控制、输入解码
  render/             cell 缓冲区、双缓冲 diff 渲染器、颜色
  unicode/            字素切分与列宽（CJK / emoji）
  ui/                 换行、Markdown、输入编辑器、对话视图、ABI trace 面板
  agent/              Worker 轮询线程、bridge、内置工具
```

## 快速开始

依赖：CMake ≥ 3.16、C11 编译器、libcurl（macOS 自带）、Bun ≥ 1.3。

```sh
bun install
bun run build:native   # 编译 build/libsope.dylib、测试和示例
bun run test:native    # C 测试
bun test               # 绑定 + TUI 单元测试
cp .env.example .env   # 填入 SOPE_API_KEY（.env 不会进 git）
bun run tui            # 启动 TUI；没有 key 时使用离线 mock
```

带 sanitizer 编译：

```sh
cmake -S . -B build-thread -DSOPE_SANITIZE=thread && cmake --build build-thread && ./build-thread/test_agent
```

## TUI

| 按键 | 作用 |
|---|---|
| `enter` | 发送 |
| `ctrl+j` / `alt+enter` | 换行 |
| `esc` | 取消当前回合（连同子 agent） |
| `ctrl+t` / `F2` | 打开/关闭 ABI trace 面板：`→` 是 TUI 调进库的调用，`←` 是 `sope_poll` 返回的事件 |
| `pgup` / `pgdn` | 滚动对话 |
| `↑` / `↓` | 在多行输入里移动；到达边界后翻历史记录 |
| `ctrl+a/e`、`alt+b/f`、`ctrl+w/u/k` | Emacs 风格编辑（按词移动支持中文分词） |
| `ctrl+c` | 有回合在跑时取消，输入框非空时清空，否则退出 |

命令：`/help`、`/clear`（同时清空对话历史）、`/model <name>`、`/thinking`（展开/折叠推理过程）、`/trace`、`/mouse`、`/set <key> [value]`、`/quit`。

提供给模型的工具：`echo`、`clock`、`sleep`、`list_files`、`read_file`（只读，限制在当前目录内），以及用于子 agent 的 `agent`。

配置（环境变量或 `.env`）：

| 变量 | 默认 |
|---|---|
| `SOPE_API_KEY` | 设置后默认使用 `openai` provider |
| `SOPE_MODEL` | `glm-5.3` |
| `SOPE_BASE_URL` | `https://api-taas.moi.matrixorigin.cn/v1` |
| `SOPE_PROVIDER` | 有 key 时为 `openai`，否则 `mock` |

颜色：自动检测真彩色（`COLORTERM`），macOS 自带的 Terminal.app 会退化到 256 色；可用 `SOPE_TRUECOLOR=0|1` 强制指定。
