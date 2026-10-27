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
//   SOPE_COMPACT_THRESHOLD  compact the history past this many tokens (0: never;
//                           default: 80% of the model's window, 100000 while
//                           the window is unknown)
//   SOPE_CONTEXT_WINDOW     model's full token window (default: what the
//                           endpoint's /models says, else unknown)
//   SOPE_REASONING_EFFORT   low | medium | high | xhigh (also none, minimal):
//                           how long the model thinks (default: the model's)
//   SOPE_MOUSE              0 leaves the mouse to the terminal (default: the TUI
//                           takes it for wheel scrolling and drag-to-copy)
//   SOPE_SCROLL_SPEED       rows per vertical wheel report (positive integer,
//                           default 1; terminals already accelerate trackpads)
//   SOPE_PERMISSIONS        ask | auto | full: who approves edits, commands and
//                           fetches (default auto, "Approve for me")

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEffort, type Effort } from "./agent/effort";
import { DEFAULT_MODE, parseMode, type PermissionMode } from "./agent/permissions";

export const DEFAULT_BASE_URL = "https://api-taas.moi.matrixorigin.cn/v1";
export const DEFAULT_MODEL = "glm-5.3";
/** glm-5.3 reads text only; on the default endpoint kimi-k3 takes over for images. */
export const DEFAULT_IMAGE_MODEL = "kimi-k3";
export const DEFAULT_COMPACT_THRESHOLD = 100_000;
/** Without SOPE_COMPACT_THRESHOLD, compaction starts at this share of a known window. */
export const AUTO_COMPACT_SHARE = 0.8;

export interface Config {
  /** Explicit print-mode durable execution and host acceptance contract. */
  executionDirectory?: string;
  acceptanceContract?: string;
  provider: string;
  model: string;
  /** Used once a conversation holds an image (option image_model); "" for the main model. */
  imageModel: string;
  baseUrl: string;
  apiKey?: string;
  /** null: AUTO_COMPACT_SHARE of the model's window (contextOptions). */
  compactThreshold: number | null;
  contextWindow: number;
  /** Reasoning effort; "" leaves it to the model. */
  effort: Effort;
  mouse: boolean;
  scrollSpeed: number;
  /** Who approves built-in tools that change things (agent/permissions.ts). */
  permissions: PermissionMode;
}

export type Overrides = Partial<Pick<Config, "provider" | "model" | "baseUrl" | "permissions" | "effort">>;

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
  const threshold = Number(get("SOPE_COMPACT_THRESHOLD") ?? NaN);
  const window = Number(get("SOPE_CONTEXT_WINDOW") ?? 0);
  const scrollSpeed = Number(get("SOPE_SCROLL_SPEED") ?? 1);
  const baseUrl = overrides.baseUrl || get("SOPE_BASE_URL") || DEFAULT_BASE_URL;
  const imageModel = get("SOPE_IMAGE_MODEL") ?? (provider === "openai" && baseUrl === DEFAULT_BASE_URL ? DEFAULT_IMAGE_MODEL : "");
  return {
    provider,
    model: overrides.model || get("SOPE_MODEL") || (provider === "mock" ? "" : DEFAULT_MODEL),
    imageModel: /^(off|none|0)$/i.test(imageModel) ? "" : imageModel,
    baseUrl,
    apiKey,
    compactThreshold: Number.isInteger(threshold) && threshold >= 0 && threshold <= 0xffffffff ? threshold : null,
    contextWindow: Number.isInteger(window) && window >= 0 && window <= 0xffffffff ? window : 0,
    effort: overrides.effort ?? parseEffort(get("SOPE_REASONING_EFFORT") ?? "") ?? "",
    mouse: !/^(0|false|off|no)$/i.test(get("SOPE_MOUSE") ?? ""),
    scrollSpeed: Number.isSafeInteger(scrollSpeed) && scrollSpeed > 0 ? scrollSpeed : 1,
    permissions: overrides.permissions ?? parseMode(get("SOPE_PERMISSIONS") ?? "") ?? DEFAULT_MODE,
  };
}

export function systemPrompt(cwd = process.cwd(), now = new Date()): string {
  return [
    "You are sope, an AI assistant working in the user's terminal.",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}. Today is ${now.toDateString()}.`,
    "",
    "Use read, glob and grep to resolve specific unknowns. Reuse existing observations; reread only the necessary range when content changed or a concrete uncertainty remains.",
    "write, edit, bash and web_fetch may need the user's approval. Explain briefly what you are about to change; if a call is refused, do not retry it as is: ask the user or take another way.",
    "Read a file before editing it. Prefer small, verifiable steps, and check your work (run the tests or the program) when you can.",
    "For work with several steps, keep a todo list with todo_write. Complete the requested deliverables, verify them, reconcile the plan, and finish autonomously. Do not expand scope or repeat passing checks without a reason. Mark genuinely blocked work with a specific reason; completion statuses are claims, not proof. Use the runtime working state and evidence tool after compaction rather than trusting summary interpretations.",
    "For broad investigations, launch subagents with the agent tool, several at once when the parts are independent.",
    "Answer in the user's language. Be concise; use Markdown for structure and code.",
  ].join("\n");
}

/**
 * The context budget for a model whose window is `window` tokens (0:
 * unknown); SOPE_CONTEXT_WINDOW and SOPE_COMPACT_THRESHOLD win over it.
 */
export function contextOptions(c: Config, window = 0): Record<"context.window" | "compact.threshold", string> {
  const w = c.contextWindow || window;
  const threshold = c.compactThreshold ?? (w ? Math.floor(w * AUTO_COMPACT_SHARE) : DEFAULT_COMPACT_THRESHOLD);
  return { "context.window": String(w), "compact.threshold": String(threshold) };
}

/**
 * Agent options for a config; secrets stay out of anything that gets
 * displayed. Built-in tools that change things always ask: the host
 * answers each request by the permission mode (agent/permissions.ts), so a
 * new mode applies at once, even to requests already waiting.
 */
export function agentOptions(c: Config): Record<string, string> {
  const options: Record<string, string> = { provider: c.provider, system: systemPrompt(), permissions: "ask" };
  if (c.acceptanceContract) options["acceptance.contract"] = c.acceptanceContract;
  if (c.model) options.model = c.model;
  if (c.imageModel && c.imageModel !== c.model) options.image_model = c.imageModel;
  if (c.effort) options["reasoning.effort"] = c.effort;
  Object.assign(options, contextOptions(c));
  if (c.provider === "openai") {
    options["openai.base_url"] = c.baseUrl;
    if (c.apiKey) options["openai.api_key"] = c.apiKey;
  }
  return options;
}
