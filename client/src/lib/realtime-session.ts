// Realtime voice call WebSocket client. Streams microphone frames up and
// receives audio, transcripts and tool events down. Reconnects with backoff,
// reusing the shape of the older `voice-session.ts`.

export type RealtimeEvent =
  | { type: "ready" }
  | { type: "audio"; data: string; rate: number }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "interrupted" }
  | { type: "turnComplete" }
  | { type: "closed"; reason: string }
  | { type: "error"; error: string; fatal?: boolean };

export interface RealtimeSession {
  /** Base64 PCM16 @16 kHz. Dropped silently while the socket is down. */
  sendAudio: (base64: string) => void;
  /** Typed message during a call. */
  sendText: (text: string) => void;
  /** Local speech onset beat the server's VAD — keep the two in step. */
  interrupt: () => void;
  close: () => void;
}

export function openRealtimeSession(opts: {
  token: string;
  onEvent: (event: RealtimeEvent) => void;
}): RealtimeSession {
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function wsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/ws/realtime?token=${encodeURIComponent(opts.token)}`;
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = Math.min(10_000, 1_000 * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      reconnectAttempts = 0;
    };

    socket.onmessage = (ev) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(String(ev.data)) as RealtimeEvent;
      } catch {
        return;
      }
      // A fatal error means reconnecting cannot help (no API key, bad tool
      // schema) — stop trying so the UI can show one clear message instead of a
      // reconnect loop.
      if (event.type === "error" && event.fatal) {
        closed = true;
      }
      opts.onEvent(event);
    };

    socket.onerror = () => {
      // onclose fires next; reconnect is handled there.
    };

    socket.onclose = () => {
      socket = null;
      if (!closed) scheduleReconnect();
    };
  }

  connect();

  const sendJson = (payload: Record<string, unknown>): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  return {
    // Audio frames are deliberately dropped rather than queued while the socket
    // is down: buffering live microphone input means replaying stale speech
    // seconds later, which is worse than a gap.
    sendAudio: (base64) => sendJson({ type: "audio", data: base64 }),
    sendText: (text) => sendJson({ type: "text", text }),
    interrupt: () => sendJson({ type: "interrupt" }),
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    },
  };
}
