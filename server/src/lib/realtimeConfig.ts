import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger";

/**
 * Realtime (speech-to-speech) voice configuration.
 *
 * The live voice call talks to Gemini's Live API over a WebSocket: audio in,
 * audio out, with server-side voice-activity detection doing the turn-taking.
 * That VAD is the whole point — it is what lets the user interrupt mid-sentence,
 * which the old browser-SpeechRecognition path could not do.
 *
 * Same shape as `cartesia.ts`: defaults from .env, runtime overrides persisted
 * to data/realtime-config.json so the Settings page can change them without a
 * restart. The API key never leaves the server — the browser only exchanges
 * audio with our own WebSocket, which proxies upstream.
 *
 * NOTE ON THE MODEL ID: the Live API is a preview surface and Google renames
 * these fairly often. The default below is the one to check first if the socket
 * closes immediately with a model error — it is overridable from Settings → AI
 * precisely so a rename is a config change, not a deploy. Native-audio variants
 * (…-native-audio-…) sound noticeably warmer and support affective dialog, but
 * their IDs churn the most, so the more stable half-cascade model is the default.
 */

export interface RealtimeRuntimeConfig {
  apiKey: string;
  model: string;
  voice: string;
}

export interface RealtimeConfigSnapshot {
  model: string;
  voice: string;
  hasKey: boolean;
  configured: boolean;
  updatedAt: string | null;
}

export const DEFAULT_REALTIME_MODEL = "gemini-2.0-flash-live-001";

/** Prebuilt Live API voices, shown as a picker in Settings. */
export const REALTIME_VOICES = [
  "Aoede",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Zephyr",
] as const;

export const DEFAULT_REALTIME_VOICE = "Aoede";

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "realtime-config.json");

interface PersistedConfig {
  apiKey?: string;
  model?: string;
  voice?: string;
  updatedAt?: string;
}

/**
 * Strip prefixes people paste by accident ("Bearer …", "key=…") and whitespace.
 * A malformed key makes the upstream socket close with an opaque 1008, which is
 * a miserable thing to debug.
 */
function normalizeApiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^key\s*=\s*/i, "")
    .trim();
}

function defaults(): RealtimeRuntimeConfig {
  return {
    // GEMINI_API_KEY is the name Google's own docs and SDKs use; accept the
    // generic name too so this is not surprising either way.
    apiKey: process.env.GEMINI_API_KEY ?? process.env.REALTIME_API_KEY ?? "",
    model: process.env.REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL,
    voice: process.env.REALTIME_VOICE ?? DEFAULT_REALTIME_VOICE,
  };
}

// Re-read per call (no cache): the file is tiny, and edits made from the
// dashboard must take effect on the next call without a restart.
async function loadPersisted(): Promise<PersistedConfig> {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")) as PersistedConfig;
  } catch {
    return {};
  }
}

async function savePersisted(next: PersistedConfig): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

export async function getRealtimeConfig(): Promise<RealtimeRuntimeConfig> {
  const p = await loadPersisted();
  const d = defaults();
  return {
    apiKey: normalizeApiKey(p.apiKey !== undefined ? p.apiKey : d.apiKey),
    model: (p.model ?? d.model).trim() || DEFAULT_REALTIME_MODEL,
    voice: (p.voice ?? d.voice).trim() || DEFAULT_REALTIME_VOICE,
  };
}

export async function isRealtimeConfigured(): Promise<boolean> {
  const cfg = await getRealtimeConfig();
  return cfg.apiKey.length > 0;
}

export async function getRealtimeConfigSnapshot(): Promise<RealtimeConfigSnapshot> {
  const cfg = await getRealtimeConfig();
  const p = await loadPersisted();
  return {
    model: cfg.model,
    voice: cfg.voice,
    hasKey: cfg.apiKey.length > 0,
    configured: cfg.apiKey.length > 0,
    updatedAt: p.updatedAt ?? null,
  };
}

/**
 * Apply runtime overrides.
 * - `apiKey` omitted → keep current; "" → clear (voice calls disabled)
 * - `model` / `voice` empty string → back to defaults
 */
export async function updateRealtimeConfig(input: {
  apiKey?: string;
  model?: string;
  voice?: string;
}): Promise<RealtimeConfigSnapshot> {
  const p = await loadPersisted();
  const next: PersistedConfig = { ...p };

  if (input.apiKey !== undefined) {
    next.apiKey = normalizeApiKey(input.apiKey);
  }
  if (input.model !== undefined) {
    const model = input.model.trim();
    next.model = model.length > 0 ? model : undefined;
  }
  if (input.voice !== undefined) {
    const voice = input.voice.trim();
    next.voice = voice.length > 0 ? voice : undefined;
  }
  next.updatedAt = new Date().toISOString();

  await savePersisted(next);
  logger.info("Realtime voice configuration updated from the dashboard");
  return getRealtimeConfigSnapshot();
}
