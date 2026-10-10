import { Router, type IRouter } from "express";
import { DeviceStateHistoryModel } from "../models/deviceStateHistory";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_HOURS = 720;
const MAX_HOURS = 24 * 365;

function parseHours(raw: unknown, fallback: number | undefined): number | undefined {
  if (raw === undefined || raw === "") return fallback;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(hours, MAX_HOURS);
}

router.get("/devices/history", async (req, res): Promise<void> => {
  const device = typeof req.query.device === "string" ? req.query.device : undefined;
  const hours = parseHours(req.query.hours, undefined);

  const filter: Record<string, unknown> = {};
  if (device) filter.device = device;

  if (hours !== undefined) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    // Include runs that started before the window but overlap it (still
    // running, or ended inside it) — otherwise a long run vanishes from the
    // graph the moment its start scrolls out of range.
    filter.$or = [
      { startedAt: { $gte: since } },
      { endedAt: null },
      { endedAt: { $gte: since } },
    ];
  }

  logger.debug({ filter, hours }, "GET /devices/history");

  const events = await DeviceStateHistoryModel
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(500)
    .lean();

  res.json(
    events.map((e) => ({
      device: e.device,
      state: e.state,
      startedAt: e.startedAt.toISOString(),
      endedAt: e.endedAt ? e.endedAt.toISOString() : null,
      source: e.source,
      durationMs: e.durationMs,
    })),
  );
});

router.get("/devices/history/summary", async (req, res): Promise<void> => {
  const hours = parseHours(req.query.hours, DEFAULT_HOURS) ?? DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  logger.debug({ hours, since }, "GET /devices/history/summary");

  const events = await DeviceStateHistoryModel
    .find({
      $or: [
        { startedAt: { $gte: since } },
        { endedAt: null },
        { endedAt: { $gte: since } },
      ],
    })
    .sort({ startedAt: 1 })
    .lean();

  const now = Date.now();
  const sinceMs = since.getTime();
  const summary: Record<string, { onCount: number; offCount: number; totalOnMs: number; lastOnAt: string | null }> = {};

  for (const e of events) {
    const bucket = (summary[e.device] ??= {
      onCount: 0,
      offCount: 0,
      totalOnMs: 0,
      lastOnAt: null,
    });

    if (!e.state) {
      if (e.startedAt.getTime() >= sinceMs) bucket.offCount += 1;
      continue;
    }

    // Count only the part of the run that falls inside the window, so a run
    // that has been going for a week doesn't report 168h in a 24h view.
    const runStart = e.startedAt.getTime();
    const runEnd = e.endedAt ? e.endedAt.getTime() : now;
    if (runEnd <= sinceMs) continue;

    bucket.onCount += 1;
    // Events are sorted ascending, so the last assignment is the latest run.
    bucket.lastOnAt = e.startedAt.toISOString();

    const clampedStart = Math.max(runStart, sinceMs);
    if (runEnd > clampedStart) bucket.totalOnMs += runEnd - clampedStart;
  }

  res.json({ hours, summary });
});

export default router;
