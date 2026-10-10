import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getRealtimeConfigSnapshot,
  updateRealtimeConfig,
  REALTIME_VOICES,
  DEFAULT_REALTIME_MODEL,
} from "../lib/realtimeConfig";

const router: IRouter = Router();

/**
 * Realtime voice-call configuration (Settings → AI). Mirrors /voice/config.
 * The API key is never returned — only whether one is set.
 */
router.get("/realtime/config", async (_req, res): Promise<void> => {
  const snapshot = await getRealtimeConfigSnapshot();
  res.json({
    ...snapshot,
    voices: REALTIME_VOICES,
    defaultModel: DEFAULT_REALTIME_MODEL,
  });
});

// The client uses this to decide whether the call button is usable.
router.get("/realtime/health", async (_req, res): Promise<void> => {
  res.json(await getRealtimeConfigSnapshot());
});

// apiKey omitted → keep current; "" → clear (voice calls disabled).
const UpdateSchema = z
  .object({
    apiKey: z.string().trim().max(500).optional(),
    model: z.string().trim().max(200).optional(),
    voice: z.string().trim().max(100).optional(),
  })
  .strict();

router.put("/realtime/config", async (req, res): Promise<void> => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config" });
    return;
  }
  res.json(await updateRealtimeConfig(parsed.data));
});

export default router;
