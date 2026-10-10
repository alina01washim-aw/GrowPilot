import { Router, type IRouter } from "express";
import { z } from "zod";
import { aiModelName, isAiConfigured, parseChatMessages, runAiChat } from "../lib/ai";
import {
  getAiConfigSnapshot,
  updateAiConfig,
} from "../lib/aiConfig";

const router: IRouter = Router();

// Whether the AI assistant is wired up (client uses this to show a hint).
router.get("/ai/health", async (_req, res): Promise<void> => {
  res.json({ configured: await isAiConfigured(), model: await aiModelName() });
});

// Runtime AI settings (Settings → AI tab). Never returns the actual key.
router.get("/ai/config", async (_req, res): Promise<void> => {
  res.json(await getAiConfigSnapshot());
});

// Update runtime AI settings. apiKey omitted → keep current; "" → clear.
const UpdateConfigSchema = z
  .object({
    provider: z.enum(["openai", "gemini", "opencode", "custom"]).optional(),
    baseUrl: z.string().trim().max(500).optional(),
    apiKey: z.string().trim().max(500).optional(),
    model: z.string().trim().max(200).optional(),
  })
  .strict();

router.put("/ai/config", async (req, res): Promise<void> => {
  const parsed = UpdateConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config" });
    return;
  }
  const snapshot = await updateAiConfig(parsed.data);
  res.json(snapshot);
});

// Non-streaming fallback for clients that cannot use the WebSocket endpoint.
// The dashboard itself chats over /api/ws/ai (see lib/aiSocket.ts).
router.post("/ai/chat", async (req, res): Promise<void> => {
  if (!(await isAiConfigured())) {
    res.status(503).json({
      error:
        "AI is not configured. Add an API key in Settings → AI, or set AI_API_KEY in the server .env file.",
    });
    return;
  }

  const parsed = parseChatMessages(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const result = await runAiChat(parsed.messages);
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "AI request failed",
    });
  }
});

export default router;