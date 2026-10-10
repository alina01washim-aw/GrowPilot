import { Schema, model, type InferSchemaType } from "mongoose";

export const RELAY_NAMES = ["fan", "fridge", "humidifier"] as const;
export type RelayName = (typeof RELAY_NAMES)[number];

const relaySchema = new Schema({
  name: { type: String, required: true, unique: true, enum: RELAY_NAMES },
  state: { type: Boolean, required: true, default: false },
  updatedAt: { type: Date, required: true, default: () => new Date() },
  // Compressor/device safety guard: while set and in the future, this relay
  // cannot be turned back ON even if requested.
  guardedUntil: { type: Date, default: null },
  source: { type: String, enum: ["manual", "auto"], default: "manual" },
  // Individual automation control: when false, automation will skip this relay
  automationEnabled: { type: Boolean, required: true, default: true },
});

export type RelayDocument = InferSchemaType<typeof relaySchema>;

export const RelayModel = model("Relay", relaySchema);
