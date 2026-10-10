import { Router, type IRouter } from "express";
import {
  listBatches,
  getBatch,
  getCropCycleStatus,
  getDefaultStagePlan,
  createBatch,
  updateBatch,
  patchStage,
  deleteBatch,
  startBatch,
  advanceBatchStage,
  setBatchStage,
  completeBatch,
  abortBatch,
  applyStage,
  recordBatchOutcome,
  importBatch,
  CropCycleError,
} from "../lib/cropCycle";
import { OUTCOME_LABELS } from "../models/cropBatch";
import { z } from "zod";

const router: IRouter = Router();

/** Maps a domain validation failure onto 400; anything else keeps bubbling. */
function handle(err: unknown, res: import("express").Response): void {
  if (err instanceof CropCycleError) {
    res.status(400).json({ error: err.message });
    return;
  }
  throw err;
}

// Everything the dashboard needs about the running crop, in one call.
router.get("/crop-cycle/status", async (_req, res): Promise<void> => {
  res.json(await getCropCycleStatus());
});

// The built-in Agaricus bisporus plan, used to seed the new-batch form.
router.get("/crop-cycle/default-plan", async (_req, res): Promise<void> => {
  res.json({ stages: getDefaultStagePlan() });
});

router.get("/crop-cycle/batches", async (_req, res): Promise<void> => {
  res.json(await listBatches());
});

router.get("/crop-cycle/batches/:batchId", async (req, res): Promise<void> => {
  const batch = await getBatch(String(req.params.batchId));
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  res.json(batch);
});

router.post("/crop-cycle/batches", async (req, res): Promise<void> => {
  try {
    res.status(201).json(await createBatch(req.body ?? {}));
  } catch (err) {
    handle(err, res);
  }
});

router.patch("/crop-cycle/batches/:batchId", async (req, res): Promise<void> => {
  try {
    res.json(await updateBatch(String(req.params.batchId), req.body ?? {}));
  } catch (err) {
    handle(err, res);
  }
});

// Edits one stage. This is what the dated schedule writes to — a stage's end
// date is changed by setting its `days`, so every later stage shifts with it.
router.patch("/crop-cycle/batches/:batchId/stages/:index", async (req, res): Promise<void> => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index)) {
    res.status(400).json({ error: "index must be a stage number (0-based)" });
    return;
  }
  try {
    res.json(await patchStage(String(req.params.batchId), index, req.body ?? {}));
  } catch (err) {
    handle(err, res);
  }
});

router.delete("/crop-cycle/batches/:batchId", async (req, res): Promise<void> => {
  try {
    await deleteBatch(String(req.params.batchId));
    res.json({ ok: true });
  } catch (err) {
    handle(err, res);
  }
});

router.post("/crop-cycle/batches/:batchId/start", async (req, res): Promise<void> => {
  try {
    res.json(await startBatch(String(req.params.batchId)));
  } catch (err) {
    handle(err, res);
  }
});

router.post("/crop-cycle/batches/:batchId/advance", async (req, res): Promise<void> => {
  try {
    res.json(await advanceBatchStage(String(req.params.batchId), "manual"));
  } catch (err) {
    handle(err, res);
  }
});

// Jump to a specific stage — used to go back a stage when pinning is late, or
// to skip a flush that failed.
router.post("/crop-cycle/batches/:batchId/stage", async (req, res): Promise<void> => {
  const index = Number(req.body?.index);
  if (!Number.isInteger(index)) {
    res.status(400).json({ error: "index must be a stage number (0-based)" });
    return;
  }
  try {
    res.json(await setBatchStage(String(req.params.batchId), index, "manual"));
  } catch (err) {
    handle(err, res);
  }
});

router.post("/crop-cycle/batches/:batchId/complete", async (req, res): Promise<void> => {
  try {
    res.json(await completeBatch(String(req.params.batchId), "manual"));
  } catch (err) {
    handle(err, res);
  }
});

router.post("/crop-cycle/batches/:batchId/abort", async (req, res): Promise<void> => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  try {
    res.json(await abortBatch(String(req.params.batchId), reason));
  } catch (err) {
    handle(err, res);
  }
});

// Re-asserts the current stage: pushes its thresholds, device modes and rules
// again. Useful after an ESP swap, or if someone changed settings by hand.
router.post("/crop-cycle/reapply", async (_req, res): Promise<void> => {
  const status = await getCropCycleStatus();
  if (!status.stage) {
    res.status(400).json({ error: "No batch is running" });
    return;
  }
  res.json(await applyStage(status.stage));
});

// ─── Outcome and history import ──────────────────────────────────────────────

const OutcomeSchema = z.object({
  label: z.enum(OUTCOME_LABELS),
  yieldKg: z.number().min(0).max(100_000).nullable().optional(),
  gradePercent: z.number().min(0).max(100).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Records how a finished batch turned out. The risk engine weights every warning
 * by this, so it is the single most valuable field to fill in after a harvest.
 */
router.put("/crop-cycle/batches/:batchId/outcome", async (req, res): Promise<void> => {
  const parsed = OutcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid outcome" });
    return;
  }
  try {
    res.json(await recordBatchOutcome(String(req.params.batchId), parsed.data));
  } catch (err) {
    handle(err, res);
  }
});

const ImportSchema = z.object({
  name: z.string().trim().min(1).max(200),
  species: z.string().trim().max(200).optional(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  notes: z.string().max(4000).optional(),
  outcome: OutcomeSchema.optional(),
});

/**
 * Records a batch that already happened, so the knowledge base is not empty on
 * day one. Notes are then added against it through /annotations with manual
 * conditions, since an imported batch has no telemetry.
 */
router.post("/crop-cycle/batches/import", async (req, res): Promise<void> => {
  const parsed = ImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid batch" });
    return;
  }
  const startedAt = new Date(parsed.data.startedAt);
  const completedAt = new Date(parsed.data.completedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(completedAt.getTime())) {
    res.status(400).json({ error: "Start and end dates must be valid" });
    return;
  }

  try {
    res.status(201).json(
      await importBatch({ ...parsed.data, startedAt, completedAt }),
    );
  } catch (err) {
    handle(err, res);
  }
});

export default router;
