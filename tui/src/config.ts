// SPDX-License-Identifier: MIT
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
//   SOPE_MOUSE              0 leaves the mouse to the terminal (default: the TUI
//                           takes it for wheel scrolling and drag-to-copy)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://api-taas.moi.matrixorigin.cn/v1";
export const DEFAULT_MODEL = "glm-5.3";
/** glm-5.3 reads text only; on the default endpoint kimi-k3 takes over for images. */
export const DEFAULT_IMAGE_MODEL = "kimi-k3";
export const DEFAULT_COMPACT_THRESHOLD = 100_000;

export interface Config {
  provider: string;
  model: string;
  /** Used once a conversation holds an image (option image_model); "" for the main model. */
  imageModel: string;
  baseUrl: string;
  apiKey?: string;
  compactThreshold: number;
  mouse: boolean;
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
  const baseUrl = overrides.baseUrl || get("SOPE_BASE_URL") || DEFAULT_BASE_URL;
  const imageModel = get("SOPE_IMAGE_MODEL") ?? (provider === "openai" && baseUrl === DEFAULT_BASE_URL ? DEFAULT_IMAGE_MODEL : "");
  return {
    provider,
    model: overrides.model || get("SOPE_MODEL") || (provider === "mock" ? "" : DEFAULT_MODEL),
    imageModel: /^(off|none|0)$/i.test(imageModel) ? "" : imageModel,
    baseUrl,
    apiKey,
    compactThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_COMPACT_THRESHOLD,
    mouse: !/^(0|false|off|no)$/i.test(get("SOPE_MOUSE") ?? ""),
  };
}

export function systemPrompt(cwd = process.cwd(), now = new Date()): string {
  return [
    "You are sope, an AI assistant working in the user's terminal.",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}. Today is ${now.toDateString()}.`,
    "",
    "Use the tools to look things up instead of guessing: read, glob and grep are free to use.",
    "write, edit, bash and web_fetch need the user's approval each time, so batch work sensibly and explain briefly what you are about to change.",
    "Read a file before editing it. Prefer small, verifiable steps, and check your work (run the tests or the program) when you can.",
    "For work with several steps, keep a todo list with todo_write so the user can follow along.",
    "For broad investigations, launch subagents with the agent tool, several at once when the parts are independent.",
    "Answer in the user's language. Be concise; use Markdown for structure and code.",
  ].join("\n");
}

/**
 * Agent options for a config; secrets stay out of anything that gets
 * displayed. permissions: whether built-in tools that change things ask
 * first (the TUI answers), run freely (--allow-all), or are refused.
 */
export function agentOptions(c: Config, permissions: "ask" | "allow" | "deny" = "ask"): Record<string, string> {
  const options: Record<string, string> = { provider: c.provider, system: systemPrompt(), permissions };
  if (c.model) options.model = c.model;
  if (c.imageModel && c.imageModel !== c.model) options.image_model = c.imageModel;
  if (c.compactThreshold) options["compact.threshold"] = String(c.compactThreshold);
  if (c.provider === "openai") {
    options["openai.base_url"] = c.baseUrl;
    if (c.apiKey) options["openai.api_key"] = c.apiKey;
  }
  return options;
}
