import { CropBatchModel } from "../models/cropBatch";

/**
 * Which crop stage is currently running.
 *
 * Deliberately dependency-free (models only) so `ruleControl` and
 * `ruleEvaluator` can filter rules by stage without importing `cropCycle`,
 * which imports them back. Same trick as `mqttClientRef`.
 *
 * Cached briefly because every rule publish and every automation pass asks for
 * it, and it only changes on a stage transition — which invalidates the cache.
 */

const CACHE_TTL_MS = 5_000;
let cachedKey: string | null = null;
let cacheLoaded = false;
let cacheExpiry = 0;

export function invalidateActiveStageCache(): void {
  cachedKey = null;
  cacheLoaded = false;
  cacheExpiry = 0;
}

/** Stage key of the active batch, or null when no batch is running. */
export async function getActiveStageKey(): Promise<string | null> {
  const now = Date.now();
  if (cacheLoaded && now < cacheExpiry) return cachedKey;

  const batch = await CropBatchModel.findOne({ status: "active" })
    .select("stages currentStageIndex")
    .lean();

  const stage = batch?.stages?.[batch.currentStageIndex ?? 0];
  cachedKey = stage?.key ?? null;
  cacheLoaded = true;
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedKey;
}

/**
 * True when a rule applies right now. A rule with no `stageKeys` is unscoped
 * and always applies; a stage-scoped rule applies only during its stages, and
 * never while no batch is running (an unscoped rule is the right tool for
 * "always on" behaviour).
 */
export function ruleAppliesToStage(
  stageKeys: string[] | undefined,
  activeStageKey: string | null,
): boolean {
  if (!stageKeys || stageKeys.length === 0) return true;
  if (!activeStageKey) return false;
  return stageKeys.includes(activeStageKey);
}
