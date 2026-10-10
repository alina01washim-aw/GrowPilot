import { customFetch } from "./custom-fetch";

export interface VoiceHealth {
  configured: boolean;
  voiceId: string | null;
  model: string | null;
}

export interface VoiceConfig {
  voiceId: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
  updatedAt: string | null;
}

export interface VoiceConfigInput {
  /** Omitted → keep current; empty string → clear the key. */
  apiKey?: string;
  voiceId?: string;
  model?: string;
}

export interface TtsResult {
  audio: string;
  format: "wav";
}

export function getVoiceHealth(): Promise<VoiceHealth> {
  return customFetch<VoiceHealth>("/api/voice/health");
}

export function getVoiceConfig(): Promise<VoiceConfig> {
  return customFetch<VoiceConfig>("/api/voice/config");
}

export function updateVoiceConfig(input: VoiceConfigInput): Promise<VoiceConfig> {
  return customFetch<VoiceConfig>("/api/voice/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function textToSpeech(text: string): Promise<TtsResult> {
  return customFetch<TtsResult>("/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}