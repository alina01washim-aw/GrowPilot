/**
 * Predictive risk matching: does the running batch look like a past failure?
 *
 * Pure and zero-import by design, following the pattern `activeStage.ts`
 * documents — a `node --test` file can only import modules whose whole graph
 * avoids extensionless imports, so keeping the decision logic free of models is
 * what makes it testable at all.
 *
 * Two ideas do the real work here.
 *
 * 1. Deviations are measured in *band-widths outside the stage's own target
 *    band*, never in absolute units. 96% humidity is unremarkable during a spawn
 *    run and dangerous during fruiting; an absolute threshold cannot express
 *    that, but "0.8 band-widths above the ceiling" compares correctly across
 *    batches whose plans differ.
 *
 * 2. Incidents are matched by crop stage and day-within-stage, not by day of
 *    batch. Day 8 of one plan is spawn run and of another is pinning, so a
 *    day-number match would compare unrelated phases. Day-of-batch is only a
 *    fallback when the stages genuinely differ.
 *
 * A match must agree in *direction*. A past disaster caused by air that was too
 * dry tells you nothing when today's air is too wet, so opposite-sign deviations
 * are rejected rather than scored low.
 */

export type MetricKey = "temp" | "hum" | "co2" | "compostTemp" | "vpd";

export type Severity = "info" | "warning" | "critical";

export type OutcomeLabel =
  | "good"
  | "partial_loss"
  | "major_loss"
  | "spoiled"
  | "contaminated"
  | "aborted";

export interface TargetBand {
  min: number;
  max: number;
}

export interface MetricSample {
  metric: MetricKey;
  value: number;
  band: TargetBand;
}

export interface BatchOutcome {
  label: OutcomeLabel;
  yieldKg: number | null;
  gradePercent: number | null;
}

/** A logged problem from a past batch, with the conditions at the time. */
export interface HistoricalIncident {
  annotationId: string;
  batchId: string;
  batchName: string;
  stageKey: string;
  stageLabel: string;
  dayOfStage: number;
  dayOfBatch: number;
  severity: Severity;
  category: string;
  title: string;
  samples: MetricSample[];
  outcome: BatchOutcome | null;
}

export interface CurrentState {
  batchId: string;
  stageKey: string;
  stageLabel: string;
  dayOfStage: number;
  dayOfBatch: number;
  samples: MetricSample[];
}

export interface MetricMatch {
  metric: MetricKey;
  direction: "high" | "low";
  currentValue: number;
  historicalValue: number;
  band: TargetBand;
  /** Band-widths outside the band; sign carries the direction. */
  currentDeviation: number;
  historicalDeviation: number;
  /** 1.0 means as far out of band as last time; above 1 means worse. */
  ratio: number;
  explanation: string;
}

export interface RiskMatch {
  incident: HistoricalIncident;
  /** 0..1. Compared against `minScore` to decide whether to warn. */
  score: number;
  stageAligned: boolean;
  dayGap: number;
  metrics: MetricMatch[];
  headline: string;
  advice: string;
  /** Stable across ticks, so the same warning is not raised twice. */
  dedupeKey: string;
}

export interface RiskOptions {
  /** Fraction of the historical deviation the present must reach to count. */
  matchFraction: number;
  /** Score below which a match is not worth interrupting anyone for. */
  minScore: number;
  /** Weakest historical severity worth learning from. */
  minSeverity: Severity;
  /** Day distance at which proximity confidence has halved. */
  dayTolerance: number;
}

export const DEFAULT_RISK_OPTIONS: RiskOptions = {
  matchFraction: 0.6,
  // Calibrated against the cases that should and should not warn:
  //   critical + spoiled + same stage-day    ~0.79  warn
  //   critical + outcome not yet recorded    ~0.42  warn (a critical note at
  //                                                 exactly this point matters
  //                                                 even before the harvest is in)
  //   warning  + partial loss + same day     ~0.35  warn, marginally
  //   warning  + batch finished healthy      ~0.09  stay quiet
  // 0.45 would have silenced the unrecorded-outcome case, which is the most
  // common state for a batch still in progress.
  minScore: 0.35,
  minSeverity: "warning",
  dayTolerance: 3,
};

// A degenerate band (min === max) would divide by zero. Treating it as a very
// narrow band means any deviation reads as large, which is the correct reading of
// "this value must be exactly N".
const MIN_BAND_WIDTH = 1e-6;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0.25,
  warning: 0.7,
  critical: 1,
};

/**
 * How much a past outcome should make us care. A note on a batch that turned out
 * fine is a weak signal — the grower recorded a worry that did not materialise —
 * whereas spoilage is the strongest evidence available.
 */
const OUTCOME_WEIGHT: Record<OutcomeLabel, number> = {
  good: 0.15,
  partial_loss: 0.6,
  aborted: 0.8,
  contaminated: 0.9,
  major_loss: 0.95,
  spoiled: 1,
};

// No outcome recorded yet: not evidence of safety, so mid-weight rather than low.
const UNKNOWN_OUTCOME_WEIGHT = 0.5;

const METRIC_LABEL: Record<MetricKey, string> = {
  temp: "Air temperature",
  hum: "Humidity",
  co2: "CO2",
  compostTemp: "Compost temperature",
  vpd: "VPD",
};

const METRIC_UNIT: Record<MetricKey, string> = {
  temp: "°C",
  hum: "%",
  co2: " ppm",
  compostTemp: "°C",
  vpd: " kPa",
};

function bandWidth(band: TargetBand): number {
  return Math.max(band.max - band.min, MIN_BAND_WIDTH);
}

/**
 * How far outside its target band a value sits, in band-widths.
 * Positive above the ceiling, negative below the floor, zero inside.
 */
export function deviation(value: number, band: TargetBand): number {
  if (!Number.isFinite(value)) return 0;
  const width = bandWidth(band);
  if (value > band.max) return (value - band.max) / width;
  if (value < band.min) return (value - band.min) / width;
  return 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatValue(metric: MetricKey, value: number): string {
  const digits = metric === "co2" ? 0 : metric === "vpd" ? 3 : 1;
  return `${round(value, digits)}${METRIC_UNIT[metric]}`;
}

/**
 * Pairs one metric across then and now. Returns null when there is nothing to
 * learn: the past value was in band, the present is in band, the directions
 * disagree, or the present is not yet close enough to the past deviation.
 */
function matchMetric(
  current: MetricSample,
  historical: MetricSample,
  options: RiskOptions,
): MetricMatch | null {
  const historicalDeviation = deviation(historical.value, historical.band);
  if (historicalDeviation === 0) return null;

  const currentDeviation = deviation(current.value, current.band);
  if (currentDeviation === 0) return null;
  if (Math.sign(currentDeviation) !== Math.sign(historicalDeviation)) return null;

  const magnitude = Math.abs(currentDeviation);
  const historicalMagnitude = Math.abs(historicalDeviation);
  if (magnitude < historicalMagnitude * options.matchFraction) return null;

  const direction: "high" | "low" = currentDeviation > 0 ? "high" : "low";
  const edge = direction === "high" ? current.band.max : current.band.min;
  const label = METRIC_LABEL[current.metric];
  const overshoot = Math.abs(current.value - edge);

  return {
    metric: current.metric,
    direction,
    currentValue: current.value,
    historicalValue: historical.value,
    band: current.band,
    currentDeviation: round(currentDeviation, 2),
    historicalDeviation: round(historicalDeviation, 2),
    ratio: round(magnitude / historicalMagnitude, 2),
    explanation:
      `${label} is ${formatValue(current.metric, overshoot)} ` +
      `${direction === "high" ? "above" : "below"} the ` +
      `${formatValue(current.metric, edge)} target, ` +
      `against ${formatValue(historical.metric, historical.value)} last time`,
  };
}

function outcomeWeight(outcome: BatchOutcome | null): number {
  if (!outcome) return UNKNOWN_OUTCOME_WEIGHT;
  return OUTCOME_WEIGHT[outcome.label] ?? UNKNOWN_OUTCOME_WEIGHT;
}

function describeOutcome(outcome: BatchOutcome | null): string {
  if (!outcome) return "outcome not recorded";
  const parts: string[] = [];
  switch (outcome.label) {
    case "good":
      parts.push("finished healthy");
      break;
    case "partial_loss":
      parts.push("lost part of the crop");
      break;
    case "major_loss":
      parts.push("lost most of the crop");
      break;
    case "spoiled":
      parts.push("spoiled");
      break;
    case "contaminated":
      parts.push("was contaminated");
      break;
    case "aborted":
      parts.push("was abandoned");
      break;
  }
  if (outcome.gradePercent != null) {
    parts.push(`${round(outcome.gradePercent, 0)}% marketable`);
  } else if (outcome.yieldKg != null) {
    parts.push(`${round(outcome.yieldKg, 1)} kg`);
  }
  return parts.join(", ");
}

/**
 * Scores one historical incident against the present. Null when it does not
 * match at all, or matches too weakly to be worth raising.
 */
export function scoreIncident(
  current: CurrentState,
  incident: HistoricalIncident,
  options: RiskOptions = DEFAULT_RISK_OPTIONS,
): RiskMatch | null {
  if (SEVERITY_RANK[incident.severity] < SEVERITY_RANK[options.minSeverity]) return null;
  // Never match a batch against its own logged notes.
  if (incident.batchId === current.batchId) return null;

  const byMetric = new Map(incident.samples.map((s) => [s.metric, s]));
  const metrics: MetricMatch[] = [];
  for (const sample of current.samples) {
    const historical = byMetric.get(sample.metric);
    if (!historical) continue;
    const match = matchMetric(sample, historical, options);
    if (match) metrics.push(match);
  }
  if (metrics.length === 0) return null;

  const stageAligned = incident.stageKey === current.stageKey;
  const dayGap = stageAligned
    ? Math.abs(current.dayOfStage - incident.dayOfStage)
    : Math.abs(current.dayOfBatch - incident.dayOfBatch);

  // Strongest single metric drives the score; extra agreeing metrics corroborate
  // it but must not let a pile of weak signals outrank one severe one.
  const strongest = metrics.reduce((best, m) => (m.ratio > best.ratio ? m : best), metrics[0]!);
  const baseStrength = Math.min(1, strongest.ratio);
  // Bounded above 1 on purpose: two metrics agreeing is stronger evidence than
  // one. Capping this at 1 (as an earlier version did) silently disabled
  // corroboration entirely.
  const corroboration = Math.min(1.3, 1 + 0.15 * (metrics.length - 1));

  const proximity = 1 / (1 + dayGap / Math.max(options.dayTolerance, 1));
  const stageFactor = stageAligned ? 1 : 0.6;

  const score = Math.min(
    1,
    baseStrength *
      corroboration *
      SEVERITY_WEIGHT[incident.severity] *
      outcomeWeight(incident.outcome) *
      proximity *
      stageFactor,
  );

  if (score < options.minScore) return null;

  const worse = strongest.ratio > 1;
  const headline =
    `${METRIC_LABEL[strongest.metric]} ${strongest.direction === "high" ? "high" : "low"} ` +
    `in ${current.stageLabel}${worse ? " — already worse than" : " — matching"} ` +
    `"${incident.batchName}" (${incident.stageLabel}, day ${incident.dayOfStage})`;

  const advice =
    `${incident.title || incident.category} was logged at this point in ` +
    `"${incident.batchName}", which ${describeOutcome(incident.outcome)}. ` +
    `${metrics.map((m) => m.explanation).join("; ")}.`;

  return {
    incident,
    score: round(score, 3),
    stageAligned,
    dayGap,
    metrics,
    headline,
    advice,
    dedupeKey: buildDedupeKey(current, incident, metrics),
  };
}

/**
 * Identity of a warning. Includes the metrics so a new problem appearing on the
 * same stage-day still surfaces, but excludes the score so a small drift in
 * severity does not read as a fresh alert.
 */
export function buildDedupeKey(
  current: CurrentState,
  incident: HistoricalIncident,
  metrics: MetricMatch[],
): string {
  const keys = metrics.map((m) => m.metric).sort().join(",");
  return [
    current.batchId,
    current.stageKey,
    String(current.dayOfStage),
    keys,
    incident.annotationId,
  ].join("|");
}

/**
 * All incidents worth warning about, strongest first.
 *
 * With no history this returns nothing, which is the honest answer rather than a
 * guess: the engine can only recognise patterns it has been shown.
 */
export function findRisks(
  current: CurrentState,
  history: readonly HistoricalIncident[],
  options: RiskOptions = DEFAULT_RISK_OPTIONS,
): RiskMatch[] {
  const matches: RiskMatch[] = [];
  for (const incident of history) {
    const match = scoreIncident(current, incident, options);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score);
}
