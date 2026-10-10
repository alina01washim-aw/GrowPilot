import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Crop cycle — the growing calendar the whole controller follows.
 *
 * A mushroom crop is not one environment, it is a sequence of them. Agaricus
 * bisporus spends its spawn run warm and deliberately CO2-rich (mycelium
 * thrives on it), then gets *shocked* into fruiting by dropping the air
 * temperature and venting the CO2 out, then holds a tight band through each
 * flush with a warmer rest period between them. Run one static threshold set
 * across all of that and you either stall the spawn run or never get pins.
 *
 * So a batch carries its own plan: an ordered list of stages, each with the
 * environment targets for that stage. Entering a stage pushes its targets into
 * the live settings (and therefore to the ESP), parks the devices that stage
 * does not use, re-publishes the rule set filtered to that stage, and drives
 * the relays to match immediately.
 *
 * The stage list is a *snapshot* on the batch, not a reference to a shared
 * template: editing next season's plan must never rewrite what this batch
 * actually ran.
 */

/** Canonical stage keys. Custom stages may use any other string. */
export const STAGE_KEYS = [
  "spawn_run",
  "case_run",
  "pinning",
  "fruiting",
  "flush_break",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const BATCH_STATUSES = ["planned", "active", "completed", "aborted"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * How a batch actually turned out. This is the label the risk engine learns from:
 * a critical note on a batch that finished healthy is a worry that did not
 * materialise, while the same note on a spoiled batch is real evidence.
 *
 * Numbers as well as a category, so a warning can say what a pattern actually
 * cost rather than only that it resembles a past problem.
 */
export const OUTCOME_LABELS = [
  "good",
  "partial_loss",
  "major_loss",
  "spoiled",
  "contaminated",
  "aborted",
] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

const batchOutcomeSchema = new Schema(
  {
    label: { type: String, required: true, enum: OUTCOME_LABELS },
    /** Total harvested weight. Null when not weighed. */
    yieldKg: { type: Number, default: null, min: 0 },
    /** Percentage of the harvest that was marketable. */
    gradePercent: { type: Number, default: null, min: 0, max: 100 },
    notes: { type: String, default: "", maxlength: 2000 },
    recordedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const stageTargetsSchema = new Schema(
  {
    tempMin: { type: Number, required: true },
    tempMax: { type: Number, required: true },
    co2Min: { type: Number, required: true },
    co2Max: { type: Number, required: true },
    humidityMin: { type: Number, required: true },
    humidityMax: { type: Number, required: true },
  },
  { _id: false },
);

const cropStageSchema = new Schema(
  {
    // Rules tagged with this key activate while the stage is current. Repeated
    // keys are intentional: three "fruiting" stages all match a fruiting rule.
    key: { type: String, required: true },
    label: { type: String, required: true },
    // Planned length. 0 = open-ended, only a manual advance moves it on.
    days: { type: Number, required: true, default: 0, min: 0 },
    targets: { type: stageTargetsSchema, required: true },
    // Devices the stage puts under automation. Everything else is parked in
    // MANUAL and switched off on entry — a fan left running from the previous
    // stage would vent away a spawn run.
    devicesAuto: { type: [String], required: true, default: [] },
    notes: { type: String, default: "" },
  },
  { _id: false },
);

const stageHistorySchema = new Schema(
  {
    stageKey: { type: String, required: true },
    label: { type: String, required: true },
    index: { type: Number, required: true },
    enteredAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
    enteredBy: { type: String, enum: ["start", "auto", "manual"], required: true },
  },
  { _id: false },
);

const cropBatchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    species: { type: String, default: "Agaricus bisporus" },
    status: { type: String, required: true, enum: BATCH_STATUSES, default: "planned" },

    stages: { type: [cropStageSchema], required: true, default: [] },
    currentStageIndex: { type: Number, required: true, default: 0 },
    currentStageStartedAt: { type: Date, default: null },

    // Intended fill date, so a *planned* batch can show a real calendar before
    // it is started. Dates for a running batch come from `startedAt` and the
    // stage history instead — this field is only the pre-start projection.
    plannedStartAt: { type: Date, default: null },

    // When true the scheduler moves to the next stage once the planned days
    // elapse. Off means the grower advances by eye, which is how experienced
    // growers run pinning.
    autoAdvance: { type: Boolean, required: true, default: true },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
    stageHistory: { type: [stageHistorySchema], required: true, default: [] },

    /** How it ended. Null until recorded at harvest; drives risk weighting. */
    outcome: { type: batchOutcomeSchema, default: null },

    /**
     * True for a batch entered by hand to seed the knowledge base rather than
     * run through the controller. Imported batches have no telemetry, so the
     * risk engine reads their conditions from annotation snapshots instead. Kept
     * distinct so they can be excluded from yield reporting, where a
     * remembered number should not sit alongside a measured one.
     */
    imported: { type: Boolean, required: true, default: false },

    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

cropBatchSchema.index({ status: 1, startedAt: -1 });

export type CropBatchDocument = InferSchemaType<typeof cropBatchSchema>;
export type CropStage = CropBatchDocument["stages"][number];

export const CropBatchModel = model("CropBatch", cropBatchSchema);

/**
 * Default plan for button mushroom (Agaricus bisporus), the species this farm
 * is configured for. Values follow standard commercial practice; they are a
 * starting point the grower is expected to tune per strain and per room.
 *
 * Note the CO2 bands. High CO2 during the spawn and case run is not a fault —
 * it is what the mycelium wants, so the exhaust fan is deliberately left out of
 * `devicesAuto` and the band is set wide enough that it never trips. Pinning
 * inverts that: the fan comes on, CO2 drops, temperature drops, and the crop
 * switches from growing mycelium to growing mushrooms.
 *
 * UV-C is never automated by default. It is a between-batch sanitation tool and
 * it damages both the crop and anyone in the room.
 */
export const DEFAULT_STAGE_PLAN: CropStage[] = [
  {
    key: "spawn_run",
    label: "Spawn Run",
    days: 16,
    targets: { tempMin: 23, tempMax: 25, co2Min: 3000, co2Max: 15000, humidityMin: 90, humidityMax: 96 },
    devicesAuto: ["ac", "mist_maker"],
    notes: "Mycelium colonises the compost. Keep it warm, humid and sealed — CO2 is beneficial here, so no venting.",
  },
  {
    key: "case_run",
    label: "Case Run",
    days: 6,
    targets: { tempMin: 23, tempMax: 25, co2Min: 2000, co2Max: 10000, humidityMin: 92, humidityMax: 97 },
    devicesAuto: ["ac", "mist_maker"],
    notes: "Mycelium grows through the casing layer. Still sealed and humid; surface must never dry out.",
  },
  {
    key: "pinning",
    label: "Pinning (Venting)",
    days: 5,
    targets: { tempMin: 17, tempMax: 19, co2Min: 800, co2Max: 1500, humidityMin: 88, humidityMax: 93 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "The shock that starts fruiting: drop air temperature and vent the CO2 out. Pins appear in 4-6 days.",
  },
  {
    key: "fruiting",
    label: "Fruiting — Flush 1",
    days: 10,
    targets: { tempMin: 16, tempMax: 18, co2Min: 600, co2Max: 1000, humidityMin: 85, humidityMax: 90 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "Harvest window. Tight bands — swings here mark the caps and cost grade.",
  },
  {
    key: "flush_break",
    label: "Flush Break 1",
    days: 7,
    targets: { tempMin: 18, tempMax: 20, co2Min: 1000, co2Max: 2000, humidityMin: 88, humidityMax: 92 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "Rest between flushes. Slightly warmer and less vented so the bed can recharge.",
  },
  {
    key: "fruiting",
    label: "Fruiting — Flush 2",
    days: 8,
    targets: { tempMin: 16, tempMax: 18, co2Min: 600, co2Max: 1000, humidityMin: 85, humidityMax: 90 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "Second flush, typically 60-75% of the first.",
  },
  {
    key: "flush_break",
    label: "Flush Break 2",
    days: 7,
    targets: { tempMin: 18, tempMax: 20, co2Min: 1000, co2Max: 2000, humidityMin: 88, humidityMax: 92 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "Rest between flushes.",
  },
  {
    key: "fruiting",
    label: "Fruiting — Flush 3",
    days: 7,
    targets: { tempMin: 16, tempMax: 18, co2Min: 600, co2Max: 1000, humidityMin: 85, humidityMax: 90 },
    devicesAuto: ["fan", "ac", "mist_maker"],
    notes: "Final flush. Yield drops sharply after this — plan the turnaround.",
  },
] as CropStage[];

/** CO2 ceiling above which the room must be vented before anyone walks in. */
export const CO2_ENTRY_WARNING_PPM = 5000;

/**
 * Upper bound on a stage's planned length. No mushroom stage runs for a year;
 * a number this large is a typo (a mistyped `30` as `3650` would otherwise
 * silently plan a decade and stall auto-advance forever).
 */
export const MAX_STAGE_DAYS = 365;
