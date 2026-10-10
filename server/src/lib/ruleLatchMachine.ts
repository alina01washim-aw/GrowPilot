import type {
  RuleOperator,
  MatchMode,
  SensorKey,
} from "../models/automationRule";

/**
 * The automation rule latch state machine.
 *
 * A pure transcription of `firmware/src/rule_engine.cpp`, RuleEngine::evaluate.
 * Both the ESP and the server act on the same relays, so the server has to make
 * the same decisions the device does — and the device latches:
 *
 *     if (groupActive) {
 *         if (cutoff && heldFor >= minOnMs) release();
 *     } else if (triggered) {
 *         if (sinceLastAction >= cooldownMs && sinceLastAction >= minOffMs) activate();
 *     }
 *
 * Two consequences a stateless evaluator gets wrong:
 *
 *   1. Once a group latches ON the *triggers stop mattering* — only a cutoff
 *      releases it. That is where the hysteresis lives. A rule "fan ON when CO2
 *      > 1200 / cutoff CO2 < 800" must keep the fan on at CO2 = 1000. Re-testing
 *      the trigger would release it and short-cycle the device.
 *   2. The dwell timers are windows measured over that latch, so they only mean
 *      anything if the latch exists.
 *
 * Deliberately dependency-free: the only imports are `import type`, which Node's
 * native type stripping erases, so this module can be unit-tested without
 * loading mongoose. Same reasoning as `cropSchedule.ts` and `activeStage.ts`.
 * `ruleEvaluator.ts` owns the persistence and calls in here.
 */

export type SensorValues = Partial<Record<SensorKey, number>>;

export interface Condition {
  sensor: string;
  operator: string;
  value: number;
}

function compare(actual: number, operator: RuleOperator, value: number): boolean {
  switch (operator) {
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case "==":
      return actual === value;
    case "!=":
      return actual !== value;
    default:
      // An operator the model does not define cannot be honoured; failing false
      // is the safe direction — it never flips a relay.
      return false;
  }
}

export function matchConditions(
  conditions: Condition[],
  mode: MatchMode,
  values: SensorValues,
): boolean {
  if (conditions.length === 0) return false;

  const test = (c: Condition): boolean => {
    const actual = values[c.sensor as SensorKey];
    // Sensor offline → false, matching the firmware's fail-safe.
    if (actual == null) return false;
    return compare(actual, c.operator as RuleOperator, c.value);
  };

  return mode === "all" ? conditions.every(test) : conditions.some(test);
}

/** The subset of a rule the latch logic needs. */
export interface EvaluableRule {
  id: string;
  name: string;
  triggerMode: MatchMode;
  triggers: Condition[];
  cutoffMode: MatchMode;
  cutoffs: Condition[];
  turnOn: string[];
  turnOff: string[];
  release: string[];
  minOnMs: number;
  minOffMs: number;
  cooldownMs: number;
}

export interface LatchState {
  groupActive: boolean;
  /** ms epoch the group latched ON; null when it has never been active. */
  groupActiveSince: number | null;
  /** ms epoch the rule last acted in either direction; null when never. */
  lastActionAt: number | null;
}

export const IDLE_LATCH: LatchState = {
  groupActive: false,
  groupActiveSince: null,
  lastActionAt: null,
};

/**
 * What happened to a rule's latch on one pass.
 *
 *   activated / released — an edge: the rule acted, and the devices it claims
 *                          must be written.
 *   held                 — latched ON, no cutoff (or a cutoff still inside
 *                          `minOnMs`). Devices keep the latched state, but the
 *                          firmware would not re-write them.
 *   blocked              — wanted to activate but a dwell window forbids it.
 *   idle                 — nothing to say about this rule.
 */
export type LatchTransition = "activated" | "released" | "held" | "blocked" | "idle";

export interface StepResult {
  latch: LatchState;
  transition: LatchTransition;
  /** Devices this rule has an opinion about, and what that opinion is. */
  claims: Array<{ device: string; on: boolean }>;
  /** For `blocked`: ms epoch at which the rule may act. */
  blockedUntil: number | null;
}

/** One pass of the firmware's latch state machine for a single rule. */
export function stepRule(
  rule: EvaluableRule,
  latch: LatchState,
  values: SensorValues,
  now: number,
): StepResult {
  const triggered = matchConditions(rule.triggers, rule.triggerMode, values);
  const cutoff = matchConditions(rule.cutoffs, rule.cutoffMode, values);

  if (latch.groupActive) {
    // The group is latched. Only a cutoff releases it, and only once it has been
    // held for at least minOnMs.
    const heldSince = latch.groupActiveSince ?? now;
    const heldFor = now - heldSince;

    if (cutoff && heldFor >= rule.minOnMs) {
      return {
        latch: { groupActive: false, groupActiveSince: null, lastActionAt: now },
        transition: "released",
        claims: rule.release.map((device) => ({ device, on: false })),
        blockedUntil: null,
      };
    }

    // Still latched: the devices stay where the activation put them. The claims
    // are reported even though nothing is written, so an `assert` pass (resume)
    // can restore the latched state.
    return {
      latch,
      transition: "held",
      claims: [
        ...rule.turnOn.map((device) => ({ device, on: true })),
        ...rule.turnOff.map((device) => ({ device, on: false })),
      ],
      blockedUntil: cutoff ? heldSince + rule.minOnMs : null,
    };
  }

  if (!triggered) {
    return { latch, transition: "idle", claims: [], blockedUntil: null };
  }

  // Triggers fire, but the group may not re-activate until both the cooldown and
  // the minimum-off window have elapsed since the rule last acted.
  const dwellMs = Math.max(rule.cooldownMs, rule.minOffMs);
  if (latch.lastActionAt != null && dwellMs > 0) {
    const since = now - latch.lastActionAt;
    if (since < dwellMs) {
      return {
        latch,
        transition: "blocked",
        claims: [],
        blockedUntil: latch.lastActionAt + dwellMs,
      };
    }
  }

  return {
    latch: { groupActive: true, groupActiveSince: now, lastActionAt: now },
    transition: "activated",
    claims: [
      ...rule.turnOn.map((device) => ({ device, on: true })),
      ...rule.turnOff.map((device) => ({ device, on: false })),
    ],
    blockedUntil: null,
  };
}
