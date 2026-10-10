import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./auth";
import { isAiConfigured, parseChatMessages, runAiChatStream, type AiEvent } from "./ai";
import { logger } from "./logger";

const WS_PATH = "/api/ws/ai";
const PING_INTERVAL_MS = 30_000;

interface ActiveRun {
  abort: () => void;
}

/**
 * Attaches an authenticated WebSocket endpoint for the AI chat.
 *
 * The browser cannot set headers on WebSocket connections, so the JWT is
 * passed as a query parameter (?token=...) and verified here before the
 * upgrade is accepted.
 *
 * Protocol (client → server):
 *   { "type": "chat", "messages": [{ role, content }, ...] }
 *   { "type": "cancel" }
 * Protocol (server → client): JSON-serialized AiEvent messages:
 *   start / chunk / tool / done / error
 */
export function attachAiSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }

    // Only handle our path; anything else is not ours to upgrade.
    if (url.pathname !== WS_PATH) return;

    const token = url.searchParams.get("token") ?? "";
    try {
      verifyToken(token);
    } catch {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    let run: ActiveRun | null = null;

    ws.on("message", async (raw) => {
      let msg: { type?: string; messages?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        send(ws, { type: "error", error: "Invalid JSON message" });
        return;
      }

      if (msg.type === "chat") {
        if (run) {
          send(ws, { type: "error", error: "Another request is already running" });
          return;
        }
        if (!(await isAiConfigured())) {
          send(ws, {
            type: "error",
            error:
              "AI is not configured. Add an API key in Settings → AI, or set AI_API_KEY in the server .env file.",
          });
          return;
        }

        const parsed = parseChatMessages({ messages: msg.messages });
        if (!parsed.ok) {
          send(ws, { type: "error", error: parsed.error });
          return;
        }

        const controller = new AbortController();
        run = { abort: () => controller.abort() };

        void runAiChatStream(parsed.messages, (event) => send(ws, event), controller.signal)
          .catch((err) => {
            logger.error({ err }, "AI chat stream failed");
            send(ws, {
              type: "error",
              error: err instanceof Error ? err.message : "AI request failed",
            });
          })
          .finally(() => {
            run = null;
          });
        return;
      }

      if (msg.type === "cancel") {
        run?.abort();
        return;
      }

      send(ws, { type: "error", error: `Unknown message type: ${String(msg.type)}` });
    });

    ws.on("close", () => {
      run?.abort();
      run = null;
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

function send(ws: WebSocket, event: AiEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}