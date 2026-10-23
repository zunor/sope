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
tar xzf sope-0.3.0-darwin-arm64.tar.gz
sope-0.3.0-darwin-arm64/install.sh         # 安装 sope 到 ~/.local/bin
sope-0.3.0-darwin-arm64/install.sh --lib   # 同时安装 libsope 和 sope.h
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

### 图片

截图、图表可以直接发给模型：`ctrl+v` 粘贴剪贴板里的图片（macOS 用 osascript，Linux 用 wl-paste 或 xclip），把图片文件拖进终端也会自动变成附件；输入框里显示为 `[Image #1]`，发送时一起带上。命令行用 `sope --image shot.png "这里哪里不对？"`（`-p` 模式同样可用）。模型自己也能看图：`read` 读到图片文件、`web_fetch` 抓到图片 URL 时会把图片交给模型。默认的 glm-5.3 只认文字，对话里一出现图片，sope 自动改用 `SOPE_IMAGE_MODEL`（默认 `kimi-k3`）。

### 审批预览

`write` / `edit` 的确认框显示和当前文件的 diff：行号、增删行的底色，以及按文件类型的语法高亮（C/C++、JS/TS、Python、Go、Rust、Java、Shell、JSON）。

### 会话

顶部是最近用过的几个会话（最多 5 个），每个会话是一行高、固定 24 列宽的浅底色标签（极窄窗口会缩小），标签间仅留一格分隔，长标题截断、鼠标悬浮时缓慢往返滚动；当前会话的标题加粗、底色稍亮；最右侧的 `⋯`（或 `/sessions`）列出当前目录保存过的全部会话，可以输入文字筛选、回车打开。每个标签是一个独立的 agent，切走后照常在后台运行。会话存在 SQLite 里（`~/.local/share/sope/sope.db`，可用 `SOPE_DB` 改位置），下次在同一目录打开 sope 时原样恢复：界面上的对话记录，以及模型记得的内容（库的 `sope_agent_history` / `sope_agent_load_history`）。

点 `+`、`alt+n` 或 `/new` 新建会话；点击标签或 `alt+1…9` 切换；鼠标悬停在标签上会出现 `×`，点击（或 `alt+w`、`/close`）关闭。关闭只是不再列出，数据仍留在数据库里。标签上的 `?` 表示那个会话在等你批准，`•` 表示它在后台跑完了。

鼠标由 TUI 接管：拖动选中文字，松开即复制到剪贴板（底栏会提示“copied N characters”）。想用终端自己的选择，按住 Shift（iTerm2 是 Option）再拖，或者 `/mouse` 关掉接管；`SOPE_MOUSE=0` 默认关闭。

状态栏的像素流星沿小正方形每 3 秒转一圈，只占一行高、两列宽。启动时探测 Kitty 图片协议，收到成功回复才启用；未支持或在 tmux/screen/Zellij 内时回退到一行高的盲文点阵动画。`SOPE_GRAPHICS=0` 可关闭像素效果。独立预览（不调用模型）：`bun scripts/preview-meteor.ts`。

输入 `/` 会在输入框上方弹出命令列表，继续输入可筛选；`↑`/`↓` 选择、`Enter` 使用、`Tab` 只补全、`Esc` 收起，也支持鼠标选择和滚轮。必须带参数的命令先补全到输入框。

### 工具与权限

工具都内置在 libsope 里（完整说明见 [`docs/abi.md` 第 6 节](docs/abi.md#6-内置工具)），`sope` 只负责显示和批准：

| 工具 | 作用 | 需要批准 |
|---|---|---|
| `read`、`glob`、`grep` | 读文件（带行号）、按模式找文件、正则搜索（跳过 `.gitignore` 忽略的文件） | 不需要 |
| `write`、`edit` | 新建或覆盖文件、精确替换；必须先读过，且读过之后没被别人改过 | 看权限模式，并预览改动 |
| `bash` | 在当前目录运行命令（无终端、无输入，默认超时 2 分钟）；可以放到后台 | 看权限模式，并显示命令 |
| `bash_output`、`bash_kill` | 查看、停止后台命令 | 不需要 |
| `web_fetch` | 抓取网页，转成文本 | 看权限模式，并显示 URL |
| `todo_write` | 任务清单，显示在对话里 | 不需要 |

谁来批准由权限模式决定，底栏左侧显示当前模式，`shift+tab` 轮换，`/permissions` 或点击底栏的模式名打开选择框（`↑`/`↓` 选择，回车确认）：

| 模式 | 行为 |
|---|---|
| Ask for approval（`ask`） | 上表“看权限模式”的工具每次都弹窗确认 |
| Approve for me（`auto`，默认） | 尽量放行，只有要紧的操作才弹窗：删除或改动工作目录以外的文件（临时目录除外）、删除整个工作目录或 `.git`、`git push` 和其他发布（`npm publish`、`gh` 的写操作）、丢弃未提交的 git 改动（`reset --hard`、`clean -f`、`checkout -- 文件`）、`sudo` 等系统改动、全局安装（`npm -g`、`brew install`）、`ssh`/`scp` 远程操作、`curl` 往外发数据、把下载的脚本直接交给 shell。弹窗里会写明为什么要问 |
| Full access（`full`） | 全部直接执行 |

“Approve for me”像 shell 一样拆解命令（管道、`&&`、`$( )`、`sh -c`、`find -exec`、`xargs` 里的命令都会检查），但它防的是失误，不是恶意：它放行的脚本和程序（测试、`python x.py`）本身能做任何事，抓网页也直接放行。在 `/` 或 home 目录下运行时，工作目录范围太大，除临时目录外的删除和写入都会问。

确认弹窗里 `↑`/`↓` 选择、回车确认，也可以按数字 `1`–`4`、点击，或用快捷键：`y` 允许一次，`a` 本次会话不再询问这个工具，`n` 拒绝（模型会收到拒绝并改变做法），`esc` 拒绝并停止整个回合。等待中的请求在切换到更宽松的模式后会自动放行。`--permissions ask|auto|full`（或 `SOPE_PERMISSIONS`）设置启动时的模式，`--allow-all` 等于 `full`。`-p` 模式下没人能确认：按模式判断，需要问的一律拒绝（模型会收到说明）。

### 按键与命令

| 按键 | 作用 |
|---|---|
| `enter` | 发送 |
| `ctrl+j` / `alt+enter` | 换行 |
| `esc` | 取消当前回合（连同子 agent） |
| `shift+tab` | 轮换权限模式 |
| `alt+n` / `alt+w` | 新建 / 关闭会话 |
| `alt+m` | 选择模型 |
| `alt+1` … `alt+9` | 切换到第 N 个会话 |
| `ctrl+t` / `F2` | 打开/关闭 ABI trace 面板：`→` 是 TUI 调进库的调用，`←` 是 `sope_poll` 返回的事件 |
| `pgup` / `pgdn` | 滚动对话 |
| 悬浮 / 点击工具输出的 `⎿` 或 `… N more lines` | 连接符与提示联动高亮；点击展开，再点 `show fewer lines` 或连接符收起 |
| `↑` / `↓` | 在多行输入里移动；到达边界后翻历史记录 |
| `ctrl+a/e`、`alt+b/f`、`ctrl+w/u/k` | Emacs 风格编辑（按词移动支持中文分词） |
| `ctrl+c` | 有回合在跑时取消，输入框非空时清空，否则退出 |

命令：`/help`、`/new`、`/close`、`/clear`（同时清空对话历史）、`/compact [重点]`、`/model [name]`（不带参数打开模型选择框）、`/thinking`（展开/折叠推理过程）、`/permissions [ask|auto|full]`、`/trace`、`/mouse`、`/set <key> [value]`、`/quit`。

`/model` 或 `alt+m` 打开模型选择框：列出端点（`GET /models`）提供的对话模型和上下文大小，最近用过的排在最前；直接输入文字搜索，`↑`/`↓` 选择、回车使用，端点没列出的名字也可以照输入的用。选中的模型从当前会话的下一回合起生效，之后新开的会话也用它。

上下文超过 `SOPE_COMPACT_THRESHOLD`（默认 100000 token）时，历史会自动压缩成摘要；`/compact` 可以随时手动压缩。界面上的对话记录保持不变，只是模型之后看到的是摘要。

### 配置

优先级从低到高：`~/.config/sope/config`（`KEY=VALUE` 格式）< 环境变量 < 命令行参数。

| 变量 | 参数 | 默认 |
|---|---|---|
| `SOPE_API_KEY` | | 设置后默认使用 `openai` provider |
| `SOPE_MODEL` | `-m`, `--model` | `glm-5.3` |
| `SOPE_IMAGE_MODEL` | | 默认端点上为 `kimi-k3`（glm-5.3 不能看图）；`off` 表示图片也发给 `SOPE_MODEL` |
| `SOPE_DB` | | `~/.local/share/sope/sope.db`（会话数据库） |
| `SOPE_BASE_URL` | `--base-url` | `https://api-taas.moi.matrixorigin.cn/v1` |
| `SOPE_PROVIDER` | `--provider` | 有 key 时为 `openai`，否则 `mock` |
| `SOPE_PERMISSIONS` | `--permissions`, `--allow-all` | `auto`（Approve for me）；`ask`、`full` |
| `SOPE_COMPACT_THRESHOLD` | | `100000`（`0` 关闭自动压缩） |
| `SOPE_LIB` | | 加载另一份 libsope，而不是内嵌的那份 |
| `SOPE_MOUSE` | | `1`；`0` 时鼠标留给终端（滚轮会变成 ↑/↓） |
| `SOPE_GRAPHICS` | | 自动探测 Kitty 图片协议；`0` 关闭像素流星 |
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
  session.ts store.ts 一个会话（标签）的状态；SQLite 保存与恢复
  agent/permissions.ts 权限模式；“Approve for me”怎么判断命令和文件
  agent/models.ts     端点的模型列表（模型选择框用）
  agent/              Worker 轮询线程、bridge、工具的显示与预览、mock 用的宿主工具
  term/ render/       raw mode、输入解码、cell 缓冲区、diff 渲染器
  unicode/ ui/        字素与列宽、换行、Markdown、编辑器、对话视图、标签栏、状态行、弹窗、模型选择框、trace 面板
scripts/              release.sh（构建并打包）、install.sh
```
