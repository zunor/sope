---
name: release
description: Build and validate unreleased sope changes locally or in a consuming repository, or prepare and publish a versioned sope release. Use for sope validation builds, local installation, packaging, version bumps, and releases; ordinary bug investigation alone does not require this workflow.
---

# Building and releasing sope

sope ships libsope (C ABI) and the Bun TUI executable from one version in
`include/sope.h`. Read [release policy](../../../docs/release.md) from the
repository root as `docs/release.md`, and inspect the current build scripts.

## Choose the delivery mode first

| User intent | Mode | Result |
|---|---|---|
| Try a local fix, install a development build, validate in another repository | Validation build | A tested library/executable from the working tree and consumer regression results |
| Bump a version, prepare a release without publishing | Release preparation | Versioned commit and verified packages; remote actions only within the requested scope |
| Publish a GitHub Release | Publication | Verified packages, tag, release notes, uploaded assets, and README download links |

A validation build does **not** imply a version bump, changelog release heading,
commit, tag, push, or GitHub Release. Follow the user's existing authorization;
using this skill itself does not grant publication permission. If they ask only
to validate a fix, finish after validation. If both are requested, validate first
and then continue to release preparation/publication.

## Validation build: use the working tree

1. Inspect the diff and identify the consumer regression to reproduce. Include
   relevant uncommitted edits; do not build an older tag or discard local work.
   Record the base commit, dirty state and changed paths. Use a scratch build
   manifest/diff digest and artifact checksum to distinguish successive dirty
   builds: `--version` alone cannot identify an unreleased fix.
2. Build the component the consumer uses, then run the affected native/binding
   tests. Configure a fresh build directory when necessary:

   ```sh
   cmake -S . -B build-validate -DCMAKE_BUILD_TYPE=Debug
   cmake --build build-validate --parallel 3
   ctest --test-dir build-validate --output-on-failure --timeout 120
   ```

   Choose `SOPE_CURL` for the target: macOS normally uses `system`; Linux release
   packages use `bundled`. Run Go/JS checks when those bindings are involved.
   `scripts/ci/check-ctest.py build-validate` verifies that Go tests were not
   silently omitted. Add sanitizers for relevant native memory/thread changes.
3. Route the consumer explicitly to this build:
   - **JS or a compatible sope executable:** use a command-scoped absolute
     `SOPE_LIB` path to the rebuilt `.dylib`/`.so`. If TUI code changed, run the
     current TUI source or compile a new executable; replacing its library alone
     does not update its embedded TypeScript.
   - **Go/C host:** use the matching header, library, bindings and pkg-config
     files. Set `PKG_CONFIG_PATH` for that command; Go needs `go build -a` or
     `go test -a` because its cache does not track external C library changes.
     Prefer a temporary `GOWORK`/consumer checkout over persisting dependency
     replacements in another repository. Confirm which shared library is loaded.
   - **Standalone executable/package:** `bash scripts/release.sh` builds the
     working tree without creating a tag or publishing. It runs full package
     checks and writes version-named outputs in `dist/`. Preserve any existing
     same-name artifact before rebuilding, then copy the validation package into
     a scratch directory identified by its commit/dirty-build digest. Label it
     unreleased, even though its embedded version still matches the last release.
     Validate with `scripts/ci/check-package.py` (requires Gitleaks), and install
     from the archive into an explicit temporary `--prefix`. Unset `SOPE_LIB`
     when testing the executable's embedded library.
4. In the requested consumer repository, run the original failing scenario and
   relevant regression checks. Respect that repository's instructions and local
   changes. Use throwaway session/data paths where persistent state is not part
   of the regression. Do not change its Git accounts, remotes, global PATH or
   default installation. If an ABI changed, rebuild the consumer with matching
   bindings; do not bypass ABI guards to make a smoke test pass.
5. Report the tested source identity, absolute artifact/install path, consumer
   scenario and result. State that this is an unreleased validation build, with
   the current embedded version. No publication steps follow unless requested.

## GitHub account isolation for this checkout

The publication target is **zunor/sope**. The user's default GitHub CLI and SSH
account is **iamlinjunhong** for other repositories. Keep that default intact.

Use the sope-local `git gh` alias for GitHub operations, from the sope repository:

```sh
git gh api user --jq .login                 # must be zunor
git gh repo view zunor/sope --json nameWithOwner
git remote get-url --push origin
```

Pass `--repo zunor/sope` on commands that support it. Git push uses this
checkout's local credential helper and its username-qualified HTTPS remote.
Do not run `gh auth switch`, `gh auth setup-git`, or change global/SSH settings
for this release. Do not assume ordinary `gh` uses the repository's account.

The alias and credential helper live in `.git/config`; they are not copied by
cloning. If absent, configure only this checkout, or use a per-command token
obtained with `gh auth token --hostname github.com --user zunor`. Check token
lookup succeeded and verify the resulting API identity before any mutation.
Keep the token in process memory/environment; never print it or save it in the
repository. Missing credentials are a setup issue, not a reason to switch the
user's global account. Local validation needs no GitHub authentication.

## Prepare a versioned release

1. Read the diff since the latest release and choose the version:

   | Change | Before 1.0 | From 1.0 |
   |---|---|---|
   | TUI-only changes, fixes, performance | Patch +1 | Patch +1 |
   | New ABI functions, events or options | Minor +1 | Minor +1 |
   | Breaking ABI changes | Minor +1 | Major +1 |

   Before 1.0, a minor bump requires consumers to rebuild with matching
   bindings. Explain that in the release notes.
2. Run `scripts/bump-version.sh X.Y.Z`. Inspect header/package/lockfile versions,
   JS and Go ABI guards, and documentation; do not assume the script covers
   every version reference. Convert the relevant Unreleased notes into a dated
   English changelog section and update feature docs. Check exported symbols
   against `docs/abi.md`. Keep the README concise and text-only unless the user requests images.
3. Run `python3 scripts/ci/check-metadata.py`, targeted checks for the changes,
   and `git diff --check`. Before a public push, scan the intended source/history
   with Gitleaks using `--redact=100`, and compare against available local
   credentials without displaying them. Keep `.env`, session databases, build
   outputs and scratch evidence out of Git. Stage only the intended files.
4. Commit the reviewed release changes, normally as
   `Release X.Y.Z: <concrete changes>`. Do not add a Co-Authored-By trailer unless
   the user explicitly requests one. Capture the commit SHA. Do not amend a
   pushed commit or move an existing release tag as routine release work.

## Verify that commit and collect packages

Prefer the existing GitHub workflows when remote validation is in scope; a
local Linux environment is not needed. Push the release commit only within the
user's authorized scope, then select runs by **head SHA**, not merely the latest
successful run or branch name.

- **CI** must finish successfully: native/Go/JS tests, type checking, both Linux
  sanitizers, metadata and history secret scanning.
- **Nightly**, triggered manually for that commit, adds Linux arm64/Intel Mac,
  macOS leak checks, PTY interaction, benchmarks and the two package builds.
  Benchmarks currently record observations rather than enforce thresholds.
- **Packages** can run separately if no suitable Nightly package artifacts exist.
  Its outputs are Linux x64 and macOS arm64 archives plus checksums, each named
  with the source commit in the Actions artifact name. Other tested platforms
  are not automatically packaged.

```sh
git gh workflow run nightly.yml --ref main --repo zunor/sope
git gh run list --workflow nightly.yml --commit "$release_commit" \
  --repo zunor/sope --json databaseId,headSha,status,conclusion
```

Use the actual release branch instead of `main` if applicable. A dispatch can
race a branch update: verify the selected run's SHA equals `release_commit`.
Wait for completion and inspect failed jobs. Fix failures and validate the new
commit; do not treat successful individual steps inside a failed/cancelled run
as a successful workflow. For a runner-only failure, retry the affected job
once before investigating; avoid an indefinite cancel/rerun loop. Reuse passed
checks and packages for the same source rather than repeating local checks just
because several instructions mention them.

Download the two verified package artifacts by run ID into separate scratch
folders, and check their filenames, versions and SHA-256 files. Use the tested
bytes for publication, rather than rebuilding another binary after CI.
`scripts/ci/check-package.py` checks archive contents, credential
patterns, temporary-prefix installation and execution from outside the checkout
on each package's own platform. Never try to run a Linux binary on macOS.

For local-only release preparation, run the equivalent checks available on the
host and `scripts/release.sh`; report unverified platforms. Use full `ctest` runs
under ASan/UBSan and TSan, not only selected test executables. Use
`scripts/ci/check-leaks.py` for macOS diagnostics and `scripts/ci/tui-smoke.py`
(with pyte) for PTY checks. Keep shell failure status intact; do not hide failed
tests behind `tail` or `grep` pipelines.

CI has no real model credentials. When available, exercise the release's live
model behavior locally using the packaged executable for this host, plus the
changed user-visible features. Load credentials only for the child process,
keep them out of logs, and record any live checks that could not be run. For an
explicit API-key audit, also compare available local secrets against raw package
bytes: text scanning alone does not establish binary contents are clean.

## Publish only when requested

1. Reconfirm the target account/repository, exact release commit, successful
   verification and package checksums. Create the annotated `vX.Y.Z` tag at
   that commit only after verification. Push that tag to the checked remote.
2. Prepare English notes describing behavior changes, ABI compatibility,
   available platforms and signing status. Keep notes concise and text-only; include
   a changelog link and add images only when the user requests them. Supply multiline notes via `--notes-file`.
3. Inspect any existing tag/Release before creating or retrying. Create a draft,
   upload both platforms and their checksums, verify asset names/sizes/digests,
   then publish the draft. Use `git gh release ... --repo zunor/sope` throughout.
   Do not silently replace an already-public asset or retag a published release.
   After an ambiguous network result, inspect remote state before retrying.
4. Confirm the public release and download/checksum links. Update README download
   URLs, install commands and platform coverage, then commit/push that documentation
   within the authorized scope. Keep the tag and binaries tied to their verified
   source commit; a later README link update does not require rebuilding them.

The current Actions workflows upload build artifacts only: pushing a tag does
not itself publish a GitHub Release.

## Report

State which mode was completed. For validation, report source identity, artifact
path and consumer regression evidence. For a release, include version/ABI impact,
commit/tag, release and asset links, sizes/checksums, validation results and any
platform or signing limits. Confirm account isolation when GitHub was used.
