# sope

可嵌入的 agent 库：C 实现，对外只暴露 C ABI，任何能做 FFI 的语言都可以使用，定位类似 SQLite。附带 `sope` 命令行：一个从零手写的全屏终端 UI，可以直接当编码助手用，也可以用来调试 ABI。

- **C ABI**：`include/sope.h` 是唯一事实来源，详细语义见 [`docs/abi.md`](docs/abi.md)
- **agent 循环**：模型 → 工具 → 模型……直到模型给出最终回答；支持并行工具调用
- **内置工具**：`read`、`write`、`edit`、`glob`、`grep`、`bash`（含后台命令）、`web_fetch`、`todo_write`，由库自己执行；改文件、执行命令、联网之前通过 `SOPE_EVENT_PERMISSION` 请宿主批准
- **子 agent**：内置 `agent` 工具 + 可注册的子 agent 类型，多个子 agent 并行运行（设计参考 soren 的 AgentTool）
- **并发**：所有 agent 跑在一个共享线程池上，agent 本身不占线程；等待模型、工具、子 agent 都不占线程
- **接入方式**：阻塞 `sope_poll`，或把 `sope_agent_fd` 接入任意事件循环
- **历史压缩**：超过阈值自动总结历史，或调用 `sope_compact` 手动压缩
- **模型**：任何 OpenAI 兼容服务（默认配置为 GLM 5.3），以及离线的 mock
- **单文件**：共享库只导出 `sope_*`；可选把 curl + mbedTLS 静态编进库里

## 安装

从发布包安装：

```sh
tar xzf sope-0.2.0-darwin-arm64.tar.gz
sope-0.2.0-darwin-arm64/install.sh         # 安装 sope 到 ~/.local/bin
sope-0.2.0-darwin-arm64/install.sh --lib   # 同时安装 libsope 和 sope.h
```

从源码构建并安装：

```sh
bun install
bun run release        # 构建、跑全部测试、打包到 dist/
dist/sope-*/install.sh
```

然后配置模型（只需一次）：

```sh
mkdir -p ~/.config/sope
cat > ~/.config/sope/config <<'EOF'
SOPE_API_KEY=你的 key
# SOPE_MODEL=glm-5.3
# SOPE_BASE_URL=https://api-taas.moi.matrixorigin.cn/v1
EOF
chmod 600 ~/.config/sope/config
```

## 使用 sope

```sh
sope                          # 在当前目录打开 TUI
sope "解释一下这个项目的结构"    # 打开 TUI 并直接发送第一条消息
sope -p "总结 README"          # 不开 TUI：回答输出到 stdout，然后退出
git diff | sope -p "review 这段改动"
sope --version
```

TUI 是全屏的（终端的备用屏幕，和 vim、htop 一样）：退出后终端恢复原样，对话内容不会留在滚动历史里。用滚轮或 `pgup`/`pgdn` 翻看对话；往上翻时新输出不会把视图拉回底部。

鼠标由 TUI 接管：拖动选中文字，松开即复制到剪贴板（底栏会提示“copied N characters”）。想用终端自己的选择，按住 Shift（iTerm2 是 Option）再拖，或者 `/mouse` 关掉接管；`SOPE_MOUSE=0` 默认关闭。

### 工具与权限

工具都内置在 libsope 里（完整说明见 [`docs/abi.md` 第 6 节](docs/abi.md#6-内置工具)），`sope` 只负责显示和批准：

| 工具 | 作用 | 需要批准 |
|---|---|---|
| `read`、`glob`、`grep` | 读文件（带行号）、按模式找文件、正则搜索（跳过 `.gitignore` 忽略的文件） | 不需要 |
| `write`、`edit` | 新建或覆盖文件、精确替换；必须先读过，且读过之后没被别人改过 | 需要，并预览改动 |
| `bash` | 在当前目录运行命令（无终端、无输入，默认超时 2 分钟）；可以放到后台 | 需要，并显示命令 |
| `bash_output`、`bash_kill` | 查看、停止后台命令 | 不需要 |
| `web_fetch` | 抓取网页，转成文本 | 需要，并显示 URL |
| `todo_write` | 任务清单，显示在对话里 | 不需要 |

模型（或它的子 agent）要运行需要批准的工具时，输入框会换成一个确认框：`y` 允许一次，`a` 本次会话总是允许这个工具，`n` 拒绝（模型会收到拒绝并改变做法），`esc` 拒绝并停止整个回合。`--allow-all` 跳过所有确认。`-p` 模式下无法确认，需要批准的工具一律拒绝（模型会收到说明），除非加 `--allow-all`。

### 按键与命令

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

命令：`/help`、`/clear`（同时清空对话历史）、`/compact [重点]`、`/model <name>`、`/thinking`（展开/折叠推理过程）、`/permissions`、`/trace`、`/mouse`、`/set <key> [value]`、`/quit`。

顶栏的 `ctx` 是模型最近一次看到的上下文大小。超过 `SOPE_COMPACT_THRESHOLD`（默认 100000 token）时，历史会自动压缩成摘要；`/compact` 可以随时手动压缩。界面上的对话记录保持不变，只是模型之后看到的是摘要。

### 配置

优先级从低到高：`~/.config/sope/config`（`KEY=VALUE` 格式）< 环境变量 < 命令行参数。

| 变量 | 参数 | 默认 |
|---|---|---|
| `SOPE_API_KEY` | | 设置后默认使用 `openai` provider |
| `SOPE_MODEL` | `-m`, `--model` | `glm-5.3` |
| `SOPE_BASE_URL` | `--base-url` | `https://api-taas.moi.matrixorigin.cn/v1` |
| `SOPE_PROVIDER` | `--provider` | 有 key 时为 `openai`，否则 `mock` |
| `SOPE_COMPACT_THRESHOLD` | | `100000`（`0` 关闭自动压缩） |
| `SOPE_LIB` | | 加载另一份 libsope，而不是内嵌的那份 |
| `SOPE_MOUSE` | | `1`；`0` 时鼠标留给终端（滚轮会变成 ↑/↓） |
| `SOPE_TRUECOLOR` | | 自动检测；`0`/`1` 强制 256 色/真彩色 |

## 嵌入 libsope

```c
#include <sope.h>

sope_agent_t *agent;
sope_agent_new(&agent);
sope_agent_set_option(agent, "provider", "openai");
sope_agent_set_option(agent, "model", "glm-5.3");
sope_agent_set_option(agent, "openai.base_url", "https://api-taas.moi.matrixorigin.cn/v1");
sope_agent_set_option(agent, "openai.api_key", key);
sope_send(agent, "列出当前目录的 C 文件", strlen("列出当前目录的 C 文件"), NULL);

sope_event_t ev = { .size = sizeof ev };
while (sope_poll(agent, &ev, -1) == 1 && ev.type != SOPE_EVENT_TURN_END) {
    if (ev.type == SOPE_EVENT_TEXT_DELTA) fwrite(ev.data, 1, ev.data_len, stdout);
    if (ev.type == SOPE_EVENT_PERMISSION)   /* 内置的 write/edit/bash/web_fetch 先问宿主 */
        sope_permit(agent, ev.call_id, ask_user(ev.name, ev.data), NULL, 0);
}
sope_agent_free(agent);
```

读文件、搜索、执行命令这些工具库都自带，宿主只需要回答 `PERMISSION`（或者用 `permissions` 选项设成 `allow` / `deny`）。也可以用 `sope_tool_register` 注册自己的工具，同名时替换内置工具。完整的 ABI 语义（线程、生命周期、工具、子 agent、压缩、事件布局）见 [`docs/abi.md`](docs/abi.md)，更多示例在 `examples/`。Bun/TypeScript 可以直接用 `bindings/js`。

## 版本

库、绑定和 `sope` 使用同一个版本号（定义在 `include/sope.h`），同时发布；`sope` 内嵌同版本的 libsope。两者之间的契约是 ABI 版本，加载时会检查。详见 [`docs/release.md`](docs/release.md)，变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。

## 开发

依赖：CMake ≥ 3.20、C11 编译器、libcurl（macOS 自带）、Bun ≥ 1.3。

```sh
bun install
bun run build:native   # 编译 build/libsope.dylib、测试和示例
bun run test:native    # C 测试
bun test               # 绑定 + TUI 测试
bun run typecheck
cp .env.example .env   # 填入 SOPE_API_KEY（.env 不会进 git）
bun run tui            # 从源码运行 sope；参数同上，例如 bun run tui -- -p "hi"
```

构建选项 `-DSOPE_CURL=system|bundled|off` 见 [`docs/abi.md` 第 12 节](docs/abi.md#12-构建与依赖)。带 sanitizer 编译：

```sh
cmake -S . -B build-thread -DSOPE_SANITIZE=thread && cmake --build build-thread && ./build-thread/test_agent
```

## 目录结构

```
include/sope.h        公开头文件，也就是 ABI 本身
src/
  agent.c             公共 API、事件队列、可读 fd、生命周期
  loop.c              回合状态机（agent 循环）、子 agent、压缩
  compact.c           压缩用的提示词与对话记录
  tools.c             内置工具：注册表、执行任务、许可，read/write/edit、bash、todo_write
  search.c, web.c     glob/grep（.gitignore、glob 模式、正则改写），web_fetch（HTML 转文本）
  pool.c              共享线程池与定时器
  http.c              libcurl multi 的 I/O 线程（唯一接触 libcurl 的文件）
  proc.c              子进程：新会话、合并输出、回收线程
  provider_openai.c   OpenAI 兼容的流式 Chat Completions
  provider_mock.c     离线 mock 模型
  json.c, util.c      JSON 解析、字符串与缓冲区
cmake/BundledCurl.cmake  SOPE_CURL=bundled：静态构建 curl + mbedTLS
docs/                 abi.md（ABI 文档）、release.md（发布与版本）
tests/                C 测试：ABI 行为、内置工具、内部函数（都在 TSan/ASan 下跑过）
examples/             hello.c（最小宿主）、multiplex.c（fd 多路复用）
bindings/js/          bun:ffi 绑定（类型化 API + 测试，含离线的 OpenAI 假服务器测试）
tui/src/
  main.ts, cli.ts     sope 可执行文件入口与参数解析
  app.ts, print.ts    全屏 TUI 与 -p 模式
  agent/              Worker 轮询线程、bridge、工具的显示与预览、mock 用的宿主工具
  term/ render/       raw mode、输入解码、cell 缓冲区、diff 渲染器
  unicode/ ui/        字素与列宽、换行、Markdown、编辑器、对话视图、trace 面板
scripts/              release.sh（构建并打包）、install.sh
```
