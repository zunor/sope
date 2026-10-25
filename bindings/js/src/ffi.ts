// SPDX-License-Identifier: MIT
// Raw symbol table for libsope. Keep in sync with include/sope.h.
// size_t is declared as u64: only 64-bit targets are supported for now.
//
// The library is opened on first use, so a host can pick the file first
// with useLibrary() (the sope executable points it at its embedded copy).
import { dlopen, FFIType, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** ABI version these bindings were written against (sope.h SOPE_VERSION_MAJOR/MINOR). */
export const ABI = { major: 0, minor: 6 } as const;

const symbols = {
  sope_version: { args: [], returns: FFIType.cstring },
  sope_version_number: { args: [], returns: FFIType.u32 },
  sope_strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  sope_last_error: { args: [], returns: FFIType.cstring },
  sope_set_threads: { args: [FFIType.u32], returns: FFIType.i32 },
  sope_shutdown: { args: [], returns: FFIType.i32 },
  sope_agent_new: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_open: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_recovery: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_outcome: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_resume: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_resolve: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_agent_set_option: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_policy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_tool_register: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_send: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  sope_attach_image: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_compact: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  sope_tool_result: {
    args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  sope_permit: {
    args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  sope_cancel: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_close: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_free: { args: [FFIType.ptr], returns: FFIType.void },
  sope_agent_reset: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_history: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_context: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_agent_load_history: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_agent_fd: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_subagent_register: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_subagent_cancel: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_agent_shells: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_shell_stop: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  sope_poll: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

type Symbols = ReturnType<typeof dlopen<typeof symbols>>["symbols"];

let opened: Symbols | null = null;
let chosen: string | null = null;

/** Locates libsope: $SOPE_LIB, else the CMake build directory at the repo root. */
export function findLibrary(): string {
  const fromEnv = process.env.SOPE_LIB;
  if (fromEnv) return fromEnv;
  const file = `libsope.${suffix}`;
  const candidate = resolve(import.meta.dir, "../../../build", file);
  if (existsSync(candidate)) return candidate;
  throw new Error(`sope: ${file} not found at ${candidate}; run \`bun run build:native\` or set SOPE_LIB`);
}

/** Selects the library file to load. Must run before the first call into sope. */
export function useLibrary(path: string): void {
  if (opened && path !== chosen) throw new Error(`sope: already loaded from ${chosen}`);
  chosen = path;
}

/** Path of the library in use (or about to be). */
export function libraryPath(): string {
  return (chosen ??= findLibrary());
}

/** True when a library built as `loaded` serves bindings written for ABI. */
export function abiCompatible(loaded: number): boolean {
  const major = loaded >>> 16;
  const minor = (loaded >>> 8) & 0xff;
  if (major !== ABI.major) return false;
  return major === 0 ? minor === ABI.minor : minor >= ABI.minor;
}

/** The symbol table, opening the library on first use. */
export function C(): Symbols {
  if (opened) return opened;
  const path = libraryPath();
  const lib = dlopen(path, symbols).symbols;
  const loaded = lib.sope_version_number();
  if (!abiCompatible(loaded)) {
    const v = `${loaded >>> 16}.${(loaded >>> 8) & 0xff}.${loaded & 0xff}`;
    throw new Error(`sope: ${path} is version ${v}, but these bindings need ABI ${ABI.major}.${ABI.minor}`);
  }
  return (opened = lib);
}
