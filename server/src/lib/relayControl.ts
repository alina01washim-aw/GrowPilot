import { RelayModel, RELAY_NAMES, type RelayName } from "../models/relay";
import { logger } from "./logger";
import {
  logDeviceStateOn,
  logDeviceStateOff,
  type HistorySource,
} from "./deviceStateHistory";

/**
 * Compressor/device safety guard (hysteresis).
 *
 * The fridge's compressor is damaged by rapid on/off cycling. Once it is
 * turned OFF, it cannot be turned back ON for this many seconds, no matter
 * how urgently the automation logic (or a user) wants it on.
 */
const GUARD_SECONDS_BY_RELAY: Record<RelayName, number> = {
  fan: 0,
  fridge: 300,
  humidifier: 0,
};

export interface RelayView {
  name: RelayName;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null;
  source: "manual" | "auto";
  automationEnabled: boolean;
}

function toView(doc: {
  name: string;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null | undefined;
  source: string;
  automationEnabled?: boolean;
}): RelayView {
  return {
    name: doc.name as RelayName,
    state: doc.state,
    updatedAt: doc.updatedAt,
    guardedUntil: doc.guardedUntil ?? null,
    source: doc.source as "manual" | "auto",
    automationEnabled: doc.automationEnabled ?? true,
  };
}

/**
 * Ensures a relay document exists for every known relay name, defaulting to
 * OFF. Safe to call repeatedly (idempotent upsert).
 */
export async function ensureRelaysInitialized(): Promise<void> {
  await Promise.all(
    RELAY_NAMES.map((name) =>
      RelayModel.updateOne(
        { name },
        { $setOnInsert: { name, state: false, updatedAt: new Date(), automationEnabled: true } },
        { upsert: true },
      ),
    ),
  );
}

export async function listRelays(): Promise<RelayView[]> {
  const docs = await RelayModel.find().sort({ name: 1 }).lean();
  return docs.map((d) =>
    toView({
      name: d.name,
      state: d.state,
      updatedAt: d.updatedAt,
      guardedUntil: d.guardedUntil ?? null,
      source: d.source ?? "manual",
      automationEnabled: d.automationEnabled ?? true,
    }),
  );
}

export class RelayGuardedError extends Error {
  guardedUntil: Date;
  constructor(name: RelayName, guardedUntil: Date) {
    super(
      `${name} is guarded until ${guardedUntil.toISOString()} and cannot be turned on yet`,
    );
    this.guardedUntil = guardedUntil;
  }
}

/**
 * Runtime history is best-effort: a failed history write must never stop a relay
 * from being commanded. It is still logged, because a silently dropped session
 * makes the Device History page under-report runtime with no clue why.
 */
function recordHistory(promise: Promise<void>, name: RelayName, state: boolean): void {
  promise.catch((err) => {
    logger.warn({ err, name, state }, "Could not record device runtime history");
  });
}

/**
 * Sets a relay's on/off state, enforcing the safety guard timer.
 *
 * - Turning a relay OFF always succeeds and (for guarded relays) starts the
 *   cooldown window during which it cannot be turned back ON.
 * - Turning a relay ON while still within a previous cooldown window throws
 *   `RelayGuardedError` instead of applying the change.
 *
 * `options.historySource` overrides how the change is labelled in the device
 * runtime history. The relay document itself only distinguishes manual from
 * auto; an emergency stop is manual to the relay but worth separating in the
 * history, so it passes `historySource: "emergency"`.
 */
export async function setRelayState(
  name: RelayName,
  state: boolean,
  source: "manual" | "auto",
  options: { historySource?: HistorySource } = {},
): Promise<RelayView> {
  const now = new Date();
  const guardSeconds = GUARD_SECONDS_BY_RELAY[name];
  const historySource = options.historySource ?? source;

  if (state) {
    // Turning ON: atomically apply the change only if there is no active
    // guard. Filtering on the guard condition inside the query (rather than
    // read-then-write) closes the race window where two concurrent requests
    // could both read a stale "not guarded" state and both flip the relay on.
    const updated = await RelayModel.findOneAndUpdate(
      {
        name,
        $or: [{ guardedUntil: null }, { guardedUntil: { $lte: now } }],
      },
      { $set: { state: true, updatedAt: now, source } },
      { new: true },
    ).lean();

    if (updated) {
      logger.info({ name, state, source }, "Relay state changed");
      recordHistory(logDeviceStateOn(name, historySource), name, true);
      return toView({
        name: updated.name,
        state: updated.state,
        updatedAt: updated.updatedAt,
        guardedUntil: updated.guardedUntil ?? null,
        source: updated.source ?? "manual",
        automationEnabled: updated.automationEnabled ?? true,
      });
    }

    // The conditional update matched no document: either the relay doesn't
    // exist yet (first-ever command) or it's actively guarded. Disambiguate
    // with a read so we can report the correct guardedUntil to the caller.
    const current = await RelayModel.findOneAndUpdate(
      { name },
      { $setOnInsert: { name, state: false, updatedAt: now } },
      { upsert: true, new: true },
    ).lean();

    if (current.guardedUntil && current.guardedUntil > now) {
      throw new RelayGuardedError(name, current.guardedUntil);
    }

    // Guard already expired between the two operations above -- retry once.
    const retried = await RelayModel.findOneAndUpdate(
      { name, $or: [{ guardedUntil: null }, { guardedUntil: { $lte: now } }] },
      { $set: { state: true, updatedAt: now, source } },
      { new: true },
    ).lean();
    if (!retried) {
      throw new RelayGuardedError(name, current.guardedUntil ?? now);
    }
    logger.info({ name, state, source }, "Relay state changed");
    recordHistory(logDeviceStateOn(name, historySource), name, true);
    return toView({
      name: retried.name,
      state: retried.state,
      updatedAt: retried.updatedAt,
      guardedUntil: retried.guardedUntil ?? null,
      source: retried.source ?? "manual",
      automationEnabled: retried.automationEnabled ?? true,
    });
  }

  // Turning OFF always succeeds. Only start a fresh cooldown if the relay
  // was actually on (idempotent OFF requests should not extend the guard).
  const updated = await RelayModel.findOneAndUpdate(
    { name, state: true },
    {
      $set: {
        state: false,
        updatedAt: now,
        source,
        ...(guardSeconds > 0
          ? { guardedUntil: new Date(now.getTime() + guardSeconds * 1000) }
          : {}),
      },
    },
    { new: true },
  ).lean();

  const finalDoc =
    updated ??
    (await RelayModel.findOneAndUpdate(
      { name },
      { $setOnInsert: { name, state: false, updatedAt: now, source } },
      { upsert: true, new: true },
    ).lean());

  logger.info({ name, state, source }, "Relay state changed");
  recordHistory(logDeviceStateOff(name, historySource), name, false);

  return toView({
    name: finalDoc.name,
    state: finalDoc.state,
    updatedAt: finalDoc.updatedAt,
    guardedUntil: finalDoc.guardedUntil ?? null,
    source: finalDoc.source ?? "manual",
    automationEnabled: finalDoc.automationEnabled ?? true,
  });
}

export function isRelayName(value: string): value is RelayName {
  return (RELAY_NAMES as readonly string[]).includes(value);
}
