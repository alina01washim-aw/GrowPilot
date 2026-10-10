import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A predictive warning that has actually been raised.
 *
 * Persisted rather than computed on demand for two reasons. The monitor runs on a
 * timer, so without a record the same warning would be re-raised on every tick
 * and the grower would be toasted every half hour about one problem. And an
 * acknowledgement has to survive a page reload and a server restart, or
 * "dismiss" means nothing.
 *
 * `dedupeKey` comes from `riskEngine.buildDedupeKey` and is unique: batch, stage,
 * day-in-stage, the metrics that matched, and the source annotation. That
 * deliberately excludes the score, so a warning drifting from 0.62 to 0.64 is the
 * same alert, while a *new* metric going out of band on the same day is a new
 * one worth surfacing.
 *
 * The matched evidence is copied in rather than referenced. An alert has to keep
 * explaining itself even if the source annotation is later edited or deleted —
 * otherwise the history of what the grower was told becomes unreliable.
 */

export const RISK_ALERT_STATES = ["active", "acknowledged", "dismissed"] as const;
export type RiskAlertState = (typeof RISK_ALERT_STATES)[number];

const matchedMetricSchema = new Schema(
  {
    metric: { type: String, required: true },
    direction: { type: String, required: true, enum: ["high", "low"] },
    currentValue: { type: Number, required: true },
    historicalValue: { type: Number, required: true },
    bandMin: { type: Number, required: true },
    bandMax: { type: Number, required: true },
    currentDeviation: { type: Number, required: true },
    historicalDeviation: { type: Number, required: true },
    ratio: { type: Number, required: true },
    explanation: { type: String, default: "" },
  },
  { _id: false },
);

const riskAlertSchema = new Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },

    // Where the warning fired.
    batchId: { type: String, required: true },
    stageKey: { type: String, default: "" },
    stageLabel: { type: String, default: "" },
    dayOfStage: { type: Number, default: 1 },
    dayOfBatch: { type: Number, default: 1 },

    // What it was matched against. Copied, not referenced — see the header.
    sourceAnnotationId: { type: String, required: true },
    sourceBatchId: { type: String, required: true },
    sourceBatchName: { type: String, default: "" },
    sourceStageLabel: { type: String, default: "" },
    sourceDayOfStage: { type: Number, default: 1 },
    sourceSeverity: { type: String, default: "warning" },
    sourceOutcome: { type: String, default: null },

    score: { type: Number, required: true },
    stageAligned: { type: Boolean, default: false },
    dayGap: { type: Number, default: 0 },
    metrics: { type: [matchedMetricSchema], default: [] },

    headline: { type: String, required: true },
    advice: { type: String, default: "" },

    state: { type: String, required: true, enum: RISK_ALERT_STATES, default: "active" },
    firedAt: { type: Date, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

// The dashboard panel asks for active alerts, newest first.
riskAlertSchema.index({ state: 1, firedAt: -1 });
riskAlertSchema.index({ batchId: 1, state: 1 });

export type RiskAlertDocument = InferSchemaType<typeof riskAlertSchema>;

export const RiskAlertModel = model("RiskAlert", riskAlertSchema);
