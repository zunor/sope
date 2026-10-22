# Changelog

版本号以 `include/sope.h` 为准，库、绑定和 `sope` 可执行文件同步发布，规则见 [docs/release.md](docs/release.md)。

## 0.1.1 — 2026-10-23

- 许可证：MIT（`LICENSE`，源文件带 SPDX 标识）；bundled 发布包附带 curl 和 mbedTLS 的许可证
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
