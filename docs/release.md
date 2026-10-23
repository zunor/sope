# Releases and versioning

## What we ship

sope has two artifacts for two audiences:

| Artifact | Audience | Format |
|---|---|---|
| **libsope** | Developers embedding agents in their own programs, in any language through the C ABI | `libsope.dylib/.so`, `libsope.a`, `sope.h` |
| **sope executable** | People using and debugging agents directly in a terminal | A single `bin/sope` file; opens a full-screen TUI, with `-p` for noninteractive mode |

Their relationship is similar to `libsqlite3` and the `sqlite3` CLI: the CLI is just one consumer of the library, using exactly the same ABI as any embedding application.

## Do the TUI and agent need the same version?

**They share a version number and are released together, but an exact version match is not required at runtime.**

- **One repository, one version number.** The version is defined only in `include/sope.h` (`SOPE_VERSION_*`). CMake reads it from the header, and `package.json` versions must match. If they do not, `scripts/release.sh` refuses to release and tests fail. Each release gets one tag, such as `v0.1.0`.
  - This avoids maintaining a version matrix. Changes often affect both sides—for example, `sope_compact` and the `/compact` command were added together—so one commit and one release cover both.
- **The `sope` executable embeds the libsope it was built with.** Users therefore receive a matching TUI and library without needing to install the library separately.
- **The ABI version is the only compatibility contract between them.** Bindings check `sope_version_number()` when loading the library:
  - Before 1.0, both major and minor versions must match.
  - From 1.0 onward, the major version must match, and the minor version must be at least the one the bindings were written for.

  Incompatibility produces an immediate error instead of a crash on a later call. This check also supports loading another library with `SOPE_LIB=/path/to/libsope.dylib sope`, for example to debug a modified library or reproduce an embedding application's version.
- **Embedding applications only need the library.** They choose it by ABI version, independently of the TUI. TUI changes (interface, tools, permission interactions) that do not affect the ABI only require a patch or minor version increment.

Version increments:

| Change | Before 1.0 | From 1.0 onward |
|---|---|---|
| TUI-only changes, bug fixes, performance | Patch +1 | Patch +1 |
| New ABI functions, events, or options | Minor +1 | Minor +1 |
| Breaking ABI changes (struct layout or semantics) | Minor +1 | Major +1 |

## Release archive contents

`scripts/release.sh` builds `dist/sope-<version>-<os>-<arch>.tar.gz` for the current platform, with a `.sha256` file:

```
sope-0.1.0-darwin-arm64/
  bin/sope            Single executable (Bun runtime, TUI, and embedded libsope)
  lib/libsope.*       Shared library (exports only sope_*) and static library
  include/sope.h
  docs/  README.md  CHANGELOG.md  LICENSE
  licenses/           curl and mbedTLS licenses in bundled mode
  install.sh          Install sope into ~/.local/bin; --lib also installs the library and header
```

The script runs a Release build, C tests, binding and TUI tests, and type checking. It then compiles `sope`, smoke-tests it from `/` without relying on the repository, and packages the result.

### HTTP/TLS by platform

| Platform | `SOPE_CURL` | Reason |
|---|---|---|
| macOS | `system` | libcurl is part of the OS, so it adds no extra dependency. TLS trusts the system keychain, including corporate certificates and HTTPS proxies |
| Linux | `bundled` | libcurl versions and paths vary across distributions; bundling it makes the binary self-contained. mbedTLS reads the system certificate file, which is the standard approach on Linux |

Override with `SOPE_CURL=bundled bash scripts/release.sh`.

### About the size of `sope`

`bin/sope` is about 58 MB, almost all of which is the Bun runtime. libsope itself is under 100 KB (about 1.1 MB in bundled mode). A future C or Zig rewrite of the TUI could link libsope statically for a smaller executable without any ABI changes.

## License

sope uses the MIT license; the full text is in `LICENSE`. Every source file starts with a short SPDX identifier:

```c
/* SPDX-License-Identifier: MIT */
```

This is a common convention in projects such as the Linux kernel and curl, and tools such as `reuse` and GitHub recognize it. `include/sope.h` also includes a copyright notice because embedding applications often copy only this header.

Bundled mode compiles curl (curl license, MIT-style) and mbedTLS (Apache-2.0) into libsope. Release archives include their full license texts in `licenses/`, as required by those licenses.

## Release steps

```sh
scripts/bump-version.sh 0.4.0           # Update sope.h, three package.json files, the bindings' ABI, and doc versions
# Add a “## 0.4.0 — YYYY-MM-DD” section to CHANGELOG.md
bash scripts/release.sh                 # Build, test, and package into dist/
git tag -a v0.4.0 -m "sope 0.4.0"
dist/sope-0.4.0-darwin-arm64/install.sh # Install locally
```

The complete checklist (ASan/TSan/leak checks, bundled builds, live model checks, checking for secrets before committing, and installation from the archive) is in `.claude/skills/release/SKILL.md`. Enter `/release` in Claude Code to follow it.

Each platform requires a run on a machine of that platform (libsope is native code and cannot be cross-compiled). Uploading to distribution channels such as GitHub Releases is currently manual.

## Open decisions

- **macOS signing and notarization**: currently ad-hoc signed only. Gatekeeper blocks archives downloaded through a browser; `install.sh` removes the quarantine attribute. Formal distribution should use Developer ID signing and notarization.
- **Windows**: the fd, thread pool, and HTTP layers do not yet have Windows implementations.
