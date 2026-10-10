import {
  CropBatchModel,
  DEFAULT_STAGE_PLAN,
  CO2_ENTRY_WARNING_PPM,
  MAX_STAGE_DAYS,
  type CropStage,
  type BatchStatus,
  type OutcomeLabel,
} from "../models/cropBatch";
import { DEFAULT_RELAY_MAP } from "../models/deviceProfile";
import { updateSettings } from "./settingsControl";
import { applyDeviceMode, applyDeviceState, getDeviceLabels, DEFAULT_PROFILE_ID } from "./deviceControl";
import { publishRulePayload } from "./ruleControl";
import { invalidateActiveStageCache } from "./activeStage";
import { getLatestSensorSnapshot } from "./ruleEvaluator";
import { isAutomationPaused } from "./automationControl";
import {
  syncAutomationToSensors,
  scheduleRetryIfUnsettled,
  type AutomationSyncReport,
} from "./automationSync";
import { logger } from "./logger";
import { buildSchedule, DAY_MS, type ScheduledStage } from "./cropSchedule";

/**
 * The crop cycle engine.
 *
 * Entering a stage is the one operation that matters here, and it is a real
 * reconfiguration of the whole controller, in this order:
 *
 *   1. the stage's targets become the live thresholds (which publishes them to
 *      the ESP, so the edge keeps them even if the backend goes away),
 *   2. devices the stage does not use are parked in MANUAL and switched off,
 *      devices it does use go to AUTO,
 *   3. the rule payload is re-published — now filtered to this stage's rules,
 *   4. the relays are driven to match the new targets immediately, instead of
 *      waiting for the next sensor message.
 *
 * Steps 1-3 are configuration and always run. Step 4 is a physical action and
 * is skipped while an emergency stop is active.
 */

const ALL_DEVICE_KEYS = DEFAULT_RELAY_MAP.map((d) => d.key);

// ─── Views ───────────────────────────────────────────────────────────────────

export interface StageView {
  index: number;
  key: string;
  label: string;
  days: number;
  targets: CropStage["targets"];
  devicesAuto: string[];
  notes: string;
}

export interface BatchView {
  batchId: string;
  name: string;
  species: string;
  status: BatchStatus;
  stages: StageView[];
  currentStageIndex: number;
  currentStageStartedAt: string | null;
  plannedStartAt: string | null;
  autoAdvance: boolean;
  startedAt: string | null;
  completedAt: string | null;
  notes: string;
  totalDaysPlanned: number;
  /** Dated plan: when each stage runs and what changes when it begins. */
  schedule: ScheduledStage[];
  /** How the batch ended. Null until recorded; weights risk warnings. */
  outcome: {
    label: string;
    yieldKg: number | null;
    gradePercent: number | null;
    notes: string;
    recordedAt: string | null;
  } | null;
  /** True for a batch entered by hand to seed the knowledge base. */
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

/** A numeric target that differs from the previous stage. */
export type { TargetChange, StageChanges, ScheduledStage } from "./cropSchedule";


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
  batch: BatchView | null;
  stage: StageView | null;
  nextStage: StageView | null;
  /**
   * The dated plan. Empty when no batch is running — the dashboard shows this
   * directly, so it comes back on the same call as the rest of the status.
   */
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
  /** Stage keeps CO2 high enough that the room must be vented before entry. */
  ventBeforeEntry: boolean;
  /** Devices this stage deliberately leaves switched off. */
  devicesParked: Array<{ key: string; label: string }>;
}

function toStageView(stage: CropStage, index: number): StageView {
  return {
    index,
    key: stage.key,
    label: stage.label,
    days: stage.days,
    targets: {
      tempMin: stage.targets.tempMin,
      tempMax: stage.targets.tempMax,
      co2Min: stage.targets.co2Min,
      co2Max: stage.targets.co2Max,
      humidityMin: stage.targets.humidityMin,
      humidityMax: stage.targets.humidityMax,
    },
    devicesAuto: stage.devicesAuto ?? [],
    notes: stage.notes ?? "",
  };
}

function toBatchView(doc: {
  batchId: string;
  name: string;
  species?: string | null;
  status: string;
  stages: CropStage[];
  currentStageIndex: number;
  currentStageStartedAt?: Date | null;
  plannedStartAt?: Date | null;
  autoAdvance: boolean;
  startedAt?: Date | null;
  completedAt?: Date | null;
  notes?: string | null;
  outcome?: {
    label: string;
    yieldKg?: number | null;
    gradePercent?: number | null;
    notes?: string | null;
    recordedAt?: Date | null;
  } | null;
  imported?: boolean | null;
  stageHistory?: Array<{
    stageKey: string;
    label: string;
    index: number;
    enteredAt: Date;
    leftAt?: Date | null;
    enteredBy: string;
  }> | null;
}): BatchView {
  const stages = doc.stages.map(toStageView);
  const history = (doc.stageHistory ?? []).map((h) => ({
    stageKey: h.stageKey,
    label: h.label,
    index: h.index,
    enteredAt: h.enteredAt.toISOString(),
    leftAt: h.leftAt?.toISOString() ?? null,
    enteredBy: h.enteredBy,
  }));

  return {
    batchId: doc.batchId,
    name: doc.name,
    species: doc.species ?? "Agaricus bisporus",
    status: doc.status as BatchStatus,
    stages,
    currentStageIndex: doc.currentStageIndex,
    currentStageStartedAt: doc.currentStageStartedAt?.toISOString() ?? null,
    plannedStartAt: doc.plannedStartAt?.toISOString() ?? null,
    autoAdvance: doc.autoAdvance,
    startedAt: doc.startedAt?.toISOString() ?? null,
    completedAt: doc.completedAt?.toISOString() ?? null,
    notes: doc.notes ?? "",
    totalDaysPlanned: doc.stages.reduce((sum, s) => sum + (s.days ?? 0), 0),
    schedule: scheduleFor({
      stages,
      status: doc.status as BatchStatus,
      currentStageIndex: doc.currentStageIndex,
      currentStageStartedAt: doc.currentStageStartedAt ?? null,
      startedAt: doc.startedAt ?? null,
      plannedStartAt: doc.plannedStartAt ?? null,
      stageHistory: doc.stageHistory ?? [],
    }),
    outcome: doc.outcome
      ? {
          label: doc.outcome.label,
          yieldKg: doc.outcome.yieldKg ?? null,
          gradePercent: doc.outcome.gradePercent ?? null,
          notes: doc.outcome.notes ?? "",
          recordedAt: doc.outcome.recordedAt?.toISOString() ?? null,
        }
      : null,
    imported: doc.imported ?? false,
    stageHistory: history,
  };
}

// ─── Dated schedule ──────────────────────────────────────────────────────────
//
// The arithmetic lives in `cropSchedule.ts`, which is dependency-free so it can
// be unit-tested without a database. This file only supplies the device registry
// and the persisted batch.

function scheduleFor(batch: {
  stages: StageView[];
  status: BatchStatus;
  currentStageIndex: number;
  currentStageStartedAt: Date | null;
  startedAt: Date | null;
  plannedStartAt: Date | null;
  stageHistory: Array<{ index: number; enteredAt: Date }>;
}): ScheduledStage[] {
  return buildSchedule(batch, ALL_DEVICE_KEYS);
}


// ─── Validation ──────────────────────────────────────────────────────────────

export class CropCycleError extends Error {}

interface StageHistoryEntry {
  stageKey: string;
  label: string;
  index: number;
  enteredAt: Date;
  leftAt: Date | null;
  enteredBy: "start" | "auto" | "manual";
}

/**
 * Copies a document's stage history into plain objects so new entries can be
 * appended — a hydrated Mongoose document array only accepts subdocuments.
 */
function toHistoryEntries(
  raw: Array<{
    stageKey: string;
    label: string;
    index: number;
    enteredAt: Date;
    leftAt?: Date | null;
    enteredBy: string;
  }> | null | undefined,
): StageHistoryEntry[] {
  return (raw ?? []).map((h) => ({
    stageKey: h.stageKey,
    label: h.label,
    index: h.index,
    enteredAt: h.enteredAt,
    leftAt: h.leftAt ?? null,
    enteredBy: h.enteredBy as StageHistoryEntry["enteredBy"],
  }));
}

/** Closes the currently-open history entry, if there is one. */
function closeOpenEntry(history: StageHistoryEntry[], at: Date): void {
  const open = history[history.length - 1];
  if (open && !open.leftAt) open.leftAt = at;
}

function assertStagesSane(stages: CropStage[]): void {
  if (stages.length === 0) {
    throw new CropCycleError("A batch needs at least one stage");
  }
  for (const [i, stage] of stages.entries()) {
    const where = `Stage ${i + 1} (${stage.label || stage.key || "unnamed"})`;
    if (!stage.key?.trim()) throw new CropCycleError(`${where}: stage key is required`);
    if (!stage.label?.trim()) throw new CropCycleError(`${where}: label is required`);
    if (!Number.isFinite(stage.days) || stage.days < 0) {
      throw new CropCycleError(`${where}: days must be 0 or more`);
    }
    if (stage.days > MAX_STAGE_DAYS) {
      throw new CropCycleError(
        `${where}: ${stage.days} days is not a real stage length (max ${MAX_STAGE_DAYS})`,
      );
    }
    const t = stage.targets;
    if (!t) throw new CropCycleError(`${where}: targets are required`);
    if (t.tempMin >= t.tempMax) throw new CropCycleError(`${where}: temp min must be below max`);
    if (t.co2Min >= t.co2Max) throw new CropCycleError(`${where}: CO2 min must be below max`);
    if (t.humidityMin >= t.humidityMax) {
      throw new CropCycleError(`${where}: humidity min must be below max`);
    }
    if (t.humidityMin < 0 || t.humidityMax > 100) {
      throw new CropCycleError(`${where}: humidity must be within 0-100%`);
    }
    for (const device of stage.devicesAuto ?? []) {
      if (!ALL_DEVICE_KEYS.includes(device as never)) {
        throw new CropCycleError(`${where}: unknown device "${device}"`);
      }
    }
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listBatches(): Promise<BatchView[]> {
  const docs = await CropBatchModel.find()
    .sort({ status: 1, startedAt: -1, createdAt: -1 })
    .lean();
  return docs.map((d) => toBatchView(d as never));
}

export async function getBatch(batchId: string): Promise<BatchView | null> {
  const doc = await CropBatchModel.findOne({ batchId }).lean();
  return doc ? toBatchView(doc as never) : null;
}

export function getDefaultStagePlan(): StageView[] {
  return DEFAULT_STAGE_PLAN.map(toStageView);
}

function readTarget(
  key: TargetReadout["key"],
  label: string,
  unit: string,
  min: number,
  max: number,
  actual: number | undefined,
): TargetReadout {
  if (actual == null) {
    return { key, label, unit, min, max, actual: null, status: "unknown" };
  }
  const status: TargetStatus = actual < min ? "low" : actual > max ? "high" : "ok";
  return { key, label, unit, min, max, actual, status };
}

/** Everything the dashboard card and the crop cycle page need, in one call. */
export async function getCropCycleStatus(): Promise<CropCycleStatus> {
  const doc = await CropBatchModel.findOne({ status: "active" }).lean();

  if (!doc) {
    return {
      batch: null,
      stage: null,
      nextStage: null,
      schedule: [],
      progress: null,
      readout: [],
      reading: null,
      ventBeforeEntry: false,
      devicesParked: [],
    };
  }

  const batch = toBatchView(doc as never);
  const stage = batch.stages[batch.currentStageIndex] ?? null;
  const nextStage = batch.stages[batch.currentStageIndex + 1] ?? null;

  const snapshot = await getLatestSensorSnapshot();
  const now = Date.now();

  const readout: TargetReadout[] = stage
    ? [
        readTarget("temp", "Air temp", "°C", stage.targets.tempMin, stage.targets.tempMax, snapshot?.values.air_temp),
        readTarget("co2", "CO2", "ppm", stage.targets.co2Min, stage.targets.co2Max, snapshot?.values.co2),
        readTarget("humidity", "Humidity", "%", stage.targets.humidityMin, stage.targets.humidityMax, snapshot?.values.humidity),
      ]
    : [];

  let progress: CropCycleStatus["progress"] = null;
  if (stage && doc.currentStageStartedAt) {
    const stageStart = doc.currentStageStartedAt.getTime();
    const elapsedMs = Math.max(0, now - stageStart);
    const dayOfStage = Math.floor(elapsedMs / DAY_MS) + 1;
    const stageEndsAt = stage.days > 0 ? new Date(stageStart + stage.days * DAY_MS) : null;

    // Days completed in earlier stages, from the plan rather than the clock, so
    // an early manual advance still reads as "day N of the plan".
    const daysBefore = batch.stages
      .slice(0, batch.currentStageIndex)
      .reduce((sum, s) => sum + s.days, 0);

    progress = {
      dayOfStage,
      daysPlanned: stage.days,
      stagePercent:
        stage.days > 0 ? Math.min(100, Math.round((elapsedMs / (stage.days * DAY_MS)) * 100)) : 0,
      stageEndsAt: stageEndsAt?.toISOString() ?? null,
      daysRemainingInStage: stageEndsAt
        ? Math.max(0, Math.ceil((stageEndsAt.getTime() - now) / DAY_MS))
        : null,
      dayOfBatch: daysBefore + dayOfStage,
      totalDaysPlanned: batch.totalDaysPlanned,
      batchPercent:
        batch.totalDaysPlanned > 0
          ? Math.min(100, Math.round(((daysBefore + dayOfStage) / batch.totalDaysPlanned) * 100))
          : 0,
    };
  }

  // Labels come from the profile, not the seed constant, so a device the grower
  // has renamed is named correctly here too.
  const deviceLabels = await getDeviceLabels();
  const devicesParked = stage
    ? ALL_DEVICE_KEYS.filter((key) => !stage.devicesAuto.includes(key)).map((key) => ({
        key,
        label: deviceLabels.get(key) ?? key,
      }))
    : [];

  return {
    batch,
    stage,
    nextStage,
    schedule: batch.schedule,
    progress,
    readout,
    reading: snapshot
      ? {
          timestamp: snapshot.timestamp.toISOString(),
          ageSeconds: Math.max(0, Math.round((now - snapshot.timestamp.getTime()) / 1000)),
        }
      : null,
    ventBeforeEntry: stage ? stage.targets.co2Max > CO2_ENTRY_WARNING_PPM : false,
    devicesParked,
  };
}

// ─── Stage application ───────────────────────────────────────────────────────

export interface StageApplication {
  stage: StageView;
  thresholdsApplied: boolean;
  devicesAuto: string[];
  devicesParked: string[];
  sync: AutomationSyncReport | null;
  warnings: string[];
}

/**
 * Makes a stage the live configuration of the controller. Safe to call again
 * for the same stage — it is how the grower re-asserts a stage after editing
 * its targets.
 */
export async function applyStage(stage: StageView): Promise<StageApplication> {
  const warnings: string[] = [];

  // 1. Targets become the live thresholds (and get published to the ESP).
  let thresholdsApplied = false;
  try {
    await updateSettings({
      tempMin: stage.targets.tempMin,
      tempMax: stage.targets.tempMax,
      co2Min: stage.targets.co2Min,
      co2Max: stage.targets.co2Max,
      humidityMin: stage.targets.humidityMin,
      humidityMax: stage.targets.humidityMax,
    });
    thresholdsApplied = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, stage: stage.key }, "Stage change could not apply thresholds");
    warnings.push(`Thresholds not applied: ${message}`);
  }

  // 2. Devices the stage uses go to AUTO; the rest are parked OFF so nothing
  //    carries over from the previous stage.
  const devicesAuto: string[] = [];
  const devicesParked: string[] = [];
  const deviceLabels = await getDeviceLabels();

  for (const key of ALL_DEVICE_KEYS) {
    const shouldAutomate = stage.devicesAuto.includes(key);
    try {
      await applyDeviceMode(key, shouldAutomate ? "auto" : "manual");
      if (shouldAutomate) {
        devicesAuto.push(key);
      } else {
        // Labelled "auto" in the runtime history on purpose: the stage change
        // switched this off, not a person at the dashboard. The device is left in
        // MANUAL mode so nothing restarts it, but the history should attribute
        // the shutdown to automation.
        await applyDeviceState(key, false, "auto", { historySource: "auto" });
        devicesParked.push(key);
      }
    } catch (err) {
      logger.error({ err, device: key, stage: stage.key }, "Stage change could not set device");
      warnings.push(`${deviceLabels.get(key) ?? key}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  // 3. Republish the rule set, now filtered to this stage.
  invalidateActiveStageCache();
  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Stage change could not publish rules");
    warnings.push("Rules were not published to the device");
  });

  // 4. Drive the relays to the new targets now, unless we are stopped.
  let sync: AutomationSyncReport | null = null;
  if (await isAutomationPaused()) {
    warnings.push("Emergency stop is active — devices stay off until you resume");
  } else {
    sync = await syncAutomationToSensors("stage-change");
    scheduleRetryIfUnsettled(sync);
  }

  logger.info(
    { stage: stage.key, label: stage.label, devicesAuto, devicesParked, warnings },
    "Crop stage applied",
  );

  return { stage, thresholdsApplied, devicesAuto, devicesParked, sync, warnings };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export interface CreateBatchInput {
  batchId?: string;
  name: string;
  species?: string;
  stages?: CropStage[];
  autoAdvance?: boolean;
  notes?: string;
  plannedStartAt?: string | Date | null;
}

/** Accepts an ISO string or Date; rejects anything that is not a real date. */
function parseDate(value: string | Date | null | undefined, field: string): Date | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CropCycleError(`${field} is not a valid date`);
  }
  return date;
}

function generateBatchId(): string {
  // Sortable and human-readable; uniqueness is enforced by the unique index and
  // the retry in createBatch.
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(now.getTime() % 1000)
    .toString()
    .padStart(3, "0");
  return `BATCH-${stamp}-${suffix}`;
}

export async function createBatch(input: CreateBatchInput): Promise<BatchView> {
  if (!input.name?.trim()) throw new CropCycleError("Batch name is required");

  const stages = (input.stages?.length ? input.stages : DEFAULT_STAGE_PLAN) as CropStage[];
  assertStagesSane(stages);

  const batchId = input.batchId?.trim() || generateBatchId();
  const existing = await CropBatchModel.exists({ batchId });
  if (existing) throw new CropCycleError(`Batch "${batchId}" already exists`);

  const doc = await CropBatchModel.create({
    batchId,
    name: input.name.trim(),
    species: input.species?.trim() || "Agaricus bisporus",
    status: "planned",
    stages,
    currentStageIndex: 0,
    autoAdvance: input.autoAdvance ?? true,
    notes: input.notes ?? "",
    plannedStartAt: parseDate(input.plannedStartAt, "plannedStartAt"),
  });

  logger.info({ batchId, stages: stages.length }, "Crop batch created");
  return toBatchView(doc.toObject() as never);
}

export interface UpdateBatchInput {
  name?: string;
  species?: string;
  stages?: CropStage[];
  autoAdvance?: boolean;
  notes?: string;
  plannedStartAt?: string | Date | null;
}

/**
 * Edits a batch. Editing the stages of the *running* batch re-applies the
 * current stage, so a corrected target takes effect straight away rather than
 * at the next transition.
 */
export async function updateBatch(
  batchId: string,
  patch: UpdateBatchInput,
): Promise<{ batch: BatchView; applied: StageApplication | null }> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status === "completed" || doc.status === "aborted") {
    throw new CropCycleError("A finished batch cannot be edited");
  }

  if (patch.stages) {
    assertStagesSane(patch.stages);
    if (doc.status === "active" && patch.stages.length <= doc.currentStageIndex) {
      throw new CropCycleError(
        "The new plan has fewer stages than the batch has already run through",
      );
    }
    doc.set("stages", patch.stages);
  }
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new CropCycleError("Batch name is required");
    doc.set("name", patch.name.trim());
  }
  if (patch.species !== undefined) doc.set("species", patch.species.trim());
  if (patch.autoAdvance !== undefined) doc.set("autoAdvance", patch.autoAdvance);
  if (patch.notes !== undefined) doc.set("notes", patch.notes);
  if (patch.plannedStartAt !== undefined) {
    if (doc.status === "active") {
      // The running batch's calendar is anchored on what actually happened, so
      // a planned start date would be ignored — refuse rather than store a value
      // that has no effect.
      throw new CropCycleError(
        "A running batch is dated from when it actually started — edit stage lengths instead",
      );
    }
    doc.set("plannedStartAt", parseDate(patch.plannedStartAt, "plannedStartAt"));
  }
  doc.set("updatedAt", new Date());
  await doc.save();

  const batch = toBatchView(doc.toObject() as never);

  let applied: StageApplication | null = null;
  if (doc.status === "active" && patch.stages) {
    const stage = batch.stages[batch.currentStageIndex];
    if (stage) applied = await applyStage(stage);
  }

  return { batch, applied };
}

export interface StagePatch {
  key?: string;
  label?: string;
  days?: number;
  targets?: Partial<CropStage["targets"]>;
  devicesAuto?: string[];
  notes?: string;
}

/**
 * Edits one stage of a batch in place.
 *
 * This is what the schedule UI writes to. Editing a stage's *end date* is
 * expressed as a change to its `days`, so the calendar stays derived from a
 * single source of truth and stage dates after it shift automatically.
 *
 * Re-applies the stage only when the edited one is currently running — editing a
 * future stage must not disturb the room.
 */
export async function patchStage(
  batchId: string,
  index: number,
  patch: StagePatch,
): Promise<{ batch: BatchView; applied: StageApplication | null }> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status === "completed" || doc.status === "aborted") {
    throw new CropCycleError("A finished batch cannot be edited");
  }

  const stages = (doc.stages as CropStage[]).map((s) => ({
    key: s.key,
    label: s.label,
    days: s.days,
    targets: { ...s.targets },
    devicesAuto: [...(s.devicesAuto ?? [])],
    notes: s.notes ?? "",
  })) as CropStage[];

  if (!Number.isInteger(index) || index < 0 || index >= stages.length) {
    throw new CropCycleError(`Stage ${index + 1} does not exist in this plan`);
  }

  const stage = stages[index]!;
  if (patch.key !== undefined) stage.key = patch.key.trim();
  if (patch.label !== undefined) stage.label = patch.label.trim();
  if (patch.days !== undefined) stage.days = patch.days;
  if (patch.notes !== undefined) stage.notes = patch.notes;
  if (patch.devicesAuto !== undefined) stage.devicesAuto = patch.devicesAuto;
  if (patch.targets !== undefined) {
    stage.targets = { ...stage.targets, ...patch.targets };
  }

  assertStagesSane(stages);

  doc.set("stages", stages);
  doc.set("updatedAt", new Date());
  await doc.save();

  const batch = toBatchView(doc.toObject() as never);

  let applied: StageApplication | null = null;
  if (doc.status === "active" && index === doc.currentStageIndex) {
    const current = batch.stages[index];
    if (current) applied = await applyStage(current);
  }

  logger.info({ batchId, index, patch: Object.keys(patch) }, "Crop stage edited");
  return { batch, applied };
}

/**
 * Records how a batch turned out.
 *
 * Only for a finished batch: an outcome on a running crop would be a guess, and
 * the risk engine weights its warnings by this field, so a premature "healthy"
 * would actively suppress useful warnings on the next batch.
 *
 * Re-recordable, because the full picture often only arrives after the last
 * flush is graded.
 */
export async function recordBatchOutcome(
  batchId: string,
  outcome: {
    label: OutcomeLabel;
    yieldKg?: number | null;
    gradePercent?: number | null;
    notes?: string;
  },
): Promise<BatchView> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status === "planned") {
    throw new CropCycleError("This batch has not run yet — there is no outcome to record");
  }
  if (doc.status === "active") {
    throw new CropCycleError(
      "Finish or stop the batch before recording how it turned out",
    );
  }

  doc.set("outcome", {
    label: outcome.label,
    yieldKg: outcome.yieldKg ?? null,
    gradePercent: outcome.gradePercent ?? null,
    notes: outcome.notes ?? "",
    recordedAt: new Date(),
  });
  doc.set("updatedAt", new Date());
  await doc.save();

  logger.info({ batchId, label: outcome.label }, "Crop batch outcome recorded");
  return toBatchView(doc.toObject() as never);
}

export interface ImportBatchInput {
  name: string;
  species?: string;
  stages?: CropStage[];
  startedAt: Date;
  completedAt: Date;
  notes?: string;
  outcome?: {
    label: OutcomeLabel;
    yieldKg?: number | null;
    gradePercent?: number | null;
    notes?: string;
  };
}

/**
 * Creates a batch that already happened, so the knowledge base has something to
 * learn from before a full crop has been run through the controller.
 *
 * Marked `imported` and given a synthetic `stageHistory` derived from the plan's
 * durations across the real date range. That history is what lets the annotation
 * endpoint work out which stage a remembered problem belongs to, and therefore
 * which target band applied — without it, an imported note could not be compared
 * against anything.
 *
 * Goes straight to `completed`: it is history, and it must never be picked up by
 * the stage scheduler or the risk monitor as the active batch.
 */
export async function importBatch(input: ImportBatchInput): Promise<BatchView> {
  if (!input.name?.trim()) throw new CropCycleError("Batch name is required");
  if (input.completedAt <= input.startedAt) {
    throw new CropCycleError("The end date must be after the start date");
  }

  const stages = (input.stages?.length ? input.stages : DEFAULT_STAGE_PLAN) as CropStage[];
  assertStagesSane(stages);

  const batchId = generateBatchId();
  const existing = await CropBatchModel.exists({ batchId });
  if (existing) throw new CropCycleError(`Batch "${batchId}" already exists`);

  // Spread the plan's stages proportionally across the actual duration, so a
  // remembered 40-day crop maps onto a 61-day default plan without the later
  // stages falling outside the batch entirely.
  const plannedDays = stages.reduce((sum, s) => sum + (s.days ?? 0), 0) || 1;
  const actualMs = input.completedAt.getTime() - input.startedAt.getTime();
  const msPerPlannedDay = actualMs / plannedDays;

  let cursor = input.startedAt.getTime();
  const stageHistory = stages.map((stage, index) => {
    const enteredAt = new Date(cursor);
    cursor += Math.max(stage.days ?? 0, 0) * msPerPlannedDay;
    return {
      stageKey: stage.key,
      label: stage.label,
      index,
      enteredAt,
      leftAt: new Date(Math.min(cursor, input.completedAt.getTime())),
      enteredBy: "start" as const,
    };
  });

  const doc = await CropBatchModel.create({
    batchId,
    name: input.name.trim(),
    species: input.species?.trim() || "Agaricus bisporus",
    status: "completed",
    stages,
    currentStageIndex: Math.max(0, stages.length - 1),
    currentStageStartedAt: stageHistory[stageHistory.length - 1]?.enteredAt ?? input.startedAt,
    autoAdvance: false,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    notes: input.notes ?? "",
    stageHistory,
    imported: true,
    outcome: input.outcome
      ? {
          label: input.outcome.label,
          yieldKg: input.outcome.yieldKg ?? null,
          gradePercent: input.outcome.gradePercent ?? null,
          notes: input.outcome.notes ?? "",
          recordedAt: new Date(),
        }
      : null,
  });

  logger.info({ batchId, name: input.name }, "Past crop batch imported");
  return toBatchView(doc.toObject() as never);
}

export async function deleteBatch(batchId: string): Promise<void> {
  const doc = await CropBatchModel.findOne({ batchId }).lean();
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status === "active") {
    throw new CropCycleError("Stop the batch before deleting it");
  }
  await CropBatchModel.deleteOne({ batchId });
  logger.info({ batchId }, "Crop batch deleted");
}

export interface TransitionResult {
  batch: BatchView;
  applied: StageApplication | null;
  message: string;
}

/** Starts a planned batch and applies its first stage. One batch at a time. */
export async function startBatch(batchId: string): Promise<TransitionResult> {
  const active = await CropBatchModel.findOne({ status: "active" }).select("batchId name").lean();
  if (active && active.batchId !== batchId) {
    throw new CropCycleError(
      `"${active.name}" is still running — finish or stop it before starting another batch`,
    );
  }

  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status === "active") throw new CropCycleError("Batch is already running");
  if (doc.status !== "planned") throw new CropCycleError("Only a planned batch can be started");
  assertStagesSane(doc.stages as CropStage[]);

  const now = new Date();
  const firstStage = doc.stages[0] as CropStage;

  doc.set("status", "active");
  doc.set("startedAt", now);
  doc.set("completedAt", null);
  doc.set("currentStageIndex", 0);
  doc.set("currentStageStartedAt", now);
  doc.set("stageHistory", [
    {
      stageKey: firstStage.key,
      label: firstStage.label,
      index: 0,
      enteredAt: now,
      leftAt: null,
      enteredBy: "start",
    },
  ]);
  doc.set("updatedAt", now);
  await doc.save();

  invalidateActiveStageCache();
  const applied = await applyStage(toStageView(firstStage, 0));

  return {
    batch: toBatchView(doc.toObject() as never),
    applied,
    message: `${doc.name} started — ${firstStage.label}`,
  };
}

/**
 * Moves the running batch to a specific stage. `by` records whether the
 * scheduler or a person did it, which matters when reviewing a batch later.
 */
export async function setBatchStage(
  batchId: string,
  index: number,
  by: "auto" | "manual",
): Promise<TransitionResult> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status !== "active") throw new CropCycleError("Batch is not running");

  const stages = doc.stages as CropStage[];
  if (!Number.isInteger(index) || index < 0 || index >= stages.length) {
    throw new CropCycleError(`Stage ${index + 1} does not exist in this plan`);
  }

  const now = new Date();
  const stage = stages[index];

  const history = toHistoryEntries(doc.stageHistory);
  closeOpenEntry(history, now);
  history.push({
    stageKey: stage.key,
    label: stage.label,
    index,
    enteredAt: now,
    leftAt: null,
    enteredBy: by,
  });

  doc.set("currentStageIndex", index);
  doc.set("currentStageStartedAt", now);
  doc.set("stageHistory", history);
  doc.set("updatedAt", now);
  await doc.save();

  invalidateActiveStageCache();
  const applied = await applyStage(toStageView(stage, index));

  logger.info({ batchId, index, stage: stage.key, by }, "Crop stage changed");
  return {
    batch: toBatchView(doc.toObject() as never),
    applied,
    message: `${stage.label} started`,
  };
}

/**
 * Advances one stage. Past the last stage the batch completes: the thresholds
 * of the final stage stay in force, because leaving a room uncontrolled at the
 * end of a crop is worse than holding the last known-good band.
 */
export async function advanceBatchStage(
  batchId: string,
  by: "auto" | "manual",
): Promise<TransitionResult> {
  const doc = await CropBatchModel.findOne({ batchId }).lean();
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status !== "active") throw new CropCycleError("Batch is not running");

  const next = doc.currentStageIndex + 1;
  if (next >= doc.stages.length) {
    return completeBatch(batchId, by);
  }
  return setBatchStage(batchId, next, by);
}

export async function completeBatch(
  batchId: string,
  by: "auto" | "manual" = "manual",
): Promise<TransitionResult> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status !== "active") throw new CropCycleError("Batch is not running");

  const now = new Date();
  const history = toHistoryEntries(doc.stageHistory);
  closeOpenEntry(history, now);

  doc.set("status", "completed");
  doc.set("completedAt", now);
  doc.set("stageHistory", history);
  doc.set("updatedAt", now);
  await doc.save();

  invalidateActiveStageCache();
  // Stage-scoped rules stop applying now that no stage is active; unscoped
  // rules and the final stage's thresholds keep the room under control.
  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Could not publish rules after completing batch");
  });

  logger.info({ batchId, by }, "Crop batch completed");
  return {
    batch: toBatchView(doc.toObject() as never),
    applied: null,
    message: `${doc.name} completed`,
  };
}

/** Stops a batch early. Devices are left exactly as they are. */
export async function abortBatch(batchId: string, reason?: string): Promise<TransitionResult> {
  const doc = await CropBatchModel.findOne({ batchId });
  if (!doc) throw new CropCycleError(`Batch "${batchId}" not found`);
  if (doc.status !== "active" && doc.status !== "planned") {
    throw new CropCycleError("Batch is not running");
  }

  const now = new Date();
  const history = toHistoryEntries(doc.stageHistory);
  closeOpenEntry(history, now);

  doc.set("status", "aborted");
  doc.set("completedAt", now);
  doc.set("stageHistory", history);
  if (reason) doc.set("notes", `${doc.notes ? `${doc.notes}\n` : ""}Aborted: ${reason}`);
  doc.set("updatedAt", now);
  await doc.save();

  invalidateActiveStageCache();
  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Could not publish rules after aborting batch");
  });

  logger.warn({ batchId, reason }, "Crop batch aborted");
  return {
    batch: toBatchView(doc.toObject() as never),
    applied: null,
    message: `${doc.name} stopped`,
  };
}

// ─── Auto-advance scheduler ──────────────────────────────────────────────────

const TICK_INTERVAL_MS = 60_000;
let tickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/**
 * Advances the active batch when the current stage's planned days are up.
 *
 * Does nothing while an emergency stop is active: a stopped room must not creep
 * forward through the crop calendar behind the operator's back, and resume
 * re-applies whatever stage is current anyway.
 *
 * A stage whose due time passed while the server was down is advanced on the
 * next tick, so an overnight outage does not strand a batch.
 */
export async function runStageAdvanceCheck(): Promise<TransitionResult | null> {
  if (await isAutomationPaused()) return null;

  const doc = await CropBatchModel.findOne({ status: "active" })
    .select("batchId stages currentStageIndex currentStageStartedAt autoAdvance")
    .lean();

  if (!doc || !doc.autoAdvance || !doc.currentStageStartedAt) return null;

  const stage = doc.stages[doc.currentStageIndex];
  // days = 0 means open-ended: only a person advances it.
  if (!stage || !stage.days || stage.days <= 0) return null;

  const dueAt = doc.currentStageStartedAt.getTime() + stage.days * DAY_MS;
  if (Date.now() < dueAt) return null;

  logger.info(
    { batchId: doc.batchId, stage: stage.key, days: stage.days },
    "Crop stage complete — advancing automatically",
  );
  return advanceBatchStage(doc.batchId, "auto");
}

export function startCropCycleScheduler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    // A transition does several awaited writes; never let two overlap.
    if (tickInFlight) return;
    tickInFlight = true;
    void runStageAdvanceCheck()
      .catch((err) => {
        logger.error({ err }, "Crop stage auto-advance failed");
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, TICK_INTERVAL_MS);
  tickTimer.unref?.();
  logger.info({ intervalSeconds: TICK_INTERVAL_MS / 1000 }, "Crop cycle scheduler started");
}

export function stopCropCycleScheduler(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}
