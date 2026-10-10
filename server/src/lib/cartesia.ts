import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger";

// Cartesia voice configuration. Defaults come from the server .env file; the
// Settings page can override them at runtime. Overrides are persisted to
// data/voice-config.json so they survive restarts. The API key stays on the
// server — the browser only ever receives the audio it requests.

export interface VoiceRuntimeConfig {
  apiKey: string;
  voiceId: string;
  model: string;
}

export interface VoiceConfigSnapshot {
  voiceId: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
  updatedAt: string | null;
}

export const DEFAULT_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"; // Skylar — conversational Hinglish/English

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "voice-config.json");

interface PersistedConfig {
  apiKey?: string;
  voiceId?: string;
  model?: string;
  updatedAt?: string;
}

// Clean up keys that were pasted with accidental prefixes (e.g. "cartesia sk_…",
// "Bearer …") or stray whitespace. A malformed key makes Cartesia return 401.
function normalizeApiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^cartesia\s+/i, "")
    .replace(/^bearer\s+/i, "")
    .trim();
}

function defaults(): VoiceRuntimeConfig {
  return {
    apiKey: process.env.CARTESIA_API_KEY ?? "",
    voiceId: process.env.CARTESIA_VOICE_ID ?? DEFAULT_VOICE_ID,
    model: process.env.CARTESIA_MODEL ?? "sonic-3",
  };
}

// No in-memory cache: the file is small and re-read on every call, so edits
// made through the dashboard (or manually) take effect without a restart.
async function loadPersisted(): Promise<PersistedConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as PersistedConfig;
  } catch {
    return {};
  }
}

async function savePersisted(next: PersistedConfig): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

export async function getVoiceConfig(): Promise<VoiceRuntimeConfig> {
  const p = await loadPersisted();
  const d = defaults();
  return {
    apiKey: normalizeApiKey(p.apiKey !== undefined ? p.apiKey : d.apiKey),
    voiceId: (p.voiceId ?? d.voiceId).trim() || DEFAULT_VOICE_ID,
    model: p.model ?? d.model,
  };
}

export async function getVoiceConfigSnapshot(): Promise<VoiceConfigSnapshot> {
  const cfg = await getVoiceConfig();
  const p = await loadPersisted();
  return {
    voiceId: cfg.voiceId,
    model: cfg.model,
    hasKey: cfg.apiKey.length > 0,
    configured: cfg.apiKey.length > 0,
    updatedAt: p.updatedAt ?? null,
  };
}

/**
 * Apply runtime overrides.
 * - `apiKey` omitted → keep current; "" → clear (voice disabled)
 * - `voiceId` / `model` empty string → back to defaults
 */
export async function updateVoiceConfig(input: {
  apiKey?: string;
  voiceId?: string;
  model?: string;
}): Promise<VoiceConfigSnapshot> {
  const p = await loadPersisted();
  const next: PersistedConfig = { ...p };

  if (input.apiKey !== undefined) {
    next.apiKey = normalizeApiKey(input.apiKey);
  }
  if (input.voiceId !== undefined) {
    const v = input.voiceId.trim();
    next.voiceId = v.length > 0 ? v : undefined;
  }
  if (input.model !== undefined) {
    const m = input.model.trim();
    next.model = m.length > 0 ? m : undefined;
  }
  next.updatedAt = new Date().toISOString();

  await savePersisted(next);
  logger.info("Voice (Cartesia) configuration updated from the dashboard");
  return getVoiceConfigSnapshot();
}

/**
 * Synthesize speech with Cartesia. Returns base64-encoded WAV audio.
 */
export async function textToSpeechBase64(text: string): Promise<string> {
  const cfg = await getVoiceConfig();
  if (cfg.apiKey.length === 0) {
    throw new Error("Voice is not configured. Add a Cartesia API key in Settings → AI.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        "Cartesia-Version": "2026-03-01",
      },
      body: JSON.stringify({
        transcript: text,
        model_id: cfg.model,
        voice: { mode: "id", id: cfg.voiceId },
        output_format: {
          container: "wav",
          encoding: "pcm_s16le",
          sample_rate: 24000,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as {
          detail?: string | Array<{ msg?: string }>;
          message?: string;
        };
        detail = Array.isArray(body.detail)
          ? body.detail.map((d) => d.msg ?? "").join("; ")
          : (body.detail ?? body.message ?? "");
      } catch {
        /* ignore */
      }
      if (res.status === 401) {
        throw new Error("Cartesia API key is invalid (401). Check it in Settings → AI.");
      }
      throw new Error(`Cartesia error (${res.status}): ${detail || "see server logs"}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("Cartesia returned empty audio");
    return buf.toString("base64");
  } finally {
    clearTimeout(timeout);
  }
}
