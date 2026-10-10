import { DeviceStateHistoryModel, type DeviceKey } from "../models/deviceStateHistory";
import { RelayModel } from "../models/relay";
import { DeviceProfileModel, DEFAULT_RELAY_MAP } from "../models/deviceProfile";
import { logger } from "./logger";

/**
 * Device runtime history.
 *
 * A runtime is stored as a single "ON session" document:
 *   { state: true, startedAt, endedAt: null }   -- currently running
 *   { state: true, startedAt, endedAt, durationMs } -- completed run
 *
 * Turning a device OFF closes its open session and appends a lightweight
 * { state: false } marker so the event feed shows the transition.
 *
 * The open session lives in MongoDB, not in process memory, so a server
 * restart cannot lose a run that is still in progress.
 */

export type HistorySource = "manual" | "auto" | "emergency";

/**
 * Callers use two vocabularies: the canonical device keys (deviceControl) and
 * the legacy Relay document names (relayControl still passes `fridge` /
 * `humidifier`). Both must resolve, otherwise those devices are never logged.
 */
const DEVICE_KEY_ALIASES: Record<string, DeviceKey> = {
  fan: "fan",
  ac: "ac",
  fridge: "ac",
  mist_maker: "mist_maker",
  humidifier: "mist_maker",
  uv: "uv",
};

// Inverse of the aliases above, for the relay-document backfill. Kept local
// rather than imported from deviceControl to avoid a circular import.
const LEGACY_RELAY_NAME: Record<string, "fan" | "fridge" | "humidifier" | null> = {
  fan: "fan",
  ac: "fridge",
  mist_maker: "humidifier",
  uv: null,
};

function deviceKey(key: string): DeviceKey {
  const mapped = DEVICE_KEY_ALIASES[key];
  if (!mapped) throw new Error(`Unknown device key: ${key}`);
  return mapped;
}

/**
 * Opens a runtime session for a device. Repeated ON commands for an already
 * running device are ignored so one physical run stays one session.
 */
export async function logDeviceStateOn(
  key: string,
  source: HistorySource = "manual",
): Promise<void> {
  const device = deviceKey(key);

  const open = await DeviceStateHistoryModel.exists({
    device,
    state: true,
    endedAt: null,
  });
  if (open) return;

  await DeviceStateHistoryModel.create({
    device,
    state: true,
    startedAt: new Date(),
    endedAt: null,
    source,
    durationMs: null,
  });

  logger.debug({ device, source }, "Device history: runtime session opened");
}

/**
 * Closes the open runtime session for a device and records the OFF event.
 * A device that is already off produces no document — there is no runtime to
 * close, and duplicate OFF commands should not pollute the event feed.
 */
export async function logDeviceStateOff(
  key: string,
  source: HistorySource = "manual",
): Promise<void> {
  const device = deviceKey(key);
  const now = new Date();

  const open = await DeviceStateHistoryModel.findOne({
    device,
    state: true,
    endedAt: null,
  })
    .sort({ startedAt: -1 })
    .lean();

  if (!open) return;

  const durationMs = Math.max(0, now.getTime() - open.startedAt.getTime());

  // Re-check `endedAt: null` so a concurrent OFF cannot close the same
  // session twice and append two OFF markers.
  const result = await DeviceStateHistoryModel.updateOne(
    { _id: open._id, endedAt: null },
    { $set: { endedAt: now, durationMs } },
  );
  if (result.modifiedCount === 0) return;

  await DeviceStateHistoryModel.create({
    device,
    state: false,
    startedAt: now,
    endedAt: now,
    source,
    durationMs: 0,
  });

  logger.debug(
    { device, source, durationMs },
    "Device history: runtime session closed",
  );
}

export async function ensureDeviceStateHistoryInitialized(): Promise<void> {
  await DeviceStateHistoryModel.createIndexes();
}

/**
 * Seeds open sessions for devices that are already ON when the server starts
 * with an empty history collection, so their runtime is counted from boot
 * instead of from the first state change.
 */
export async function backfillDeviceHistoryFromRelays(): Promise<void> {
  const existingCount = await DeviceStateHistoryModel.countDocuments();
  if (existingCount > 0) {
    logger.info({ count: existingCount }, "Device state history already exists, skipping backfill");
    return;
  }

  const relayDocs = await RelayModel.find().lean();
  const profile = await DeviceProfileModel.findOne({ profileId: "main" }).lean();
  const relayMap = profile?.relayMap ?? DEFAULT_RELAY_MAP;

  const legacyByName = new Map(relayDocs.map((d) => [d.name, d]));

  const now = new Date();
  const entries: Array<{
    device: DeviceKey;
    state: boolean;
    startedAt: Date;
    endedAt: Date | null;
    source: HistorySource;
    durationMs: number | null;
  }> = [];

  for (const entry of relayMap) {
    const profileEntry = entry as { key: string; state?: boolean };
    const legacyName = LEGACY_RELAY_NAME[profileEntry.key];
    const doc = legacyName ? legacyByName.get(legacyName) : undefined;
    const isOn = doc ? doc.state : (profileEntry.state ?? false);

    // Devices that are already off have no runtime worth backfilling.
    if (!isOn) continue;

    entries.push({
      device: deviceKey(profileEntry.key),
      state: true,
      startedAt: now,
      endedAt: null,
      source: (doc?.source as HistorySource) ?? "manual",
      durationMs: null,
    });
  }

  if (entries.length > 0) {
    await DeviceStateHistoryModel.insertMany(entries);
    logger.info({ count: entries.length }, "Backfilled open device runtime sessions from relay state");
  }
}
