import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A note pinned to a moment in a crop batch.
 *
 * Two things make this more than a comments table.
 *
 * The stage and day fields are *denormalised* on write. They are derivable from
 * the batch's `startedAt` and `stageHistory`, but the risk engine queries by
 * "critical humidity notes during fruiting, around day 3 of the stage", and
 * recomputing that per candidate across every past batch on every scheduler tick
 * is wasteful. They are fixed facts once written — a note's position in the crop
 * never changes retroactively.
 *
 * The `snapshot` records the conditions at the moment the note was made. For a
 * batch the system actually ran this is redundant with the Reading collection,
 * but it is what lets a *hand-entered* past batch participate: an imported batch
 * has no telemetry, so the annotation carries its own numbers and the engine
 * treats real and imported history identically. It also survives any future
 * pruning of raw readings.
 */

export const ANNOTATION_CATEGORIES = [
  "issue",
  "milestone",
  "contamination",
  "temp_spike",
  "humidity",
  "co2",
  "pest",
  "harvest",
  "other",
] as const;
export type AnnotationCategory = (typeof ANNOTATION_CATEGORIES)[number];

export const ANNOTATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type AnnotationSeverity = (typeof ANNOTATION_SEVERITIES)[number];

const snapshotSchema = new Schema(
  {
    temp: { type: Number, default: null },
    hum: { type: Number, default: null },
    co2: { type: Number, default: null },
    compostTemp: { type: Number, default: null },
    vpd: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * The stage's target bands as they stood when the note was written.
 *
 * Copied rather than looked up from the batch, for two reasons. A plan can be
 * edited after the fact (`updateBatch` permits it), which would retroactively
 * change what "out of band" meant for a note written months earlier and quietly
 * rewrite history. And a plan can contain several stages sharing one key — three
 * separate `fruiting` stages in the default plan — so `stageKey` alone cannot
 * identify which band applied.
 *
 * With these stored, the risk engine needs nothing from the batch document to
 * evaluate a past incident.
 */
const annotationTargetsSchema = new Schema(
  {
    tempMin: { type: Number, default: null },
    tempMax: { type: Number, default: null },
    co2Min: { type: Number, default: null },
    co2Max: { type: Number, default: null },
    humidityMin: { type: Number, default: null },
    humidityMax: { type: Number, default: null },
  },
  { _id: false },
);

const batchAnnotationSchema = new Schema(
  {
    batchId: { type: String, required: true },
    /** The moment on the chart this note is pinned to. */
    at: { type: Date, required: true },

    // Denormalised position within the crop — see the file header.
    dayOfBatch: { type: Number, required: true, min: 1 },
    stageKey: { type: String, default: "" },
    stageLabel: { type: String, default: "" },
    /** Disambiguates repeated stage keys within one plan. -1 when unknown. */
    stageIndex: { type: Number, default: -1 },
    dayOfStage: { type: Number, default: 1, min: 1 },

    category: { type: String, required: true, enum: ANNOTATION_CATEGORIES, default: "issue" },
    severity: { type: String, required: true, enum: ANNOTATION_SEVERITIES, default: "info" },
    title: { type: String, required: true, maxlength: 160 },
    note: { type: String, default: "", maxlength: 4000 },

    /** Conditions when this was logged; the engine's only input for imports. */
    snapshot: { type: snapshotSchema, default: () => ({}) },
    /** Target bands in force at the time — frozen, see schema comment above. */
    targets: { type: annotationTargetsSchema, default: () => ({}) },

    /** Ids into the batchAnnotationImage collection. */
    imageIds: { type: [String], default: [] },

    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

// Chart overlay: every note for a batch, in time order.
batchAnnotationSchema.index({ batchId: 1, at: 1 });
// Risk engine: past incidents of a given seriousness at a given point in a stage.
batchAnnotationSchema.index({ severity: 1, stageKey: 1, dayOfStage: 1 });
// Knowledge-base filtering by tag.
batchAnnotationSchema.index({ category: 1, severity: 1 });

export type BatchAnnotationDocument = InferSchemaType<typeof batchAnnotationSchema>;

export const BatchAnnotationModel = model("BatchAnnotation", batchAnnotationSchema);
