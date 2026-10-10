import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getVoiceConfigSnapshot,
  updateVoiceConfig,
  textToSpeechBase64,
} from "../lib/cartesia";

const router: IRouter = Router();

// Whether the voice assistant is wired up (client uses this to enable TTS).
router.get("/voice/health", async (_req, res): Promise<void> => {
  res.json(await getVoiceConfigSnapshot());
});

// Runtime voice settings (Settings → AI tab). Never returns the actual key.
router.get("/voice/config", async (_req, res): Promise<void> => {
  res.json(await getVoiceConfigSnapshot());
});

// Update runtime voice settings. apiKey omitted → keep current; "" → clear.
const UpdateConfigSchema = z
  .object({
    apiKey: z.string().trim().max(500).optional(),
    voiceId: z.string().trim().max(200).optional(),
    model: z.string().trim().max(200).optional(),
  })
  .strict();

router.put("/voice/config", async (req, res): Promise<void> => {
  const parsed = UpdateConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config" });
    return;
  }
  res.json(await updateVoiceConfig(parsed.data));
});

// Text → speech (Cartesia). Returns base64 WAV so the browser can play it
// directly without any audio streaming plumbing.
const TtsSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

router.post("/voice/tts", async (req, res): Promise<void> => {
  const parsed = TtsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid text" });
    return;
  }

  const snapshot = await getVoiceConfigSnapshot();
  if (!snapshot.configured) {
    res.status(503).json({
      error:
        "Voice is not configured. Add a Cartesia API key in Settings → AI (Voice section).",
    });
    return;
  }

  try {
    const audio = await textToSpeechBase64(parsed.data.text);
    res.json({ audio, format: "wav" });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Voice synthesis failed",
    });
  }
});

export default router;