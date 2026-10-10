import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from "./ruleControl";
import {
  listDeviceControls,
  setDeviceMode,
  setDeviceState,
} from "./deviceControl";
import { emergencyStopAll, resumeAutomation } from "./emergencyStop";
import {
  getCropCycleStatus,
  listBatches,
  advanceBatchStage,
  setBatchStage,
  startBatch,
} from "./cropCycle";
import { isAutomationPaused } from "./automationControl";
import { ReadingModel } from "../models/reading";
import { logger } from "./logger";
import { z } from "zod";

// ─── Configuration ───────────────────────────────────────────────────────────
// Runtime config (defaults from .env, overridable from the Settings page via
// lib/aiConfig.ts). Read per request so updates apply without a restart.

import { getAiConfig } from "./aiConfig";

export async function isAiConfigured(): Promise<boolean> {
  const cfg = await getAiConfig();
  return cfg.apiKey.length > 0;
}

export async function aiModelName(): Promise<string | null> {
  const cfg = await getAiConfig();
  return cfg.apiKey.length > 0 ? cfg.model : null;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "AI is not configured. Add an API key in Settings → AI, or set AI_API_KEY in the server .env file.",
    );
    this.name = "AiNotConfiguredError";
  }
}

// ─── Chat message types (OpenAI-compatible) ─────────────────────────────────

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | null
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/** Builds OpenAI-compatible content (plain text, or text + image for vision). */
function llmContent(msg: AiChatMessage): LlmMessage["content"] {
  if (msg.image) {
    return [
      { type: "text", text: msg.content },
      { type: "image_url", image_url: { url: msg.image } },
    ];
  }
  return msg.content;
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Optional base64 data-URL image attached to a user message (vision). */
  image?: string;
}

export interface AiResult {
  reply: string;
  actions: string[];
}

/** Events pushed to the caller as the AI run progresses (WebSocket protocol). */
export type AiEvent =
  | { type: "start" }
  | { type: "chunk"; text: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "done"; actions: string[] }
  | { type: "error"; error: string };

export type AiEventSink = (event: AiEvent) => void;

/** Validates a client-provided chat history. Shared by HTTP route + WebSocket. */
export function parseChatMessages(body: unknown):
  | { ok: true; messages: AiChatMessage[] }
  | { ok: false; error: string } {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid chat body" };
  }
  for (const m of parsed.data.messages) {
    if (m.content.trim().length === 0 && !m.image) {
      return { ok: false, error: "Each message needs text or an image" };
    }
  }
  return { ok: true, messages: parsed.data.messages };
}

const ChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().max(8000),
        image: z
          .string()
          .max(10_000_000)
          .refine((v) => v.startsWith("data:image/"), {
            message: "Image must be a data:image/… URL",
          })
          .optional(),
      }),
    )
    .min(1)
    .max(40),
});

// ─── Tools ───────────────────────────────────────────────────────────────────

const SENSOR_KEYS = ["air_temp", "humidity", "co2", "scd_temp", "scd_hum", "compost_temp"];
const RELAY_KEYS = ["fan", "ac", "mist_maker", "uv"];
const OPERATORS = [">", ">=", "<", "<=", "==", "!="];

const CONDITION_SCHEMA = {
  type: "object",
  properties: {
    sensor: { type: "string", enum: SENSOR_KEYS, description: "Sensor key to read" },
    operator: { type: "string", enum: OPERATORS },
    value: { type: "number", description: "Threshold value (temp °C, humidity %, co2 ppm)" },
  },
  required: ["sensor", "operator", "value"],
} as const;

const RELAY_LIST = { type: "array", items: { type: "string", enum: RELAY_KEYS } } as const;

export const TOOLS: Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> = [
  {
    type: "function",
    function: {
      name: "get_situation",
      description:
        "Get the CURRENT farm situation: latest sensor reading (temp, humidity, CO2, compost temp, VPD), relay/device states + AUTO/MANUAL mode, whether automation is paused, and the list of automation rules. Call this before giving advice or before changing anything.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_readings_history",
      description:
        "Get sensor history statistics (average/min/max over a time window) plus the most recent raw readings. Use for analyzing trends like temperature swings or humidity drops.",
      parameters: {
        type: "object",
        properties: {
          hours: {
            type: "number",
            description: "How many hours back to analyze (default 24, max 168)",
            minimum: 1,
            maximum: 168,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_rule",
      description:
        "Create an automation rule. IF block = conditions that turn devices ON, THEN = which relays turn ON/OFF together, STOP block = target conditions that release the group (turn OFF the Release relays). Provide all required fields. Use hysteresis: trigger threshold and stop threshold must differ (e.g. IF humidity < 85, STOP humidity >= 95).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short rule name, e.g. 'Humidity target (misting)'" },
          enabled: { type: "boolean", default: true },
          priority: { type: "number", description: "0-1000, lower = higher priority on conflict", default: 100 },
          profileIds: { type: "array", items: { type: "string" }, default: [] },
          triggerMode: { type: "string", enum: ["all", "any"], default: "all" },
          triggers: {
            type: "array",
            items: CONDITION_SCHEMA,
            minItems: 1,
            description: "IF conditions (need at least 1)",
          },
          actions: {
            type: "object",
            properties: {
              turnOn: { ...RELAY_LIST, description: "Relays to switch ON" },
              turnOff: { ...RELAY_LIST, description: "Relays to switch OFF (optional)" },
            },
            default: { turnOn: [], turnOff: [] },
          },
          cutoffMode: { type: "string", enum: ["all", "any"], default: "any" },
          cutoffs: {
            type: "array",
            items: CONDITION_SCHEMA,
            minItems: 1,
            description: "STOP conditions (need at least 1)",
          },
          offActions: {
            type: "object",
            properties: { turnOff: { ...RELAY_LIST, description: "Relays released (turned OFF) when STOP fires" } },
            default: { turnOff: [] },
          },
          minOnMs: { type: "number", description: "Minimum ON time in milliseconds", default: 0 },
          minOffMs: { type: "number", description: "Minimum OFF time in milliseconds", default: 0 },
          cooldownMs: { type: "number", description: "Cooldown between switches in milliseconds", default: 0 },
        },
        required: ["name", "triggers", "cutoffs"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_rule",
      description:
        "Update an existing automation rule. Pass only the fields to change. The rule id is required — get it from get_situation or list_rules.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Rule id" },
          name: { type: "string" },
          enabled: { type: "boolean" },
          priority: { type: "number" },
          triggerMode: { type: "string", enum: ["all", "any"] },
          triggers: { type: "array", items: CONDITION_SCHEMA, minItems: 1 },
          actions: {
            type: "object",
            properties: {
              turnOn: { ...RELAY_LIST },
              turnOff: { ...RELAY_LIST },
            },
          },
          cutoffMode: { type: "string", enum: ["all", "any"] },
          cutoffs: { type: "array", items: CONDITION_SCHEMA, minItems: 1 },
          offActions: {
            type: "object",
            properties: { turnOff: { ...RELAY_LIST } },
          },
          minOnMs: { type: "number" },
          minOffMs: { type: "number" },
          cooldownMs: { type: "number" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_rule",
      description: "Delete an automation rule permanently. Confirm with the user before deleting.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Rule id to delete" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_device_mode",
      description:
        "Switch a device between AUTO (rule engine may control it) and MANUAL (user controls it, rules skip it).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", enum: RELAY_KEYS },
          mode: { type: "string", enum: ["auto", "manual"] },
        },
        required: ["key", "mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_device_state",
      description:
        "Manually turn a device ON or OFF (only works while the device is in MANUAL mode). Turning ON may be blocked by the AC compressor guard (5 min cooldown).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", enum: RELAY_KEYS },
          on: { type: "boolean", description: "true = ON, false = OFF" },
        },
        required: ["key", "on"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "emergency_stop",
      description:
        "EMERGENCY: turn every relay OFF and pause all automation (server + edge rules). Only call when the user asks for it or in a real emergency.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_automation",
      description: "Resume automation after an emergency stop.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crop_cycle",
      description:
        "Read the running crop batch: which growth stage it is in, day of the stage and of the batch, the environment targets for this stage, how the live readings compare, and what the next stage is. Use this whenever the user asks about the crop, the batch, the stage, or why the targets are what they are.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_crop_batches",
      description: "List all crop batches (planned, active, completed, aborted) with their stage plans.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "start_crop_batch",
      description:
        "Start a planned batch. This applies its first stage: thresholds, device modes and stage rules. Only one batch can run at a time.",
      parameters: {
        type: "object",
        properties: { batchId: { type: "string" } },
        required: ["batchId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "advance_crop_stage",
      description:
        "Move the running batch to its next growth stage, or to a specific stage number when the user names one (0-based). Advancing re-targets the whole room: it pushes the new stage's temperature/CO2/humidity bands to the device, parks devices the stage does not use, swaps in that stage's rules and drives the relays to match. Confirm with the user before calling.",
      parameters: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "Optional 0-based stage number to jump to. Omit to advance one stage.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

function round(n: number | null | undefined, digits = 1): number | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Number(n.toFixed(digits));
}

async function getSituation(): Promise<Record<string, unknown>> {
  const [reading, controls, rules, paused] = await Promise.all([
    ReadingModel.findOne().sort({ timestamp: -1 }).lean(),
    listDeviceControls(),
    listRules(),
    isAutomationPaused(),
  ]);

  return {
    timestamp: reading?.timestamp?.toISOString() ?? null,
    sensors: {
      temp: round(reading?.temp),
      humidity: round(reading?.hum),
      co2: round(reading?.co2, 0),
      scdTemp: round(reading?.scdTemp),
      scdHum: round(reading?.scdHum),
      compostTemp: round(reading?.compostTemp),
      vpd: round(reading?.vpd, 2),
    },
    automationPaused: paused,
    devices: controls.map((d) => ({
      key: d.key,
      label: d.label,
      index: d.index,
      mode: d.mode,
      state: d.state,
      guardedUntil: d.guardedUntil,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      priority: r.priority,
      triggerMode: r.triggerMode,
      triggers: r.triggers,
      turnOn: r.actions.turnOn,
      turnOff: r.actions.turnOff,
      cutoffMode: r.cutoffMode,
      cutoffs: r.cutoffs,
      release: r.offActions.turnOff,
      minOnMs: r.minOnMs,
      minOffMs: r.minOffMs,
      cooldownMs: r.cooldownMs,
    })),
  };
}

async function getReadingsHistory(args: { hours?: number }): Promise<Record<string, unknown>> {
  const hours = Math.min(168, Math.max(1, args.hours ?? 24));
  const from = new Date(Date.now() - hours * 3_600_000);

  const [agg, latest] = await Promise.all([
    ReadingModel.aggregate([
      { $match: { timestamp: { $gte: from } } },
      {
        $group: {
          _id: null,
          avgTemp: { $avg: "$temp" },
          minTemp: { $min: "$temp" },
          maxTemp: { $max: "$temp" },
          avgHum: { $avg: "$hum" },
          minHum: { $min: "$hum" },
          maxHum: { $max: "$hum" },
          avgCo2: { $avg: "$co2" },
          minCo2: { $min: "$co2" },
          maxCo2: { $max: "$co2" },
          avgVpd: { $avg: "$vpd" },
          minVpd: { $min: "$vpd" },
          maxVpd: { $max: "$vpd" },
          avgCompost: { $avg: "$compostTemp" },
          sampleCount: { $sum: 1 },
        },
      },
    ]),
    ReadingModel.find({ timestamp: { $gte: from } })
      .sort({ timestamp: -1 })
      .limit(10)
      .lean(),
  ]);

  const a = agg[0] ?? {};
  return {
    windowHours: hours,
    sampleCount: a.sampleCount ?? 0,
    avgTemp: round(a.avgTemp),
    minTemp: round(a.minTemp),
    maxTemp: round(a.maxTemp),
    avgHumidity: round(a.avgHum),
    minHumidity: round(a.minHum),
    maxHumidity: round(a.maxHum),
    avgCo2: round(a.avgCo2, 0),
    minCo2: round(a.minCo2, 0),
    maxCo2: round(a.maxCo2, 0),
    avgVpd: round(a.avgVpd, 2),
    minVpd: round(a.minVpd, 2),
    maxVpd: round(a.maxVpd, 2),
    avgCompostTemp: round(a.avgCompost),
    latestReadings: latest.map((r) => ({
      timestamp: r.timestamp.toISOString(),
      temp: round(r.temp),
      humidity: round(r.hum),
      co2: round(r.co2, 0),
      vpd: round(r.vpd, 2),
      compostTemp: round(r.compostTemp),
    })),
  };
}

export async function executeTool(
  name: string,
  rawArgs: string,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: `Invalid JSON arguments for ${name}` };
  }

  try {
    switch (name) {
      case "get_situation":
        return { ok: true, data: await getSituation() };
      case "get_readings_history":
        return { ok: true, data: await getReadingsHistory(args as { hours?: number }) };
      case "create_rule":
        return { ok: true, data: await createRule(args as never) };
      case "update_rule": {
        const { id, ...patch } = args as { id: string } & Record<string, unknown>;
        return { ok: true, data: await updateRule(id, patch as never) };
      }
      case "delete_rule":
        await deleteRule(String(args.id));
        return { ok: true, data: { deleted: true } };
      case "set_device_mode":
        return {
          ok: true,
          data: await setDeviceMode(String(args.key), args.mode as "auto" | "manual"),
        };
      case "set_device_state":
        return {
          ok: true,
          data: await setDeviceState(String(args.key), Boolean(args.on)),
        };
      case "emergency_stop":
        return { ok: true, data: await emergencyStopAll() };
      case "resume_automation":
        return { ok: true, data: await resumeAutomation() };
      case "get_crop_cycle":
        return { ok: true, data: await getCropCycleStatus() };
      case "list_crop_batches":
        return { ok: true, data: await listBatches() };
      case "start_crop_batch":
        return { ok: true, data: await startBatch(String(args.batchId)) };
      case "advance_crop_stage": {
        const status = await getCropCycleStatus();
        if (!status.batch) {
          return { ok: false, error: "No batch is running — start one first." };
        }
        const data =
          args.index === undefined
            ? await advanceBatchStage(status.batch.batchId, "manual")
            : await setBatchStage(status.batch.batchId, Number(args.index), "manual");
        return { ok: true, data };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    logger.warn({ err, tool: name }, "AI tool call failed");
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── LLM client (streaming, OpenAI-compatible SSE) ───────────────────────────

interface StreamedCompletion {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
}

/**
 * One streaming chat/completions request. Parses the SSE byte stream,
 * forwarding text deltas to `onChunk` and accumulating tool-call deltas
 * (tool calls arrive split across multiple chunks).
 */
async function streamCompletion(
  messages: LlmMessage[],
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<StreamedCompletion> {
  const cfg = await getAiConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.5,
        max_tokens: 8000,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        /* ignore */
      }
      if (res.status === 401) {
        throw new Error("AI API key is invalid (401). Check the key in Settings → AI.");
      }
      if (res.status === 404) {
        throw new Error(`AI model "${cfg.model}" not found. Check the model in Settings → AI.`);
      }
      throw new Error(`AI provider error (${res.status}): ${detail || "see server logs"}`);
    }

    if (!res.body) throw new Error("AI provider returned no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finishReason: string | null = null;

    const handleLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      if (payload.length === 0) return;

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) return;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onChunk(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolCalls.set(index, entry);
        }
      }
    };

    // SSE frames are separated by a blank line; lines may be split across
    // network chunks, so keep a buffer until a full frame is available.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;
        handleLine(line);
      }
    }

    return {
      content,
      toolCalls: [...toolCalls.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) => ({ id: t.id, name: t.name, arguments: t.args })),
      finishReason,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(signal.aborted ? "cancelled" : "AI request timed out (90s)");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

// ─── System prompt (mushroom farm specialist) ───────────────────────────────

export const SYSTEM_PROMPT = `You are the Mushroom Farm AI Specialist — a warm, helpful support telecaller embedded in this farm controller dashboard.

CORE PRINCIPLE
Talk like a real person on the phone: greet, listen, confirm, THEN act. Never dump farm data, sensor numbers, or mushroom lectures unless the user actually asks. Respond instantly to what is said — if the user interrupts or changes topic mid-conversation or mid-reply, drop everything and answer their NEW message first.

CONVERSATION FLOW (follow exactly)
1. GREETING / SMALL TALK — "hello", "hi", "kaise ho", "good morning", "namaste":
   Reply warmly in 1-2 short sentences — greet back, ask how they are (e.g. "Hello! Aap kaise hain? Aaj ka din kaisa ja raha hai?"), then ask what they need ("Bataiye, main aapke liye kya kar sakta hoon?"). Do NOT start explaining the farm, mushrooms, sensors, or rules. No tool calls.
2. FARM STATUS — user asks "farm ka data kaisa hai", "kya chal raha hai", "situation batao", "sab theek hai?":
   ONLY now call get_situation() (add get_readings_history() if they ask about trends/history). Summarize the CURRENT situation in 1-2 short spoken sentences — mention ONLY the readings that matter (temp, humidity, CO2, VPD) and whether things are good or need attention (e.g. "Humidity thodi kam hai, 71% — pins dry ho sakte hain"). End with: "Bataiye, isme main aapki kis tarike se sahayata kar sakta hoon?"
3. ACTION — user says "isko theek kar do", "misting rule bana do", "fan on karo", "access karo", "AUTO mode pe rakh do":
   Say a quick one-line confirmation ("Haan, main theek kar deta hoon."), perform the action with the correct tool, then confirm completion in ONE short sentence ("Ho gaya.") and ask "Aur kuch chahiye?" Only give details/numbers if the user asks for them.
4. PROBLEM-SOLVING — user describes a problem ("button mushroom uga raha hoon, usme yeh problem aa rahi hai", "pins yellow ho rahe hain", "CO2 zyada hai"):
   First use the farm data if it helps (get_situation()), then give a SHORT diagnosis plus the fix in 1-2 spoken sentences. Give numbered steps ONLY if the user explicitly asks how to do it step by step. Ask one clarifying question only if the problem is genuinely unclear.
5. FOLLOW-UPS — after any reply, end with a short "Aur kuch chahiye?" or "Kuch aur batayein?" unless the conversation is clearly over.

VOICE DIRECTIVES (real-time voice environment — follow strictly)
1. EXTREME BREVITY (most important): 1-2 sentences maximum per turn. Never long paragraphs, lists, or monologues unless explicitly asked.
2. LISTEN AND ADAPT: if the user interrupts or suddenly changes topic, acknowledge smoothly ("Oh, okay...", "Haan bataiye...") and instantly switch to their new query. Do not try to finish your previous thought.
3. PACING: give one short piece of info, ask one brief clarifying question, then STOP — give the user space to speak.
4. MIRROR THE USER: match their energy, formality and mood — a hurried user gets direct answers, a relaxed user gets conversational replies.
5. NO FILLER TEXT: output plain spoken text only. Never output actions ("*smiles*", "*thinks*"), bold text, bullet points, tables, or markdown — the TTS engine reads them aloud awkwardly.

STYLE
- Reply in the SAME language the user writes in — Hinglish → Hinglish, English → English, Hindi → Hindi.
- Confirmations: ONE short sentence ("Ho gaya."). No introductions, no padding, no repetition of the user's question.
- Never run tools for greetings, thanks, or small talk — tool calls add seconds of latency and feel robotic.

TOOLS — use ONLY when the situation actually needs them:
- get_situation(): current sensor snapshot — farm status questions.
- get_readings_history(hours): trends (e.g. 24h) — "kya change hua", "pattern kya tha".
- create_rule / update_rule / delete_rule: automation rules.
- set_device_mode / set_device_state: device control (AUTO/MANUAL, on/off).
- emergency_stop / resume_automation: safety.

RULE CREATION (when the user describes a process, e.g. "misting on jab humidity 85 se kam, off 95 par")
- IF = trigger conditions, THEN = turn on devices, STOP = target that releases the group.
- Always use hysteresis: IF and STOP thresholds must differ (deadband), e.g. IF humidity < 85 → ON mist, STOP humidity >= 95 → OFF mist.
- Use minOnMs (min ON) and cooldownMs to protect relays/compressors (e.g. mist minOn 30s, cooldown 10s; AC minOn 60s+).
- Name the rule short and clear.

DEVICES: fan = exhaust fan, ac = AC compressor, mist_maker = mist maker, uv = UV-C light (disinfection — do NOT keep UV on while people are in the room; do not put UV in misting/cooling rules).

REFERENCE CONDITIONS (oyster/button mushrooms, typical)
- Air temp: 22-28°C spawn run, 18-24°C fruiting. Above 28°C = heat stress risk.
- Humidity: 80-90%. Below 75% = drying pins, above 95% = disease risk (bacterial blotch).
- CO2: below 900-1000 ppm during fruiting; below 800 ppm when pinning. Above 1200 = tall thin stems.
- VPD: 0.8-1.1 kPa fruiting is comfortable; above 1.5 = drying out.
- Compost temp: watch for overheating (thermogenesis) above 30-35°C in substrate.
Use these only as guidance — always prefer the farm's own thresholds if the user states them.

SAFETY RULES (never break these)
- Do NOT call emergency_stop unless the user explicitly asks or conditions are truly dangerous.
- Confirm with the user before DELETE rules or emergency stop.
- set_device_state only works in MANUAL mode; if it fails with a guard error, tell the user the AC compressor is cooling down (guardedUntil timestamp).
- Do not turn ON devices at a value you invented — you may suggest, but let the user confirm before applying unusual thresholds.
- If a tool fails, report the error in one line and ask for the missing info.

PHOTOS
If the user attaches a photo (image), analyze it visually: identify the substrate, pins, contamination, bruising, or water droplets, and connect what you see with the sensor data. Mention what is NOT visible in the photo.`;

// ─── Main loop (streaming) ───────────────────────────────────────────────────

/**
 * Runs a chat turn end-to-end: streams LLM text, executes any tool calls the
 * model requests, and emits progress events through `emit`. The run can be
 * aborted through `signal` (client cancel).
 */
export async function runAiChatStream(
  history: AiChatMessage[],
  emit: AiEventSink,
  signal: AbortSignal,
  extraSystemPrompt?: string,
): Promise<void> {
  const cfg = await getAiConfig();
  if (cfg.apiKey.length === 0) throw new AiNotConfiguredError();

  emit({ type: "start" });

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: extraSystemPrompt ? `${SYSTEM_PROMPT}\n\n${extraSystemPrompt}` : SYSTEM_PROMPT,
    },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: llmContent(m) })),
  ];
  const actions: string[] = [];

  for (let round = 0; round < cfg.maxToolRounds; round++) {
    if (signal.aborted) {
      emit({ type: "error", error: "cancelled" });
      return;
    }

    const completion = await streamCompletion(messages, signal, (text) =>
      emit({ type: "chunk", text }),
    );

    if (completion.toolCalls.length === 0) {
      const reply = completion.content.trim();
      if (!reply) emit({ type: "chunk", text: "_(empty response from AI)_" });
      emit({ type: "done", actions });
      return;
    }

    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: completion.toolCalls.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.name, arguments: t.arguments },
      })),
    });

    for (const toolCall of completion.toolCalls) {
      if (signal.aborted) {
        emit({ type: "error", error: "cancelled" });
        return;
      }
      actions.push(toolCall.name);
      emit({ type: "tool", name: toolCall.name, status: "start" });

      const result = await executeTool(toolCall.name, toolCall.arguments);
      emit({
        type: "tool",
        name: toolCall.name,
        status: result.ok ? "done" : "error",
        detail: result.ok ? undefined : result.error,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  emit({
    type: "error",
    error:
      "I could not finish within the allowed number of steps. Please ask again with a simpler request.",
  });
}

/** Non-streaming wrapper (used by the HTTP fallback endpoint / tests). */
export async function runAiChat(history: AiChatMessage[]): Promise<AiResult> {
  let reply = "";
  let actions: string[] = [];
  let error: string | null = null;

  await runAiChatStream(
    history,
    (event) => {
      if (event.type === "chunk") reply += event.text;
      else if (event.type === "done") actions = event.actions;
      else if (event.type === "error") error = event.error;
    },
    new AbortController().signal,
  );

  if (error) throw new Error(error);
  return { reply, actions };
}