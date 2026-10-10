import { CropBatchModel, type CropStage } from "../models/cropBatch";
import { BatchAnnotationModel } from "../models/batchAnnotation";
import { RiskAlertModel } from "../models/riskAlert";
import {
  getBatchDayStats,
  stagePositionAt,
  dayOfBatch as dayOfBatchAt,
  type TelemetryWindowStats,
} from "./batchTelemetry";
import {
  findRisks,
  DEFAULT_RISK_OPTIONS,
  type CurrentState,
  type HistoricalIncident,
  type MetricKey,
  type MetricSample,
  type OutcomeLabel,
  type RiskMatch,
  type Severity,
} from "./riskEngine";
import { logger } from "./logger";

/**
 * Runs the risk engine against live conditions and records what it finds.
 *
 * Split from `riskEngine.ts` on purpose: the engine is pure so it can be tested
 * without a database, and everything that touches Mongo lives here.
 *
 * Cadence is deliberately slow. Conditions are aggregated over the current
 * *stage-day*, so re-evaluating more often than that would compare a noisier
 * version of the same number and produce nothing new — while every tick risks
 * interrupting the grower. Half-hourly is frequent enough that a developing
 * problem is caught within one working period.
 */

const TICK_INTERVAL_MS = 30 * 60_000;

let tickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/** Metrics the engine can compare, paired with their target band field names. */
const METRIC_BANDS: Array<{
  metric: MetricKey;
  min: keyof CropStage["targets"];
  max: keyof CropStage["targets"];
}> = [
  { metric: "temp", min: "tempMin", max: "tempMax" },
  { metric: "hum", min: "humidityMin", max: "humidityMax" },
  { metric: "co2", min: "co2Min", max: "co2Max" },
];

/**
 * Which telemetry average corresponds to each metric. `compostTemp` and `vpd`
 * have no target band in the stage plan, so they cannot be compared band-relative
 * and are left out rather than compared against an invented range.
 */
function currentSamples(stats: TelemetryWindowStats, stage: CropStage): MetricSample[] {
  const value: Record<string, number | null> = {
    temp: stats.temp.avg,
    hum: stats.hum.avg,
    co2: stats.co2.avg,
  };

  const samples: MetricSample[] = [];
  for (const { metric, min, max } of METRIC_BANDS) {
    const observed = value[metric];
    const bandMin = stage.targets[min];
    const bandMax = stage.targets[max];
    if (observed == null) continue;
    if (typeof bandMin !== "number" || typeof bandMax !== "number") continue;
    samples.push({ metric, value: observed, band: { min: bandMin, max: bandMax } });
  }
  return samples;
}

/** Same mapping for a stored annotation, which carries its own frozen bands. */
function incidentSamples(doc: {
  snapshot?: { temp?: number | null; hum?: number | null; co2?: number | null } | null;
  targets?: {
    tempMin?: number | null;
    tempMax?: number | null;
    co2Min?: number | null;
    co2Max?: number | null;
    humidityMin?: number | null;
    humidityMax?: number | null;
  } | null;
}): MetricSample[] {
  const snapshot = doc.snapshot ?? {};
  const targets = doc.targets ?? {};

  const pairs: Array<{ metric: MetricKey; value?: number | null; min?: number | null; max?: number | null }> = [
    { metric: "temp", value: snapshot.temp, min: targets.tempMin, max: targets.tempMax },
    { metric: "hum", value: snapshot.hum, min: targets.humidityMin, max: targets.humidityMax },
    { metric: "co2", value: snapshot.co2, min: targets.co2Min, max: targets.co2Max },
  ];

  const samples: MetricSample[] = [];
  for (const { metric, value, min, max } of pairs) {
    if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number") continue;
    samples.push({ metric, value, band: { min, max } });
  }
  return samples;
}

/**
 * Past problems worth learning from: warning/critical notes on other batches,
 * paired with how those batches ended.
 *
 * An annotation with no usable snapshot or no frozen targets is skipped — without
 * both, there is no way to say how far out of band it actually was, and guessing
 * would manufacture evidence.
 */
export async function loadHistoricalIncidents(
  excludeBatchId: string,
  minSeverity: Severity = DEFAULT_RISK_OPTIONS.minSeverity,
): Promise<HistoricalIncident[]> {
  const severities: Severity[] =
    minSeverity === "critical" ? ["critical"] : minSeverity === "warning" ? ["warning", "critical"] : ["info", "warning", "critical"];

  const docs = await BatchAnnotationModel.find({
    batchId: { $ne: excludeBatchId },
    severity: { $in: severities },
  })
    .lean()
    .limit(500);

  if (docs.length === 0) return [];

  const batchIds = [...new Set(docs.map((d) => d.batchId))];
  const batches = await CropBatchModel.find({ batchId: { $in: batchIds } })
    .select("batchId name outcome")
    .lean();
  const byBatch = new Map(batches.map((b) => [b.batchId, b]));

  const incidents: HistoricalIncident[] = [];
  for (const doc of docs) {
    const samples = incidentSamples(doc);
    if (samples.length === 0) continue;

    const batch = byBatch.get(doc.batchId);
    const outcome = batch?.outcome
      ? {
          label: batch.outcome.label as OutcomeLabel,
          yieldKg: batch.outcome.yieldKg ?? null,
          gradePercent: batch.outcome.gradePercent ?? null,
        }
      : null;

    incidents.push({
      annotationId: String(doc._id),
      batchId: doc.batchId,
      batchName: batch?.name ?? doc.batchId,
      stageKey: doc.stageKey ?? "",
      stageLabel: doc.stageLabel ?? "",
      dayOfStage: doc.dayOfStage ?? 1,
      dayOfBatch: doc.dayOfBatch ?? 1,
      severity: doc.severity as Severity,
      category: doc.category,
      title: doc.title,
      samples,
      outcome,
    });
  }
  return incidents;
}

export interface RiskCheckResult {
  checked: boolean;
  reason?: string;
  matches: RiskMatch[];
  created: number;
}

/**
 * One evaluation pass over the active batch.
 *
 * Returns `checked: false` with a reason when there is nothing to evaluate, which
 * the manual endpoint surfaces so the grower can tell "no risk found" apart from
 * "the engine could not run".
 */
export async function runRiskCheck(): Promise<RiskCheckResult> {
  const batch = await CropBatchModel.findOne({ status: "active" }).lean();
  if (!batch) return { checked: false, reason: "no-active-batch", matches: [], created: 0 };
  if (!batch.startedAt) {
    return { checked: false, reason: "batch-not-started", matches: [], created: 0 };
  }

  const now = new Date();
  const position = stagePositionAt(batch as never, now);
  const stage = batch.stages[batch.currentStageIndex] as CropStage | undefined;
  if (!stage) return { checked: false, reason: "no-current-stage", matches: [], created: 0 };

  const day = dayOfBatchAt(batch.startedAt, now);
  const stats = await getBatchDayStats(batch as never, day);
  if (!stats || stats.sampleCount === 0) {
    return { checked: false, reason: "no-telemetry-today", matches: [], created: 0 };
  }

  const samples = currentSamples(stats, stage);
  if (samples.length === 0) {
    return { checked: false, reason: "no-comparable-metrics", matches: [], created: 0 };
  }

  const current: CurrentState = {
    batchId: batch.batchId,
    stageKey: position?.stageKey ?? stage.key,
    stageLabel: position?.stageLabel ?? stage.label,
    dayOfStage: position?.dayOfStage ?? 1,
    dayOfBatch: day,
    samples,
  };

  const history = await loadHistoricalIncidents(batch.batchId);
  if (history.length === 0) {
    return { checked: true, reason: "no-history", matches: [], created: 0 };
  }

  const matches = findRisks(current, history);
  let created = 0;

  for (const match of matches) {
    // Upsert on the dedupe key: an alert already raised for this situation must
    // not fire again, and must keep whatever state the grower put it in.
    const result = await RiskAlertModel.updateOne(
      { dedupeKey: match.dedupeKey },
      {
        $setOnInsert: {
          dedupeKey: match.dedupeKey,
          batchId: current.batchId,
          stageKey: current.stageKey,
          stageLabel: current.stageLabel,
          dayOfStage: current.dayOfStage,
          dayOfBatch: current.dayOfBatch,
          sourceAnnotationId: match.incident.annotationId,
          sourceBatchId: match.incident.batchId,
          sourceBatchName: match.incident.batchName,
          sourceStageLabel: match.incident.stageLabel,
          sourceDayOfStage: match.incident.dayOfStage,
          sourceSeverity: match.incident.severity,
          sourceOutcome: match.incident.outcome?.label ?? null,
          score: match.score,
          stageAligned: match.stageAligned,
          dayGap: match.dayGap,
          metrics: match.metrics.map((m) => ({
            metric: m.metric,
            direction: m.direction,
            currentValue: m.currentValue,
            historicalValue: m.historicalValue,
            bandMin: m.band.min,
            bandMax: m.band.max,
            currentDeviation: m.currentDeviation,
            historicalDeviation: m.historicalDeviation,
            ratio: m.ratio,
            explanation: m.explanation,
          })),
          headline: match.headline,
          advice: match.advice,
          state: "active",
          firedAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount > 0) created += 1;
  }

  if (created > 0) {
    logger.warn(
      { batchId: current.batchId, stage: current.stageKey, created },
      "Risk engine raised new preemptive warnings",
    );
  }

  return { checked: true, matches, created };
}

export function startRiskMonitor(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    // A pass does several awaited reads and writes; never let two overlap.
    if (tickInFlight) return;
    tickInFlight = true;
    void runRiskCheck()
      .catch((err) => {
        logger.error({ err }, "Risk check failed");
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, TICK_INTERVAL_MS);
  tickTimer.unref?.();
  logger.info({ intervalMinutes: TICK_INTERVAL_MS / 60_000 }, "Risk monitor started");
}

export function stopRiskMonitor(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}
