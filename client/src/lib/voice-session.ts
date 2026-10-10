// Live voice call WebSocket client. Carries LLM text, TTS audio chunks and
// interrupt signals on one socket; auto-reconnects with backoff and re-sends
// a pending utterance after reconnect.

export type VoiceStreamEvent =
  | { type: "start" }
  | { type: "text"; data: string }
  | { type: "audio"; data: string; rate: number }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "done"; actions: string[] }
  | { type: "end" }
  | { type: "interrupted" }
  | { type: "cleared" }
  | { type: "error"; error: string };

export interface VoiceChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface VoiceSession {
  send: (text: string, history?: VoiceChatMessage[]) => void;
  interrupt: () => void;
  clear: () => void;
  close: () => void;
}

export function openVoiceSession(opts: {
  token: string;
  onEvent: (event: VoiceStreamEvent) => void;
}): VoiceSession {
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { text: string; history?: VoiceChatMessage[] } | null = null;

  function wsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/ws/voice?token=${encodeURIComponent(opts.token)}`;
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
      if (pending && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "chat", text: pending.text, history: pending.history }),
        );
        pending = null;
      }
    };

    socket.onmessage = (ev) => {
      let event: VoiceStreamEvent;
      try {
        event = JSON.parse(String(ev.data)) as VoiceStreamEvent;
      } catch {
        return;
      }
      opts.onEvent(event);
    };

    socket.onerror = () => {
      // onclose fires right after; reconnect is handled there.
    };

    socket.onclose = () => {
      socket = null;
      if (!closed) scheduleReconnect();
    };
  }

  return {
    send: (text, history) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        pending = { text, history };
        connect();
        return;
      }
      socket.send(JSON.stringify({ type: "chat", text, history }));
    },
    interrupt: () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "interrupt" }));
      }
    },
    clear: () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "clear" }));
      }
    },
    close: () => {
      closed = true;
      pending = null;
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