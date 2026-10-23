// SPDX-License-Identifier: MIT
import { dirname, delimiter } from "node:path";
import type { ExecutionPolicy } from "sope";
import { ASKING_TOOLS, READ_TOOLS, hostToolsFor } from "./tools";

/** Explicit shell environment: developer tools work without inheriting API keys. */
export function executionPolicy(provider: string, env = process.env): ExecutionPolicy {
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    if (env[key]) environment[key] = env[key]!;
  }
  environment.PATH = [dirname(process.execPath), env.PATH || "/usr/bin:/bin"].join(delimiter);
  return {
    tools: [...ASKING_TOOLS, ...READ_TOOLS, "agent", ...hostToolsFor(provider).map((tool) => tool.name)],
    environment,
  };
}
