import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { VoiceRuntimeConfig } from "./cartesia";
import { logger } from "./logger";

// Streaming text-to-speech over Cartesia's WebSocket API (v2026 protocol).
//
// Protocol notes (verified against docs + live probes):
// - Every input message is a FULL request: model_id, voice, output_format,
//   context_id, transcript, continue — no "type" field. Fields except
//   transcript/continue must stay identical for the whole context.
// - Managed buffering: with max_buffer_delay_ms > 0 the API buffers incoming
//   tokens itself and starts generating once it has enough context or the
//   delay elapses — so LLM tokens can be streamed straight in.
// - Barge-in: send { context_id, cancel: true } (soft cancel) and close.

const CARTESIA_WS_URL = "wss://api.cartesia.ai/tts/websocket";
// How long Cartesia buffers incoming LLM tokens before generating audio.
// 300ms keeps latency low while still batching enough text for natural
// phrasing; 600ms felt sluggish on voice calls.
const BUFFER_DELAY_MS = 300;
const TOKEN_FLUSH_MS = 120;
const CONNECT_TIMEOUT_MS = 15_000;

export interface CartesiaStreamHandlers {
  onAudio: (pcm: Buffer) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export class CartesiaStream {
  private ws: WebSocket | null = null;
  private readonly contextId = randomUUID();
  private pending = "";
  private pendingFinal = false;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly cfg: VoiceRuntimeConfig,
    private readonly handlers: CartesiaStreamHandlers,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Cartesia WebSocket connect timed out"));
        this.close();
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(CARTESIA_WS_URL, {
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Cartesia-Version": "2026-03-01",
        },
      });
      this.ws = ws;

      ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
        // Flush anything buffered while the socket was still connecting
        // (the LLM can outrun the TTS connect). Without this the buffered
        // tokens — including the final tail from finish() — would be lost.
        if (this.pending.length > 0) {
          const chunk = this.pending;
          const final = this.pendingFinal;
          this.pending = "";
          this.pendingFinal = false;
          this.sendInput(chunk, !final);
        }
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof msg.message === "string") {
          this.handlers.onError(new Error(msg.message));
          return;
        }
        if (msg.type === "chunk" && typeof msg.data === "string") {
          this.handlers.onAudio(Buffer.from(msg.data, "base64"));
          return;
        }
        if (msg.done === true) {
          this.handlers.onDone();
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        if (!this.closed) this.handlers.onError(err);
      });

      ws.on("close", () => clearTimeout(timeout));
    });
  }

  feed(text: string): void {
    if (this.closed) return;
    this.pending += text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending.length === 0) return;
      const chunk = this.pending;
      this.pending = "";
      this.sendInput(chunk, true);
    }, TOKEN_FLUSH_MS);
  }

  finish(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tail = this.pending;
    this.pending = "";
    // Empty transcript + continue:false is the documented way to end a
    // context whose final input is unknown (e.g. tool-only rounds).
    this.sendInput(tail, false);
  }

  cancel(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch {
        /* ignore */
      }
      setTimeout(() => this.close(), 150);
    } else {
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private sendInput(transcript: string, cont: boolean): void {
    if (this.closed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pending = transcript + this.pending;
      if (!cont) this.pendingFinal = true;
      return;
    }
    this.ws.send(
      JSON.stringify({
        model_id: this.cfg.model,
        voice: { mode: "id", id: this.cfg.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: 24000,
        },
        context_id: this.contextId,
        transcript,
        continue: cont,
        max_buffer_delay_ms: BUFFER_DELAY_MS,
      }),
    );
  }
}
