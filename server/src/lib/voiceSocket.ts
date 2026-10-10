import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth";
import { runAiChatStream, type AiChatMessage } from "./ai";
import { getVoiceConfig } from "./cartesia";
import { CartesiaStream } from "./cartesia-stream";
import { logger } from "./logger";

/**
 * Authenticated WebSocket endpoint for the live voice call channel.
 *
 * Zero-latency path: the LLM token stream is fed straight into a Cartesia
 * WebSocket; PCM audio chunks are relayed to the browser as they arrive —
 * never block-and-wait for the full reply.
 *
 * Protocol (client → server):
 *   { "type": "chat", "text": string, "history"?: [{ role, content }] }
 *   { "type": "interrupt" }   — kill the current turn (LLM + TTS + queues)
 *   { "type": "clear" }       — reset conversation context
 * Protocol (server → client):
 *   start / text (partial reply) / audio (base64 PCM) / tool / done / end /
 *   interrupted / cleared / error
 *
 * Context is never dropped: both the user message and whatever partial
 * assistant text was produced (even when cut mid-turn) are pushed to the
 * per-connection history, and the client may re-sync it on reconnect.
 */

const WS_PATH = "/api/ws/voice";
const PING_INTERVAL_MS = 30_000;
const MAX_HISTORY = 20;
const END_FALLBACK_MS = 10_000;

interface VoiceTurn {
  epoch: number;
  controller: AbortController;
  stream: CartesiaStream;
  partial: string;
  saved: boolean;
  endTimer: NodeJS.Timeout | null;
}

interface VoiceMessage {
  type?: string;
  text?: unknown;
  history?: unknown;
}

export function attachVoiceSocket(server: Server): void {
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

    const token = url.searchParams.get("token") ?? "";
    try {
      verifyToken(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    let history: AiChatMessage[] = [];
    let turn: VoiceTurn | null = null;
    let epoch = 0;

    function stopTurn(t: VoiceTurn): void {
      if (t.endTimer) clearTimeout(t.endTimer);
      t.controller.abort();
      t.stream.cancel();
      if (!t.saved && t.partial.trim().length > 0) {
        history.push({ role: "assistant", content: t.partial.trim() });
      }
      t.saved = true;
    }

    function savePartial(t: VoiceTurn): void {
      if (!t.saved && t.partial.trim().length > 0) {
        history.push({ role: "assistant", content: t.partial.trim() });
      }
      t.saved = true;
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    }

    ws.on("message", async (raw) => {
      let msg: VoiceMessage;
      try {
        msg = JSON.parse(raw.toString()) as VoiceMessage;
      } catch {
        send(ws, { type: "error", error: "Invalid JSON message" });
        return;
      }

      try {
        await handleVoiceMessage(msg);
      } catch (err) {
        if (turn) stopTurn(turn);
        turn = null;
        logger.error({ err }, "Voice message handling failed");
        send(ws, {
          type: "error",
          error: err instanceof Error ? err.message : "Voice request failed",
        });
      }
    });

    async function handleVoiceMessage(msg: VoiceMessage): Promise<void> {
      if (msg.type === "interrupt") {
        if (turn) stopTurn(turn);
        turn = null;
        send(ws, { type: "interrupted" });
        return;
      }

      if (msg.type === "clear") {
        if (turn) stopTurn(turn);
        turn = null;
        history = [];
        send(ws, { type: "cleared" });
        return;
      }

      if (msg.type !== "chat") {
        send(ws, { type: "error", error: `Unknown message type: ${String(msg.type)}` });
        return;
      }

      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) {
        send(ws, { type: "error", error: "chat text is required" });
        return;
      }

      // Barge-in: a new utterance while the old turn is alive kills it first.
      if (turn) stopTurn(turn);
      turn = null;

      // Client re-syncs the full conversation every turn (reconnects too) —
      // treat it as authoritative. Both roles are kept so the LLM remembers
      // what it already said. The client history already ends with this
      // utterance, so only append it when it isn't there yet.
      if (Array.isArray(msg.history)) {
        const clean = msg.history
          .filter(
            (m): m is { role: "user" | "assistant"; content: string } =>
              typeof m === "object" &&
              m !== null &&
              ((m as { role?: unknown }).role === "user" ||
                (m as { role?: unknown }).role === "assistant") &&
              typeof (m as { content?: unknown }).content === "string",
          )
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-MAX_HISTORY);
        const last = clean[clean.length - 1];
        const alreadyHasUtterance =
          last !== undefined && last.role === "user" && last.content === text;
        history = alreadyHasUtterance
          ? clean
          : [...clean, { role: "user", content: text }];
      } else {
        history.push({ role: "user", content: text });
      }

      // Safety net: collapse consecutive duplicate user messages (e.g. a
      // re-sync racing with a barge-in push) so the model isn't confused.
      const deduped: AiChatMessage[] = [];
      for (const m of history) {
        const prev = deduped[deduped.length - 1];
        if (m.role === "user" && prev?.role === "user" && prev.content === m.content) {
          continue;
        }
        deduped.push(m);
      }
      history = deduped.slice(-MAX_HISTORY);

      const cfg = await getVoiceConfig();
      if (cfg.apiKey.length === 0) {
        send(ws, {
          type: "error",
          error: "Voice is not configured. Add a Cartesia API key in Settings → AI.",
        });
        return;
      }

      const controller = new AbortController();
      const myEpoch = ++epoch;
      let t: VoiceTurn | null = null;
      const stream = new CartesiaStream(cfg, {
        onAudio: (pcm) => {
          if (turn === active) {
            send(ws, { type: "audio", data: pcm.toString("base64"), rate: 24000 });
          }
        },
        onDone: () => {
          if (turn === active) {
            if (active.endTimer) clearTimeout(active.endTimer);
            turn = null;
            send(ws, { type: "end" });
          }
        },
        onError: (err) => {
          if (turn === active) {
            stopTurn(active);
            turn = null;
            logger.error({ err }, "Voice TTS stream failed");
            send(ws, { type: "error", error: err.message });
          }
        },
      });

      t = { epoch: myEpoch, controller, stream, partial: "", saved: false, endTimer: null };
      turn = t;
      const active = t;

      void stream.connect().catch((err: Error) => {
        if (turn === active) {
          stopTurn(active);
          turn = null;
          send(ws, { type: "error", error: err.message });
        }
      });

      try {
        await runAiChatStream(
          history,
          (event) => {
            if (turn !== active) return;
            switch (event.type) {
              case "start":
                send(ws, { type: "start" });
                break;
              case "chunk":
                active.partial += event.text;
                stream.feed(event.text);
                send(ws, { type: "text", data: active.partial });
                break;
              case "tool":
                send(ws, {
                  type: "tool",
                  name: event.name,
                  status: event.status,
                  detail: event.detail,
                });
                break;
              case "done":
                savePartial(active);
                send(ws, { type: "done", actions: event.actions });
                stream.finish();
                active.endTimer = setTimeout(() => {
                  if (turn === active) {
                    turn = null;
                    send(ws, { type: "end" });
                  }
                }, END_FALLBACK_MS);
                break;
              case "error":
                if (event.error === "cancelled") {
                  savePartial(active);
                  stopTurn(active);
                  turn = null;
                  send(ws, { type: "interrupted" });
                } else {
                  savePartial(active);
                  stopTurn(active);
                  turn = null;
                  send(ws, { type: "error", error: event.error });
                }
                break;
            }
          },
          controller.signal,
          // Voice replies are spoken aloud: keep them short and plain so the
          // turn completes fast and the user isn't left waiting on a monologue.
          "The user is speaking to you over a voice call. Reply in plain text with 1-3 short spoken sentences. No markdown, no bullet lists, no code blocks — speak like you are talking to a farmer on the phone. Keep it brief and direct.",
        );
      } catch (err) {
        if (turn === active) {
          stopTurn(active);
          turn = null;
          logger.error({ err }, "Voice chat stream failed");
          send(ws, {
            type: "error",
            error: err instanceof Error ? err.message : "AI request failed",
          });
        }
      }
    }

    ws.on("close", () => {
      if (turn) stopTurn(turn);
      turn = null;
    });
  });

  // Heartbeat: terminate connections that stop answering pings (killed tabs,
  // dead networks) so sockets don't leak over time.
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

  wss.on("connection", (ws) => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
  });

  heartbeat.unref();
}

function send(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}
