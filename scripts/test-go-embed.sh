#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Exercise the actual library files as an external cgo consumer, without
# CMake transitive dependencies or a Go SQLite module. Requires Go and a C compiler.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
build="$(cd "${1:-$root/build}" && pwd)"
curl_mode="$(sed -n 's/^SOPE_CURL:STRING=//p' "$build/CMakeCache.txt")"
static="$build/libsope.a"
deps=""
case "$curl_mode" in
  system) deps="-lcurl" ;;
  bundled)
    static="$build/libsope-bundled.a"
    if [[ "$(uname -s)" == Darwin ]]; then
      deps="-framework SystemConfiguration -framework CoreFoundation -framework CoreServices"
    fi ;;
  off) ;;
  *) echo "unknown SOPE_CURL: $curl_mode" >&2; exit 1 ;;
esac
export CGO_ENABLED=1
export CGO_CFLAGS="\"-I$root/include\""
export GO111MODULE=off
for linkage in shared static; do
  if [[ "$linkage" == shared ]]; then
    export CGO_LDFLAGS="\"-L$build\" -lsope \"-Wl,-rpath,$build\" -pthread"
  else
    export CGO_LDFLAGS="\"$static\" $deps -pthread -lm"
  fi
  echo "Go host ($linkage)"
  "${GO:-go}" run "$root/tests/go_embed/main.go"
done
