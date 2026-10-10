import { Router, type IRouter } from "express";
import {
  GetSettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "../lib/api-zod";
import {
  getSettings,
  updateSettings,
  type ThresholdsView,
} from "../lib/settingsControl";

const router: IRouter = Router();

function serializeSettings(s: ThresholdsView) {
  return {
    tempMin: s.tempMin,
    tempMax: s.tempMax,
    co2Min: s.co2Min,
    co2Max: s.co2Max,
    humidityMin: s.humidityMin,
    humidityMax: s.humidityMax,
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/settings", async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json(GetSettingsResponse.parse(serializeSettings(s)));
});

router.patch("/settings", async (req, res): Promise<void> => {
  const body = UpdateSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const s = await updateSettings(body.data);
    res.json(UpdateSettingsResponse.parse(serializeSettings(s)));
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
