# Changelog

版本号以 `include/sope.h` 为准，库、绑定和 `sope` 可执行文件同步发布，规则见 [docs/release.md](docs/release.md)。

## 未发布

新增权限模式、模型选择框和斜杠命令提示，改进标签栏、状态动画和工具输出交互。只改 TUI，库的 ABI 不变。

### TUI

- 三种权限模式：Ask for approval、Approve for me（默认）、Full access；底栏显示当前模式，`shift+tab` 轮换，`/permissions` 打开选择框，`--permissions ask|auto|full` / `SOPE_PERMISSIONS` 设置启动模式（`--allow-all` 等于 `full`）
- Approve for me 拆解 shell 命令（管道、`$( )`、`sh -c`、`find -exec`、`xargs`、heredoc），只拦删除或改动工作目录以外的文件、删除整个目录或 `.git`、`git push` 等发布、丢弃未提交的 git 改动、`sudo`、全局安装、`ssh`、`curl` 上传、`curl | sh`；弹窗说明为什么要问
- 确认框改成方框弹窗：`↑`/`↓` 选择、回车确认，也能按 `1`–`4`、点击或用 `y`/`a`/`n`/`esc`；切到更宽松的模式时，等待中的请求自动放行
- `-p` 按权限模式自动判断（原来一律拒绝，除非 `--allow-all`）
- 模型选择框（`/model` 或 `alt+m`）：列出端点提供的对话模型，最近用过的在前，输入即搜索，也可以直接用输入的名字；最近用过的模型存在数据库里
- 标签栏使用一行高的浅底色标签，固定 24 列宽、间隔一列；长标题截断，悬浮时缓慢往返滚动，当前会话加粗并加亮底色
- 状态栏使用一行高、两列宽的正方形像素流星，每 3 秒绕行一圈，流星头加粗加亮；探测到 Kitty 图片协议支持才启用，其他终端及 tmux/screen/Zellij 回退到盲文点阵，`SOPE_GRAPHICS=0` 可关闭像素效果；状态栏上方保留一行间距
- 输入 `/` 弹出命令列表，支持筛选、键盘和鼠标选择、Tab 补全、Esc 收起
- 工具及子 agent 的长输出默认显示六行；悬浮连接符或 `… N more lines` 时联动高亮，点击展开，再次点击连接符或 `show fewer lines` 收起，长内容末尾也有收起入口
- 底栏只保留权限模式和临时提示，使用不同菱形图标，仅 Full access 为红色，其他模式为浅灰色；去掉按键提示和模型、上下文、token 统计，弹窗的按键提示移到弹窗下边框里

## 0.3.0 — 2026-10-23

会话可以保存和恢复，消息可以带图片：库能导出、装回对话历史，TUI 按目录把会话存进 SQLite；截图和图表能发给模型。ABI 升到 0.3（新增函数，0.2 的宿主需要重新编译）。

### libsope（C ABI 0.3）

- `sope_agent_history` / `sope_agent_load_history`：导出、装回对话历史（JSON 数组），用于保存和恢复会话；只在回合之间可用（否则 `SOPE_EBUSY`）
- `sope_attach_image`：给下一次 `sope_send` 附加图片（PNG/JPEG/GIF/WebP，≤10 MiB）
- `read` 读到图片文件、`web_fetch` 抓到图片 URL 时把图片交给模型；网页里的图片写成 `![alt](url)`（原先只有 `[image: alt]`），模型可以再抓
- `openai` provider 发送 `image_url` 内容块（data URL）；工具结果里的图片紧跟着用一条 user 消息补发
- 新选项 `image_model`：对话里出现图片后改用的模型
- 历史 JSON 里带图片（`images`），压缩时图片记为 `[N images attached]`；导出共 23 个符号

### 绑定

- `Agent.history()`、`Agent.loadHistory(json)`、`Agent.attachImage(bytes, mediaType?)`

### TUI

- 会话标签：一行、紧挨着，每个标签是一块颜色，右边缘渐暗成柔和的阴影（颜色按终端背景色取，通过 OSC 11 查询）；悬停出现 `×` 关闭（逻辑删除）。默认只显示最近 5 个会话，最右侧 `⋯` 或 `/sessions` 打开全部会话列表（可筛选）
- 会话保存在 SQLite（`~/.local/share/sope/sope.db`，`SOPE_DB` 可改），启动时恢复界面记录和模型记忆
- 图片输入：`ctrl+v` 粘贴剪贴板图片，拖入图片文件自动附加，`--image <file>`；默认端点上图片交给 `kimi-k3`（`SOPE_IMAGE_MODEL`，glm-5.3 不能看图）
- `write` / `edit` 审批预览改为和当前文件的 diff：行号、增删底色、语法高亮
- 运行状态改为输入框上方单独一行：流星划过 `──━━✦ Thinking… (1m 4s · 38 tok/s · tip: …)`，动词带流动高光，时间按秒递增，速率按最近 3 秒流式输出估算，提示每 30 秒出现 10 秒
- 去掉顶部版本信息行；模型、上下文大小和累计 token 移到底部提示行右侧

## 0.2.0 — 2026-10-23

工具从 TUI 搬进了库：任何语言嵌入 libsope 都直接拥有读写文件、搜索、执行命令和抓网页的能力。ABI 升到 0.2（新增函数和事件，0.1 的宿主需要重新编译）。

### libsope（C ABI 0.2）

- 内置工具：`read`、`write`、`edit`、`glob`、`grep`、`bash`（`run_in_background` + `bash_output` / `bash_kill`）、`web_fetch`、`todo_write`，参考 soren 的同名工具设计
- 每次工具调用是线程池上的一个独立任务：并行的工具调用真正并行，等命令和下载不占线程；新增进程回收线程（`src/proc.c`）
- 新事件 `SOPE_EVENT_TOOL_START`（12）、`SOPE_EVENT_TOOL_END`（13，所有工具调用都有，包括宿主工具）、`SOPE_EVENT_PERMISSION`（14）
- 新函数 `sope_permit`：批准或拒绝需要许可的工具调用，拒绝时可以附一句话给模型
- 新选项 `cwd`（工具的工作目录）、`permissions`（`ask` / `allow` / `deny`）
- `write` / `edit` 要求先读过文件，且读过之后文件没被改过
- 取消回合会杀掉正在运行的命令（整个进程组）、中止下载，每个打开的工具调用都以 `TOOL_END` 收尾
- 宿主可以注册同名工具替换内置工具；子 agent 类型的 `tools` 列表同时适用于内置工具和宿主工具
- mock provider：`!<tool> {json}` 直接传 JSON 输入，`;;` 一次调用多个工具

### sope 可执行文件

- 不再自己实现工具，只显示库发来的工具事件、回答许可请求
- `todo_write` 的任务清单直接显示在对话里
- `-p` 模式下（没有 `--allow-all`）需要许可的工具改为由库直接拒绝，模型会收到原因

## 0.1.1 — 2026-10-23

- 许可证：MIT（`LICENSE`，版权人 Zonor，源文件带 SPDX 标识）；bundled 发布包附带 curl 和 mbedTLS 的许可证
- TUI 默认接管鼠标：滚轮滚动对话（之前滚轮在备用屏幕里变成 ↑/↓，翻的是输入历史）；拖动选中文字、松开复制到剪贴板（OSC 52 + pbcopy/wl-copy/xclip）；`SOPE_MOUSE=0` 或 `/mouse` 还给终端
- 往上翻看时，新输出不再把视图往下推

## 0.1.0 — 2026-10-22

第一个发布版本。

### libsope（C ABI 0.1）

- agent 循环：模型 → 工具 → 模型，支持一次调用多个工具；`max_rounds` 限制轮数
- 子 agent：内置 `agent` 工具、`sope_subagent_register` 自定义类型，多个子 agent 并行
- 共享线程池：agent 不占线程，等待模型、工具、子 agent 都不占线程
- 每个 agent 一个可读 fd（`sope_agent_fd`），可接入 poll/epoll/kqueue/libuv
- 历史压缩：`compact.threshold` 自动压缩，`sope_compact` 手动压缩，`SOPE_EVENT_COMPACT` 事件
- provider：OpenAI 兼容的流式 Chat Completions（含 reasoning、并行 tool calls、usage、自动重试），离线 mock
- 构建选项 `SOPE_CURL=system|bundled|off`：bundled 把 curl + mbedTLS 静态编进 libsope，只导出 `sope_*`；`tls.ca_file` 选项
- 共享库只导出 19 个 `sope_*` 符号

### sope 可执行文件

- 单文件，内嵌 libsope；`sope` 打开全屏 TUI，`sope -p` 非交互输出，可接管道
- 工具：`list_files`、`read_file`、`search`（只读，直接运行），`write_file`、`edit_file`、`bash`（需要用户批准）
- 权限确认：允许一次 / 本次会话总是允许 / 拒绝 / 拒绝并停止；`--allow-all` 跳过
- `/compact`、上下文大小显示、ABI trace 面板、Markdown 渲染、子 agent 进度
- 配置：`~/.config/sope/config` 或环境变量
