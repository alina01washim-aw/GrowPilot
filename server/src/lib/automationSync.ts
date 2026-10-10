import { DEFAULT_RELAY_MAP } from "../models/deviceProfile";
import {
  applyDeviceState,
  listDeviceControls,
  DEFAULT_PROFILE_ID,
} from "./deviceControl";
import { RelayGuardedError } from "./relayControl";
import { getSettings } from "./settingsControl";
import { isAutomationPaused } from "./automationControl";
import {
  evaluateRules,
  getLatestSensorSnapshot,
  type SensorSnapshot,
} from "./ruleEvaluator";
import { logger } from "./logger";

/**
 * Brings the relays in line with what the sensors and the automation rules say
 * they should be, right now, in one pass.
 *
 * This is the *only* path that commands relays from sensor data. Every sensor
 * message arriving over MQTT runs it, as does a resume, a crop stage change and
 * the manual re-sync button. Before, the MQTT path had its own threshold-only
 * logic that never consulted the rules, so a rule cutoff was honoured at a stage
 * change and then quietly overridden two minutes later, and UV-C was never
 * automated at all.
 *
 * Decision order per device:
 *   1. an automation rule that has an opinion about it wins,
 *   2. otherwise the legacy min/max thresholds decide (fan/ac/mist_maker only),
 *   3. otherwise the device is left exactly as it is.
 *
 * ── Edge vs assert ──────────────────────────────────────────────────────────
 *
 * The firmware writes a relay only when a rule's group *latches or releases*,
 * then leaves it alone (see ruleEvaluator.ts). If the server re-asserted the
 * latched state on every pass it would fight the device — and would stomp a
 * manual override the firmware is deliberately respecting. So:
 *
 *   "edge"   — write only rules that acted this pass. Used for sensor messages,
 *              which is the steady state. Threshold decisions are already
 *              edge-shaped: `thresholdDecisions` returns null inside the band.
 *   "assert" — write the full desired state. Used when the relays are known to
 *              be out of step with the rules and nothing else will correct them:
 *              a resume (everything was forced off), a stage change (targets and
 *              device modes just changed), or an explicit manual re-sync.
 *
 * A device claimed by a rule that is merely *held* is still off-limits to the
 * threshold fallback in both modes — the rule owns it.
 */

// A reading older than this is not trustworthy enough to command a compressor
// from: better to wait for a fresh one than to act on a stale number.
const MAX_READING_AGE_MS = 15 * 60_000;

// Bounds on the retry loop that follows a resume with deferred devices.
const RETRY_MIN_DELAY_MS = 15_000;
const RETRY_STALE_DELAY_MS = 45_000;
const RETRY_WINDOW_MS = 20 * 60_000;

export type SyncTrigger = "sensor" | "resume" | "retry" | "manual" | "stage-change";

export type SyncMode = "edge" | "assert";

/**
 * A sensor message is the steady state and must not re-assert; everything else
 * is a correction after the relays and the rules are known to have diverged.
 */
function modeFor(trigger: SyncTrigger): SyncMode {
  return trigger === "sensor" ? "edge" : "assert";
}

export interface AutomationSyncReport {
  trigger: SyncTrigger;
  mode: SyncMode;
  evaluatedAt: string;
  reading: {
    timestamp: string;
    ageSeconds: number;
    values: Record<string, number>;
  } | null;
  /** True when there is no reading, or the newest one is too old to act on. */
  stale: boolean;
  rulesFired: Array<{ id: string; name: string; cause: "trigger" | "cutoff" }>;
  applied: Array<{
    device: string;
    state: boolean;
    decidedBy: "rule" | "threshold";
    rule: string | null;
  }>;
  unchanged: Array<{ device: string; state: boolean }>;
  deferred: Array<{ device: string; reason: string; retryAfter: string | null }>;
  skipped: Array<{ device: string; reason: string }>;
}


interface Desired {
  on: boolean;
  decidedBy: "rule" | "threshold";
  rule: string | null;
}

// Rule/device key → the legacy bands that decide it when no rule does. The
// arithmetic lives in `thresholdBands.ts` so it can be unit-tested on its own.
import { THRESHOLD_DEVICES, thresholdDecisions } from "./thresholdBands";

function emptyReport(
  trigger: SyncTrigger,
  overrides: Partial<AutomationSyncReport> = {},
): AutomationSyncReport {
  return {
    trigger,
    mode: modeFor(trigger),
    evaluatedAt: new Date().toISOString(),
    reading: null,
    stale: false,
    rulesFired: [],
    applied: [],
    unchanged: [],
    deferred: [],
    skipped: [],
    ...overrides,
  };
}

function describeReading(snapshot: SensorSnapshot, now: number) {
  return {
    timestamp: snapshot.timestamp.toISOString(),
    ageSeconds: Math.max(0, Math.round((now - snapshot.timestamp.getTime()) / 1000)),
    values: snapshot.values as Record<string, number>,
  };
}

/**
 * Evaluates the current sensor snapshot against the rules and the threshold
 * bands, then applies the result to the relays. Devices in MANUAL mode are left
 * alone, and a compressor still inside its guard window is reported as deferred
 * rather than forced.
 */
export async function syncAutomationToSensors(
  trigger: SyncTrigger = "manual",
): Promise<AutomationSyncReport> {
  const mode = modeFor(trigger);

  if (await isAutomationPaused()) {
    logger.debug({ trigger }, "Automation sync skipped — automation is paused");
    return emptyReport(trigger, {
      skipped: [{ device: "all", reason: "automation-paused" }],
    });
  }

  const now = Date.now();
  const snapshot = await getLatestSensorSnapshot();

  if (!snapshot) {
    logger.warn({ trigger }, "Automation sync: no sensor reading stored yet");
    return emptyReport(trigger, { stale: true });
  }

  const ageMs = now - snapshot.timestamp.getTime();
  if (ageMs > MAX_READING_AGE_MS) {
    logger.warn(
      { trigger, ageSeconds: Math.round(ageMs / 1000) },
      "Automation sync: newest reading is too old to act on",
    );
    return emptyReport(trigger, {
      stale: true,
      reading: describeReading(snapshot, now),
    });
  }

  const [evaluation, settings, devices] = await Promise.all([
    evaluateRules(DEFAULT_PROFILE_ID, snapshot, now),
    getSettings(),
    listDeviceControls(),
  ]);

  const desired = new Map<string, Desired>();

  // Every device a rule has an opinion about is off-limits to the threshold
  // fallback, even when the rule is only *holding* it — the rule owns it, and
  // letting the band fight a latched rule is exactly the old bug.
  const ruleClaimed = new Set<string>();

  for (const decision of evaluation.decisions) {
    ruleClaimed.add(decision.device);

    // In edge mode only a rule that actually acted this pass writes anything,
    // mirroring the firmware. In assert mode the standing latched state is
    // written too, because the relays are known to be out of step.
    const isEdge = decision.transition === "activated" || decision.transition === "released";
    if (mode === "edge" && !isEdge) continue;

    desired.set(decision.device, {
      on: decision.on,
      decidedBy: "rule",
      rule: decision.ruleName,
    });
  }

  // Threshold fallback only for devices no rule decided.
  const thresholds = thresholdDecisions(snapshot.values, settings);
  for (const key of THRESHOLD_DEVICES) {
    if (ruleClaimed.has(key)) continue;
    const on = thresholds[key];
    if (on === null) continue;
    desired.set(key, { on, decidedBy: "threshold", rule: null });
  }

  const report = emptyReport(trigger, {
    reading: describeReading(snapshot, now),
    rulesFired: evaluation.rulesFired,
  });

  // A rule inside a minOff/cooldown window wanted to act and could not. Surface
  // it as deferred so `scheduleRetryIfUnsettled` comes back when the window
  // expires, instead of waiting for the next sensor message.
  for (const blocked of evaluation.blocked) {
    report.deferred.push({
      device: `rule:${blocked.name}`,
      reason: "dwell-window",
      retryAfter: blocked.until,
    });
  }

  const knownKeys = new Set(DEFAULT_RELAY_MAP.map((d) => d.key));

  for (const [key, want] of desired) {
    if (!knownKeys.has(key as never)) {
      report.skipped.push({ device: key, reason: "unknown-device" });
      continue;
    }

    const device = devices.find((d) => d.key === key);
    if (!device) {
      report.skipped.push({ device: key, reason: "not-in-profile" });
      continue;
    }
    if (device.mode === "manual") {
      report.skipped.push({ device: key, reason: "manual-mode" });
      continue;
    }
    if (device.state === want.on) {
      report.unchanged.push({ device: key, state: device.state });
      continue;
    }

    try {
      await applyDeviceState(key, want.on, "auto");
      report.applied.push({
        device: key,
        state: want.on,
        decidedBy: want.decidedBy,
        rule: want.rule,
      });
    } catch (err) {
      if (err instanceof RelayGuardedError) {
        report.deferred.push({
          device: key,
          reason: "safety-guard",
          retryAfter: err.guardedUntil.toISOString(),
        });
        continue;
      }
      logger.error({ err, device: key }, "Automation sync failed to set device state");
      report.deferred.push({
        device: key,
        reason: err instanceof Error ? err.message : "unknown-error",
        retryAfter: null,
      });
    }
  }

  logger.info(
    {
      trigger,
      mode,
      rulesFired: report.rulesFired.length,
      applied: report.applied.length,
      unchanged: report.unchanged.length,
      deferred: report.deferred.length,
      skipped: report.skipped.length,
    },
    "Automation synced to current sensor readings",
  );

  return report;
}

// ─── Retry loop ──────────────────────────────────────────────────────────────
//
// A resume can leave work unfinished: the compressor guard blocks the AC for up
// to 5 minutes after the stop, and a stale reading blocks every decision. Both
// resolve on their own, so re-check until the system settles instead of leaving
// devices off until the next sensor message happens to land.

let retryTimer: NodeJS.Timeout | null = null;
let retryDeadline = 0;

/** Cancels any pending retry — an emergency stop must never be undone by one. */
export function cancelAutomationRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDeadline = 0;
}

function armRetry(delayMs: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runRetry();
  }, delayMs);
  // Never hold the process open for a retry.
  retryTimer.unref?.();
}

async function runRetry(): Promise<void> {
  if (Date.now() > retryDeadline) {
    logger.info("Automation retry window closed");
    return;
  }
  if (await isAutomationPaused()) {
    logger.debug("Automation retry stopped — automation paused again");
    return;
  }

  try {
    const report = await syncAutomationToSensors("retry");
    scheduleRetryIfUnsettled(report, { extendWindow: false });
  } catch (err) {
    logger.error({ err }, "Automation retry failed");
  }
}

/**
 * Schedules a follow-up sync when the last one could not finish: soonest guard
 * expiry for deferred devices, or a fixed delay while readings are stale.
 */
export function scheduleRetryIfUnsettled(
  report: AutomationSyncReport,
  options: { extendWindow?: boolean } = {},
): void {
  const unsettled = report.deferred.length > 0 || report.stale;
  if (!unsettled) {
    cancelAutomationRetry();
    return;
  }

  const now = Date.now();
  if (options.extendWindow !== false) {
    retryDeadline = now + RETRY_WINDOW_MS;
  }
  if (now > retryDeadline) return;

  const guardWaits = report.deferred
    .map((d) => (d.retryAfter ? new Date(d.retryAfter).getTime() - now + 1_000 : 0))
    .filter((ms) => ms > 0);

  const delay = Math.max(
    RETRY_MIN_DELAY_MS,
    guardWaits.length > 0 ? Math.min(...guardWaits) : RETRY_STALE_DELAY_MS,
  );

  logger.info(
    { delaySeconds: Math.round(delay / 1000), deferred: report.deferred.length, stale: report.stale },
    "Scheduling automation retry",
  );
  armRetry(Math.min(delay, retryDeadline - now));
}
