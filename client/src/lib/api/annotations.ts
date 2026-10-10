import { customFetch } from "./custom-fetch";

/**
 * Batch annotations and the predictive risk alerts derived from them.
 *
 * Query keys are exported so mutations elsewhere (creating a note, resolving an
 * alert) can invalidate the right caches without re-deriving the key shape.
 */

export const ANNOTATION_CATEGORIES = [
  "issue",
  "milestone",
  "contamination",
  "temp_spike",
  "humidity",
  "co2",
  "pest",
  "harvest",
  "other",
] as const;
export type AnnotationCategory = (typeof ANNOTATION_CATEGORIES)[number];

export const ANNOTATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type AnnotationSeverity = (typeof ANNOTATION_SEVERITIES)[number];

/** Human labels for the tag chips; keys stay stable for storage and filtering. */
export const CATEGORY_LABELS: Record<AnnotationCategory, string> = {
  issue: "Issue",
  milestone: "Milestone",
  contamination: "Contamination",
  temp_spike: "Temp spike",
  humidity: "Humidity",
  co2: "CO₂",
  pest: "Pest",
  harvest: "Harvest",
  other: "Other",
};

export const SEVERITY_LABELS: Record<AnnotationSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export interface AnnotationSnapshot {
  temp?: number | null;
  hum?: number | null;
  co2?: number | null;
  compostTemp?: number | null;
  vpd?: number | null;
}

export interface AnnotationTargets {
  tempMin?: number | null;
  tempMax?: number | null;
  co2Min?: number | null;
  co2Max?: number | null;
  humidityMin?: number | null;
  humidityMax?: number | null;
}

export interface BatchAnnotation {
  id: string;
  batchId: string;
  at: string;
  dayOfBatch: number;
  stageKey: string;
  stageLabel: string;
  stageIndex: number;
  dayOfStage: number;
  category: AnnotationCategory;
  severity: AnnotationSeverity;
  title: string;
  note: string;
  snapshot: AnnotationSnapshot;
  targets: AnnotationTargets;
  imageIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export const annotationsKey = (batchId: string) => ["annotations", batchId] as const;
export const KNOWLEDGE_BASE_KEY = ["annotations", "search"] as const;
export const RISK_ALERTS_KEY = ["risk", "alerts"] as const;

export interface CreateAnnotationInput {
  batchId: string;
  at: string;
  category: AnnotationCategory;
  severity: AnnotationSeverity;
  title: string;
  note?: string;
  imageIds?: string[];
  /** Supply manually when importing a past batch that has no telemetry. */
  snapshot?: AnnotationSnapshot;
}

export function createAnnotation(input: CreateAnnotationInput): Promise<BatchAnnotation> {
  return customFetch<BatchAnnotation>("/api/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Every note for a batch, in time order — drives the chart overlay. */
export function listBatchAnnotations(batchId: string): Promise<BatchAnnotation[]> {
  return customFetch<BatchAnnotation[]>(
    `/api/batches/${encodeURIComponent(batchId)}/annotations`,
  );
}

export interface AnnotationFilter {
  batchId?: string;
  category?: AnnotationCategory;
  severity?: AnnotationSeverity;
  stageKey?: string;
  q?: string;
  metric?: "temp" | "hum" | "co2" | "compostTemp" | "vpd";
  gte?: number;
  lte?: number;
  limit?: number;
}

/** Knowledge-base search. Filters compose; all are optional. */
export function searchAnnotations(filter: AnnotationFilter): Promise<BatchAnnotation[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== "" && value !== null) {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return customFetch<BatchAnnotation[]>(`/api/annotations${query ? `?${query}` : ""}`);
}

export interface UpdateAnnotationInput {
  category?: AnnotationCategory;
  severity?: AnnotationSeverity;
  title?: string;
  note?: string;
  imageIds?: string[];
  snapshot?: AnnotationSnapshot;
}

/**
 * Edits the content of a note. The pinned moment and its stage position are not
 * editable — they record where in the crop this happened. Move a pin by deleting
 * and re-creating it.
 */
export function updateAnnotation(
  id: string,
  patch: UpdateAnnotationInput,
): Promise<BatchAnnotation> {
  return customFetch<BatchAnnotation>(`/api/annotations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteAnnotation(id: string): Promise<{ deleted: boolean }> {
  return customFetch<{ deleted: boolean }>(`/api/annotations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Uploads before the note is saved, so a thumbnail can show while typing. */
export function uploadAnnotationImage(
  batchId: string,
  dataUrl: string,
): Promise<{ id: string; byteSize: number }> {
  return customFetch<{ id: string; byteSize: number }>("/api/annotation-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId, dataUrl }),
  });
}

/** Served as raw bytes, so it can go straight in an <img src>. */
export function annotationImageUrl(id: string): string {
  return `/api/annotation-images/${encodeURIComponent(id)}`;
}

// ─── Risk alerts ─────────────────────────────────────────────────────────────

export interface RiskMetric {
  metric: "temp" | "hum" | "co2" | "compostTemp" | "vpd";
  direction: "high" | "low";
  currentValue: number;
  historicalValue: number;
  bandMin: number;
  bandMax: number;
  currentDeviation: number;
  historicalDeviation: number;
  /** Above 1 means conditions are already worse than the past incident. */
  ratio: number;
  explanation: string;
}

export interface RiskAlert {
  id: string;
  dedupeKey: string;
  batchId: string;
  stageKey: string;
  stageLabel: string;
  dayOfStage: number;
  dayOfBatch: number;
  source: {
    annotationId: string;
    batchId: string;
    batchName: string;
    stageLabel: string;
    dayOfStage: number;
    severity: AnnotationSeverity;
    outcome: string | null;
  };
  score: number;
  stageAligned: boolean;
  dayGap: number;
  metrics: RiskMetric[];
  headline: string;
  advice: string;
  state: "active" | "acknowledged" | "dismissed";
  firedAt: string | null;
  resolvedAt: string | null;
}

export function listRiskAlerts(
  state: RiskAlert["state"] = "active",
): Promise<RiskAlert[]> {
  return customFetch<RiskAlert[]>(`/api/risk/alerts?state=${state}`);
}

export function resolveRiskAlert(
  id: string,
  state: "acknowledged" | "dismissed",
): Promise<RiskAlert> {
  return customFetch<RiskAlert>(`/api/risk/alerts/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

/**
 * Why a check produced nothing. Distinguishing these matters: an empty knowledge
 * base and a clean bill of health look identical otherwise.
 */
export type RiskCheckReason =
  | "no-active-batch"
  | "batch-not-started"
  | "no-current-stage"
  | "no-telemetry-today"
  | "no-comparable-metrics"
  | "no-history";

export interface RiskCheckResponse {
  checked: boolean;
  reason: RiskCheckReason | null;
  created: number;
  matches: Array<{
    score: number;
    headline: string;
    advice: string;
    stageAligned: boolean;
    dayGap: number;
    metrics: RiskMetric[];
    source: {
      annotationId: string;
      batchId: string;
      batchName: string;
      severity: AnnotationSeverity;
      outcome: string | null;
    };
  }>;
}

/** Runs a check now rather than waiting for the half-hourly tick. */
export function runRiskCheck(): Promise<RiskCheckResponse> {
  return customFetch<RiskCheckResponse>("/api/risk/check", { method: "POST" });
}

/** Grower-facing explanation for a check that could not produce a verdict. */
export function describeRiskReason(reason: RiskCheckReason | null): string {
  switch (reason) {
    case "no-active-batch":
      return "No batch is running, so there is nothing to compare.";
    case "batch-not-started":
      return "The batch has not been started yet.";
    case "no-current-stage":
      return "The running batch has no current stage.";
    case "no-telemetry-today":
      return "No sensor readings stored for today yet.";
    case "no-comparable-metrics":
      return "Today's readings are missing the values needed to compare.";
    case "no-history":
      return "No past problems logged yet — import a previous batch to give the engine something to learn from.";
    default:
      return "Conditions do not match any past problem.";
  }
}
