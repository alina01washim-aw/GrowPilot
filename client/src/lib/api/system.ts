import { customFetch } from "./custom-fetch";

export interface SystemStatus {
  automationPaused: boolean;
}

export interface EmergencyThresholds {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
  derivedFromRules: boolean;
}

export interface EmergencyStopResult {
  ok: boolean;
  automationPaused: boolean;
  stoppedAt: string;
  devicesOff: string[];
  errors: Array<{ device: string; error: string }>;
  relays: Array<{
    name: string;
    state: boolean;
    updatedAt: string;
    guardedUntil: string | null;
    source: string;
  }>;
}

export type SyncTrigger =
  | "sensor"
  | "resume"
  | "retry"
  | "manual"
  | "stage-change";

/**
 * "edge" writes only rules that latched or released this pass (steady state,
 * matching the firmware); "assert" drives every device to the full desired
 * state, used when the relays are known to be out of step.
 */
export type SyncMode = "edge" | "assert";

/** Outcome of re-evaluating the sensors + automation rules and driving relays. */
export interface AutomationSyncReport {
  trigger: SyncTrigger;
  mode: SyncMode;
  evaluatedAt: string;
  reading: {
    timestamp: string;
    ageSeconds: number;
    values: Record<string, number>;
  } | null;
  stale: boolean;
  rulesFired: Array<{ id: string; name: string; cause: "trigger" | "cutoff" }>;
  applied: Array<{
    device: string;
    state: boolean;
    decidedBy: "rule" | "threshold";
    rule: string | null;
  }>;
  unchanged: Array<{ device: string; state: boolean }>;
  deferred: Array<{
    device: string;
    reason: string;
    retryAfter: string | null;
  }>;
  skipped: Array<{ device: string; reason: string }>;
}

export interface ResumeResult {
  ok: boolean;
  automationPaused: false;
  resumedAt: string;
  restoredModes: Array<{ key: string; mode: "auto" | "manual" }>;
  /** Set when a crop batch is running and its stage was re-applied. */
  stageReapplied: string | null;
  sync: AutomationSyncReport;
  errors: Array<{ device: string; error: string }>;
}

export function getSystemStatus(): Promise<SystemStatus> {
  return customFetch<SystemStatus>("/api/system/status");
}

export function emergencyStopAll(): Promise<EmergencyStopResult> {
  return customFetch<EmergencyStopResult>("/api/system/emergency-stop", {
    method: "POST",
  });
}

export function resumeAutomation(): Promise<ResumeResult> {
  return customFetch<ResumeResult>("/api/system/resume-automation", {
    method: "POST",
  });
}

/**
 * Re-evaluates sensors + rules and drives the relays to match, without
 * changing the paused flag.
 */
export function syncAutomation(): Promise<AutomationSyncReport> {
  return customFetch<AutomationSyncReport>("/api/system/sync-automation", {
    method: "POST",
  });
}

/**
 * Fetches emergency alert thresholds derived from enabled automation rules.
 * Falls back to settings thresholds if no rules define a particular threshold.
 */
export function getEmergencyThresholds(): Promise<EmergencyThresholds> {
  return customFetch<EmergencyThresholds>("/api/system/emergency-thresholds");
}

/**
 * Fetches debug info for emergency threshold derivation.
 */
export function getEmergencyThresholdsDebug(): Promise<any> {
  return customFetch<any>("/api/system/emergency-thresholds/debug");
}

import { deviceLabel } from "@/lib/device-registry";
export { deviceLabel };

/** Human-readable one-liner describing what a resume actually did. */
export function describeSyncReport(sync: AutomationSyncReport): string {
  if (sync.stale) {
    return sync.reading
      ? `Last reading is ${Math.round(sync.reading.ageSeconds / 60)}m old — waiting for fresh sensor data before starting devices.`
      : "No sensor data yet — waiting for the first reading before starting devices.";
  }

  const parts: string[] = [];

  const turnedOn = sync.applied
    .filter((a) => a.state)
    .map((a) => deviceLabel(a.device));
  const turnedOff = sync.applied
    .filter((a) => !a.state)
    .map((a) => deviceLabel(a.device));

  if (turnedOn.length > 0) parts.push(`Started ${turnedOn.join(", ")}`);
  if (turnedOff.length > 0) parts.push(`Stopped ${turnedOff.join(", ")}`);

  if (sync.deferred.length > 0) {
    const names = sync.deferred.map((d) => deviceLabel(d.device)).join(", ");
    parts.push(`${names} waiting on safety guard — will retry automatically`);
  }

  if (parts.length === 0) {
    return "Auto control active — readings are already inside range, nothing to change.";
  }

  return `${parts.join(". ")}.`;
}

/** Same, prefixed with the crop stage when a batch drove the resume. */
export function describeResume(result: ResumeResult): string {
  const summary = describeSyncReport(result.sync);
  return result.stageReapplied
    ? `${result.stageReapplied} re-applied. ${summary}`
    : summary;
}
