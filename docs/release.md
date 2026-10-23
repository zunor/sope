# 发布与版本

## 发布的是什么

sope 有两个产物，面向两类使用者：

| 产物 | 给谁用 | 形式 |
|---|---|---|
| **libsope** | 把 agent 嵌进自己程序的开发者（任何语言，经 C ABI） | `libsope.dylib/.so`、`libsope.a`、`sope.h` |
| **sope 可执行文件** | 直接在终端里使用、调试 agent 的人 | 一个文件 `bin/sope`，打开全屏 TUI，`-p` 为非交互模式 |

它们的关系类似 `libsqlite3` 和 `sqlite3` 命令行：命令行只是库的一个使用者，它调用的 ABI 和任何嵌入方调用的完全一样。

## TUI 和 agent 需要同一个版本吗

**同一个版本号、同时发布，但运行时不依赖“恰好相同”。**

- **一个仓库、一个版本号。** 版本只在 `include/sope.h` 里定义（`SOPE_VERSION_*`），CMake 从头文件读取，`package.json` 必须一致；不一致时 `scripts/release.sh` 会拒绝发布，测试也会失败。发布打一个 tag：`v0.1.0`。
  - 好处：不用维护版本矩阵；改动常常同时涉及两边（比如新增 `sope_compact` 时，`/compact` 命令也一起加上了），一个提交、一次发布就能完成。
- **`sope` 可执行文件内嵌它构建时的 libsope。** 所以用户拿到的 TUI 和库不可能对不上，也不需要另外安装库。
- **两者之间唯一的契约是 ABI 版本。** 绑定层在加载库时检查 `sope_version_number()`：
  - 1.0 之前要求主、次版本号都相同；
  - 1.0 之后要求主版本相同、次版本号不低于绑定编写时的版本。

  不兼容时立即报错，不会等到调用时才崩溃。这条检查也服务于第三种情况：用 `SOPE_LIB=/path/to/libsope.dylib sope` 让 TUI 加载另一份库，比如调试自己改过的库，或者复现嵌入方用的某个版本。
- **嵌入方只需要库。** 他们按 ABI 版本选库，不关心 TUI；TUI 的改动（界面、工具、权限交互）只要不碰 ABI，就只增加修订号或次版本号。

版本号怎么变：

| 改动 | 1.0 之前 | 1.0 之后 |
|---|---|---|
| 只改 TUI、修 bug、性能 | 修订号 +1 | 修订号 +1 |
| ABI 新增函数、事件、选项 | 次版本 +1 | 次版本 +1 |
| ABI 破坏性变更（改结构体布局、改语义） | 次版本 +1 | 主版本 +1 |

## 发布包内容

`scripts/release.sh` 为当前平台构建 `dist/sope-<版本>-<系统>-<架构>.tar.gz`（附 `.sha256`）：

```
sope-0.1.0-darwin-arm64/
  bin/sope            单文件可执行程序（Bun 运行时 + TUI + 内嵌 libsope）
  lib/libsope.*       共享库（只导出 sope_*）和静态库
  include/sope.h
  docs/  README.md  CHANGELOG.md  LICENSE
  licenses/           bundled 模式下 curl 和 mbedTLS 的许可证
  install.sh          安装 sope 到 ~/.local/bin；--lib 同时安装库和头文件
```

脚本依次执行：Release 构建、C 测试、绑定和 TUI 测试、类型检查，然后编译 `sope`、在 `/` 目录下冒烟测试（不依赖仓库），最后打包。

### 各平台的 HTTP/TLS

| 平台 | `SOPE_CURL` | 原因 |
|---|---|---|
| macOS | `system` | libcurl 是系统自带的一部分（不算额外依赖）；TLS 信任系统钥匙串，公司证书、HTTPS 代理都能用 |
| Linux | `bundled` | 各发行版的 libcurl 版本和路径不一，打包进去才是真正的单文件；mbedTLS 读系统证书文件，这正是 Linux 上的惯例 |

可以用 `SOPE_CURL=bundled bash scripts/release.sh` 覆盖。

### 关于 `sope` 的体积

`bin/sope` 约 58 MB，其中绝大部分是 Bun 运行时，libsope 本身不到 100 KB（bundled 模式约 1.1 MB）。如果以后要更小，可以把 TUI 用 C 或 Zig 重写后直接静态链接 libsope，ABI 不需要任何改动。

## 许可证

sope 使用 MIT 许可证，全文在 `LICENSE`。每个源文件第一行是简写的 SPDX 标识：

```c
/* SPDX-License-Identifier: MIT */
```

这是 Linux 内核、curl 等项目通用的写法，工具（如 `reuse`、GitHub）能识别它。`include/sope.h` 还多一行版权声明，因为嵌入方常常只拷贝这一个头文件。

bundled 模式把 curl（curl 许可证，MIT 风格）和 mbedTLS（Apache-2.0）编进了 libsope，发布包会在 `licenses/` 里附上它们的许可证全文，这是这两个许可证的要求。

## 发布步骤

```sh
scripts/bump-version.sh 0.4.0           # sope.h、三个 package.json、绑定的 ABI、文档里的版本号
# 在 CHANGELOG.md 写 “## 0.4.0 — 日期” 一节
bash scripts/release.sh                 # 构建、测试、打包到 dist/
git tag -a v0.4.0 -m "sope 0.4.0"
dist/sope-0.4.0-darwin-arm64/install.sh # 本机安装
```

完整的检查清单（ASan/TSan/泄漏、bundled 构建、真实模型、提交前查密钥、从压缩包安装验证）写在 `.claude/skills/release/SKILL.md`，在 Claude Code 里输入 `/release` 就按它走一遍。

每个平台需要在对应的机器上运行一次（libsope 是原生代码，不能交叉编译）。上传到 GitHub Releases 等分发渠道目前是手动步骤。

## 尚未决定的事

- **macOS 签名与公证**：目前只有 ad-hoc 签名。通过浏览器下载的包会被 Gatekeeper 拦截，`install.sh` 会去掉隔离属性；正式分发应使用 Developer ID 签名并公证。
- **Windows**：fd、线程池和 HTTP 层都还没有 Windows 实现。
