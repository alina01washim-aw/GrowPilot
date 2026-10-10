import { RELAY_NAMES } from "../models/relay";
import { DEFAULT_RELAY_MAP } from "../models/deviceProfile";
import { SettingsModel } from "../models/settings";
import { setRelayState, RelayGuardedError, type RelayView } from "./relayControl";
import {
  publishRelayCommand,
  publishDeviceCommand,
  publishRelayIndexCommand,
} from "./mqttCommands";
import { setAutomationPaused, invalidateAutomationCache } from "./automationControl";
import {
  applyDeviceMode,
  applyDeviceState,
  getDeviceModes,
  DEFAULT_PROFILE_ID,
} from "./deviceControl";
import { publishRulePayload } from "./ruleControl";
import { getCropCycleStatus, applyStage } from "./cropCycle";
import {
  syncAutomationToSensors,
  scheduleRetryIfUnsettled,
  cancelAutomationRetry,
  type AutomationSyncReport,
} from "./automationSync";
import { clearAllRuleLatches } from "./ruleEvaluator";
import { logger } from "./logger";

/**
 * Emergency stop / resume.
 *
 * Two rules shape the ordering here:
 *
 *  1. STOP is a hardware action first and a bookkeeping action second. Every
 *     MQTT off-command is published *before* the first database write, so a slow
 *     or unreachable MongoDB can never delay — or silently prevent — the relays
 *     going off. The firmware also latches its own `emergencyStop` flag and
 *     forces all four channels off from its loop watchdog.
 *
 *  2. RESUME must actively restore the system, not merely un-pause it. Nothing
 *     has *changed* since the stop, so no event will trigger automation on its
 *     own: resume re-reads the sensors, evaluates the automation rules, and
 *     commands the relays back to where the rules say they belong.
 */

const ALL_DEVICE_KEYS = DEFAULT_RELAY_MAP.map((d) => d.key);

export interface EmergencyStopReport {
  ok: boolean;
  stoppedAt: string;
  automationPaused: boolean;
  /** Relay documents after the stop (legacy fan/fridge/humidifier). */
  relays: RelayView[];
  /** Device keys confirmed OFF, including those with no legacy relay doc. */
  devicesOff: string[];
  errors: Array<{ device: string; error: string }>;
}

/**
 * Cuts power to every device and pauses all automation — server-side and the
 * rules running on the ESP.
 */
export async function emergencyStopAll(): Promise<EmergencyStopReport> {
  const stoppedAt = new Date();
  const errors: Array<{ device: string; error: string }> = [];

  // ── 1. Hardware first, no awaits in front of it ────────────────────────────
  // The firmware sets its emergency flag, forces all relays off and latches a
  // manual override on every channel.
  publishDeviceCommand("EMERGENCY_STOP");
  // Legacy fallback for firmware that predates EMERGENCY_STOP. Current firmware
  // ignores these (it drops every other command while its emergency flag is
  // set) — by which point it has already forced all four channels off itself.
  for (const name of RELAY_NAMES) {
    publishRelayCommand(name, false);
  }
  for (const device of DEFAULT_RELAY_MAP) {
    publishRelayIndexCommand(device.index, false);
  }
  logger.warn("Emergency stop — OFF commands published to device");

  // A retry from an earlier resume must not turn anything back on.
  cancelAutomationRetry();

  // ── 2. Snapshot the current modes so resume can restore them ───────────────
  let modes: Array<{ key: string; mode: "auto" | "manual" }> = [];
  try {
    modes = await getDeviceModes();
  } catch (err) {
    logger.error({ err }, "Emergency stop — could not read device modes");
  }

  // ── 3. Pause automation (also republishes rules with masterEnabled=false) ──
  invalidateAutomationCache();
  try {
    await setAutomationPaused(true);
  } catch (err) {
    logger.error({ err }, "Emergency stop — failed to persist paused flag");
    errors.push({
      device: "automation",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Only record a snapshot for the *first* stop. A second stop while already
    // paused would otherwise capture the all-MANUAL state the first one wrote,
    // and resume would then restart nothing. `stoppedAt: null` also matches
    // documents saved before this field existed.
    await SettingsModel.updateOne(
      { _id: "default", stoppedAt: null },
      { $set: { stoppedAt, stoppedModes: modes, updatedAt: new Date() } },
    );
  } catch (err) {
    logger.error({ err }, "Emergency stop — failed to store mode snapshot");
  }

  // ── 4. Persist OFF state for every device ──────────────────────────────────
  const relays: RelayView[] = [];
  const devicesOff: string[] = [];

  for (const name of RELAY_NAMES) {
    try {
      const relay = await setRelayState(name, false, "manual", {
        historySource: "emergency",
      });
      publishRelayCommand(name, false);
      relays.push(relay);
      logger.warn({ name }, "Emergency stop — device turned OFF");
    } catch (err) {
      // Turning OFF is never guard-blocked; log defensively all the same.
      if (err instanceof RelayGuardedError) {
        logger.error(
          { name, err: err.message },
          "Unexpected: relay guarded during emergency stop (turning OFF)",
        );
      } else {
        logger.error({ name, err }, "Failed to turn off relay during emergency stop");
      }
      errors.push({ device: name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Devices without a legacy Relay document (UV-C) go through the device path
  // so their profile state and runtime history stay in sync.
  for (const device of DEFAULT_RELAY_MAP) {
    if (legacyNameFor(device.key)) continue; // already handled by the loop above
    try {
      await applyDeviceState(device.key, false, "manual", {
        historySource: "emergency",
      });
      devicesOff.push(device.key);
      logger.warn({ device: device.key }, "Emergency stop — device turned OFF");
    } catch (err) {
      logger.error({ err, device: device.key }, "Failed to turn off device during emergency stop");
      errors.push({
        device: device.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5. Park every device in MANUAL so nothing can restart it ───────────────
  for (const key of ALL_DEVICE_KEYS) {
    try {
      await applyDeviceMode(key, "manual");
    } catch (err) {
      logger.error({ err, device: key }, "Failed to set device to manual during emergency stop");
    }
  }

  // One rules publish for all of the above (masterEnabled is already false).
  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Failed to re-publish rules after emergency stop");
  });

  // Every relay is now forced off, so no rule group can still be considered
  // latched. Dropping the latches makes resume re-decide from the current
  // readings instead of restoring a group whose devices are already off — and
  // clears the dwell windows, which are measured against those latches.
  await clearAllRuleLatches();

  for (const relay of relays) {
    const key = deviceKeyFor(relay.name);
    if (key) devicesOff.push(key);
  }

  if (errors.length > 0) {
    logger.error({ errors }, "Emergency stop completed with errors");
  }

  return {
    ok: errors.length === 0,
    stoppedAt: stoppedAt.toISOString(),
    automationPaused: true,
    relays,
    devicesOff,
    errors,
  };
}

export interface ResumeReport {
  ok: boolean;
  resumedAt: string;
  automationPaused: false;
  restoredModes: Array<{ key: string; mode: "auto" | "manual" }>;
  /** Set when a crop batch is running and its stage was re-applied instead. */
  stageReapplied: string | null;
  /** Result of re-evaluating the sensors + rules and driving the relays. */
  sync: AutomationSyncReport;
  errors: Array<{ device: string; error: string }>;
}

/**
 * Restarts the system: clears the pause, tells the firmware to resume, then
 * re-evaluates the current sensor readings against the automation rules and
 * commands the relays accordingly.
 *
 * If a crop batch is running, its current stage is re-applied and *that*
 * decides the device modes — the crop plan is the authority whenever there is
 * one, so the two cannot end up disagreeing about which devices are automated.
 * With no batch, the AUTO/MANUAL modes captured at the stop are restored, so a
 * device the operator had deliberately parked in MANUAL is not restarted.
 */
export async function resumeAutomation(): Promise<ResumeReport> {
  const resumedAt = new Date();
  const errors: Array<{ device: string; error: string }> = [];

  // ── 1. Clear the pause; this republishes the rules with masterEnabled=true ─
  invalidateAutomationCache();
  await setAutomationPaused(false);

  // Clears the firmware's emergency flag and its per-channel manual overrides.
  publishDeviceCommand("RESUME");

  const settings = await SettingsModel.findById("default")
    .select("stoppedModes")
    .lean();

  await SettingsModel.findByIdAndUpdate("default", {
    $set: { stoppedAt: null, stoppedModes: [], updatedAt: new Date() },
  }).catch((err) => {
    logger.error({ err }, "Failed to clear emergency stop snapshot");
  });

  // ── 2. A running crop stage outranks the pre-stop snapshot ─────────────────
  const cropStatus = await getCropCycleStatus().catch((err) => {
    logger.error({ err }, "Resume could not read the crop cycle");
    return null;
  });

  if (cropStatus?.stage) {
    const applied = await applyStage(cropStatus.stage);
    const restoredModes = ALL_DEVICE_KEYS.map((key) => ({
      key,
      mode: (applied.devicesAuto.includes(key) ? "auto" : "manual") as "auto" | "manual",
    }));

    logger.info(
      { stage: cropStatus.stage.key, applied: applied.sync?.applied.length ?? 0 },
      "Automation resumed — crop stage re-applied",
    );

    return {
      ok: applied.warnings.length === 0,
      resumedAt: resumedAt.toISOString(),
      automationPaused: false,
      restoredModes,
      stageReapplied: cropStatus.stage.label,
      sync: applied.sync ?? (await syncAutomationToSensors("resume")),
      errors,
    };
  }

  // ── 3. No batch running: restore the modes captured at the stop ────────────
  const snapshot = new Map(
    (settings?.stoppedModes ?? []).map((m) => [m.key, m.mode as "auto" | "manual"]),
  );

  const restoredModes: Array<{ key: string; mode: "auto" | "manual" }> = [];
  for (const key of ALL_DEVICE_KEYS) {
    const mode = snapshot.get(key) ?? "auto";
    try {
      await applyDeviceMode(key, mode);
      restoredModes.push({ key, mode });
    } catch (err) {
      logger.error({ err, device: key }, "Failed to restore device mode during resume");
      errors.push({
        device: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Failed to re-publish rules after resume");
  });

  // ── 4. Analyse the sensors + rules and put the relays back to work ─────────
  const sync = await syncAutomationToSensors("resume");
  scheduleRetryIfUnsettled(sync);

  logger.info(
    {
      applied: sync.applied.length,
      deferred: sync.deferred.length,
      stale: sync.stale,
      restoredModes,
    },
    "Automation resumed after emergency stop",
  );

  return {
    ok: errors.length === 0,
    resumedAt: resumedAt.toISOString(),
    automationPaused: false,
    restoredModes,
    stageReapplied: null,
    sync,
    errors,
  };
}

// ─── key ↔ legacy relay name helpers ────────────────────────────────────────

const LEGACY_NAME_BY_KEY: Record<string, string | null> = {
  fan: "fan",
  ac: "fridge",
  mist_maker: "humidifier",
  uv: null,
};

function legacyNameFor(key: string): string | null {
  return LEGACY_NAME_BY_KEY[key] ?? null;
}

function deviceKeyFor(relayName: string): string | null {
  const entry = Object.entries(LEGACY_NAME_BY_KEY).find(([, name]) => name === relayName);
  return entry ? entry[0] : null;
}
