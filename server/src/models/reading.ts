import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Time-series collection of raw sensor readings.
 *
 * Integer mapping is used instead of repeating strings on every document:
 * - `sensorId` is a small integer instead of a string like "SCD40_FRIDGE_01"
 * - `relays.*` are booleans instead of the strings "ON"/"OFF"
 */
const readingSchema = new Schema(
  {
    timestamp: { type: Date, required: true, index: true },
    sensorId: { type: Number, required: true },
    batchId: { type: String, required: true },
    temp: { type: Number, required: false }, // SHT40 room temp
    hum: { type: Number, required: false }, // SHT40 room humidity
    co2: { type: Number, required: false }, // SCD40 CO2
    scdTemp: { type: Number, required: false }, // SCD40 temp
    scdHum: { type: Number, required: false }, // SCD40 hum
    compostTemp: { type: Number, required: false }, // DS18B20 compost temp
    vpd: { type: Number, required: false }, // computed vpd (needs both t and h)
    relays: {
      fan: { type: Boolean, required: true },
      fridge: { type: Boolean, required: true },
      humidifier: { type: Boolean, required: true },
    },
  },
  {
    timeseries: {
      timeField: "timestamp",
      metaField: "sensorId",
      granularity: "seconds",
    },
  },
);

export type ReadingDocument = InferSchemaType<typeof readingSchema>;

export const ReadingModel = model("Reading", readingSchema);
