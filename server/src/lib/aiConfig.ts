import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger";

// Runtime AI configuration. Defaults come from the server .env file; the
// Settings page can override them at runtime. Overrides are persisted to
// data/ai-config.json so they survive restarts. Secrets stay on the server.

export type AiProviderId = "openai" | "gemini" | "opencode" | "custom";

export interface AiProviderPreset {
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
}

// Presets shown in Settings → AI. The provider field on the config is derived
// from the effective base URL (detectAiProvider), so switching presets only
// rewrites baseUrl/model — nothing extra is persisted.
export const AI_PROVIDER_PRESETS: Record<Exclude<AiProviderId, "custom">, AiProviderPreset> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o3-mini"],
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  opencode: {
    label: "OpenCode",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "deepseek-v4-flash-free",
    models: [
      "deepseek-v4-flash-free",
      "glm-4.7-free",
      "glm-5-free",
      "kimi-k2.5-free",
      "hy3-free",
      "nemotron-3-super-free",
      "minimax-m3-free",
      "deepseek-v4-flash",
    ],
  },
};

// OpenCode Zen used to be advertised as opencode.ai/api/v1; the real endpoint
// is opencode.ai/zen/v1. Rewrite legacy URLs so saved configs keep working.
function normalizeBaseUrl(url: string): string {
  return url
    .replace(/^https?:\/\/opencode\.ai\/api(\/?)$/, "https://opencode.ai/zen/v1")
    .replace(/\/+$/, "");
}

export function detectAiProvider(baseUrl: string): AiProviderId {
  const url = baseUrl.toLowerCase();
  if (url.includes("opencode.ai")) return "opencode";
  if (url.includes("generativelanguage") || url.includes("googleapis")) return "gemini";
  if (url.includes("openai.com")) return "openai";
  return "custom";
}

export interface AiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxToolRounds: number;
}

export interface AiConfigSnapshot {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
  updatedAt: string | null;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "ai-config.json");

interface PersistedConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxToolRounds?: number;
  updatedAt?: string;
}

let persisted: PersistedConfig | null = null;

function defaults(): AiRuntimeConfig {
  return {
    baseUrl: (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.AI_API_KEY ?? "",
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
    maxToolRounds: Math.max(1, parseInt(process.env.AI_MAX_TOOL_ROUNDS ?? "6", 10) || 6),
  };
}

async function loadPersisted(): Promise<PersistedConfig> {
  if (persisted) return persisted;
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    persisted = JSON.parse(raw) as PersistedConfig;
  } catch {
    persisted = {};
  }
  return persisted;
}

async function savePersisted(next: PersistedConfig): Promise<void> {
  persisted = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

export async function getAiConfig(): Promise<AiRuntimeConfig> {
  const p = await loadPersisted();
  const d = defaults();
  return {
    baseUrl: normalizeBaseUrl(p.baseUrl ?? d.baseUrl),
    apiKey: p.apiKey !== undefined ? p.apiKey : d.apiKey,
    model: p.model ?? d.model,
    maxToolRounds: Math.max(1, p.maxToolRounds ?? d.maxToolRounds),
  };
}

export async function getAiConfigSnapshot(): Promise<AiConfigSnapshot> {
  const cfg = await getAiConfig();
  const p = await loadPersisted();
  return {
    provider: detectAiProvider(cfg.baseUrl),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: cfg.apiKey.length > 0,
    configured: cfg.apiKey.length > 0,
    updatedAt: p.updatedAt ?? null,
  };
}

/**
 * Apply runtime overrides. Semantics:
 * - `apiKey` omitted  → keep the current key
 * - `apiKey` empty string "" → clear the key (AI disabled)
 * - `apiKey` non-empty → set a new key
 * - `provider` "custom" → leave baseUrl/model untouched
 * - `provider` preset  → fill baseUrl (and model, when not given) from the preset
 */
export async function updateAiConfig(input: {
  provider?: AiProviderId;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<AiConfigSnapshot> {
  const p = await loadPersisted();
  const next: PersistedConfig = { ...p };

  if (input.provider !== undefined && input.provider !== "custom") {
    const preset = AI_PROVIDER_PRESETS[input.provider];
    if (input.baseUrl === undefined) next.baseUrl = preset.baseUrl;
    if (input.model === undefined) next.model = preset.defaultModel;
  }
  if (input.baseUrl !== undefined) {
    const url = normalizeBaseUrl(input.baseUrl.trim());
    next.baseUrl = url.length > 0 ? url : undefined;
  }
  if (input.apiKey !== undefined) {
    next.apiKey = input.apiKey.trim();
  }
  if (input.model !== undefined) {
    const model = input.model.trim();
    next.model = model.length > 0 ? model : undefined;
  }
  next.updatedAt = new Date().toISOString();

  await savePersisted(next);
  logger.info("AI configuration updated from the dashboard");
  return getAiConfigSnapshot();
}
