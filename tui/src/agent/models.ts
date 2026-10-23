// SPDX-License-Identifier: MIT
// The models an OpenAI-compatible endpoint offers (GET /models), for the
// model popup. Only chat models: embedding and rerank models are listed by
// some endpoints too, and a conversation cannot use them.

import type { Config } from "../config";

export interface ModelInfo {
  id: string;
  /** Context window in tokens, when the endpoint says. */
  context?: number;
  /** Reads images. */
  vision?: boolean;
}

interface Listed {
  id?: unknown;
  type?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  capabilities?: unknown;
}

/** Picks the chat models out of a /models reply, sorted by name. */
export function parseModels(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("the reply has no model list");
  const models: ModelInfo[] = [];
  for (const m of data as Listed[]) {
    if (typeof m?.id !== "string" || (typeof m.type === "string" && m.type !== "chat")) continue;
    const context = Number(m.context_window ?? m.context_length);
    models.push({
      id: m.id,
      ...(Number.isFinite(context) && context > 0 ? { context } : {}),
      ...(Array.isArray(m.capabilities) && m.capabilities.includes("vision") ? { vision: true } : {}),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Asks the endpoint for its models; the mock provider has none. */
export async function listModels(c: Config, timeoutMs = 10_000): Promise<ModelInfo[]> {
  if (c.provider !== "openai") return [];
  const res = await fetch(`${c.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return parseModels(await res.json());
}

/** "1M context", "256k context". */
export function describeModel(m: ModelInfo): string {
  const parts: string[] = [];
  if (m.context) {
    const n = m.context;
    parts.push(`${n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`} context`);
  }
  if (m.vision) parts.push("images");
  return parts.join(" · ");
}
