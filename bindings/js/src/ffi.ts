// Raw symbol table for libsope. Keep in sync with include/sope.h.
// size_t is declared as u64: only 64-bit targets are supported for now.
import { dlopen, FFIType, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Locates libsope: $SOPE_LIB, else the CMake build directory at the repo root. */
export function findLibrary(): string {
  const fromEnv = process.env.SOPE_LIB;
  if (fromEnv) return fromEnv;
  const file = `libsope.${suffix}`;
  const candidate = resolve(import.meta.dir, "../../../build", file);
  if (existsSync(candidate)) return candidate;
  throw new Error(`sope: ${file} not found at ${candidate}; run \`bun run build:native\` or set SOPE_LIB`);
}

export const C = dlopen(findLibrary(), {
  sope_version: { args: [], returns: FFIType.cstring },
  sope_version_number: { args: [], returns: FFIType.u32 },
  sope_strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  sope_last_error: { args: [], returns: FFIType.cstring },
  sope_set_threads: { args: [FFIType.u32], returns: FFIType.i32 },
  sope_shutdown: { args: [], returns: FFIType.i32 },
  sope_agent_new: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_set_option: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_tool_register: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sope_send: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  sope_tool_result: {
    args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  sope_cancel: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_close: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_free: { args: [FFIType.ptr], returns: FFIType.void },
  sope_agent_reset: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_agent_fd: { args: [FFIType.ptr], returns: FFIType.i32 },
  sope_subagent_register: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  sope_poll: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
}).symbols;
