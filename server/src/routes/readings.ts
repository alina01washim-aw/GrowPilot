import { Router, type IRouter } from "express";
import {
  ListReadingsQueryParams,
  ListReadingsResponse,
  GetLatestReadingResponse,
  GetReadingsSummaryQueryParams,
  GetReadingsSummaryResponse,
} from "../lib/api-zod";
import { ReadingModel } from "../models/reading";
import { listRelays } from "../lib/relayControl";

const router: IRouter = Router();

function serializeReading(doc: {
  _id: unknown;
  timestamp: Date;
  sensorId: number;
  batchId: string;
  temp?: number | null;
  hum?: number | null;
  co2?: number | null;
  scdTemp?: number | null;
  scdHum?: number | null;
  compostTemp?: number | null;
  vpd?: number | null;
  relays?: { fan: boolean; fridge: boolean; humidifier: boolean } | null;
}) {
  return {
    id: String(doc._id),
    timestamp: doc.timestamp.toISOString(),
    sensorId: doc.sensorId,
    batchId: doc.batchId,
    temp: doc.temp ?? null,
    hum: doc.hum ?? null,
    co2: doc.co2 ?? null,
    scdTemp: doc.scdTemp ?? null,
    scdHum: doc.scdHum ?? null,
    compostTemp: doc.compostTemp ?? null,
    vpd: doc.vpd ?? null,
    relays: doc.relays ?? { fan: false, fridge: false, humidifier: false },
  };
}

function coerceDateQuery(
  query: Record<string, unknown>,
): Record<string, unknown> | { error: string } {
  const coerced: Record<string, unknown> = { ...query };
  for (const key of ["from", "to"]) {
    const value = coerced[key];
    if (typeof value === "string" && value.length > 0) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return { error: `Invalid date format for '${key}': ${value}` };
      }
      coerced[key] = date;
    } else if (value === "" || value === undefined) {
      delete coerced[key];
    }
  }
  return coerced;
}

function serializeRelay(relay: {
  name: string;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null;
  source: string;
}) {
  return {
    name: relay.name as "fan" | "fridge" | "humidifier",
    state: relay.state,
    updatedAt: relay.updatedAt.toISOString(),
    guardedUntil: relay.guardedUntil ? relay.guardedUntil.toISOString() : null,
    source: relay.source as "manual" | "auto",
  };
}

router.get("/readings", async (req, res): Promise<void> => {
  const coerced = coerceDateQuery(req.query as Record<string, unknown>);
  if ("error" in coerced) {
    res.status(400).json({ error: coerced.error });
    return;
  }

  const params = ListReadingsQueryParams.safeParse(coerced);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { from, to, limit } = params.data;
  const filter: Record<string, unknown> = {};
  if (from || to) {
    const timestamp: Record<string, Date> = {};
    if (from) timestamp["$gte"] = new Date(from);
    if (to) timestamp["$lte"] = new Date(to);
    filter["timestamp"] = timestamp;
  }

  const docs = await ReadingModel.find(filter)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

  const readings = docs.reverse().map(serializeReading);
  res.json(ListReadingsResponse.parse(readings));
});

router.get("/readings/latest", async (_req, res): Promise<void> => {
  const doc = await ReadingModel.findOne().sort({ timestamp: -1 }).lean();
  res.json(
    GetLatestReadingResponse.parse({
      reading: doc ? serializeReading(doc) : null,
    }),
  );
});

router.get("/readings/summary", async (req, res): Promise<void> => {
  const coerced = coerceDateQuery(req.query as Record<string, unknown>);
  if ("error" in coerced) {
    res.status(400).json({ error: coerced.error });
    return;
  }

  const params = GetReadingsSummaryQueryParams.safeParse(coerced);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { from, to } = params.data;
  const match: Record<string, unknown> = {};
  if (from || to) {
    const timestamp: Record<string, Date> = {};
    if (from) timestamp["$gte"] = new Date(from);
    if (to) timestamp["$lte"] = new Date(to);
    match["timestamp"] = timestamp;
  }

  const [agg] = await ReadingModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        avgTemp: { $avg: "$temp" },
        avgHum: { $avg: "$hum" },
        avgCo2: { $avg: "$co2" },
        avgVpd: { $avg: "$vpd" },
        minTemp: { $min: "$temp" },
        maxTemp: { $max: "$temp" },
        minHum: { $min: "$hum" },
        maxHum: { $max: "$hum" },
        minCo2: { $min: "$co2" },
        maxCo2: { $max: "$co2" },
        sampleCount: { $sum: 1 },
      },
    },
  ]);

  const relays = await listRelays();

  res.json(
    GetReadingsSummaryResponse.parse({
      avgTemp: agg?.avgTemp ?? null,
      avgHum: agg?.avgHum ?? null,
      avgCo2: agg?.avgCo2 ?? null,
      avgVpd: agg?.avgVpd ?? null,
      minTemp: agg?.minTemp ?? null,
      maxTemp: agg?.maxTemp ?? null,
      minHum: agg?.minHum ?? null,
      maxHum: agg?.maxHum ?? null,
      minCo2: agg?.minCo2 ?? null,
      maxCo2: agg?.maxCo2 ?? null,
      sampleCount: agg?.sampleCount ?? 0,
      relays: relays.map(serializeRelay),
    }),
  );
});

export default router;
