import { ReadingModel } from "../models/reading";
import type { CropStage } from "../models/cropBatch";
import { logger } from "./logger";

/**
 * Joining telemetry to a crop batch.
 *
 * `Reading.batchId` cannot be used for this. It is written as a fixed constant —
 * `process.env.MUSHROOM_BATCH_ID ?? "BATCH_CURRENT"` in `mqttClient.ts` — so every
 * reading ever stored carries the same value and it identifies nothing. Rather
 * than start stamping the real id (which would only help batches run from now on,
 * and cannot repair the existing history), readings are matched to a batch by
 * time window. That works retroactively over all stored data and needs no
 * migration.
 *
 * `timestamp` is indexed and the collection is a MongoDB time-series, so range
 * scans are the cheap access pattern here.
 */

const DAY_MS = 86_400_000;

export interface MetricStats {
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface TelemetryWindowStats {
  from: string;
  to: string;
  sampleCount: number;
  temp: MetricStats;
  hum: MetricStats;
  co2: MetricStats;
  compostTemp: MetricStats;
  vpd: MetricStats;
}

export interface DailyStats extends TelemetryWindowStats {
  /** 1-based day within the batch. */
  dayOfBatch: number;
  date: string;
}

interface BatchLike {
  startedAt?: Date | null;
  completedAt?: Date | null;
  stages: CropStage[];
  stageHistory?: Array<{ index: number; enteredAt: Date; leftAt?: Date | null }> | null;
}

/**
 * The wall-clock span a batch occupied. An unfinished batch runs to now; a batch
 * that never started has no window at all, which callers must treat as "no data"
 * rather than as an empty range starting at the epoch.
 */
export function getBatchWindow(batch: BatchLike): { from: Date; to: Date } | null {
  if (!batch.startedAt) return null;
  return { from: batch.startedAt, to: batch.completedAt ?? new Date() };
}

/**
 * 1-based day number of a timestamp within a batch.
 *
 * Counts elapsed 24-hour periods from the exact start instant rather than
 * calendar dates. A batch started at 22:00 therefore has its day 1 end at 22:00
 * the following evening, not two hours later at midnight — which is what a grower
 * means by "day 3 of the spawn run", and it sidesteps timezone and DST handling
 * entirely.
 */
export function dayOfBatch(startedAt: Date, at: Date): number {
  const elapsed = at.getTime() - startedAt.getTime();
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / DAY_MS) + 1;
}

/**
 * Which stage was running at a moment, and the day within it.
 *
 * Read from `stageHistory` — the record of what actually happened — rather than
 * from the plan, because a manual "go to stage" or an early advance makes the
 * planned durations wrong. Falls back to the plan only for a batch with no
 * recorded history.
 */
export function stagePositionAt(
  batch: BatchLike,
  at: Date,
): { stageKey: string; stageLabel: string; stageIndex: number; dayOfStage: number } | null {
  const history = batch.stageHistory ?? [];

  for (const entry of history) {
    const enteredAt = entry.enteredAt.getTime();
    const leftAt = entry.leftAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (at.getTime() >= enteredAt && at.getTime() < leftAt) {
      const stage = batch.stages[entry.index];
      if (!stage) continue;
      return {
        stageKey: stage.key,
        stageLabel: stage.label,
        // Carried through because a plan may repeat a key (three `fruiting`
        // stages in the default plan), so the key alone cannot identify which
        // stage — and therefore which target band — applied.
        stageIndex: entry.index,
        dayOfStage: Math.floor((at.getTime() - enteredAt) / DAY_MS) + 1,
      };
    }
  }

  if (!batch.startedAt) return null;

  // No history: walk the planned durations from the start.
  let cursor = batch.startedAt.getTime();
  for (const [index, stage] of batch.stages.entries()) {
    if (stage.days <= 0) {
      // Open-ended stage swallows everything after it in a projection.
      return {
        stageKey: stage.key,
        stageLabel: stage.label,
        stageIndex: index,
        dayOfStage: Math.floor((at.getTime() - cursor) / DAY_MS) + 1,
      };
    }
    const end = cursor + stage.days * DAY_MS;
    if (at.getTime() < end) {
      return {
        stageKey: stage.key,
        stageLabel: stage.label,
        stageIndex: index,
        dayOfStage: Math.floor((at.getTime() - cursor) / DAY_MS) + 1,
      };
    }
    cursor = end;
  }
  return null;
}

const GROUP_METRICS = {
  avgTemp: { $avg: "$temp" },
  minTemp: { $min: "$temp" },
  maxTemp: { $max: "$temp" },
  avgHum: { $avg: "$hum" },
  minHum: { $min: "$hum" },
  maxHum: { $max: "$hum" },
  avgCo2: { $avg: "$co2" },
  minCo2: { $min: "$co2" },
  maxCo2: { $max: "$co2" },
  avgCompostTemp: { $avg: "$compostTemp" },
  minCompostTemp: { $min: "$compostTemp" },
  maxCompostTemp: { $max: "$compostTemp" },
  avgVpd: { $avg: "$vpd" },
  minVpd: { $min: "$vpd" },
  maxVpd: { $max: "$vpd" },
  sampleCount: { $sum: 1 },
} as const;

interface AggRow {
  avgTemp?: number | null;
  minTemp?: number | null;
  maxTemp?: number | null;
  avgHum?: number | null;
  minHum?: number | null;
  maxHum?: number | null;
  avgCo2?: number | null;
  minCo2?: number | null;
  maxCo2?: number | null;
  avgCompostTemp?: number | null;
  minCompostTemp?: number | null;
  maxCompostTemp?: number | null;
  avgVpd?: number | null;
  minVpd?: number | null;
  maxVpd?: number | null;
  sampleCount?: number;
}

function stats(row: AggRow | undefined, key: "Temp" | "Hum" | "Co2" | "CompostTemp" | "Vpd"): MetricStats {
  const pick = (prefix: "avg" | "min" | "max"): number | null => {
    const value = (row as Record<string, unknown> | undefined)?.[`${prefix}${key}`];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return { avg: pick("avg"), min: pick("min"), max: pick("max") };
}

function toWindowStats(row: AggRow | undefined, from: Date, to: Date): TelemetryWindowStats {
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    sampleCount: row?.sampleCount ?? 0,
    temp: stats(row, "Temp"),
    hum: stats(row, "Hum"),
    co2: stats(row, "Co2"),
    compostTemp: stats(row, "CompostTemp"),
    vpd: stats(row, "Vpd"),
  };
}

/** Aggregate stats for an arbitrary window. */
export async function getWindowStats(from: Date, to: Date): Promise<TelemetryWindowStats> {
  const [row] = (await ReadingModel.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: null, ...GROUP_METRICS } },
  ])) as AggRow[];
  return toWindowStats(row, from, to);
}

/**
 * Stats for one day of a batch, counted from its start instant.
 *
 * Used by the risk monitor for "what do conditions look like on day N of this
 * stage", so it deliberately aggregates a single 24-hour slice rather than a
 * calendar day.
 */
export async function getBatchDayStats(
  batch: BatchLike,
  day: number,
): Promise<TelemetryWindowStats | null> {
  const window = getBatchWindow(batch);
  if (!window) return null;
  const from = new Date(window.from.getTime() + (day - 1) * DAY_MS);
  const to = new Date(Math.min(from.getTime() + DAY_MS, window.to.getTime()));
  if (to <= from) return null;
  return getWindowStats(from, to);
}

/**
 * Per-day stats across the whole batch, for the chart and the knowledge base.
 *
 * Buckets by elapsed-days-from-start rather than `$dateTrunc` on the calendar, so
 * the day numbering agrees with `dayOfBatch` and with the stage scheduler. A
 * 60-day batch at one reading per two minutes is roughly 43k documents, which is
 * a single indexed range scan plus a grouping stage.
 */
export async function getBatchDailyStats(batch: BatchLike): Promise<DailyStats[]> {
  const window = getBatchWindow(batch);
  if (!window) return [];

  const startMs = window.from.getTime();

  const rows = (await ReadingModel.aggregate([
    { $match: { timestamp: { $gte: window.from, $lte: window.to } } },
    {
      $group: {
        _id: {
          $floor: {
            $divide: [{ $subtract: ["$timestamp", window.from] }, DAY_MS],
          },
        },
        ...GROUP_METRICS,
      },
    },
    { $sort: { _id: 1 } },
  ])) as Array<AggRow & { _id: number }>;

  return rows.map((row) => {
    const from = new Date(startMs + row._id * DAY_MS);
    const to = new Date(Math.min(from.getTime() + DAY_MS, window.to.getTime()));
    return {
      ...toWindowStats(row, from, to),
      dayOfBatch: row._id + 1,
      date: from.toISOString(),
    };
  });
}

/**
 * Conditions at a single moment, for stamping onto a new annotation.
 *
 * Takes the nearest reading within a tolerance rather than interpolating: the
 * grower is pinning a note to an observed event, and the honest value is the
 * measurement that actually exists. Returns nulls when nothing is close enough,
 * which is also the case for a hand-entered historical batch.
 */
export async function getSnapshotAt(
  at: Date,
  toleranceMs = 15 * 60_000,
): Promise<{ temp: number | null; hum: number | null; co2: number | null; compostTemp: number | null; vpd: number | null }> {
  const empty = { temp: null, hum: null, co2: null, compostTemp: null, vpd: null };
  try {
    const doc = await ReadingModel.findOne({
      timestamp: { $gte: new Date(at.getTime() - toleranceMs), $lte: new Date(at.getTime() + toleranceMs) },
    })
      .sort({ timestamp: -1 })
      .lean();
    if (!doc) return empty;
    return {
      temp: doc.temp ?? null,
      hum: doc.hum ?? null,
      co2: doc.co2 ?? null,
      compostTemp: doc.compostTemp ?? null,
      vpd: doc.vpd ?? null,
    };
  } catch (err) {
    // A missing snapshot must not block creating the note.
    logger.warn({ err, at }, "Could not read telemetry snapshot for annotation");
    return empty;
  }
}
