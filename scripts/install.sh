#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Installs sope from an unpacked release package (this script ships at its
# root) or from a repo checkout after scripts/release.sh.
#
#   ./install.sh                 sope -> ~/.local/bin
#   ./install.sh --prefix /usr/local --lib
#                                also install lib/ and include/ for C hosts
set -euo pipefail

prefix="$HOME/.local"
with_lib=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --lib) with_lib=1; shift ;;
    -h | --help) sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown option $1" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here"
if [[ ! -x "$pkg/bin/sope" ]]; then # repo checkout: newest package in dist/
  pkg="$(ls -dt "$here"/../dist/sope-*/ 2>/dev/null | grep -v '\.tar' | head -1 || true)"
  pkg="${pkg%/}"
  [[ -n "$pkg" && -x "$pkg/bin/sope" ]] || { echo "install: no package found; run scripts/release.sh first" >&2; exit 1; }
fi

mkdir -p "$prefix/bin"
install -m 755 "$pkg/bin/sope" "$prefix/bin/sope"
if [[ "$(uname -s)" == Darwin ]]; then
  xattr -d com.apple.quarantine "$prefix/bin/sope" 2>/dev/null || true # downloaded via a browser
fi
echo "installed $prefix/bin/sope ($("$prefix/bin/sope" --version))"

if [[ $with_lib == 1 ]]; then
  mkdir -p "$prefix/lib" "$prefix/include"
  cp -RP "$pkg"/lib/. "$prefix/lib/"
  mkdir -p "$prefix/share/sope/bindings"
  cp -R "$pkg/bindings/go" "$prefix/share/sope/bindings/"
  install -m 644 "$pkg/include/sope.h" "$prefix/include/sope.h"
  echo "installed libsope and sope.h under $prefix"
fi

case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "note: $prefix/bin is not on your PATH" ;;
esac
