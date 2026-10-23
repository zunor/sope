---
name: release
description: Cut a sope release end to end — pick the version, bump it everywhere, verify (C tests under ASan/TSan/leaks, bundled build, JS tests, typecheck, live model), commit, run scripts/release.sh, tag, install from the tarball and smoke-test. Use when the user asks to release, publish, ship, cut, tag or upgrade sope, or to bump its version.
---

# Releasing sope

sope ships two products from one version number: **libsope** (C ABI) and the
**sope** executable (Bun TUI with libsope embedded). The version lives in
`include/sope.h`; everything else follows it. Background and policy:
`docs/release.md`. Work from the repo root.

Do the steps in order and stop at the first failure: fix it, then resume
from the step that failed. Never skip a verification step silently; if one
cannot run, say so in the report.

## 1. Pick the version

Read `git log --oneline <last tag>..HEAD` and the uncommitted diff, then
apply the table in `docs/release.md`:

| Change | Before 1.0 | After 1.0 |
|---|---|---|
| TUI only, bug fixes, performance | patch +1 | patch +1 |
| ABI adds functions, events, options | minor +1 | minor +1 |
| ABI breaks (struct layout, semantics) | minor +1 | major +1 |

Any new `SOPE_API` function, `SOPE_EVENT_*`, or agent option counts as an ABI
addition. Before 1.0 the bindings refuse a library whose major.minor differs,
so a minor bump means hosts must rebuild: say so in the CHANGELOG.

## 2. Bump and document

```sh
scripts/bump-version.sh X.Y.Z
```

It updates `include/sope.h`, the three `package.json`, the bindings' `ABI`
in `bindings/js/src/ffi.ts`, the version line of `docs/abi.md`, and the
tarball names in `README.md` and `docs/guide/quickstart.md`, and reports whether `CHANGELOG.md` has a
section for X.Y.Z. Then by hand:

- **CHANGELOG.md**: a `## X.Y.Z — YYYY-MM-DD` section at the top (rename an
  `## Unreleased…` heading if there is one), in English like the rest, grouped
  as `### libsope (C ABI x.y)`, `### Bindings`, `### TUI`. Lead with one
  sentence on what the release is about and whether hosts must recompile.
- **Exported symbol count**: `nm -gU build/libsope.dylib | grep -c " _sope_"`
  (Linux: `nm -D --defined-only build/libsope.so | grep -c " sope_"`) must
  match "exports only the public `sope_*` functions (N in total)" in `docs/abi.md`.
- **Docs for anything new**: `include/sope.h` comments, `docs/abi.md`
  (options table, events table, limitations in the last section), `README.md`
  (overview), `docs/guide/terminal.md` (keys and commands), and
  `docs/guide/configuration.md` (configuration table). Check with
  `grep -rn "<old version>" README.md docs include */package.json` that
  nothing still names the old version, CHANGELOG excepted.

## 3. Verify

Rebuild native code first: after a minor bump the old build no longer
matches the bindings and every binding test fails to load the library.

```sh
cmake --build build && ctest --test-dir build --output-on-failure
for d in build-asan build-thread build-bundled; do
  cmake --build "$d" && for t in test_agent test_tools test_json; do "./$d/$t" | tail -1; done
done
leaks --atExit -- ./build/test_agent | grep "leaks for"   # macOS; expect 0 leaks
leaks --atExit -- ./build/test_tools | grep "leaks for"
bun test && bun run typecheck
```

- If `build-asan`, `build-thread` or `build-bundled` does not exist, configure
  it with the project's own options:
  `cmake -S . -B build-asan -DSOPE_SANITIZE=address -DSOPE_BUILD_EXAMPLES=OFF`,
  `cmake -S . -B build-thread -DSOPE_SANITIZE=thread -DSOPE_BUILD_EXAMPLES=OFF`,
  `cmake -S . -B build-bundled -DCMAKE_BUILD_TYPE=Release -DSOPE_CURL=bundled`.
  The bundled one is the Linux configuration and must also compile and pass
  on macOS; it downloads curl and mbedTLS, or takes local tarballs through
  `-DSOPE_CURL_URL=… -DSOPE_MBEDTLS_URL=…` when offline.
- **Live model** (needs `.env` with `SOPE_API_KEY`; load it with
  `set -a; . ./.env; set +a`, never echo it):
  `bun tui/src/main.ts -p "In one sentence: what is 1+1?"`, plus one check per
  user-visible feature of the release (for example `--image` with a small
  PNG). The endpoint sometimes stalls or times out in the TLS handshake:
  check `curl -m 20 -w "%{http_code}" "$SOPE_BASE_URL/models" -H "Authorization: Bearer $SOPE_API_KEY"`
  and retry before suspecting the code.
- **TUI changes**: drive the real TUI in a pty with the mock provider and a
  throwaway database (`SOPE_DB=<scratch>/sope.db`, `--provider mock`) using
  python's `pty` + `pyte`, and look at the screen. Two traps: macOS has no
  `timeout` (use `perl -e 'alarm N; exec @ARGV'` or a background kill), and
  ctrl+c only cancels while a turn runs, so a script that quits mid-turn
  must send it twice.

## 4. Commit

```sh
git add -A && git status --short          # look at every new file
set -a; . ./.env; set +a
git diff --cached | grep -c -F "$SOPE_API_KEY"   # must print 0
git check-ignore -q .env && echo ".env ignored"
```

Scratch files, databases, `dist/` and build directories must stay out;
`.gitignore` already covers `.env*`, `build/`, `build-*/`, `dist/` and built
libraries. Commit message:

```
Release X.Y.Z: <what the release is about, a few words>

<libsope / TUI bullet points, wrapped at 72>

Co-Authored-By: <the attribution line the session asks for>
```

## 5. Package, tag, install

```sh
bash scripts/release.sh > <scratch>/release-X.Y.Z.log 2>&1; echo "exit $?"
grep -E "==>|pass|fail|ok$|tar.gz" <scratch>/release-X.Y.Z.log | tail -25
git tag -a vX.Y.Z -m "sope X.Y.Z"
```

`release.sh` refuses mismatched versions, runs every test suite again,
compiles `bin/sope`, smoke-tests it from `/`, and writes
`dist/sope-X.Y.Z-<os>-<arch>.tar.gz` plus `.sha256`. Tag only after it
succeeds; if it fails, fix, amend the release commit, and run it again.

Install from the tarball, not from the build directory, so the package
itself is what gets checked:

```sh
(cd dist && shasum -a 256 -c sope-X.Y.Z-*.tar.gz.sha256)
tar xzf dist/sope-X.Y.Z-*.tar.gz -C <scratch> && <scratch>/sope-X.Y.Z-*/install.sh
(cd / && ~/.local/bin/sope --version)    # sope X.Y.Z (<os>-<arch>, libsope embedded)
(cd / && ~/.local/bin/sope -p "In one sentence: what is 1+1?")   # with .env loaded
```

The repository has no remote: do not push, and do not upload the tarball
anywhere unless the user asks. Each platform needs its own run of
`release.sh` on a machine of that platform (no cross compiling).

## 6. Report

Tell the user, in their language: the version and why that bump, commit
hash, tag, tarball path, size and sha256, where it is installed and what
`--version` printed, what was verified (test counts, sanitizers, live
checks) and anything that could not be verified, plus open items worth
knowing (unsigned macOS binary, untested platforms).
