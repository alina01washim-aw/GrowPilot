import { RelayModel, RELAY_NAMES, type RelayName } from "../models/relay";
import {
  DeviceProfileModel,
  DEFAULT_RELAY_MAP,
  DEVICE_ICON_IDS,
} from "../models/deviceProfile";
import { setRelayState, RelayGuardedError } from "./relayControl";
import { publishRelayCommand, publishRelayIndexCommand } from "./mqttCommands";
import { publishRulePayload } from "./ruleControl";
import { logger } from "./logger";
import {
  logDeviceStateOn,
  logDeviceStateOff,
  type HistorySource,
} from "./deviceStateHistory";

/**
 * Per-device manual/auto control for the rule-driven edge engine.
 *
 * Every device in the relay registry (fan, ac, mist_maker, uv) gets an
 * AUTO/MANUAL mode. In AUTO the ESP rule engine commands it; in MANUAL the
 * user commands it directly and the rules payload marks the device as
 * `enabled: false`, so the ESP edge engine skips it — even offline.
 *
 * Legacy relay documents (fan/fridge/humidifier) remain the source of truth
 * for state + compressor guard + automationEnabled of the mapped devices;
 * devices without a legacy document (uv) keep their last commanded state in
 * the DeviceProfile relayMap.
 */

export const DEFAULT_PROFILE_ID = "main";

// Rule key → legacy Relay document name (null = no legacy doc)
export const LEGACY_RELAY_NAME: Record<string, RelayName | null> = {
  fan: "fan",
  ac: "fridge",
  mist_maker: "humidifier",
  uv: null,
};

const RULE_KEYS = DEFAULT_RELAY_MAP.map((r) => r.key);

export interface DeviceControlView {
  key: string;
  label: string;
  icon: string;
  index: number;
  mode: "auto" | "manual";
  state: boolean;
  guardedUntil: string | null;
}

/** Falls back to the shipped label, then the key, so a row is never blank. */
const DEFAULT_LABEL = new Map<string, string>(DEFAULT_RELAY_MAP.map((d) => [d.key, d.label]));
const DEFAULT_ICON = new Map<string, string>(DEFAULT_RELAY_MAP.map((d) => [d.key, d.icon]));

function labelOf(entry: { key: string; label?: string }): string {
  return entry.label?.trim() || DEFAULT_LABEL.get(entry.key) || entry.key;
}

function iconOf(entry: { key: string; icon?: string }): string {
  return entry.icon?.trim() || DEFAULT_ICON.get(entry.key) || "device";
}

export function isRuleDeviceKey(value: string): value is string {
  return (RULE_KEYS as readonly string[]).includes(value);
}

async function ensureMainProfileRelayMap() {
  await DeviceProfileModel.updateOne(
    { profileId: DEFAULT_PROFILE_ID },
    { $setOnInsert: { profileId: DEFAULT_PROFILE_ID, name: "Main Controller", relayMap: DEFAULT_RELAY_MAP } },
    { upsert: true },
  );
  const profile = await DeviceProfileModel.findOne({ profileId: DEFAULT_PROFILE_ID }).lean();
  return profile?.relayMap ?? DEFAULT_RELAY_MAP;
}

async function getRelayDocs() {
  const docs = await RelayModel.find().lean();
  return new Map(docs.map((d) => [d.name, d]));
}

export async function listDeviceControls(): Promise<DeviceControlView[]> {
  const [relayMap, relayDocs] = await Promise.all([ensureMainProfileRelayMap(), getRelayDocs()]);

  return relayMap
    .map((entry) => {
      const profileEntry = entry as { key: string; label?: string; icon?: string; index: number; enabled?: boolean; state?: boolean };
      const legacyName = LEGACY_RELAY_NAME[entry.key];
      const doc = legacyName ? relayDocs.get(legacyName) : undefined;

      // Legacy devices: Relay document is authoritative.
      if (doc) {
        return {
          key: profileEntry.key,
          label: labelOf(profileEntry),
          icon: iconOf(profileEntry),
          index: profileEntry.index,
          mode: doc.automationEnabled === false ? "manual" : "auto",
          state: doc.state,
          guardedUntil: doc.guardedUntil?.toISOString() ?? null,
        };
      }

      // Devices without a legacy document (uv): profile entry is authoritative.
      return {
        key: profileEntry.key,
        label: labelOf(profileEntry),
        icon: iconOf(profileEntry),
        index: profileEntry.index,
        mode: profileEntry.enabled === false ? "manual" : "auto",
        state: profileEntry.state ?? false,
        guardedUntil: null,
      };
    });
}

/**
 * Device key → current display label, for server-composed messages (stage
 * warnings, resume summaries). Reads the profile so a renamed device is named
 * correctly everywhere, not just in the UI.
 */
export async function getDeviceLabels(): Promise<Map<string, string>> {
  const relayMap = await ensureMainProfileRelayMap();
  return new Map(
    relayMap.map((e) => [e.key, labelOf(e as { key: string; label?: string })]),
  );
}

export class DeviceRenameError extends Error {}

/**
 * Renames a device and/or changes its icon.
 *
 * Only presentation changes. The `key` is deliberately not editable: it is
 * referenced by every automation rule (`actions.turnOn`), every crop stage plan
 * (`devicesAuto`) and every DeviceStateHistory record, so changing it would
 * silently unwire existing rules and split the runtime history in two.
 */
export async function renameDevice(
  key: string,
  patch: { label?: string; icon?: string },
): Promise<DeviceControlView> {
  const relayMap = await ensureMainProfileRelayMap();
  const entry = relayMap.find((e) => e.key === key);
  if (!entry) throw new Error("unknown-device");

  const set: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new DeviceRenameError("Name cannot be empty");
    if (label.length > 40) throw new DeviceRenameError("Name must be 40 characters or fewer");
    const clash = relayMap.find(
      (e) => e.key !== key && labelOf(e as { key: string; label?: string }).toLowerCase() === label.toLowerCase(),
    );
    if (clash) throw new DeviceRenameError(`Another device is already called "${label}"`);
    set["relayMap.$.label"] = label;
  }

  if (patch.icon !== undefined) {
    if (!(DEVICE_ICON_IDS as readonly string[]).includes(patch.icon)) {
      throw new DeviceRenameError(`Unknown icon "${patch.icon}"`);
    }
    set["relayMap.$.icon"] = patch.icon;
  }

  await DeviceProfileModel.updateOne(
    { profileId: DEFAULT_PROFILE_ID, "relayMap.key": key },
    { $set: set },
  );

  const updated = (await ensureMainProfileRelayMap()).find((e) => e.key === key)!;
  logger.info({ key, label: patch.label, icon: patch.icon }, "Device renamed");
  return toView(updated as never);
}

async function toView(entry: {
  key: string;
  label?: string;
  icon?: string;
  index: number;
  enabled?: boolean;
  state?: boolean;
}): Promise<DeviceControlView> {
  const legacyName = LEGACY_RELAY_NAME[entry.key];
  if (legacyName) {
    const doc = await RelayModel.findOne({ name: legacyName }).lean();
    if (doc) {
      return {
        key: entry.key,
        label: labelOf(entry),
        icon: iconOf(entry),
        index: entry.index,
        mode: doc.automationEnabled === false ? "manual" : "auto",
        state: doc.state,
        guardedUntil: doc.guardedUntil?.toISOString() ?? null,
      };
    }
  }
  return {
    key: entry.key,
    label: labelOf(entry),
    icon: iconOf(entry),
    index: entry.index,
    mode: entry.enabled === false ? "manual" : "auto",
    state: entry.state ?? false,
    guardedUntil: null,
  };
}

/**
 * Switches a device between AUTO (rules control it) and MANUAL (user controls
 * it). Switching to MANUAL immediately turns the device OFF. The rules
 * payload is re-published so the ESP edge engine skips the device.
 */
export async function setDeviceMode(
  key: string,
  mode: "auto" | "manual",
): Promise<DeviceControlView> {
  const relayMap = await ensureMainProfileRelayMap();
  const entry = relayMap.find((e) => e.key === key);
  if (!entry) throw new Error("unknown-device");

  const enabled = mode === "auto";
  await applyDeviceMode(key, mode);

  const legacyName = LEGACY_RELAY_NAME[key];
  if (legacyName) {
    if (!enabled) {
      const relay = await setRelayState(legacyName, false, "manual");
      publishRelayCommand(legacyName, relay.state);
    }
  } else if (!enabled) {
    publishRelayIndexCommand(entry.index, false);
    await logDeviceStateOff(key, "manual");
    await DeviceProfileModel.updateOne(
      { profileId: DEFAULT_PROFILE_ID, "relayMap.key": key },
      { $set: { "relayMap.$.state": false, updatedAt: new Date() } },
    );
  }

  // Push the new device registry (with enabled flags) to the ESP.
  await publishRulePayload(DEFAULT_PROFILE_ID).catch((err) => {
    logger.error({ err }, "Failed to re-publish rules after mode change");
  });

  return toView({ ...entry, enabled, state: false });
}

/**
 * Persists a device's AUTO/MANUAL mode without touching relay state or
 * publishing to MQTT. Callers that change several devices at once (emergency
 * stop, resume) use this and publish the rules payload a single time.
 */
export async function applyDeviceMode(
  key: string,
  mode: "auto" | "manual",
): Promise<void> {
  const enabled = mode === "auto";

  await DeviceProfileModel.updateOne(
    { profileId: DEFAULT_PROFILE_ID, "relayMap.key": key },
    { $set: { "relayMap.$.enabled": enabled, updatedAt: new Date() } },
  );

  const legacyName = LEGACY_RELAY_NAME[key];
  if (legacyName) {
    // Mirrors the mode on the legacy Relay document so the old automation
    // path and the dashboard agree.
    await RelayModel.findOneAndUpdate(
      { name: legacyName },
      { $set: { automationEnabled: enabled, updatedAt: new Date() } },
      { upsert: true },
    );
  }
}

/** Current AUTO/MANUAL mode of every device in the relay registry. */
export async function getDeviceModes(): Promise<
  Array<{ key: string; mode: "auto" | "manual" }>
> {
  const devices = await listDeviceControls();
  return devices.map((d) => ({ key: d.key, mode: d.mode }));
}

/**
 * Manual on/off command from the dashboard. A dashboard click always implies
 * the user wants direct control, so the device's AUTO/MANUAL mode is
 * auto-switched to MANUAL — otherwise the next automation pass would just
 * stomp the user's command. The rule engine will then skip this device until
 * the user flips it back to AUTO.
 *
 * The legacy compressor guard still applies.
 */
export async function setDeviceState(
  key: string,
  on: boolean,
): Promise<DeviceControlView> {
  const relayMap = await ensureMainProfileRelayMap();
  const entry = relayMap.find((e) => e.key === key);
  if (!entry) throw new Error("unknown-device");

  if ((entry as { enabled?: boolean }).enabled !== false) {
    await setDeviceMode(key, "manual");
  }

  return applyDeviceState(key, on, "manual");
}

/**
 * Commands a device on/off, whoever the caller is. `source` is recorded on the
 * relay document and in the runtime history, so an automation-driven change is
 * distinguishable from a dashboard click or an emergency stop.
 *
 * Throws `RelayGuardedError` when the compressor guard blocks a turn-on.
 */
export async function applyDeviceState(
  key: string,
  on: boolean,
  source: "manual" | "auto",
  options: { historySource?: HistorySource } = {},
): Promise<DeviceControlView> {
  const relayMap = await ensureMainProfileRelayMap();
  const entry = relayMap.find((e) => e.key === key);
  if (!entry) throw new Error("unknown-device");

  const legacyName = LEGACY_RELAY_NAME[key];
  if (legacyName) {
    const relay = await setRelayState(legacyName, on, source, options);
    if (source === "manual") {
      publishRelayCommand(legacyName, relay.state);
    }
    return toView({ ...entry, state: relay.state, enabled: relay.automationEnabled });
  }

  if (source === "manual") {
    publishRelayIndexCommand(entry.index, on);
  }
  await DeviceProfileModel.updateOne(
    { profileId: DEFAULT_PROFILE_ID, "relayMap.key": key },
    { $set: { "relayMap.$.state": on, updatedAt: new Date() } },
  );

  const historySource = options.historySource ?? source;
  if (on) {
    await logDeviceStateOn(key, historySource);
  } else {
    await logDeviceStateOff(key, historySource);
  }

  return toView({
    ...entry,
    state: on,
    enabled: (entry as { enabled?: boolean }).enabled,
  });
}

export { RelayGuardedError };