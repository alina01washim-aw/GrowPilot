import { SettingsModel, type SettingsDocument } from "../models/settings";
import { getMqttClient } from "./mqttClientRef";
import { logger } from "./logger";

const CONFIG_TOPIC = "fridge/config";

export interface ThresholdsView {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
  updatedAt: Date;
}

function toView(doc: SettingsDocument & { updatedAt: Date }): ThresholdsView {
  return {
    tempMin:     doc.tempMin,
    tempMax:     doc.tempMax,
    co2Min:      doc.co2Min,
    co2Max:      doc.co2Max,
    humidityMin: doc.humidityMin,
    humidityMax: doc.humidityMax,
    updatedAt:   doc.updatedAt,
  };
}

const DEFAULTS = {
  tempMin: 21, tempMax: 23,
  co2Min: 700, co2Max: 1200,
  humidityMin: 85, humidityMax: 95,
};

const SETTINGS_CACHE_TTL_MS = 5_000;
let cachedSettings: ThresholdsView | null = null;
let settingsCacheExpiry = 0;

function cacheSettings(view: ThresholdsView): ThresholdsView {
  cachedSettings = view;
  settingsCacheExpiry = Date.now() + SETTINGS_CACHE_TTL_MS;
  return view;
}

/**
 * Returns current thresholds. On first boot (or after migrating from the old
 * single-threshold schema) it upserts the full 6-field doc with mushroom-farm
 * defaults. Any missing field is filled in via $set so old docs are migrated
 * transparently without wiping manually-saved values.
 */
export async function getSettings(): Promise<ThresholdsView> {
  const now = Date.now();
  if (cachedSettings && now < settingsCacheExpiry) {
    return cachedSettings;
  }

  // $setOnInsert for brand-new docs; we also $set any missing fields in
  // existing docs so an old single-threshold doc gains the new min/max fields.
  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    [
      {
        $set: {
          tempMin:     { $ifNull: ["$tempMin",     DEFAULTS.tempMin]     },
          tempMax:     { $ifNull: ["$tempMax",     DEFAULTS.tempMax]     },
          co2Min:      { $ifNull: ["$co2Min",      DEFAULTS.co2Min]      },
          co2Max:      { $ifNull: ["$co2Max",      DEFAULTS.co2Max]      },
          humidityMin: { $ifNull: ["$humidityMin", DEFAULTS.humidityMin] },
          humidityMax: { $ifNull: ["$humidityMax", DEFAULTS.humidityMax] },
          updatedAt:   { $ifNull: ["$updatedAt",   new Date()]           },
        },
      },
    ],
    { upsert: true, new: true },
  ).lean();
  return cacheSettings(toView(doc as SettingsDocument & { updatedAt: Date }));
}

/**
 * Partial-updates the singleton settings doc, validates that min < max for
 * each parameter, then publishes the new thresholds to the MQTT broker as a
 * *retained* message so ESP32 always receives the latest config on reconnect.
 */
export async function updateSettings(
  patch: Partial<Omit<ThresholdsView, "updatedAt">>,
): Promise<ThresholdsView> {
  // Merge patch over current values and validate ranges
  const current = await getSettings();
  const merged = { ...current, ...patch };

  if (merged.tempMin >= merged.tempMax)
    throw new RangeError("tempMin must be less than tempMax");
  if (merged.co2Min >= merged.co2Max)
    throw new RangeError("co2Min must be less than co2Max");
  if (merged.humidityMin >= merged.humidityMax)
    throw new RangeError("humidityMin must be less than humidityMax");

  const now = new Date();
  const $set: Record<string, unknown> = { updatedAt: now };
  for (const key of ["tempMin","tempMax","co2Min","co2Max","humidityMin","humidityMax"] as const) {
    if (patch[key] !== undefined) $set[key] = patch[key];
  }

  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    { $set, $setOnInsert: { _id: "default" } },
    { upsert: true, new: true },
  ).lean();

  const view = toView(doc as SettingsDocument & { updatedAt: Date });
  cacheSettings(view);
  publishThresholds(view);
  return view;
}

// ─── VPD targets (surface VPD status indicator) ─────────────────────────────
//
// Separate from the automation thresholds above: VPD targets only drive the
// dashboard status gauge (no relay automation), so they are not published to
// the MQTT fridge/config topic.

export interface VpdTargetsView {
  vpdTargetMin: number;
  vpdTargetMax: number;
  vpdWarningMargin: number;
  updatedAt: Date;
}

const VPD_DEFAULTS = {
  vpdTargetMin: 0.15,   // kPa — lower edge of ideal surface VPD
  vpdTargetMax: 0.35,   // kPa — upper edge of ideal surface VPD
  vpdWarningMargin: 0.05, // kPa — tolerance before warning escalates
};

const VPD_CACHE_TTL_MS = 5_000;
let cachedVpdTargets: VpdTargetsView | null = null;
let vpdCacheExpiry = 0;

function toVpdView(doc: SettingsDocument & { updatedAt: Date }): VpdTargetsView {
  return {
    vpdTargetMin:     doc.vpdTargetMin,
    vpdTargetMax:     doc.vpdTargetMax,
    vpdWarningMargin: doc.vpdWarningMargin,
    updatedAt:        doc.updatedAt,
  };
}

function cacheVpdTargets(view: VpdTargetsView): VpdTargetsView {
  cachedVpdTargets = view;
  vpdCacheExpiry = Date.now() + VPD_CACHE_TTL_MS;
  return view;
}

/**
 * Returns the current surface VPD target band, migrating old docs to the
 * mushroom-farm defaults on first access (same $ifNull pattern as getSettings).
 */
export async function getVpdTargets(): Promise<VpdTargetsView> {
  const now = Date.now();
  if (cachedVpdTargets && now < vpdCacheExpiry) {
    return cachedVpdTargets;
  }

  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    [
      {
        $set: {
          vpdTargetMin:     { $ifNull: ["$vpdTargetMin",     VPD_DEFAULTS.vpdTargetMin]     },
          vpdTargetMax:     { $ifNull: ["$vpdTargetMax",     VPD_DEFAULTS.vpdTargetMax]     },
          vpdWarningMargin: { $ifNull: ["$vpdWarningMargin", VPD_DEFAULTS.vpdWarningMargin] },
          updatedAt:        { $ifNull: ["$updatedAt",        new Date()]                     },
        },
      },
    ],
    { upsert: true, new: true },
  ).lean();
  return cacheVpdTargets(toVpdView(doc as SettingsDocument & { updatedAt: Date }));
}

/**
 * Partial-updates the VPD target band with validation:
 *  - 0 ≤ min < max ≤ 2 kPa (surface VPD rarely exceeds ~1.5 kPa)
 *  - margin > 0
 */
export async function updateVpdTargets(
  patch: Partial<Omit<VpdTargetsView, "updatedAt">>,
): Promise<VpdTargetsView> {
  const current = await getVpdTargets();
  const merged = { ...current, ...patch };

  if (!Number.isFinite(merged.vpdTargetMin) || !Number.isFinite(merged.vpdTargetMax) || !Number.isFinite(merged.vpdWarningMargin)) {
    throw new RangeError("VPD targets must be numbers");
  }
  if (merged.vpdTargetMin < 0 || merged.vpdTargetMin >= merged.vpdTargetMax) {
    throw new RangeError("vpdTargetMin must be ≥ 0 and less than vpdTargetMax");
  }
  if (merged.vpdTargetMax > 2) {
    throw new RangeError("vpdTargetMax must not exceed 2 kPa");
  }
  if (merged.vpdWarningMargin <= 0 || merged.vpdWarningMargin > 0.5) {
    throw new RangeError("vpdWarningMargin must be between 0 and 0.5 kPa");
  }

  const now = new Date();
  const $set: Record<string, unknown> = { updatedAt: now };
  for (const key of ["vpdTargetMin", "vpdTargetMax", "vpdWarningMargin"] as const) {
    if (patch[key] !== undefined) $set[key] = patch[key];
  }

  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    { $set, $setOnInsert: { _id: "default" } },
    { upsert: true, new: true },
  ).lean();

  return cacheVpdTargets(toVpdView(doc as SettingsDocument & { updatedAt: Date }));
}

/**
 * Publishes the full range thresholds to MQTT with retain=true.
 * Topic: fridge/config
 * Payload: {"tempMin":21,"tempMax":23,"co2Min":700,"co2Max":1200,"humidityMin":85,"humidityMax":95}
 *
 * ESP32 subscribes to this topic and stores the values in NVS flash so
 * the device can continue autonomous control even when the backend is offline.
 */
export function publishThresholds(thresholds: ThresholdsView): void {
  const mqttClient = getMqttClient();
  if (!mqttClient) return;
  const payload = JSON.stringify({
    tempMin:     thresholds.tempMin,
    tempMax:     thresholds.tempMax,
    co2Min:      thresholds.co2Min,
    co2Max:      thresholds.co2Max,
    humidityMin: thresholds.humidityMin,
    humidityMax: thresholds.humidityMax,
  });
  mqttClient.publish(CONFIG_TOPIC, payload, { retain: true }, (err) => {
    if (err) {
      logger.error({ err }, "Failed to publish thresholds to MQTT");
    } else {
      logger.info({ topic: CONFIG_TOPIC, payload }, "Thresholds published to MQTT (retained)");
    }
  });
}
