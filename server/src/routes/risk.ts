import { Router, type IRouter } from "express";
import { z } from "zod";
import { RiskAlertModel, RISK_ALERT_STATES } from "../models/riskAlert";
import { runRiskCheck } from "../lib/riskMonitor";

const router: IRouter = Router();

function serialize(doc: Record<string, unknown> & { _id: unknown }) {
  return {
    id: String(doc._id),
    dedupeKey: doc.dedupeKey,
    batchId: doc.batchId,
    stageKey: doc.stageKey ?? "",
    stageLabel: doc.stageLabel ?? "",
    dayOfStage: doc.dayOfStage ?? 1,
    dayOfBatch: doc.dayOfBatch ?? 1,
    source: {
      annotationId: doc.sourceAnnotationId,
      batchId: doc.sourceBatchId,
      batchName: doc.sourceBatchName ?? "",
      stageLabel: doc.sourceStageLabel ?? "",
      dayOfStage: doc.sourceDayOfStage ?? 1,
      severity: doc.sourceSeverity ?? "warning",
      outcome: doc.sourceOutcome ?? null,
    },
    score: doc.score,
    stageAligned: doc.stageAligned ?? false,
    dayGap: doc.dayGap ?? 0,
    metrics: doc.metrics ?? [],
    headline: doc.headline,
    advice: doc.advice ?? "",
    state: doc.state,
    firedAt: (doc.firedAt as Date | undefined)?.toISOString() ?? null,
    resolvedAt: (doc.resolvedAt as Date | undefined)?.toISOString() ?? null,
  };
}

const ListSchema = z.object({
  state: z.enum(RISK_ALERT_STATES).optional(),
  batchId: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Defaults to active alerts — what the dashboard panel wants. */
router.get("/risk/alerts", async (req, res): Promise<void> => {
  const parsed = ListSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid filter" });
    return;
  }
  const { state, batchId, limit } = parsed.data;

  const filter: Record<string, unknown> = { state: state ?? "active" };
  if (batchId) filter.batchId = batchId;

  const docs = await RiskAlertModel.find(filter).sort({ firedAt: -1 }).limit(limit).lean();
  res.json(docs.map((d) => serialize(d as never)));
});

/**
 * Acknowledge or dismiss.
 *
 * Both are terminal for the dashboard panel, but they are recorded distinctly:
 * "I have seen this and acted" is different evidence from "this was not relevant"
 * when tuning the engine's thresholds later.
 */
const ResolveSchema = z.object({
  state: z.enum(["acknowledged", "dismissed"]),
});

router.post("/risk/alerts/:id/resolve", async (req, res): Promise<void> => {
  const parsed = ResolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'state must be "acknowledged" or "dismissed"' });
    return;
  }

  const doc = await RiskAlertModel.findByIdAndUpdate(
    String(req.params.id),
    { $set: { state: parsed.data.state, resolvedAt: new Date() } },
    { new: true },
  ).lean();

  if (!doc) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  res.json(serialize(doc as never));
});

/**
 * Run a check immediately instead of waiting for the half-hourly tick.
 *
 * Returns the engine's `reason` when it could not evaluate, so the UI can
 * distinguish "nothing matched" from "there is no history to match against" or
 * "no telemetry stored for today" — three very different situations that would
 * otherwise all look like silence.
 */
router.post("/risk/check", async (_req, res): Promise<void> => {
  const result = await runRiskCheck();
  res.json({
    checked: result.checked,
    reason: result.reason ?? null,
    created: result.created,
    matches: result.matches.map((m) => ({
      score: m.score,
      headline: m.headline,
      advice: m.advice,
      stageAligned: m.stageAligned,
      dayGap: m.dayGap,
      metrics: m.metrics,
      source: {
        annotationId: m.incident.annotationId,
        batchId: m.incident.batchId,
        batchName: m.incident.batchName,
        severity: m.incident.severity,
        outcome: m.incident.outcome?.label ?? null,
      },
    })),
  });
});

export default router;
