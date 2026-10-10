import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Send, X, Trash2, Sparkles, ShieldAlert, Square, Check, Loader2, Hammer, Mic, ImagePlus, Volume2, VolumeX, Phone, PhoneOff } from "lucide-react";
import { getAiHealth, openAiChatSession, getVoiceHealth, textToSpeech, type AiStreamEvent } from "@/lib/api";
import { openVoiceSession, type VoiceChatMessage, type VoiceStreamEvent } from "@/lib/voice-session";
import { PcmPlayer } from "@/lib/pcm-player";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { deviceLabel } from "@/lib/device-registry";

// Legacy `mycocontrol:` prefix kept deliberately — see lib/auth-token.ts.
// Renaming these would discard existing chat history and the TTS preference.
const HISTORY_KEY = "mycocontrol:ai-history";
const HISTORY_LIMIT = 40;
const TTS_KEY = "mycocontrol:tts-enabled";
const MAX_IMAGE_DIM = 1024;
// Pause after the last spoken word before auto-sending (cuts Chrome's
// default 2-5s silence wait down to under a second).
const END_OF_SPEECH_MS = 850;

interface ToolStatus {
  name: string;
  status: "start" | "done" | "error";
  detail?: string;
}

interface ChatMsg {
  id: number;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  tools?: ToolStatus[];
  image?: string;
}

function loadHistory(): Array<{ role: "user" | "assistant"; content: string }> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is { role: "user" | "assistant"; content: string } => {
        if (!m || typeof m !== "object") return false;
        const msg = m as Partial<{ role: string; content: string }>;
        return (
          (msg.role === "user" || msg.role === "assistant") &&
          typeof msg.content === "string"
        );
      })
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMsg[]) {
  try {
    const plain = messages
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-HISTORY_LIMIT);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(plain));
  } catch {
    /* storage unavailable — ignore */
  }
}

// `prompt` is a function so device names are resolved when the button is
// clicked, not at module load — the grower may have renamed the mister.
const QUICK_ACTIONS: Array<{ label: string; prompt: () => string }> = [
  {
    label: "Analyze farm",
    prompt: () =>
      "Analyze the current farm situation using the latest sensor data. Tell me what is good and what needs attention, then give specific recommendations for temperature, humidity, CO2 and VPD.",
  },
  {
    label: "Show rules",
    prompt: () =>
      "List all current automation rules and explain what each one does in simple language.",
  },
  {
    label: "Misting rule",
    prompt: () =>
      `Create an automation rule: IF humidity < 85 THEN turn ON ${deviceLabel("mist_maker")}, STOP when humidity >= 95 and release ${deviceLabel("mist_maker")}. Minimum ON 30 seconds, cooldown 10 seconds. Name it 'Humidity target (misting)'.`,
  },
];

// Invalidates everything the AI may have changed so the dashboard stays in sync.
const AI_TOUCHED_QUERY_KEYS: unknown[][] = [
  ["rules"],
  ["device-controls"],
  ["system", "status"],
  ["readings"],
];

const TOOL_LABELS: Record<string, string> = {
  get_situation: "Farm data read",
  get_readings_history: "History analyzed",
  create_rule: "Rule created",
  update_rule: "Rule updated",
  delete_rule: "Rule deleted",
  set_device_mode: "Device mode set",
  set_device_state: "Device toggled",
  emergency_stop: "EMERGENCY STOP",
  resume_automation: "Automation resumed",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}

export function AiAssistant() {
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>(() =>
    loadHistory().map((m, i) => ({ id: i, ...m })),
  );
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const inputRef = useRef("");
  const micStopRef = useRef(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [callLang, setCallLang] = useState("en-IN");
  const [ttsEnabled, setTtsEnabled] = useState(() => {
    try {
      return localStorage.getItem(TTS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1000);
  const sessionRef = useRef<ReturnType<typeof openAiChatSession> | null>(null);
  const voiceSessionRef = useRef<ReturnType<typeof openVoiceSession> | null>(null);
  const voicePlayerRef = useRef<PcmPlayer | null>(null);
  const voiceTurnRef = useRef(false);
  const voiceBargeArmedRef = useRef(false);
  const voiceAudioReceivedRef = useRef(false);
  const voiceRecoveryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamingIdRef = useRef<number | null>(null);
  const replyRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recogRef = useRef<{ start: () => void; stop: () => void; markDead?: () => void } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const handlerRef = useRef<((event: AiStreamEvent) => void) | null>(null);
  const voiceHandlerRef = useRef<((event: VoiceStreamEvent) => void) | null>(null);
  const ttsRef = useRef(ttsEnabled);
  const voiceReadyRef = useRef(false);
  const callActiveRef = useRef(false);
  const callStatusRef = useRef<"idle" | "listening" | "thinking" | "speaking">("idle");
  const callLangRef = useRef(callLang);
  const callEpochRef = useRef(0);
  const prevTtsRef = useRef(false);
  ttsRef.current = ttsEnabled;
  handlerRef.current = handleAiEvent;
  voiceHandlerRef.current = handleVoiceEvent;

  const { data: health, isFetching: healthLoading } = useQuery({
    queryKey: ["ai", "health"],
    queryFn: getAiHealth,
    staleTime: 60_000,
  });

  const { data: voiceHealth } = useQuery({
    queryKey: ["voice", "health"],
    queryFn: getVoiceHealth,
    staleTime: 60_000,
  });

  const isStreaming = messages.some((m) => m.streaming);
  const configured = health?.configured;
  const voiceReady = voiceHealth?.configured ?? false;
  voiceReadyRef.current = voiceReady;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  useEffect(() => {
    if (!token) return;
    // (Re)create the chat session whenever the auth token changes. The socket
    // callback is routed through a ref so it always sees the latest state.
    sessionRef.current?.close();
    sessionRef.current = openAiChatSession({
      token,
      onEvent: (event) => handlerRef.current?.(event),
    });
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
      const wasCalling = callActiveRef.current;
      callEpochRef.current += 1;
      callActiveRef.current = false;
      setCallActive(false);
      callStatusRef.current = "idle";
      setCallStatus("idle");
      recogRef.current?.markDead?.();
      recogRef.current?.stop();
      recogRef.current = null;
      stopAudio();
      voiceSessionRef.current?.interrupt();
      voiceSessionRef.current?.close();
      voiceSessionRef.current = null;
      voicePlayerRef.current?.stop();
      voicePlayerRef.current = null;
      voiceTurnRef.current = false;
      voiceAudioReceivedRef.current = false;
      disarmVoiceRecovery();
      if (wasCalling) setTts(prevTtsRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function setTts(v: boolean) {
    setTtsEnabled(v);
    try {
      localStorage.setItem(TTS_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!v) stopAudio();
  }

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }

  function speak(text: string, onEnd?: () => void, onStart?: () => void) {
    const clean = text
      .replace(/[*_`#>|~]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    if (!ttsRef.current || !voiceReadyRef.current || clean.length === 0) {
      onEnd?.();
      return;
    }
    textToSpeech(clean)
      .then(({ audio }) => {
        stopAudio();
        const player = new Audio(`data:audio/wav;base64,${audio}`);
        audioRef.current = player;
        player.onended = () => {
          audioRef.current = null;
          onEnd?.();
        };
        player
          .play()
          .then(() => onStart?.())
          .catch(() => {
            audioRef.current = null;
            onEnd?.();
          });
      })
      .catch((err) => {
        toast({
          title: "Voice playback failed",
          description: err instanceof Error ? err.message : "Could not synthesize speech.",
          variant: "destructive",
        });
        onEnd?.();
      });
  }

  // ─── Voice input (browser SpeechRecognition) ─────────────────────────────
  function getRecognition(): { start: () => void; stop: () => void } | null {
    const w = window as unknown as {
      SpeechRecognition?: new () => { start: () => void; stop: () => void };
      webkitSpeechRecognition?: new () => { start: () => void; stop: () => void };
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
  }

  function toggleMic() {
    if (listening) {
      micStopRef.current = true;
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const recog = getRecognition();
    if (!recog) {
      toast({
        title: "Voice input unavailable",
        description: "Your browser doesn't support speech recognition. Try Chrome or Edge.",
        variant: "destructive",
      });
      return;
    }
    const r = recog as unknown as {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    r.lang = callLangRef.current;
    r.continuous = false;
    r.interimResults = true;
    let transcript = "";
    let interimText = "";
    let lastResultAt = Date.now();
    let dead = false;
    // Chrome only finalizes speech after seconds of silence; cut the wait by
    // stopping ourselves ~850ms after the last spoken word, then auto-send.
    const idleTimer = setInterval(() => {
      if (dead) {
        clearInterval(idleTimer);
        return;
      }
      if (interimText.length > 0 && Date.now() - lastResultAt >= END_OF_SPEECH_MS) {
        clearInterval(idleTimer);
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }
    }, 120);
    r.onresult = (e) => {
      lastResultAt = Date.now();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        for (let j = 0; j < res.length; j++) {
          if (res.isFinal) transcript += res[j].transcript;
          else interim += res[j].transcript;
        }
      }
      if (interim.length > 0) interimText = interim;
      inputRef.current = transcript;
      setInput(transcript + interim);
    };
    r.onend = () => {
      clearInterval(idleTimer);
      setListening(false);
      if (dead) return;
      if (micStopRef.current) {
        micStopRef.current = false;
        return;
      }
      const text = (transcript || interimText).trim();
      transcript = "";
      interimText = "";
      inputRef.current = "";
      if (text.length > 0) {
        send(text);
      }
    };
    r.onerror = () => {
      clearInterval(idleTimer);
      setListening(false);
      micStopRef.current = false;
    };
    recogRef.current = {
      start: () => r.start(),
      stop: () => r.stop(),
      markDead: () => {
        dead = true;
      },
    };
    try {
      r.start();
      setListening(true);
    } catch {
      clearInterval(idleTimer);
      setListening(false);
      recogRef.current = null;
    }
  }

  // ─── Live voice call (hands-free loop) ────────────────────────────────────
  // Call mode = speak → transcript auto-sends → AI streams a reply → Cartesia
  // speaks it aloud → mic re-arms. The AI can still run tools (rules, devices,
  // emergency stop) exactly like typed chat.

  function startCall() {
    if (!voiceReadyRef.current) {
      toast({
        title: "Voice not configured",
        description: "Add a Cartesia API key in Settings → AI (Voice section) to start a voice call.",
        variant: "destructive",
      });
      return;
    }
    if (callActiveRef.current) return;
    if (!token) return;
    prevTtsRef.current = ttsRef.current;
    setTts(true);
    callEpochRef.current += 1;
    callActiveRef.current = true;
    setCallActive(true);
    callStatusRef.current = "listening";
    setCallStatus("listening");

    const player = new PcmPlayer();
    player.onDrained = () => {
      if (!callActiveRef.current) return;
      // Only move to listening when the LLM turn has also finished — queue
      // gaps between sentence chunks must not end the speaking phase.
      if (callStatusRef.current === "speaking" && !voiceTurnRef.current) {
        goListening();
      }
    };
    voicePlayerRef.current?.stop();
    voicePlayerRef.current = player;

    voiceSessionRef.current?.close();
    voiceSessionRef.current = openVoiceSession({
      token,
      onEvent: (event) => voiceHandlerRef.current?.(event),
    });
    voiceTurnRef.current = false;
    startCallRecognition();
  }

  // Safety net for the hands-free loop: if a turn never completes (dropped
  // WebSocket, silent TTS failure, empty reply with no audio), force the call
  // back to listening instead of leaving it stuck in "thinking"/"speaking".
  function armVoiceRecovery(delayMs: number) {
    disarmVoiceRecovery();
    voiceRecoveryRef.current = setTimeout(() => {
      voiceRecoveryRef.current = null;
      if (!callActiveRef.current) return;
      if (callStatusRef.current !== "thinking" && callStatusRef.current !== "speaking") {
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamingIdRef.current
            ? {
                ...m,
                streaming: false,
                content:
                  m.content.length > 0
                    ? `${m.content}\n\n_⚠️ voice reply lost — try again_`
                    : "_⚠️ voice reply lost — try again_",
              }
            : m,
        ),
      );
      streamingIdRef.current = null;
      replyRef.current = "";
      voiceTurnRef.current = false;
      voicePlayerRef.current?.stop();
      goListening();
    }, delayMs);
  }

  function disarmVoiceRecovery() {
    if (voiceRecoveryRef.current) {
      clearTimeout(voiceRecoveryRef.current);
      voiceRecoveryRef.current = null;
    }
  }

  function goListening() {
    if (!callActiveRef.current) return;
    callStatusRef.current = "listening";
    setCallStatus("listening");
    voiceTurnRef.current = false;
    voiceBargeArmedRef.current = false;
    const old = recogRef.current;
    if (old) {
      // The old instance may be a barge-in listener that Chrome silently
      // killed during playback (it never fired onend). Trusting it here is
      // what wedged the call after a few turns — kill it and start fresh.
      old.markDead?.();
      old.stop();
      recogRef.current = null;
      setTimeout(() => {
        if (!callActiveRef.current) return;
        if (callStatusRef.current !== "listening") return;
        if (recogRef.current) return;
        startCallRecognition();
      }, 300);
      return;
    }
    startCallRecognition();
  }

  function endCall() {
    callEpochRef.current += 1;
    callActiveRef.current = false;
    setCallActive(false);
    callStatusRef.current = "idle";
    setCallStatus("idle");
    recogRef.current?.markDead?.();
    recogRef.current?.stop();
    recogRef.current = null;
    stopAudio();
    voiceSessionRef.current?.interrupt();
    voiceSessionRef.current?.close();
    voiceSessionRef.current = null;
    voicePlayerRef.current?.stop();
    voicePlayerRef.current = null;
    voiceTurnRef.current = false;
    voiceBargeArmedRef.current = false;
    voiceAudioReceivedRef.current = false;
    disarmVoiceRecovery();
    if (isStreaming) cancel();
    setTts(prevTtsRef.current);
  }

  function changeCallLang(lang: string) {
    setCallLang(lang);
    callLangRef.current = lang;
    if (callActiveRef.current && callStatusRef.current === "listening") {
      recogRef.current?.stop();
    }
  }

  function startCallRecognition(bargeIn = false) {
    if (!callActiveRef.current) return;
    if (bargeIn) {
      if (callStatusRef.current !== "speaking") return;
    } else {
      if (callStatusRef.current !== "listening") return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => {
        start: () => void;
        stop: () => void;
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: ((e: {
          resultIndex: number;
          results: ArrayLike<
            ArrayLike<{ transcript: string }> & { isFinal: boolean }
          >;
        }) => void) | null;
        onend: (() => void) | null;
        onerror: ((e: { error: string }) => void) | null;
      };
      webkitSpeechRecognition?: new () => {
        start: () => void;
        stop: () => void;
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: ((e: {
          resultIndex: number;
          results: ArrayLike<
            ArrayLike<{ transcript: string }> & { isFinal: boolean }
          >;
        }) => void) | null;
        onend: (() => void) | null;
        onerror: ((e: { error: string }) => void) | null;
      };
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      toast({
        title: "Voice input unavailable",
        description: "Your browser doesn't support speech recognition. Try Chrome or Edge.",
        variant: "destructive",
      });
      endCall();
      return;
    }

    const epoch = callEpochRef.current;
    // Chrome can silently fail start() while audio is still playing — the old
    // instance never fires onend/onerror, so kill it explicitly before arming
    // a fresh one. Otherwise goListening() sees a dead recogRef and the call
    // sticks forever after a few turns.
    if (recogRef.current) {
      recogRef.current.markDead?.();
      recogRef.current.stop();
      recogRef.current = null;
    }
    const r = new Ctor();
    let dead = false;
    let finalText = "";
    let interimText = "";
    let lastResultAt = Date.now();
    r.lang = callLangRef.current;
    // continuous=false ends recognition shortly after the user pauses, firing
    // onend → the transcript auto-sends. With continuous=true Chrome never
    // fires onend on silence, which left the transcript stuck in the input box.
    r.continuous = false;
    r.interimResults = true;

    // Chrome's own end-of-speech takes 2-5s of silence. Stop ourselves ~850ms
    // after the last spoken word and send immediately — this is the single
    // biggest latency win for voice commands.
    const idleTimer = setInterval(() => {
      if (dead || epoch !== callEpochRef.current) {
        clearInterval(idleTimer);
        return;
      }
      if (interimText.length > 0 && Date.now() - lastResultAt >= END_OF_SPEECH_MS) {
        clearInterval(idleTimer);
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }
    }, 120);

    // Chrome silently fails a fresh start() if it happens right after the
    // previous session ended ("aborted"/no events). Delay every re-arm so the
    // hands-free loop keeps working across turns.
    const rearm = (delay = 400, barge = false) => {
      setTimeout(() => {
        if (dead || epoch !== callEpochRef.current) return;
        if (!callActiveRef.current) return;
        if (barge) {
          if (callStatusRef.current !== "speaking" || !voiceTurnRef.current) return;
          voiceBargeArmedRef.current = false;
          startCallRecognition(true);
        } else {
          if (callStatusRef.current !== "listening") return;
          startCallRecognition();
        }
      }, delay);
    };

    r.onresult = (e) => {
      if (dead) return;
      lastResultAt = Date.now();
      let interimAdded = "";
      let finalAdded = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        for (let j = 0; j < res.length; j++) {
          if (res.isFinal) finalAdded += res[j].transcript;
          else interimAdded += res[j].transcript;
        }
      }
      if (finalAdded.length > 0) {
        finalText += finalAdded;
        inputRef.current = finalText;
        setInput(finalText);
      }
      if (interimAdded.length > 0) interimText = interimAdded;
      // Minimum length guard: background noise / the AI's own voice often
      // yields 1-char interims — don't kill the reply for those.
      if (
        bargeIn &&
        ((interimAdded.trim().length >= 2 || finalAdded.trim().length > 0))
      ) {
        // The user started talking over the reply: kill the server turn
        // (LLM + TTS) and cut local playback instantly, then keep capturing
        // the rest of what they say.
        voiceSessionRef.current?.interrupt();
        voicePlayerRef.current?.stop();
        callStatusRef.current = "listening";
        setCallStatus("listening");
      }
    };

    r.onend = () => {
      clearInterval(idleTimer);
      if (dead || epoch !== callEpochRef.current) return;
      recogRef.current = null;
      if (!callActiveRef.current) return;
      if (callStatusRef.current !== "listening" && callStatusRef.current !== "speaking") return;
      const text = (finalText || interimText).trim();
      finalText = "";
      interimText = "";
      inputRef.current = "";
      if (text.length > 0) {
        send(text);
      } else if (callStatusRef.current === "listening") {
        rearm();
      } else if (callStatusRef.current === "speaking" && voiceTurnRef.current) {
        // No speech detected during playback (no-speech timeout) — keep the
        // barge-in listener alive across long replies.
        rearm(700, true);
      }
    };

    r.onerror = (e) => {
      if (dead || epoch !== callEpochRef.current) return;
      if (e.error === "no-speech" || e.error === "aborted" || e.error === "audio-capture") {
        return; // onend decides whether to re-arm
      }
      toast({
        title: "Voice call mic error",
        description:
          e.error === "not-allowed"
            ? "Microphone permission denied. Allow mic access and try again."
            : `Speech recognition failed (${e.error}).`,
        variant: "destructive",
      });
      endCall();
    };

    recogRef.current = {
      start: () => r.start(),
      stop: () => r.stop(),
      markDead: () => {
        dead = true;
      },
    };
    try {
      r.start();
    } catch {
      // Transient failure (e.g. mic still releasing after audio playback).
      // Retry instead of silently ending the call.
      clearInterval(idleTimer);
      recogRef.current = null;
      rearm(600);
    }
  }

  // ─── Image attach (downscaled to keep the payload small) ─────────────────
  function pickImage(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Not an image", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setPendingImage(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => toast({ title: "Could not read image", variant: "destructive" });
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function handleAiEvent(event: AiStreamEvent) {
    const id = streamingIdRef.current;
    if (id === null) return;

    switch (event.type) {
      case "chunk":
        replyRef.current += event.text;
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + event.text } : m)),
        );
        break;
      case "tool":
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id || !m.tools) return m;
            if (event.status === "start") {
              return { ...m, tools: [...m.tools, { name: event.name, status: "start" }] };
            }
            const tools = m.tools.map((t, i) =>
              t.name === event.name && i === m.tools!.length - 1
                ? { ...t, status: event.status, detail: event.detail }
                : t,
            );
            return { ...m, tools };
          }),
        );
        break;
      case "done":
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
        );
        if (event.actions.length > 0) {
          for (const key of AI_TOUCHED_QUERY_KEYS) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        }
        // A typed reply that finishes during a voice call must not hijack the
        // call's own state machine (no speak() — the call uses its own TTS).
        if (!callActiveRef.current) {
          speak(
            replyRef.current,
            () => {
              if (!callActiveRef.current) return;
              if (recogRef.current) return;
              callStatusRef.current = "listening";
              setCallStatus("listening");
              startCallRecognition();
            },
            () => {
              if (callActiveRef.current && callStatusRef.current === "speaking") {
                startCallRecognition(true);
              }
            },
          );
        }
        replyRef.current = "";
        streamingIdRef.current = null;
        break;
      case "error":
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id) return m;
            const text =
              event.error === "cancelled"
                ? m.content.length > 0
                  ? `${m.content}\n\n_⏹ stopped_`
                  : "_⏹ stopped_"
                : `${m.content}${m.content.length > 0 ? "\n\n" : ""}⚠️ ${event.error}`;
            return { ...m, content: text, streaming: false };
          }),
        );
        if (!callActiveRef.current) {
          callStatusRef.current = "listening";
          setCallStatus("listening");
          startCallRecognition();
        }
        replyRef.current = "";
        streamingIdRef.current = null;
        break;
    }
  }

  if (!token) return null;

  // ─── Voice call channel events ───────────────────────────────────────────
  // The voice call runs over its own WebSocket: text tokens stream in while
  // audio chunks are already playing (zero-latency), and "interrupted" tells
  // us the server cut a turn mid-way so the partial reply stays in context.
  function handleVoiceEvent(event: VoiceStreamEvent) {
    const id = streamingIdRef.current;
    if (id === null) return;

    switch (event.type) {
      case "start":
        break;
      case "text":
        replyRef.current = event.data;
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: event.data } : m)),
        );
        break;
      case "audio":
        voiceAudioReceivedRef.current = true;
        disarmVoiceRecovery();
        if (callStatusRef.current === "thinking") {
          callStatusRef.current = "speaking";
          setCallStatus("speaking");
        }
        if (callActiveRef.current && !voiceBargeArmedRef.current) {
          voiceBargeArmedRef.current = true;
          startCallRecognition(true);
        }
        voicePlayerRef.current?.pushBase64(event.data);
        break;
      case "tool":
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id || !m.tools) return m;
            if (event.status === "start") {
              return { ...m, tools: [...m.tools, { name: event.name, status: "start" }] };
            }
            const tools = m.tools.map((t, i) =>
              t.name === event.name && i === m.tools!.length - 1
                ? { ...t, status: event.status, detail: event.detail }
                : t,
            );
            return { ...m, tools };
          }),
        );
        break;
      case "done":
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
        );
        if (event.actions.length > 0) {
          for (const key of AI_TOUCHED_QUERY_KEYS) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        }
        voiceTurnRef.current = false;
        // The LLM finished but no audio chunks arrived yet. Audio can still
        // stream in for a few seconds (TTS completes after the text), so give
        // it a grace window; if nothing ever plays, recover to listening.
        if (!voiceAudioReceivedRef.current) {
          armVoiceRecovery(8_000);
        }
        break;
      case "end":
        // All audio for the turn has been sent; playback finishes from the
        // queue, then onDrained moves the call back to listening. If nothing
        // was actually playing (empty reply, dropped audio), recover now so
        // the call never stays stuck at "Speaking…".
        disarmVoiceRecovery();
        voiceTurnRef.current = false;
        streamingIdRef.current = null;
        replyRef.current = "";
        if (callActiveRef.current && !voicePlayerRef.current?.isPlaying()) {
          goListening();
        }
        break;
      case "interrupted":
        disarmVoiceRecovery();
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id) return m;
            const text =
              m.content.length > 0 ? `${m.content}\n\n_⏹ stopped_` : "_⏹ stopped_";
            return { ...m, content: text, streaming: false };
          }),
        );
        streamingIdRef.current = null;
        replyRef.current = "";
        voiceTurnRef.current = false;
        if (callActiveRef.current) goListening();
        break;
      case "cleared":
        disarmVoiceRecovery();
        break;
      case "error":
        disarmVoiceRecovery();
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id) return m;
            const text = `${m.content}${m.content.length > 0 ? "\n\n" : ""}⚠️ ${event.error}`;
            return { ...m, content: text, streaming: false };
          }),
        );
        streamingIdRef.current = null;
        replyRef.current = "";
        voiceTurnRef.current = false;
        if (callActiveRef.current) goListening();
        break;
    }
  }

  function send(text: string) {
    const content = text.trim();
    // During a call the server barge-in kills any active turn before starting
    // this one, so rapid utterances must never be blocked by isStreaming.
    if ((!content && !pendingImage) || (isStreaming && !callActiveRef.current)) return;
    if (callActiveRef.current) {
      // Voice call path: the server barge-in kills any active turn before
      // starting this one, so a rapid second utterance must never be dropped.
      callStatusRef.current = "thinking";
      setCallStatus("thinking");
      recogRef.current?.markDead?.();
      recogRef.current?.stop();
      recogRef.current = null;
      setInput("");
      inputRef.current = "";

      const userMsg: ChatMsg = { id: ++idRef.current, role: "user", content };
      const assistantMsg: ChatMsg = {
        id: ++idRef.current,
        role: "assistant",
        content: "",
        streaming: true,
        tools: [],
      };
      const next = [...messages, userMsg, assistantMsg];
      setMessages(next);
      saveHistory(next);
      streamingIdRef.current = assistantMsg.id;
      replyRef.current = "";
      voiceTurnRef.current = true;
      voiceBargeArmedRef.current = false;

      const history: VoiceChatMessage[] = next
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => m.content.trim().length > 0)
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));

      voiceAudioReceivedRef.current = false;
      armVoiceRecovery(45_000);
      voiceSessionRef.current?.send(content, history);
      return;
    }
    setInput("");
    inputRef.current = "";
    const image = pendingImage;
    setPendingImage(null);

    const userMsg: ChatMsg = { id: ++idRef.current, role: "user", content, image: image ?? undefined };
    const assistantMsg: ChatMsg = {
      id: ++idRef.current,
      role: "assistant",
      content: "",
      streaming: true,
      tools: [],
    };
    const next = [...messages, userMsg, assistantMsg];
    setMessages(next);
    saveHistory(next);
    streamingIdRef.current = assistantMsg.id;
    replyRef.current = "";

    const history = next
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          (m.content.trim().length > 0 || Boolean(m.image)),
      )
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content, ...(m.image ? { image: m.image } : {}) }));

    sessionRef.current?.send(history);
  }

  function cancel() {
    if (callActiveRef.current) {
      voiceSessionRef.current?.interrupt();
      return;
    }
    sessionRef.current?.cancel();
  }

  function clearChat() {
    if (isStreaming) cancel();
    setMessages([]);
    saveHistory([]);
    streamingIdRef.current = null;
    if (callActiveRef.current) voiceSessionRef.current?.clear();
  }

  return (
    <>
      {/* Floating toggle button */}
      <button
        type="button"
        aria-label={open ? "Close Farm Assistant" : "Open Farm Assistant"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-5 right-5 z-[60] grid h-14 w-14 place-items-center rounded-full shadow-xl transition-all",
          "bg-gradient-to-br from-primary to-indigo-600 text-primary-foreground hover:scale-105 active:scale-95",
          open && "rotate-90",
        )}
      >
        {open ? <X className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
        {!open && !configured && !healthLoading && (
          <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-background bg-amber-500" />
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-[5.5rem] right-5 z-[60] flex h-[min(34rem,72vh)] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-card-border bg-card/95 shadow-2xl backdrop-blur">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border/50 bg-gradient-to-r from-primary/10 to-indigo-500/10 px-3.5 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-primary to-indigo-600 text-primary-foreground">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold uppercase tracking-widest">
                Farm Assistant
              </p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {healthLoading
                  ? "checking…"
                  : configured
                    ? `model: ${health?.model ?? "?"} · streaming`
                    : "AI not configured"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {isStreaming && (
                <button
                  type="button"
                  onClick={cancel}
                  title="Stop response"
                  className="flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[10px] uppercase text-destructive hover:bg-destructive/10"
                >
                  <Square className="h-3 w-3 fill-current" /> Stop
                </button>
              )}
              <button
                type="button"
                onClick={callActive ? endCall : startCall}
                title={
                  callActive
                    ? "End voice call"
                    : "Start live voice call — speak, the AI replies aloud and can take action"
                }
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md transition-colors",
                  callActive
                    ? "animate-pulse bg-destructive text-destructive-foreground"
                    : "text-primary hover:bg-primary/10",
                )}
              >
                {callActive ? <PhoneOff className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setTts(!ttsEnabled)}
                disabled={!voiceReady}
                title={
                  voiceReady
                    ? ttsEnabled
                      ? "Spoken replies ON — click to mute"
                      : "Spoken replies OFF — click to enable"
                    : "Add a Cartesia key in Settings → AI to enable spoken replies"
                }
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md",
                  ttsEnabled
                    ? "text-primary hover:bg-primary/10"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  !voiceReady && "cursor-not-allowed opacity-40",
                )}
              >
                {ttsEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={clearChat}
                title="Clear chat"
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Call status banner */}
          {callActive && (
            <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3.5 py-2">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  callStatus === "listening" && "animate-pulse bg-emerald-500",
                  callStatus === "thinking" && "animate-pulse bg-amber-500",
                  callStatus === "speaking" && "animate-pulse bg-primary",
                )}
              />
              <span className="truncate font-mono text-[10px] font-medium">
                {callStatus === "listening"
                  ? "Listening — speak now"
                  : callStatus === "thinking"
                    ? "Thinking…"
                    : "Speaking…"}
              </span>
              <select
                value={callLang}
                onChange={(e) => changeCallLang(e.target.value)}
                title="Voice language"
                className="ml-auto h-6 shrink-0 rounded-md border border-input bg-background px-1 font-mono text-[9px] outline-none focus:border-primary"
              >
                <option value="en-US">EN-US</option>
                <option value="en-IN">EN-IN</option>
                <option value="hi-IN">हिन्दी</option>
              </select>
            </div>
          )}

          {/* Not-configured notice */}
          {!healthLoading && !configured && (
            <div className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3.5 py-2">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <p className="font-mono text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
                AI is not configured. Add your API key in Settings → AI to enable
                the assistant. Any OpenAI-compatible provider works.
              </p>
            </div>
          )}

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3">
            {messages.length === 0 && (
              <div className="space-y-2 rounded-xl border border-dashed border-card-border p-3 text-center">
                <Sparkles className="mx-auto h-5 w-5 text-primary" />
                <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                  Mushroom farm specialist. Ask anything — analyze the farm, create an
                  automation rule, or understand a problem. Replies stream live, and the
                  AI can take action in the app for you. Tap the phone button for a
                  hands-free voice call.
                </p>
                <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                  {QUICK_ACTIONS.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => send(a.prompt())}
                      className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className="space-y-1">
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 font-mono text-[11px] leading-relaxed",
                    m.role === "user"
                      ? "ml-auto rounded-br-sm bg-primary text-primary-foreground"
                      : "mr-auto rounded-bl-sm border border-card-border bg-muted/60",
                  )}
                >
                  {m.image && (
                    <img
                      src={m.image}
                      alt="Attached"
                      className="mb-1.5 max-h-40 w-full rounded-lg object-cover"
                    />
                  )}
                  {m.content}
                  {m.streaming && (
                    <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-current align-middle" />
                  )}
                  {m.streaming && m.content.length === 0 && (
                    <TypingDots />
                  )}
                </div>

                {m.tools && m.tools.length > 0 && (
                  <div className="mr-auto flex max-w-[85%] flex-wrap gap-1">
                    {m.tools.map((t, i) => (
                      <span
                        key={i}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px]",
                          t.status === "start" &&
                            "border-primary/40 bg-primary/10 text-primary",
                          t.status === "done" &&
                            "border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]",
                          t.status === "error" &&
                            "border-destructive/40 bg-destructive/10 text-destructive",
                        )}
                        title={t.detail}
                      >
                        {t.status === "start" ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : t.status === "done" ? (
                          <Check className="h-2.5 w-2.5" />
                        ) : (
                          <Hammer className="h-2.5 w-2.5" />
                        )}
                        {toolLabel(t.name)}
                        {t.status === "error" && " ✕"}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="border-t border-border/50 p-2.5">
            {pendingImage && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5">
                <img
                  src={pendingImage}
                  alt="Attached preview"
                  className="h-9 w-9 shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                  Image attached — the AI will analyze it
                </span>
                <button
                  type="button"
                  onClick={() => setPendingImage(null)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickImage(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach image"
                title="Attach a photo (mushroom, substrate, contamination…) — needs a vision-capable model"
                onClick={() => fileRef.current?.click()}
                disabled={isStreaming || callActive}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-input bg-background text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                <ImagePlus className="h-4 w-4" />
              </button>
              {!callActive && (
                <>
                  <select
                    value={callLang}
                    onChange={(e) => changeCallLang(e.target.value)}
                    title="Voice command language"
                    aria-label="Voice command language"
                    className="h-9 w-12 shrink-0 rounded-lg border border-input bg-background px-1 text-center font-mono text-[10px] outline-none focus:border-primary"
                  >
                    <option value="en-US">EN</option>
                    <option value="en-IN">EN-IN</option>
                    <option value="hi-IN">हि</option>
                  </select>
                  <button
                    type="button"
                    aria-label={listening ? "Stop listening" : "Voice command"}
                    title={
                      listening
                        ? "Listening… click to stop"
                        : "Speak a command — sent automatically (Chrome/Edge, transcribed locally)"
                    }
                    onClick={toggleMic}
                    disabled={isStreaming}
                    className={cn(
                      "grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors disabled:opacity-40",
                      listening
                        ? "animate-pulse border-destructive bg-destructive/15 text-destructive"
                        : "border-input bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                </>
              )}
              <input
                className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary"
                placeholder={
                  listening
                    ? "Listening… speak now"
                    : "Type or speak… (Enter to send)"
                }
                value={input}
                disabled={isStreaming}
                onChange={(e) => {
                  setInput(e.target.value);
                  inputRef.current = e.target.value;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send(input);
                }}
              />
              <button
                type="button"
                aria-label="Send message"
                onClick={() => send(input)}
                disabled={isStreaming || (input.trim().length === 0 && !pendingImage)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1.5 px-1 font-mono text-[9px] text-muted-foreground/70">
              Live streaming · tools let the AI take action (rules, devices) — every
              action appears as a status chip below the reply.
              {callActive
                ? " Voice call on — speak, pause, the AI replies aloud."
                : voiceReady && ttsEnabled && " Spoken replies on."}
            </p>
          </div>
        </div>
      )}
    </>
  );
}