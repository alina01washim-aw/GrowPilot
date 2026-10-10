import { Schema, model, type InferSchemaType } from "mongoose";

export type DeviceKey = "fan" | "ac" | "mist_maker" | "uv";

const deviceStateHistorySchema = new Schema(
  {
    device: { type: String, required: true, index: true },
    state: { type: Boolean, required: true },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null },
    source: { type: String, enum: ["manual", "auto", "emergency"], default: "manual" },
    durationMs: { type: Number, default: null },
  },
  { versionKey: false, timestamps: false },
);

deviceStateHistorySchema.index({ device: 1, startedAt: -1 });

export type DeviceStateHistoryDocument = InferSchemaType<
  typeof deviceStateHistorySchema
>;

export const DeviceStateHistoryModel = model(
  "DeviceStateHistory",
  deviceStateHistorySchema,
);
