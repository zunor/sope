// Agent configuration. Later sources win:
//
//   1. defaults
//   2. the config file: $XDG_CONFIG_HOME/sope/config (~/.config/sope/config),
//      KEY=VALUE lines like a .env file
//   3. environment variables (`bun run tui` also loads ./.env)
//   4. command-line flags
//
//   SOPE_API_KEY            enables the openai provider
//   SOPE_PROVIDER           mock | openai (default: openai when a key is set)
//   SOPE_MODEL              default glm-5.3
//   SOPE_BASE_URL           any OpenAI-compatible endpoint
//   SOPE_COMPACT_THRESHOLD  compact the history past this many tokens (0: never)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://api-taas.moi.matrixorigin.cn/v1";
export const DEFAULT_MODEL = "glm-5.3";
export const DEFAULT_COMPACT_THRESHOLD = 100_000;

export interface Config {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  compactThreshold: number;
}

export type Overrides = Partial<Pick<Config, "provider" | "model" | "baseUrl">>;

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sope", "config");
}

/** Parses KEY=VALUE lines; # comments, optional quotes and `export ` prefixes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function readConfigFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(
  overrides: Overrides = {},
  env: Record<string, string | undefined> = process.env,
  file: Record<string, string> = readConfigFile(configPath(env)),
): Config {
  const get = (key: string) => env[key] || file[key] || undefined;
  const apiKey = get("SOPE_API_KEY");
  const provider = overrides.provider || get("SOPE_PROVIDER") || (apiKey ? "openai" : "mock");
  const threshold = Number(get("SOPE_COMPACT_THRESHOLD") ?? DEFAULT_COMPACT_THRESHOLD);
  return {
    provider,
    model: overrides.model || get("SOPE_MODEL") || (provider === "mock" ? "" : DEFAULT_MODEL),
    baseUrl: overrides.baseUrl || get("SOPE_BASE_URL") || DEFAULT_BASE_URL,
    apiKey,
    compactThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_COMPACT_THRESHOLD,
  };
}

export function systemPrompt(cwd = process.cwd(), now = new Date()): string {
  return [
    "You are sope, an AI assistant working in the user's terminal.",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}. Today is ${now.toDateString()}.`,
    "",
    "Use the tools to look things up instead of guessing: list_files, read_file and search are free to use.",
    "write_file, edit_file and bash need the user's approval each time, so batch work sensibly and explain briefly what you are about to change.",
    "Read a file before editing it. Prefer small, verifiable steps, and check your work (run the tests or the program) when you can.",
    "For broad investigations, launch subagents with the agent tool, several at once when the parts are independent.",
    "Answer in the user's language. Be concise; use Markdown for structure and code.",
  ].join("\n");
}

/** Agent options for a config; secrets stay out of anything that gets displayed. */
export function agentOptions(c: Config): Record<string, string> {
  const options: Record<string, string> = { provider: c.provider, system: systemPrompt() };
  if (c.model) options.model = c.model;
  if (c.compactThreshold) options["compact.threshold"] = String(c.compactThreshold);
  if (c.provider === "openai") {
    options["openai.base_url"] = c.baseUrl;
    if (c.apiKey) options["openai.api_key"] = c.apiKey;
  }
  return options;
}
