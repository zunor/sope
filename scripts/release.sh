#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Builds a release package for the current platform into dist/:
#
#   dist/sope-<version>-<os>-<arch>.tar.gz (+ .sha256), containing
#     bin/sope              the CLI/TUI, a single executable with libsope embedded
#     lib/libsope.<ext>     the shared library (exports only sope_*)
#     lib/libsope.a         static library
#     include/sope.h        the ABI
#     docs/, README.md, CHANGELOG.md, LICENSE, install.sh
#     licenses/             SQLite notice; curl's and mbedTLS's when bundled
#
# HTTP: macOS links the system libcurl (part of the OS; TLS trusts the
# Keychain); Linux bundles curl + mbedTLS into libsope. Override with
# SOPE_CURL=system|bundled. Runs every test suite before packaging.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(sed -n 's/^#define SOPE_VERSION_STRING "\(.*\)"/\1/p' include/sope.h)"
for pkg in bindings/js/package.json tui/package.json package.json; do
  v="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$pkg")"
  [[ "$v" == "$version" ]] || { echo "release: $pkg has version '$v', sope.h has '$version'" >&2; exit 1; }
done

case "$(uname -s)" in
  Darwin) os=darwin; ext=dylib; curl_mode="${SOPE_CURL:-system}" ;;
  Linux) os=linux; ext=so; curl_mode="${SOPE_CURL:-bundled}" ;;
  *) echo "release: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "release: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

name="sope-$version-$os-$arch"
build="$root/build-release"
stage="$root/dist/$name"
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; } # macOS has no timeout(1)

step "libsope $version ($os-$arch, curl: $curl_mode)"
cmake -S . -B "$build" -DCMAKE_BUILD_TYPE=Release -DSOPE_CURL="$curl_mode" >/dev/null
cmake --build "$build" -j "$(getconf _NPROCESSORS_ONLN)"
lib="$(cd "$build" && pwd -P)/libsope.$ext"
real_lib="$(readlink -f "$lib" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$lib")"

step "tests"
ctest --test-dir "$build" --output-on-failure
SOPE_LIB="$lib" bun test
bun run typecheck

step "sope executable"
embed="$build/embed"
rm -rf "$embed" "$stage"
mkdir -p "$embed" "$stage"/{bin,lib,include,docs}
cp "$real_lib" "$embed/libsope.$ext" # a plain name, whatever the soname
# --root .: the worker specifier in tui/src/agent/bridge.ts depends on it.
bun build --compile --root . --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile "$stage/bin/sope" tui/src/main.ts tui/src/agent/poller.ts "$embed/libsope.$ext"

step "smoke test"
(cd / && with_timeout 10 "$stage/bin/sope" --version)
(cd / && env -u SOPE_LIB perl -e 'alarm 30; exec @ARGV' "$stage/bin/sope" -p --provider mock "smoke test" </dev/null | grep -q "You said: smoke test")
echo "ok"

step "package"
cp "$real_lib" "$stage/lib/$(basename "$real_lib")"
if [[ "$os" == darwin ]]; then
  ln -s "$(basename "$real_lib")" "$stage/lib/libsope.0.dylib"
  ln -s libsope.0.dylib "$stage/lib/libsope.dylib"
else
  ln -s "$(basename "$real_lib")" "$stage/lib/libsope.so.0"
  ln -s libsope.so.0 "$stage/lib/libsope.so"
fi
if [[ "$curl_mode" == bundled ]]; then
  cp "$build/libsope-bundled.a" "$stage/lib/libsope.a" # SQLite + curl + mbedTLS inside
else
  cp "$build/libsope.a" "$stage/lib/libsope.a" # SQLite inside; link with -lcurl
fi
cp include/sope.h "$stage/include/"
cp -R docs/. "$stage/docs/"
cp README.md CHANGELOG.md "$stage/"
cp scripts/install.sh "$stage/install.sh"
cp LICENSE "$stage/"
mkdir -p "$stage/licenses"
cp cmake/SQLite-NOTICE.txt "$stage/licenses/sqlite.txt"
if [[ "$curl_mode" == bundled ]]; then # their code is inside libsope: ship their licenses
  mkdir -p "$stage/licenses"
  cp "$build/curl_ep-prefix/src/curl_ep/COPYING" "$stage/licenses/curl.txt"
  cp "$build/mbedtls_ep-prefix/src/mbedtls_ep/LICENSE" "$stage/licenses/mbedtls.txt"
fi

(cd dist && tar -czf "$name.tar.gz" "$name" && shasum -a 256 "$name.tar.gz" >"$name.tar.gz.sha256")
step "done"
ls -lh "dist/$name.tar.gz" "$stage/bin/sope" "$stage/lib/"*
cat "dist/$name.tar.gz.sha256"
