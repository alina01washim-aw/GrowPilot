import { Router, type IRouter } from "express";
import { ReadingModel } from "../models/reading";
import {
  getVpdTargets,
  updateVpdTargets,
  type VpdTargetsView,
} from "../lib/settingsControl";
import {
  calculateSurfaceVpd,
  classifySurfaceVpd,
  surfaceVpdMessage,
  type VpdStatusCode,
} from "../lib/vpd";

const router: IRouter = Router();

export interface VpdStatusResponse {
  co2_ppm: number | null;
  air_temp_c: number | null;
  air_rh: number | null;
  compost_temp_c: number | null;
  surface_vpd_kpa: number | null;
  target_min: number;
  target_max: number;
  status_code: VpdStatusCode | "NO_DATA";
  status_message: string;
}

const NO_DATA: VpdStatusResponse = {
  co2_ppm: null,
  air_temp_c: null,
  air_rh: null,
  compost_temp_c: null,
  surface_vpd_kpa: null,
  target_min: 0.15,
  target_max: 0.35,
  status_code: "NO_DATA",
  status_message: "Waiting for sensor data (SHT40 + compost probe required).",
};

/**
 * GET /api/vpd/status
 *
 * Structured surface-VPD snapshot for the BP-style status gauge:
 *   surface_vpd = SVP(compost temp) − AVP(air temp & RH)
 *
 * SCD40 contributes CO₂ only; SHT40 contributes air temp + RH; the DS18B20
 * contributes compost temp. Missing sensors yield status_code "NO_DATA".
 */
router.get("/vpd/status", async (_req, res): Promise<void> => {
  const [reading, targets] = await Promise.all([
    ReadingModel.findOne().sort({ timestamp: -1 }).lean(),
    getVpdTargets(),
  ]);

  if (!reading) {
    res.json(NO_DATA);
    return;
  }

  const { temp, hum, co2, compostTemp } = reading;
  if (temp == null || hum == null || compostTemp == null) {
    res.json({ ...NO_DATA, co2_ppm: co2 ?? null, target_min: targets.vpdTargetMin, target_max: targets.vpdTargetMax });
    return;
  }

  try {
    const surfaceVpd = calculateSurfaceVpd({
      airTempC: temp,
      airRhPct: hum,
      compostTempC: compostTemp,
    });
    const code = classifySurfaceVpd(surfaceVpd, {
      targetMinKpa: targets.vpdTargetMin,
      targetMaxKpa: targets.vpdTargetMax,
      warningMarginKpa: targets.vpdWarningMargin,
    });

    res.json({
      co2_ppm: co2 ?? null,
      air_temp_c: temp,
      air_rh: hum,
      compost_temp_c: compostTemp,
      surface_vpd_kpa: surfaceVpd,
      target_min: targets.vpdTargetMin,
      target_max: targets.vpdTargetMax,
      status_code: code,
      status_message: surfaceVpdMessage(code, surfaceVpd, {
        targetMinKpa: targets.vpdTargetMin,
        targetMaxKpa: targets.vpdTargetMax,
        warningMarginKpa: targets.vpdWarningMargin,
      }),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "VPD calculation failed" });
  }
});

function serializeVpdTargets(s: VpdTargetsView) {
  return {
    vpdTargetMin: s.vpdTargetMin,
    vpdTargetMax: s.vpdTargetMax,
    vpdWarningMargin: s.vpdWarningMargin,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** GET /api/vpd/targets — current VPD target band. */
router.get("/vpd/targets", async (_req, res): Promise<void> => {
  const s = await getVpdTargets();
  res.json(serializeVpdTargets(s));
});

/** PUT /api/vpd/targets — partial update of the VPD target band. */
router.put("/vpd/targets", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const patch: Partial<Omit<VpdTargetsView, "updatedAt">> = {};
  for (const key of ["vpdTargetMin", "vpdTargetMax", "vpdWarningMargin"] as const) {
    if (typeof body[key] === "number") patch[key] = body[key] as number;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Provide at least one of vpdTargetMin, vpdTargetMax, vpdWarningMargin" });
    return;
  }

  try {
    const s = await updateVpdTargets(patch);
    res.json(serializeVpdTargets(s));
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
