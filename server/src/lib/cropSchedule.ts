/**
 * Turning a crop plan into a calendar.
 *
 * Deliberately dependency-free — no models, no MQTT, no logger — so the date
 * arithmetic can be unit-tested without a database. Same reasoning as
 * `activeStage.ts`. `cropCycle.ts` owns the persistence and calls in here.
 *
 * The one rule that matters: `days` is the single source of truth for how long a
 * stage lasts, and dates are always *derived* from it. Nothing stores a stage's
 * start or end date. That is why the calendar can never disagree with
 * `runStageAdvanceCheck`, which schedules from `currentStageStartedAt + days`.
 */

export const DAY_MS = 86_400_000;

export interface StageTargets {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
}

/** The parts of a stage the schedule needs. */
export interface ScheduleStageInput {
  key: string;
  label: string;
  days: number;
  targets: StageTargets;
  devicesAuto: string[];
  notes: string;
}

export type BatchScheduleStatus = "planned" | "active" | "completed" | "aborted";

/** A numeric target that differs from the previous stage. */
export type TargetChange = { from: number; to: number } | null;

/**
 * What actually changes when a stage begins. This is the answer to "on which
 * date does what happen" — the reason the schedule exists rather than just a
 * list of durations.
 */
export interface StageChanges {
  tempMin: TargetChange;
  tempMax: TargetChange;
  co2Min: TargetChange;
  co2Max: TargetChange;
  humidityMin: TargetChange;
  humidityMax: TargetChange;
  /** Devices this stage automates that the previous one did not. */
  devicesTurnedOn: string[];
  /** Devices the previous stage automated that this one parks off. */
  devicesTurnedOff: string[];
}

export interface ScheduledStage {
  index: number;
  key: string;
  label: string;
  days: number;
  targets: StageTargets;
  devicesAuto: string[];
  /** Devices this stage deliberately leaves off. */
  devicesParked: string[];
  notes: string;
  startsAt: string;
  /** Null for an open-ended stage (days = 0) — only a manual advance ends it. */
  endsAt: string | null;
  /**
   * True when `startsAt` is a recorded fact (from the stage history) rather than
   * a projection. The UI must not present a guess as a date the room ran.
   */
  actual: boolean;
  state: "done" | "current" | "upcoming";
  changes: StageChanges;
}

export interface ScheduleInput {
  stages: ScheduleStageInput[];
  status: BatchScheduleStatus;
  currentStageIndex: number;
  currentStageStartedAt: Date | null;
  startedAt: Date | null;
  plannedStartAt: Date | null;
  stageHistory: Array<{ index: number; enteredAt: Date }>;
}

function diffTarget(from: number | undefined, to: number): TargetChange {
  if (from == null || from === to) return null;
  return { from, to };
}

export function stageChanges(
  previous: ScheduleStageInput | null,
  stage: ScheduleStageInput,
): StageChanges {
  const p = previous?.targets;
  const before = new Set(previous?.devicesAuto ?? []);
  const after = new Set(stage.devicesAuto);

  return {
    tempMin: diffTarget(p?.tempMin, stage.targets.tempMin),
    tempMax: diffTarget(p?.tempMax, stage.targets.tempMax),
    co2Min: diffTarget(p?.co2Min, stage.targets.co2Min),
    co2Max: diffTarget(p?.co2Max, stage.targets.co2Max),
    humidityMin: diffTarget(p?.humidityMin, stage.targets.humidityMin),
    humidityMax: diffTarget(p?.humidityMax, stage.targets.humidityMax),
    // For the first stage there is no "previous", so everything it automates is
    // a turn-on. That reads correctly: starting the batch does switch them on.
    devicesTurnedOn: stage.devicesAuto.filter((d) => !before.has(d)),
    devicesTurnedOff: [...before].filter((d) => !after.has(d)),
  };
}

/**
 * Places every stage of a plan on the calendar.
 *
 * Anchoring, in order of trustworthiness:
 *   - a stage that has been entered uses its recorded `enteredAt` (`actual`),
 *   - the running batch anchors on `currentStageStartedAt`,
 *   - later stages project forward from that anchor, stage by stage,
 *   - earlier stages without a recorded entry are projected *backwards*, so a
 *     batch started mid-plan still reads as a coherent calendar,
 *   - a batch that is not running anchors on `startedAt` (it ran) or
 *     `plannedStartAt` (it has not), falling back to `now` so the shape of an
 *     undated plan is still visible.
 *
 * `allDeviceKeys` is passed in rather than imported so this module stays free of
 * the model layer; `cropCycle.ts` supplies the real registry.
 */
export function buildSchedule(
  batch: ScheduleInput,
  allDeviceKeys: readonly string[],
  now: Date = new Date(),
): ScheduledStage[] {
  const { stages, status, currentStageIndex } = batch;
  if (stages.length === 0) return [];

  const running = status === "active";

  // Last recorded entry per stage index — a stage re-run by "go to" has several.
  const enteredAt = new Map<number, Date>();
  for (const entry of batch.stageHistory) {
    enteredAt.set(entry.index, entry.enteredAt);
  }

  // Clamp: a corrupt currentStageIndex must not produce holes in the calendar.
  const anchorIndex = running
    ? Math.min(Math.max(currentStageIndex, 0), stages.length - 1)
    : 0;
  const anchorDate = running
    ? (batch.currentStageStartedAt ?? enteredAt.get(anchorIndex) ?? now)
    : (batch.startedAt ?? batch.plannedStartAt ?? now);

  const startsAt: Date[] = new Array(stages.length);
  startsAt[anchorIndex] = anchorDate;

  for (let i = anchorIndex + 1; i < stages.length; i++) {
    startsAt[i] = new Date(startsAt[i - 1]!.getTime() + stages[i - 1]!.days * DAY_MS);
  }
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const recorded = enteredAt.get(i);
    startsAt[i] =
      recorded ?? new Date(startsAt[i + 1]!.getTime() - stages[i]!.days * DAY_MS);
  }

  return stages.map((stage, index) => {
    const start = startsAt[index]!;
    const state: ScheduledStage["state"] = !running
      ? status === "planned"
        ? "upcoming"
        : "done"
      : index < anchorIndex
        ? "done"
        : index === anchorIndex
          ? "current"
          : "upcoming";

    return {
      index,
      key: stage.key,
      label: stage.label,
      days: stage.days,
      targets: stage.targets,
      devicesAuto: stage.devicesAuto,
      devicesParked: allDeviceKeys.filter((k) => !stage.devicesAuto.includes(k)),
      notes: stage.notes,
      startsAt: start.toISOString(),
      endsAt:
        stage.days > 0
          ? new Date(start.getTime() + stage.days * DAY_MS).toISOString()
          : null,
      actual: enteredAt.has(index),
      state,
      changes: stageChanges(index > 0 ? stages[index - 1]! : null, stage),
    };
  });
}
