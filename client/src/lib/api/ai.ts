import { customFetch } from "./custom-fetch";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type AiProviderId = "openai" | "gemini" | "opencode" | "custom";

export interface AiProviderOption {
  id: Exclude<AiProviderId, "custom">;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
}

// Mirrors server/src/lib/aiConfig.ts — keep in sync when adding presets.
export const AI_PROVIDER_OPTIONS: AiProviderOption[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o3-mini"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  {
    id: "opencode",
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
];

export interface AiHealth {
  configured: boolean;
  model: string | null;
}

export interface AiConfig {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
  updatedAt: string | null;
}

export interface AiConfigInput {
  provider?: AiProviderId;
  baseUrl?: string;
  model?: string;
  /** Omitted → keep current; empty string → clear the key. */
  apiKey?: string;
}

export interface AiChatResponse {
  reply: string;
  actions: string[];
}

/** Events streamed from the server over the WebSocket. */
export type AiStreamEvent =
  | { type: "start" }
  | { type: "chunk"; text: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "done"; actions: string[] }
  | { type: "error"; error: string };

export function getAiHealth(): Promise<AiHealth> {
  return customFetch<AiHealth>("/api/ai/health");
}

export function getAiConfig(): Promise<AiConfig> {
  return customFetch<AiConfig>("/api/ai/config");
}

export function updateAiConfig(input: AiConfigInput): Promise<AiConfig> {
  return customFetch<AiConfig>("/api/ai/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function sendAiChat(messages: AiChatMessage[]): Promise<AiChatResponse> {
  return customFetch<AiChatResponse>("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

// ─── WebSocket chat client ───────────────────────────────────────────────────
// One persistent socket is shared by the whole app. If it drops mid-chat the
// pending request fails with a clear error and the next send reconnects.

let socket: WebSocket | null = null;
let socketToken = "";
let socketHandler: ((event: AiStreamEvent) => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let reconnectWhenIdle = false;
let pendingOnOpen: AiChatMessage[] | null = null;

function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/ai?token=${encodeURIComponent(token)}`;
}

function deliver(event: AiStreamEvent): void {
  socketHandler?.(event);
}

function closeSocket(): void {
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
}

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;

  try {
    socket = new WebSocket(wsUrl(socketToken));
  } catch {
    deliver({ type: "error", error: "WebSocket not supported in this browser" });
    return;
  }

  socket.onopen = () => {
    reconnectAttempts = 0;
    if (pendingOnOpen && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "chat", messages: pendingOnOpen }));
      pendingOnOpen = null;
    }
  };

  socket.onmessage = (ev) => {
    let event: AiStreamEvent;
    try {
      event = JSON.parse(String(ev.data)) as AiStreamEvent;
    } catch {
      return;
    }
    deliver(event);
  };

  socket.onerror = () => {
    // onclose fires right after; error is reported there.
  };

  socket.onclose = () => {
    pendingOnOpen = null;
    socket = null;
    if (reconnectWhenIdle) {
      // Keep trying in the background so the next send works immediately.
      const delay = Math.min(10_000, 1_000 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (reconnectWhenIdle) connect();
      }, delay);
    }
  };
}

export interface AiChatSession {
  send: (messages: AiChatMessage[]) => void;
  cancel: () => void;
  close: () => void;
}

export function openAiChatSession(opts: {
  token: string;
  onEvent: (event: AiStreamEvent) => void;
}): AiChatSession {
  const wasClosed = !socket || socket.readyState === WebSocket.CLOSED;
  socketToken = opts.token;
  socketHandler = opts.onEvent;
  reconnectWhenIdle = true;

  if (wasClosed) {
    closeSocket();
    connect();
  }

  return {
    send: (messages) => {
      if (!socket) {
        deliver({ type: "error", error: "AI connection lost — reconnecting…" });
        return;
      }
      if (socket.readyState === WebSocket.CONNECTING) {
        pendingOnOpen = messages;
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        deliver({ type: "error", error: "AI connection lost — reconnecting…" });
        return;
      }
      socket.send(JSON.stringify({ type: "chat", messages }));
    },
    cancel: () => {
      pendingOnOpen = null;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel" }));
      }
    },
    close: () => {
      reconnectWhenIdle = false;
      socketHandler = null;
      closeSocket();
    },
  };
}