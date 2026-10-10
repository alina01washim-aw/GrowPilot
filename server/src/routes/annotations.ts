import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  BatchAnnotationModel,
  ANNOTATION_CATEGORIES,
  ANNOTATION_SEVERITIES,
} from "../models/batchAnnotation";
import { BatchAnnotationImageModel } from "../models/batchAnnotationImage";
import { CropBatchModel, type CropStage } from "../models/cropBatch";
import {
  dayOfBatch as dayOfBatchAt,
  stagePositionAt,
  getSnapshotAt,
} from "../lib/batchTelemetry";

const router: IRouter = Router();

/**
 * Batch annotations: the notes pinned onto the environment chart, and the
 * queryable history behind the knowledge base.
 *
 * Hand-written Zod like `cropCycle.ts` and `deviceHistory.ts` rather than the
 * generated `api-zod` layer, which only covers the original readings/relays
 * endpoints.
 */

function serialize(doc: Record<string, unknown> & { _id: unknown }) {
  return {
    id: String(doc._id),
    batchId: doc.batchId,
    at: (doc.at as Date).toISOString(),
    dayOfBatch: doc.dayOfBatch,
    stageKey: doc.stageKey ?? "",
    stageLabel: doc.stageLabel ?? "",
    stageIndex: doc.stageIndex ?? -1,
    dayOfStage: doc.dayOfStage ?? 1,
    category: doc.category,
    severity: doc.severity,
    title: doc.title,
    note: doc.note ?? "",
    snapshot: doc.snapshot ?? {},
    targets: doc.targets ?? {},
    imageIds: doc.imageIds ?? [],
    createdAt: (doc.createdAt as Date | undefined)?.toISOString() ?? null,
    updatedAt: (doc.updatedAt as Date | undefined)?.toISOString() ?? null,
  };
}

const CreateSchema = z.object({
  batchId: z.string().trim().min(1),
  at: z.string().datetime({ offset: true }).or(z.string().min(1)),
  category: z.enum(ANNOTATION_CATEGORIES).default("issue"),
  severity: z.enum(ANNOTATION_SEVERITIES).default("info"),
  title: z.string().trim().min(1).max(160),
  note: z.string().max(4000).default(""),
  imageIds: z.array(z.string()).max(6).default([]),
  /**
   * Optional manual conditions. Supplied when importing a past batch, where
   * there is no telemetry to read; omitted for a live note, which gets its
   * snapshot from the readings around that moment.
   */
  snapshot: z
    .object({
      temp: z.number().nullable().optional(),
      hum: z.number().nullable().optional(),
      co2: z.number().nullable().optional(),
      compostTemp: z.number().nullable().optional(),
      vpd: z.number().nullable().optional(),
    })
    .optional(),
});

/**
 * Resolves where a moment sits in a batch, and which target bands applied.
 *
 * Both are frozen onto the annotation at write time — the bands because a plan
 * can be edited later, and the position because it is a fixed historical fact
 * that should not be recomputed against a plan that has since changed.
 */
async function resolvePosition(batchId: string, at: Date) {
  const batch = await CropBatchModel.findOne({ batchId }).lean();
  if (!batch) return null;

  const startedAt = batch.startedAt ?? batch.plannedStartAt ?? batch.createdAt ?? at;
  const position = stagePositionAt(batch as never, at);

  // The recorded history knows exactly which stage was running; fall back to the
  // batch's current index only when there is no history to consult.
  const stageIndex = position?.stageIndex ?? batch.currentStageIndex ?? 0;
  const stage = (batch.stages as CropStage[])[stageIndex];

  return {
    dayOfBatch: dayOfBatchAt(startedAt as Date, at),
    stageKey: position?.stageKey ?? stage?.key ?? "",
    stageLabel: position?.stageLabel ?? stage?.label ?? "",
    stageIndex,
    dayOfStage: position?.dayOfStage ?? 1,
    targets: stage
      ? {
          tempMin: stage.targets.tempMin,
          tempMax: stage.targets.tempMax,
          co2Min: stage.targets.co2Min,
          co2Max: stage.targets.co2Max,
          humidityMin: stage.targets.humidityMin,
          humidityMax: stage.targets.humidityMax,
        }
      : {},
  };
}

router.post("/annotations", async (req, res): Promise<void> => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid annotation" });
    return;
  }
  const input = parsed.data;
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) {
    res.status(400).json({ error: `Invalid date: ${input.at}` });
    return;
  }

  const position = await resolvePosition(input.batchId, at);
  if (!position) {
    res.status(404).json({ error: `Batch "${input.batchId}" not found` });
    return;
  }

  // A caller-supplied snapshot wins: it is the only source for an imported batch,
  // and an explicit number should never be overwritten by a nearby reading.
  const snapshot = input.snapshot ?? (await getSnapshotAt(at));

  const doc = await BatchAnnotationModel.create({
    batchId: input.batchId,
    at,
    ...position,
    category: input.category,
    severity: input.severity,
    title: input.title,
    note: input.note,
    snapshot,
    imageIds: input.imageIds,
  });

  if (input.imageIds.length > 0) {
    await BatchAnnotationImageModel.updateMany(
      { _id: { $in: input.imageIds } },
      { $set: { annotationId: String(doc._id), batchId: input.batchId } },
    );
  }

  res.status(201).json(serialize(doc.toObject() as never));
});

/** Every note for one batch, in time order — the chart overlay. */
router.get("/batches/:batchId/annotations", async (req, res): Promise<void> => {
  const docs = await BatchAnnotationModel.find({ batchId: String(req.params.batchId) })
    .sort({ at: 1 })
    .lean();
  res.json(docs.map((d) => serialize(d as never)));
});

/**
 * Knowledge base query. Every filter is optional and they compose, so the same
 * endpoint serves "all contamination notes" and "critical humidity problems
 * during pinning above 95%".
 */
const ListSchema = z.object({
  batchId: z.string().trim().optional(),
  category: z.enum(ANNOTATION_CATEGORIES).optional(),
  severity: z.enum(ANNOTATION_SEVERITIES).optional(),
  stageKey: z.string().trim().optional(),
  /** Free text over title and note. */
  q: z.string().trim().max(200).optional(),
  /** Threshold filters, e.g. humidity at or above 95 when the note was made. */
  metric: z.enum(["temp", "hum", "co2", "compostTemp", "vpd"]).optional(),
  gte: z.coerce.number().optional(),
  lte: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get("/annotations", async (req, res): Promise<void> => {
  const parsed = ListSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid filter" });
    return;
  }
  const { batchId, category, severity, stageKey, q, metric, gte, lte, limit } = parsed.data;

  const filter: Record<string, unknown> = {};
  if (batchId) filter.batchId = batchId;
  if (category) filter.category = category;
  if (severity) filter.severity = severity;
  if (stageKey) filter.stageKey = stageKey;
  if (q) {
    // Escaped so a stray "(" in a search box cannot throw a regex error.
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: safe, $options: "i" } },
      { note: { $regex: safe, $options: "i" } },
    ];
  }
  if (metric && (gte !== undefined || lte !== undefined)) {
    const range: Record<string, number> = {};
    if (gte !== undefined) range.$gte = gte;
    if (lte !== undefined) range.$lte = lte;
    filter[`snapshot.${metric}`] = range;
  }

  const docs = await BatchAnnotationModel.find(filter).sort({ at: -1 }).limit(limit).lean();
  res.json(docs.map((d) => serialize(d as never)));
});

const UpdateSchema = z
  .object({
    category: z.enum(ANNOTATION_CATEGORIES).optional(),
    severity: z.enum(ANNOTATION_SEVERITIES).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    note: z.string().max(4000).optional(),
    imageIds: z.array(z.string()).max(6).optional(),
    snapshot: z
      .object({
        temp: z.number().nullable().optional(),
        hum: z.number().nullable().optional(),
        co2: z.number().nullable().optional(),
        compostTemp: z.number().nullable().optional(),
        vpd: z.number().nullable().optional(),
      })
      .optional(),
  })
  .strict();

router.patch("/annotations/:id", async (req, res): Promise<void> => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid patch" });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  // `at`, the stage position and the frozen targets are deliberately not
  // editable: they record where in the crop this happened. Move the pin by
  // deleting and re-creating, so the recorded position stays coherent.
  const doc = await BatchAnnotationModel.findByIdAndUpdate(
    String(req.params.id),
    { $set: { ...parsed.data, updatedAt: new Date() } },
    { new: true },
  ).lean();

  if (!doc) {
    res.status(404).json({ error: "Annotation not found" });
    return;
  }
  res.json(serialize(doc as never));
});

router.delete("/annotations/:id", async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const doc = await BatchAnnotationModel.findByIdAndDelete(id).lean();
  if (!doc) {
    res.status(404).json({ error: "Annotation not found" });
    return;
  }
  // Attached images go with it, or they leak.
  await BatchAnnotationImageModel.deleteMany({ annotationId: id });
  res.json({ deleted: true });
});

// ─── Images ──────────────────────────────────────────────────────────────────

const ImageSchema = z.object({
  batchId: z.string().trim().min(1),
  /** data:image/…;base64,… produced by the client-side downscaler. */
  dataUrl: z
    .string()
    .max(6_000_000)
    .refine((v) => v.startsWith("data:image/"), { message: "Must be a data:image/… URL" }),
});

/**
 * Uploaded before the annotation exists, so the dialog can show a thumbnail while
 * the note is still being written. `annotationId` is filled in on save.
 */
router.post("/annotation-images", async (req, res): Promise<void> => {
  const parsed = ImageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid image" });
    return;
  }
  const { batchId, dataUrl } = parsed.data;
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    res.status(400).json({ error: "Image must be base64-encoded" });
    return;
  }

  const doc = await BatchAnnotationImageModel.create({
    batchId,
    mimeType: match[1],
    data: match[2],
    byteSize: Math.floor((match[2]!.length * 3) / 4),
  });
  res.status(201).json({ id: String(doc._id), byteSize: doc.byteSize });
});

/** Served as raw bytes so the browser can cache it like any other image. */
router.get("/annotation-images/:id", async (req, res): Promise<void> => {
  const doc = await BatchAnnotationImageModel.findById(String(req.params.id)).lean();
  if (!doc) {
    res.status(404).json({ error: "Image not found" });
    return;
  }
  const buffer = Buffer.from(doc.data, "base64");
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(buffer);
});

export default router;
