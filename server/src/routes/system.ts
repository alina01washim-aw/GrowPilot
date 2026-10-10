import { Router, type IRouter } from "express";
import { isAutomationPaused } from "../lib/automationControl";
import { emergencyStopAll, resumeAutomation } from "../lib/emergencyStop";
import {
  syncAutomationToSensors,
  scheduleRetryIfUnsettled,
} from "../lib/automationSync";
import { publishDeviceCommand } from "../lib/mqttCommands";
import { getEmergencyThresholds } from "../lib/emergencyThresholds";

const router: IRouter = Router();

function serializeRelay(relay: {
  name: string;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null;
  source: string;
}) {
  return {
    name: relay.name,
    state: relay.state,
    updatedAt: relay.updatedAt.toISOString(),
    guardedUntil: relay.guardedUntil ? relay.guardedUntil.toISOString() : null,
    source: relay.source,
  };
}

router.get("/system/status", async (_req, res): Promise<void> => {
  const automationPaused = await isAutomationPaused();
  res.json({ automationPaused });
});

router.post("/system/emergency-stop", async (_req, res): Promise<void> => {
  const report = await emergencyStopAll();
  res.json({
    ok: report.ok,
    automationPaused: report.automationPaused,
    stoppedAt: report.stoppedAt,
    devicesOff: report.devicesOff,
    errors: report.errors,
    relays: report.relays.map(serializeRelay),
  });
});

router.post("/system/resume-automation", async (_req, res): Promise<void> => {
  const report = await resumeAutomation();
  res.json({
    ok: report.ok,
    automationPaused: report.automationPaused,
    resumedAt: report.resumedAt,
    restoredModes: report.restoredModes,
    sync: report.sync,
    errors: report.errors,
  });
});

// Re-evaluates the current sensor readings against the automation rules and
// drives the relays to match, without touching the paused flag. Useful after
// editing rules, or to retry devices that were guard-blocked during a resume.
router.post("/system/sync-automation", async (_req, res): Promise<void> => {
  const report = await syncAutomationToSensors("manual");
  scheduleRetryIfUnsettled(report);
  res.json(report);
});

// Sends a raw command string to the ESP32 (REBOOT, WIFI_RESET). The device
// picks it up over MQTT on fridge/commands.
router.post("/system/device-command", async (req, res): Promise<void> => {
  const command =
    typeof req.body?.command === "string" ? req.body.command.trim() : "";
  if (!["REBOOT", "WIFI_RESET"].includes(command)) {
    res
      .status(400)
      .json({ error: "command must be one of: REBOOT, WIFI_RESET" });
    return;
  }
  publishDeviceCommand(command);
  res.json({ ok: true, command });
});

// Returns emergency alert thresholds derived from enabled automation rules.
// Falls back to settings thresholds if no rules define a particular threshold.
router.get("/system/emergency-thresholds", async (_req, res): Promise<void> => {
  const thresholds = await getEmergencyThresholds();
  res.json(thresholds);
});

// Debug endpoint to inspect raw rule values for threshold derivation
router.get(
  "/system/emergency-thresholds/debug",
  async (_req, res): Promise<void> => {
    const { AutomationRuleModel } = await import("../models/automationRule");
    const { getSettings } = await import("../lib/settingsControl");

    const settings = await getSettings();
    const rules = await AutomationRuleModel.find({ enabled: true }).lean();

    const debug = {
      settings: {
        tempMin: settings.tempMin,
        tempMax: settings.tempMax,
        humidityMin: settings.humidityMin,
        humidityMax: settings.humidityMax,
        co2Min: settings.co2Min,
        co2Max: settings.co2Max,
      },
      rules: rules.map((r) => ({
        name: r.name,
        enabled: r.enabled,
        triggers: r.triggers,
        cutoffs: r.cutoffs,
      })),
      extracted: {
        tempMinValues: [] as number[],
        tempMaxValues: [] as number[],
        humidityMinValues: [] as number[],
        humidityMaxValues: [] as number[],
        co2MinValues: [] as number[],
        co2MaxValues: [] as number[],
      },
    };

    for (const rule of rules) {
      for (const trigger of rule.triggers || []) {
        const value = trigger.value;
        switch (trigger.sensor) {
          case "air_temp":
            debug.extracted.tempMaxValues.push(value);
            break;
          case "humidity":
            if (trigger.operator === "<" || trigger.operator === "<=")
              debug.extracted.humidityMinValues.push(value);
            else
              debug.extracted.humidityMaxValues.push(value);
            break;
          case "co2":
            if (trigger.operator === "<" || trigger.operator === "<=")
              debug.extracted.co2MinValues.push(value);
            else
              debug.extracted.co2MaxValues.push(value);
            break;
        }
      }
      for (const cutoff of rule.cutoffs || []) {
        const value = cutoff.value;
        switch (cutoff.sensor) {
          case "air_temp":
            debug.extracted.tempMinValues.push(value);
            break;
          case "humidity":
            if (cutoff.operator === "<" || cutoff.operator === "<=")
              debug.extracted.humidityMinValues.push(value);
            else
              debug.extracted.humidityMaxValues.push(value);
            break;
          case "co2":
            if (cutoff.operator === "<" || cutoff.operator === "<=")
              debug.extracted.co2MinValues.push(value);
            else
              debug.extracted.co2MaxValues.push(value);
            break;
        }
      }
    }

    const thresholds = await getEmergencyThresholds();
    res.json({ debug, final: thresholds });
  },
);

export default router;
