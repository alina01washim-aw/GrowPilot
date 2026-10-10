import { SettingsModel } from "../models/settings";
import { publishAllRulePayloads } from "./ruleControl";

const CACHE_TTL_MS = 5_000;
let cachedPaused: boolean | null = null;
let cacheExpiry = 0;

export function invalidateAutomationCache(): void {
  cachedPaused = null;
  cacheExpiry = 0;
}

export async function isAutomationPaused(): Promise<boolean> {
  const now = Date.now();
  if (cachedPaused !== null && now < cacheExpiry) {
    return cachedPaused;
  }

  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    { $setOnInsert: { _id: "default", automationPaused: false } },
    { upsert: true, new: true },
  )
    .select("automationPaused")
    .lean();

  cachedPaused = doc?.automationPaused ?? false;
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedPaused;
}

export async function setAutomationPaused(paused: boolean): Promise<void> {
  await SettingsModel.findByIdAndUpdate(
    "default",
    {
      $set: { automationPaused: paused, updatedAt: new Date() },
      $setOnInsert: { _id: "default" },
    },
    { upsert: true },
  );
  cachedPaused = paused;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  // Push the new master switch to the ESP so edge-executed rules stop/start
  // immediately, even while the device is offline from the HTTP API.
  await publishAllRulePayloads().catch(() => undefined);
}
