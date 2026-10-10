import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Runtime latch state of one automation rule.
 *
 * The firmware rule engine (`firmware/src/rule_engine.cpp`) is a *latching*
 * engine, not a stateless one: a rule whose triggers fire latches its group ON
 * and stays there until its cutoffs fire, regardless of whether the triggers
 * still hold. `minOnMs` / `minOffMs` / `cooldownMs` are dwell windows measured
 * against that latch.
 *
 * For the server to agree with the device instead of fighting it, it has to
 * keep the same latch. That state lives here rather than as extra fields on
 * AutomationRule so rule documents stay pure configuration — same split as
 * DeviceStateHistory vs Relay.
 *
 * It is persisted rather than held in memory because a server restart must not
 * silently reset every latch: that would re-activate rules whose cutoffs had
 * already released them, and reset every dwell window to zero.
 */

const ruleLatchSchema = new Schema(
  {
    // AutomationRule _id as a string. One latch document per rule.
    ruleId: { type: String, required: true, unique: true },

    // True while the rule's group is latched ON (firmware: `groupActive`).
    groupActive: { type: Boolean, required: true, default: false },

    // When the group last latched ON — `minOnMs` is measured from here
    // (firmware: `groupActiveSinceMs`).
    groupActiveSince: { type: Date, default: null },

    // When the rule last acted, in either direction — `minOffMs` and
    // `cooldownMs` are measured from here (firmware: `lastActionMs`).
    lastActionAt: { type: Date, default: null },

    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export type RuleLatchDocument = InferSchemaType<typeof ruleLatchSchema>;

export const RuleLatchModel = model("RuleLatch", ruleLatchSchema);
