import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth";
import { executeTool, SYSTEM_PROMPT, TOOLS } from "./ai";
import { assertGeminiSafe, toGeminiFunctionDeclarations } from "./geminiSchema";
import { getRealtimeConfig } from "./realtimeConfig";
import { logger } from "./logger";

/**
 * Realtime voice call: browser ⇄ this server ⇄ Gemini Live API.
 *
 * Why proxy instead of connecting the browser straight to Google: the API key
 * would have to ship to the client. Same reason `cartesia.ts` never exposed its
 * key. The browser only ever talks to us.
 *
 * Why speech-to-speech at all, rather than fixing the old path: the previous
 * implementation drove turn-taking from browser `SpeechRecognition`, which emits
 * transcripts but never a speech-*onset* signal, cannot run continuously (Chrome
 * fails rapid restarts, forcing 400-700 ms windows where the mic was deaf), and
 * self-triggered on the assistant's own voice — so barge-in needed a
 * "ignore anything under 2 characters" guard that also swallowed the words people
 * actually interrupt with. Live API does voice-activity detection server-side, so
 * interruption is a first-class signal instead of something we infer.
 *
 * Protocol, client → server:
 *   { type: "audio", data }        base64 PCM16 mono @16 kHz
 *   { type: "text", text }         typed message mid-call
 *   { type: "interrupt" }          explicit barge-in (local VAD beat the server)
 * Protocol, server → client:
 *   ready | audio | transcript | tool | interrupted | turnComplete | error | closed
 *
 * Audio formats are fixed by the API: 16 kHz PCM16 in, 24 kHz PCM16 out. The
 * output rate is exactly what `PcmPlayer` already runs at, so playback is reused.
 */

const WS_PATH = "/api/ws/realtime";
const PING_INTERVAL_MS = 30_000;

const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Extra instruction layered on the shared SYSTEM_PROMPT.
 *
 * The base prompt already covers brevity, Hinglish mirroring and the no-markdown
 * rule. What it cannot know is that in a speech-to-speech session the model owns
 * its own audio: there is no TTS stage downstream to sanitise text, and the user
 * can cut in at any instant.
 */
const REALTIME_INSTRUCTION = `You are on a live voice call. The person can interrupt you at any moment, and you will hear them immediately.

- Speak like a person on the phone, not like a document being read out. Short turns. One idea, then stop and let them talk.
- If they cut in, abandon what you were saying completely. Do not finish the sentence, do not summarise what you were about to say, just deal with what they just asked.
- Before a tool call that will take a moment, say something brief and natural first ("ek second", "dekh raha hoon") so the line is never silent while you work.
- Never speak punctuation, markdown, asterisks or stage directions. Everything you emit is heard aloud.
- Match their language exactly, including Hinglish code-switching mid-sentence. If they mix Hindi and English, mix it back the same way.`;

interface UpstreamState {
  socket: WebSocket;
  ready: boolean;
  /** Frames captured before setupComplete, replayed once the session opens. */
  backlog: string[];
}

export function attachRealtimeSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) return;

    try {
      verifyToken(url.searchParams.get("token") ?? "");
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (client) => {
    (client as WebSocket & { isAlive?: boolean }).isAlive = true;
    client.on("pong", () => {
      (client as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    let upstream: UpstreamState | null = null;
    let closing = false;

    void openUpstream();

    async function openUpstream(): Promise<void> {
      const cfg = await getRealtimeConfig();
      if (cfg.apiKey.length === 0) {
        send(client, {
          type: "error",
          error:
            "Voice calls need a Gemini API key. Add one in Settings → AI (get it free at aistudio.google.com).",
          fatal: true,
        });
        client.close();
        return;
      }

      const ws = new WebSocket(`${GEMINI_WS_BASE}?key=${encodeURIComponent(cfg.apiKey)}`);
      const state: UpstreamState = { socket: ws, ready: false, backlog: [] };
      upstream = state;

      ws.on("open", () => {
        // Validate before sending: a schema the Live API dislikes closes the
        // socket with no useful detail, so catch it here where the offending
        // tool can be named.
        let functionDeclarations;
        try {
          functionDeclarations = toGeminiFunctionDeclarations(TOOLS);
          assertGeminiSafe(functionDeclarations);
        } catch (err) {
          logger.error({ err }, "Tool schemas are not Live API compatible");
          send(client, {
            type: "error",
            error: err instanceof Error ? err.message : "Tool schema conversion failed",
            fatal: true,
          });
          ws.close();
          client.close();
          return;
        }

        // `models/` prefix is required here even though the config stores the
        // bare id, which is what the Settings field and the docs both use.
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${cfg.model}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } },
                },
              },
              systemInstruction: {
                parts: [{ text: `${SYSTEM_PROMPT}\n\n${REALTIME_INSTRUCTION}` }],
              },
              tools: [{ functionDeclarations }],
              // Transcripts of both sides, so the on-screen conversation still
              // works in an audio-only session.
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        handleUpstreamMessage(state, msg);
      });

      ws.on("error", (err: Error) => {
        logger.error({ err }, "Realtime upstream socket error");
        send(client, { type: "error", error: describeUpstreamError(err, cfg.model) });
      });

      ws.on("close", (code, reason) => {
        if (closing) return;
        const detail = reason.toString() || `code ${code}`;
        logger.warn({ code, detail }, "Realtime upstream closed");
        send(client, { type: "closed", reason: detail });
        client.close();
      });
    }

    function handleUpstreamMessage(state: UpstreamState, msg: Record<string, unknown>): void {
      if (msg.setupComplete !== undefined) {
        state.ready = true;
        for (const frame of state.backlog) state.socket.send(frame);
        state.backlog = [];
        send(client, { type: "ready" });
        return;
      }

      const serverContent = msg.serverContent as Record<string, unknown> | undefined;
      if (serverContent) {
        // Interruption first: the user is already talking, so stopping playback
        // matters more than anything else in this message.
        if (serverContent.interrupted === true) {
          send(client, { type: "interrupted" });
        }

        const inputTranscription = serverContent.inputAudioTranscription as
          | { text?: string }
          | undefined;
        if (inputTranscription?.text) {
          send(client, { type: "transcript", role: "user", text: inputTranscription.text });
        }

        const outputTranscription = serverContent.outputAudioTranscription as
          | { text?: string }
          | undefined;
        if (outputTranscription?.text) {
          send(client, {
            type: "transcript",
            role: "assistant",
            text: outputTranscription.text,
          });
        }

        const modelTurn = serverContent.modelTurn as
          | { parts?: Array<Record<string, unknown>> }
          | undefined;
        for (const part of modelTurn?.parts ?? []) {
          const inline = part.inlineData as { data?: string; mimeType?: string } | undefined;
          if (inline?.data) {
            send(client, { type: "audio", data: inline.data, rate: 24_000 });
          }
          // A native-audio model occasionally emits text alongside audio; pass it
          // through as assistant transcript rather than dropping it.
          if (typeof part.text === "string" && part.text.length > 0) {
            send(client, { type: "transcript", role: "assistant", text: part.text });
          }
        }

        if (serverContent.turnComplete === true) {
          send(client, { type: "turnComplete" });
        }
        return;
      }

      const toolCall = msg.toolCall as
        | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
        | undefined;
      if (toolCall?.functionCalls?.length) {
        void runToolCalls(state, toolCall.functionCalls);
        return;
      }

      // Sent shortly before the server drops a long session. Surface it so the
      // client can reconnect deliberately instead of appearing to freeze.
      if (msg.goAway !== undefined) {
        send(client, { type: "closed", reason: "session-expiring" });
      }
    }

    async function runToolCalls(
      state: UpstreamState,
      calls: Array<{ id?: string; name?: string; args?: unknown }>,
    ): Promise<void> {
      const responses: Array<Record<string, unknown>> = [];

      for (const call of calls) {
        const name = call.name ?? "";
        if (!name) continue;

        send(client, { type: "tool", name, status: "start" });
        // executeTool takes a JSON string because the OpenAI path streams tool
        // arguments as text; Live API hands us a parsed object, so re-encode.
        const result = await executeTool(name, JSON.stringify(call.args ?? {}));

        send(client, {
          type: "tool",
          name,
          status: result.ok ? "done" : "error",
          detail: result.ok ? undefined : result.error,
        });

        responses.push({
          id: call.id,
          name,
          // Errors go back as data, not as a transport failure: the model should
          // explain the problem to the user, not silently stall.
          response: result.ok ? { output: result.data } : { error: result.error },
        });
      }

      if (responses.length > 0 && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
    }

    client.on("message", (raw) => {
      let msg: { type?: string; data?: unknown; text?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }

      const state = upstream;
      if (!state) return;

      if (msg.type === "audio" && typeof msg.data === "string") {
        // The mime type carries the sample rate; the API relies on it rather
        // than sniffing the stream.
        const frame = JSON.stringify({
          realtimeInput: {
            audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
          },
        });
        if (!state.ready) {
          // Hold a short backlog so speech during connection setup is not lost.
          // Bounded, because an unbounded buffer on a stalled upstream is a leak.
          if (state.backlog.length < 100) state.backlog.push(frame);
          return;
        }
        if (state.socket.readyState === WebSocket.OPEN) state.socket.send(frame);
        return;
      }

      if (msg.type === "text" && typeof msg.text === "string" && msg.text.trim()) {
        if (state.socket.readyState !== WebSocket.OPEN) return;
        state.socket.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: msg.text.trim() }] }],
              turnComplete: true,
            },
          }),
        );
        return;
      }

      if (msg.type === "interrupt") {
        // The local onset detector fired before the server's VAD. Playback is
        // already stopped client-side; telling the server keeps the two in step
        // rather than letting it finish generating into a muted stream.
        if (state.socket.readyState === WebSocket.OPEN) {
          state.socket.send(
            JSON.stringify({ realtimeInput: { activityStart: {} } }),
          );
        }
      }
    });

    client.on("close", () => {
      closing = true;
      if (upstream && upstream.socket.readyState <= WebSocket.OPEN) {
        upstream.socket.close();
      }
      upstream = null;
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!(ws as WebSocket & { isAlive?: boolean }).isAlive) {
        ws.terminate();
        continue;
      }
      (ws as WebSocket & { isAlive?: boolean }).isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();
}

/**
 * Upstream failures are usually one of three things, and the raw message is
 * rarely actionable. A wrong model id is the single most likely cause because the
 * Live API renames preview models often.
 */
function describeUpstreamError(err: Error, model: string): string {
  const text = err.message.toLowerCase();
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized")) {
    return "Gemini rejected the API key. Check it in Settings → AI.";
  }
  if (text.includes("404") || text.includes("not found") || text.includes("model")) {
    return `Gemini did not recognise the model "${model}". Live API model names change often — try another in Settings → AI.`;
  }
  return `Voice connection failed: ${err.message}`;
}

function send(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}
