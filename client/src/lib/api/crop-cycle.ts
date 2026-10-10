import { customFetch } from "./custom-fetch";
import type { AutomationSyncReport } from "./system";

export interface StageTargets {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
}

export interface CropStage {
  index: number;
  key: string;
  label: string;
  days: number;
  targets: StageTargets;
  devicesAuto: string[];
  notes: string;
}

export type BatchStatus = "planned" | "active" | "completed" | "aborted";

/** A target that differs from the previous stage; null when it is unchanged. */
export type TargetChange = { from: number; to: number } | null;

/** What actually changes on the day a stage begins. */
export interface StageChanges {
  tempMin: TargetChange;
  tempMax: TargetChange;
  co2Min: TargetChange;
  co2Max: TargetChange;
  humidityMin: TargetChange;
  humidityMax: TargetChange;
  devicesTurnedOn: string[];
  devicesTurnedOff: string[];
}

/** One stage, placed on the calendar. */
export interface ScheduledStage {
  index: number;
  key: string;
  label: string;
  days: number;
  targets: StageTargets;
  devicesAuto: string[];
  devicesParked: string[];
  notes: string;
  startsAt: string;
  /** Null for an open-ended stage (days = 0). */
  endsAt: string | null;
  /** True when the date is recorded fact, false when it is a projection. */
  actual: boolean;
  state: "done" | "current" | "upcoming";
  changes: StageChanges;
}

export type OutcomeLabel =
  | "good"
  | "partial_loss"
  | "major_loss"
  | "spoiled"
  | "contaminated"
  | "aborted";

/** How a batch turned out. This is what the risk engine weights its warnings by. */
export interface BatchOutcome {
  label: OutcomeLabel;
  yieldKg: number | null;
  gradePercent: number | null;
  notes: string;
  recordedAt: string | null;
}

export const OUTCOME_LABELS: Record<OutcomeLabel, string> = {
  good: "Healthy",
  partial_loss: "Partial loss",
  major_loss: "Major loss",
  spoiled: "Spoiled",
  contaminated: "Contaminated",
  aborted: "Abandoned",
};

export interface CropBatch {
  batchId: string;
  name: string;
  species: string;
  status: BatchStatus;
  stages: CropStage[];
  currentStageIndex: number;
  currentStageStartedAt: string | null;
  plannedStartAt: string | null;
  autoAdvance: boolean;
  startedAt: string | null;
  completedAt: string | null;
  notes: string;
  totalDaysPlanned: number;
  schedule: ScheduledStage[];
  /** Null until recorded at harvest. */
  outcome: BatchOutcome | null;
  /**
   * True for a batch entered by hand to seed the knowledge base. Such a batch has
   * no telemetry, so its notes carry manually-entered conditions instead.
   */
  imported: boolean;
  stageHistory: Array<{
    stageKey: string;
    label: string;
    index: number;
    enteredAt: string;
    leftAt: string | null;
    enteredBy: string;
  }>;
}

export type TargetStatus = "ok" | "low" | "high" | "unknown";

export interface TargetReadout {
  key: "temp" | "co2" | "humidity";
  label: string;
  unit: string;
  min: number;
  max: number;
  actual: number | null;
  status: TargetStatus;
}

export interface CropCycleStatus {
  batch: CropBatch | null;
  stage: CropStage | null;
  nextStage: CropStage | null;
  schedule: ScheduledStage[];
  progress: {
    dayOfStage: number;
    daysPlanned: number;
    stagePercent: number;
    stageEndsAt: string | null;
    daysRemainingInStage: number | null;
    dayOfBatch: number;
    totalDaysPlanned: number;
    batchPercent: number;
  } | null;
  readout: TargetReadout[];
  reading: { timestamp: string; ageSeconds: number } | null;
  ventBeforeEntry: boolean;
  devicesParked: Array<{ key: string; label: string }>;
}

export interface StageApplication {
  stage: CropStage;
  thresholdsApplied: boolean;
  devicesAuto: string[];
  devicesParked: string[];
  sync: AutomationSyncReport | null;
  warnings: string[];
}

export interface TransitionResult {
  batch: CropBatch;
  applied: StageApplication | null;
  message: string;
}

export const CROP_CYCLE_STATUS_KEY = ["crop-cycle", "status"] as const;
export const CROP_BATCHES_KEY = ["crop-cycle", "batches"] as const;

export function getCropCycleStatus(): Promise<CropCycleStatus> {
  return customFetch<CropCycleStatus>("/api/crop-cycle/status");
}

export function getDefaultStagePlan(): Promise<{ stages: CropStage[] }> {
  return customFetch<{ stages: CropStage[] }>("/api/crop-cycle/default-plan");
}

export function listCropBatches(): Promise<CropBatch[]> {
  return customFetch<CropBatch[]>("/api/crop-cycle/batches");
}

export interface CreateBatchBody {
  name: string;
  batchId?: string;
  species?: string;
  autoAdvance?: boolean;
  notes?: string;
  /** ISO date, or null to clear. Rejected on a running batch. */
  plannedStartAt?: string | null;
  stages?: Array<Omit<CropStage, "index">>;
}

export function createCropBatch(body: CreateBatchBody): Promise<CropBatch> {
  return customFetch<CropBatch>("/api/crop-cycle/batches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateCropBatch(
  batchId: string,
  body: Partial<CreateBatchBody>,
): Promise<{ batch: CropBatch; applied: StageApplication | null }> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteCropBatch(batchId: string): Promise<{ ok: true }> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}`, {
    method: "DELETE",
  });
}

export interface StagePatchBody {
  key?: string;
  label?: string;
  days?: number;
  targets?: Partial<StageTargets>;
  devicesAuto?: string[];
  notes?: string;
}

/**
 * Edits one stage. Changing `days` is also how a stage's end date is moved —
 * every later stage shifts with it, because the calendar is derived from the
 * durations rather than stored alongside them.
 */
export function patchCropStage(
  batchId: string,
  index: number,
  body: StagePatchBody,
): Promise<{ batch: CropBatch; applied: StageApplication | null }> {
  return customFetch(
    `/api/crop-cycle/batches/${encodeURIComponent(batchId)}/stages/${index}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

const DAY_MS = 86_400_000;

/**
 * Converts a picked end date into the stage length the server stores. Rounds to
 * whole days and never returns a negative, so dragging an end date before the
 * stage started collapses it to open-ended rather than corrupting the plan.
 */
export function daysFromEndDate(startsAt: string, endDate: Date): number {
  const span = endDate.getTime() - new Date(startsAt).getTime();
  return Math.max(0, Math.round(span / DAY_MS));
}

export function startCropBatch(batchId: string): Promise<TransitionResult> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}/start`, {
    method: "POST",
  });
}

export function advanceCropStage(batchId: string): Promise<TransitionResult> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}/advance`, {
    method: "POST",
  });
}

export function setCropStage(batchId: string, index: number): Promise<TransitionResult> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}/stage`, {
    method: "POST",
    body: JSON.stringify({ index }),
  });
}

export function completeCropBatch(batchId: string): Promise<TransitionResult> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}/complete`, {
    method: "POST",
  });
}

export function abortCropBatch(batchId: string, reason?: string): Promise<TransitionResult> {
  return customFetch(`/api/crop-cycle/batches/${encodeURIComponent(batchId)}/abort`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function reapplyCropStage(): Promise<StageApplication> {
  return customFetch<StageApplication>("/api/crop-cycle/reapply", { method: "POST" });
}

// ─── Presentation helpers ───────────────────────────────────────────────────

const STAGE_TONE: Record<string, string> = {
  spawn_run: "hsl(var(--chart-4))",
  case_run: "hsl(var(--chart-5))",
  pinning: "hsl(var(--chart-1))",
  fruiting: "hsl(var(--success))",
  flush_break: "hsl(var(--chart-3))",
};

export function stageColor(key: string): string {
  return STAGE_TONE[key] ?? "hsl(var(--primary))";
}

export function statusTone(status: TargetStatus): string {
  switch (status) {
    case "ok":
      return "text-[hsl(var(--success))]";
    case "low":
    case "high":
      return "text-[hsl(var(--warning))]";
    default:
      return "text-muted-foreground";
  }
}

export function formatTargetBand(readout: TargetReadout): string {
  // A band whose floor sits at or below zero reads better as a ceiling.
  if (readout.min <= 0) return `< ${readout.max} ${readout.unit}`;
  return `${readout.min}–${readout.max} ${readout.unit}`;
}

/** One-line summary of what a stage transition actually changed. */
export function describeStageApplication(applied: StageApplication | null): string {
  if (!applied) return "";
  const bits: string[] = [];
  if (applied.thresholdsApplied) {
    const t = applied.stage.targets;
    bits.push(
      `Targets ${t.tempMin}–${t.tempMax}°C · CO2 ${t.co2Min}–${t.co2Max} · RH ${t.humidityMin}–${t.humidityMax}%`,
    );
  }
  if (applied.sync?.applied.length) {
    const started = applied.sync.applied.filter((a) => a.state).length;
    const stopped = applied.sync.applied.filter((a) => !a.state).length;
    const parts: string[] = [];
    if (started) parts.push(`${started} device${started > 1 ? "s" : ""} started`);
    if (stopped) parts.push(`${stopped} stopped`);
    bits.push(parts.join(", "));
  }
  if (applied.warnings.length) bits.push(applied.warnings.join(" · "));
  return bits.join(". ");
}

// ─── Schedule presentation ──────────────────────────────────────────────────

// Device names live in the registry so a renamed device reads correctly here.
import { deviceLabel as deviceLabelFor } from "@/lib/device-registry";
export { deviceLabelFor };

/** "Aug 19" / "Aug 19, 2027" once the year differs from the reference. */
export function formatScheduleDate(iso: string, reference = new Date()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === reference.getFullYear();
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The headline for a stage row: what a grower would write on a wall planner for
 * that date. Devices first because they are the visible physical change, then
 * whichever target bands actually moved.
 */
export function describeStageChanges(changes: StageChanges): string {
  const bits: string[] = [];

  if (changes.devicesTurnedOn.length > 0) {
    bits.push(`${changes.devicesTurnedOn.map(deviceLabelFor).join(", ")} on`);
  }
  if (changes.devicesTurnedOff.length > 0) {
    bits.push(`${changes.devicesTurnedOff.map(deviceLabelFor).join(", ")} off`);
  }

  const band = (
    min: TargetChange,
    max: TargetChange,
    label: string,
    unit: string,
  ): void => {
    if (!min && !max) return;
    // Show the whole new band, not just the end that moved — "17–19°C" is what
    // the grower needs to know, and half a band is not actionable.
    bits.push(`${label} → ${(min ?? max)!.to}–${(max ?? min)!.to}${unit}`);
  };

  band(changes.tempMin, changes.tempMax, "temp", "°C");
  band(changes.co2Min, changes.co2Max, "CO2", "ppm");
  band(changes.humidityMin, changes.humidityMax, "RH", "%");

  return bits.join(" · ");
}

/** Whole days from now until `iso`; negative once it has passed. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}
