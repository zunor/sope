// Agent configuration from the environment. Bun loads ./.env automatically,
// so a local, git-ignored .env can hold the API key (see .env.example).
//
//   SOPE_API_KEY    enables the openai provider
//   SOPE_PROVIDER   mock | openai (default: openai when a key is set)
//   SOPE_MODEL      default glm-5.3
//   SOPE_BASE_URL   any OpenAI-compatible endpoint

export const DEFAULT_BASE_URL = "https://api-taas.moi.matrixorigin.cn/v1";
export const DEFAULT_MODEL = "glm-5.3";

export interface Config {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const apiKey = env.SOPE_API_KEY || undefined;
  const provider = env.SOPE_PROVIDER || (apiKey ? "openai" : "mock");
  return {
    provider,
    model: env.SOPE_MODEL || (provider === "mock" ? "" : DEFAULT_MODEL),
    baseUrl: env.SOPE_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
  };
}

/** Agent options for a config; secrets stay out of anything that gets displayed. */
export function agentOptions(c: Config): Record<string, string> {
  const options: Record<string, string> = { provider: c.provider };
  if (c.model) options.model = c.model;
  if (c.provider === "openai") {
    options["openai.base_url"] = c.baseUrl;
    if (c.apiKey) options["openai.api_key"] = c.apiKey;
  }
  return options;
}
