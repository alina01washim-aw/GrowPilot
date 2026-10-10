import {
  AutomationRuleModel,
  SENSOR_KEYS,
  type SensorKey,
  type MatchMode,
} from "../models/automationRule";
import { RuleLatchModel } from "../models/ruleLatch";
import { ReadingModel } from "../models/reading";
import { getActiveStageKey, ruleAppliesToStage } from "./activeStage";
import {
  stepRule,
  IDLE_LATCH,
  type Condition,
  type EvaluableRule,
  type LatchState,
  type LatchTransition,
} from "./ruleLatchMachine";
import { logger } from "./logger";

/**
 * Server-side evaluation of the automation rules.
 *
 * The same rules also run on the ESP itself (firmware `RuleEngine`). This module
 * exists so the server can answer the same question the device answers — *what
 * state should each device be in?* — which is what a resume needs, and what the
 * server needs in order to command devices the edge engine cannot reach (its
 * rule table is capped at 16 rules).
 *
 * The decision logic itself — the latch state machine and its dwell windows —
 * lives in `ruleLatchMachine.ts`, which is dependency-free and unit-tested. This
 * file is the part that talks to the database: load the rules and their latches,
 * step each one, persist what changed.
 */

// `RuleDecision.transition` is part of this module's public shape, so the type
// travels with it. The machine itself is imported directly by its tests.
export type { LatchState, LatchTransition, EvaluableRule } from "./ruleLatchMachine";

export interface SensorSnapshot {
  timestamp: Date;
  values: Partial<Record<SensorKey, number>>;
}

const READING_FIELD_BY_SENSOR = {
  air_temp: "temp",
  humidity: "hum",
  co2: "co2",
  scd_temp: "scdTemp",
  scd_hum: "scdHum",
  compost_temp: "compostTemp",
} as const satisfies Record<SensorKey, string>;

/** Most recent stored reading, mapped onto the rule engine's sensor keys. */
export async function getLatestSensorSnapshot(): Promise<SensorSnapshot | null> {
  const doc = await ReadingModel.findOne().sort({ timestamp: -1 }).lean();
  if (!doc) return null;

  const values: Partial<Record<SensorKey, number>> = {};
  for (const sensor of SENSOR_KEYS) {
    const raw = doc[READING_FIELD_BY_SENSOR[sensor]];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      values[sensor] = raw;
    }
  }

  return { timestamp: doc.timestamp, values };
}

// ─── Stateful evaluation ─────────────────────────────────────────────────────

export interface RuleDecision {
  device: string;
  on: boolean;
  ruleId: string;
  ruleName: string;
  /**
   * Whether this decision is an edge (the rule acted this pass) or the standing
   * state of a latched rule. The sensor path only writes edges — the firmware
   * does the same, and re-asserting every pass would fight a manual override the
   * device is respecting. A resume writes everything.
   */
  transition: LatchTransition;
}

export interface RuleEvaluation {
  decisions: RuleDecision[];
  rulesConsidered: number;
  rulesFired: Array<{ id: string; name: string; cause: "trigger" | "cutoff" }>;
  /** Rules that wanted to act but are inside a dwell window. */
  blocked: Array<{ id: string; name: string; until: string }>;
  /** Stage the evaluation ran under; null when no batch is active. */
  activeStageKey: string | null;
}

function toEvaluableRule(doc: {
  _id: unknown;
  name: string;
  triggerMode?: string | null;
  triggers?: Condition[] | null;
  cutoffMode?: string | null;
  cutoffs?: Condition[] | null;
  actions?: { turnOn?: string[] | null; turnOff?: string[] | null } | null;
  offActions?: { turnOff?: string[] | null } | null;
  minOnMs?: number | null;
  minOffMs?: number | null;
  cooldownMs?: number | null;
}): EvaluableRule {
  return {
    id: String(doc._id),
    name: doc.name,
    triggerMode: (doc.triggerMode ?? "all") as MatchMode,
    triggers: (doc.triggers ?? []) as Condition[],
    cutoffMode: (doc.cutoffMode ?? "any") as MatchMode,
    cutoffs: (doc.cutoffs ?? []) as Condition[],
    turnOn: doc.actions?.turnOn ?? [],
    turnOff: doc.actions?.turnOff ?? [],
    release: doc.offActions?.turnOff ?? [],
    minOnMs: doc.minOnMs ?? 0,
    minOffMs: doc.minOffMs ?? 0,
    cooldownMs: doc.cooldownMs ?? 0,
  };
}

function latchFromDoc(doc: {
  groupActive?: boolean | null;
  groupActiveSince?: Date | null;
  lastActionAt?: Date | null;
}): LatchState {
  return {
    groupActive: doc.groupActive ?? false,
    groupActiveSince: doc.groupActiveSince?.getTime() ?? null,
    lastActionAt: doc.lastActionAt?.getTime() ?? null,
  };
}

function latchesEqual(a: LatchState, b: LatchState): boolean {
  return (
    a.groupActive === b.groupActive &&
    a.groupActiveSince === b.groupActiveSince &&
    a.lastActionAt === b.lastActionAt
  );
}

/**
 * Evaluates every enabled rule for a profile against one sensor snapshot,
 * advancing each rule's latch.
 *
 * Devices no rule has an opinion about are simply absent from `decisions` — the
 * caller decides what to do with them (hold, or fall back to thresholds).
 *
 * Rules scoped to other crop stages are skipped *and* have their latch cleared:
 * a rule that is no longer shipped to the device must not come back still
 * latched when its stage returns, and the firmware drops it from its table
 * entirely (see `buildWirePayload` in ruleControl.ts).
 */
export async function evaluateRules(
  profileId: string,
  snapshot: SensorSnapshot,
  now: number = Date.now(),
): Promise<RuleEvaluation> {
  const [ruleDocs, activeStageKey] = await Promise.all([
    AutomationRuleModel.find({
      enabled: true,
      $or: [{ profileIds: { $size: 0 } }, { profileIds: profileId }],
    })
      .sort({ priority: 1, createdAt: 1 })
      .lean(),
    getActiveStageKey(),
  ]);

  const applicable: typeof ruleDocs = [];
  const outOfStageIds: string[] = [];
  for (const doc of ruleDocs) {
    if (ruleAppliesToStage(doc.stageKeys, activeStageKey)) {
      applicable.push(doc);
    } else {
      outOfStageIds.push(String(doc._id));
    }
  }

  const latchDocs = await RuleLatchModel.find({
    ruleId: { $in: applicable.map((d) => String(d._id)) },
  }).lean();
  const latchById = new Map(latchDocs.map((d) => [d.ruleId, latchFromDoc(d)]));

  const byDevice = new Map<string, RuleDecision>();
  const rulesFired: RuleEvaluation["rulesFired"] = [];
  const blocked: RuleEvaluation["blocked"] = [];
  const latchWrites: Array<{ ruleId: string; latch: LatchState }> = [];

  const claim = (device: string, decision: RuleDecision): void => {
    // Rules are sorted by ascending priority, so the first claim on a device
    // comes from the highest-priority rule and must not be overwritten.
    if (byDevice.has(device)) return;
    byDevice.set(device, decision);
  };

  for (const doc of applicable) {
    const rule = toEvaluableRule(doc);
    const before = latchById.get(rule.id) ?? IDLE_LATCH;
    const step = stepRule(rule, before, snapshot.values, now);

    if (!latchesEqual(before, step.latch)) {
      latchWrites.push({ ruleId: rule.id, latch: step.latch });
    }

    if (step.transition === "activated") {
      rulesFired.push({ id: rule.id, name: rule.name, cause: "trigger" });
    } else if (step.transition === "released") {
      rulesFired.push({ id: rule.id, name: rule.name, cause: "cutoff" });
    } else if (step.transition === "blocked" && step.blockedUntil != null) {
      blocked.push({
        id: rule.id,
        name: rule.name,
        until: new Date(step.blockedUntil).toISOString(),
      });
    }

    for (const { device, on } of step.claims) {
      claim(device, {
        device,
        on,
        ruleId: rule.id,
        ruleName: rule.name,
        transition: step.transition,
      });
    }
  }

  await persistLatches(latchWrites, outOfStageIds);

  return {
    decisions: [...byDevice.values()],
    rulesConsidered: applicable.length,
    rulesFired,
    blocked,
    activeStageKey,
  };
}

async function persistLatches(
  writes: Array<{ ruleId: string; latch: LatchState }>,
  clearIds: string[],
): Promise<void> {
  const ops: Array<Promise<unknown>> = [];

  for (const { ruleId, latch } of writes) {
    ops.push(
      RuleLatchModel.updateOne(
        { ruleId },
        {
          $set: {
            groupActive: latch.groupActive,
            groupActiveSince:
              latch.groupActiveSince == null ? null : new Date(latch.groupActiveSince),
            lastActionAt: latch.lastActionAt == null ? null : new Date(latch.lastActionAt),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      ).exec(),
    );
  }

  if (clearIds.length > 0) {
    ops.push(RuleLatchModel.deleteMany({ ruleId: { $in: clearIds } }).exec());
  }

  if (ops.length === 0) return;

  // A failed latch write must not stop the relays from being commanded: the
  // decision for *this* pass is already made. It does mean the next pass may
  // re-run an edge, so it is worth shouting about.
  const results = await Promise.allSettled(ops);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.error(
      { failed: failed.length, total: ops.length },
      "Could not persist rule latch state — a rule edge may repeat on the next pass",
    );
  }
}

/** Drops the latch for a rule that was deleted or disabled. */
export async function clearRuleLatch(ruleId: string): Promise<void> {
  await RuleLatchModel.deleteOne({ ruleId }).catch((err) => {
    logger.warn({ err, ruleId }, "Could not clear rule latch");
  });
}

/**
 * Drops every latch. Used by an emergency stop: the relays are all forced off,
 * so no group can still be considered active, and resume must re-decide from
 * the current readings rather than from stale latches.
 */
export async function clearAllRuleLatches(): Promise<void> {
  await RuleLatchModel.deleteMany({}).catch((err) => {
    logger.warn({ err }, "Could not clear rule latches");
  });
}
