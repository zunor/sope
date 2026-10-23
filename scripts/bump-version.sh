#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Sets the version everywhere it is written down:
#
#   scripts/bump-version.sh 0.4.0
#
#   include/sope.h            SOPE_VERSION_MAJOR/MINOR/PATCH/STRING (the source of truth)
#   package.json (×3)         root, bindings/js, tui
#   bindings/js/src/ffi.ts    ABI the bindings are written against (major.minor)
#   docs/abi.md               "当前版本 x.y.z（ABI x.y）"
#   README.md                 the release tarball names in the install example
#
# CHANGELOG.md is left to you; the script only says whether it has a
# section for the new version yet. Idempotent: the same version twice is a
# no-op. Prints what changed (git diff --stat).
set -euo pipefail

new="${1:-}"
[[ "$new" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "usage: $0 <major.minor.patch>" >&2; exit 2; }
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
old="$(sed -n 's/^#define SOPE_VERSION_STRING "\(.*\)"/\1/p' include/sope.h)"

# perl -pi works the same on macOS and Linux (sed -i does not).
perl -pi -e "s/^(#define SOPE_VERSION_MAJOR) \d+/\$1 $major/; s/^(#define SOPE_VERSION_MINOR) \d+/\$1 $minor/;" \
  -e "s/^(#define SOPE_VERSION_PATCH) \d+/\$1 $patch/; s/^(#define SOPE_VERSION_STRING) \"[^\"]*\"/\$1 \"$new\"/" include/sope.h
for pkg in package.json bindings/js/package.json tui/package.json; do
  perl -pi -e "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$new\",/" "$pkg"
done
perl -pi -e "s/^export const ABI = \{ major: \d+, minor: \d+ \}/export const ABI = { major: $major, minor: $minor }/" bindings/js/src/ffi.ts
perl -pi -e "s/当前版本 [0-9.]+（ABI [0-9.]+）/当前版本 ${new}（ABI ${major}.${minor}）/" docs/abi.md
perl -pi -e "s/sope-[0-9]+\.[0-9]+\.[0-9]+-/sope-$new-/g" README.md

echo "version: $old -> $new"
git --no-pager diff --stat -- include/sope.h package.json bindings/js/package.json tui/package.json \
  bindings/js/src/ffi.ts docs/abi.md README.md || true
if grep -q "^## $new\b\|^## 未发布（${new}）" CHANGELOG.md; then
  echo "CHANGELOG.md has a section for $new"
else
  echo "CHANGELOG.md has no section for $new yet: add '## $new — $(date +%F)' with the changes" >&2
fi
