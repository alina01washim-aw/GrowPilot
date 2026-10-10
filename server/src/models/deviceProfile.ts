import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Multi-device profile registry.
 *
 * One document per physical ESP device. It is the recommended structure for
 * handling multiple device profiles:
 *
 *   - `profileId`    → stable key used by rules (`profileIds`) and MQTT topics
 *                      (`fridge/<profileId>/rules`).
 *   - `relayMap`     → which logical relay keys live on which channel. The rule
 *                      engine only knows keys ("ac", "mist_maker", …); the
 *                      profile maps keys → hardware channel indices. Adding a
 *                      device with a different channel layout is configuration,
 *                      not firmware.
 *   - `ruleIds`      → the rules this device executes (they must also be
 *                      referenced by `profileIds` on the rule for filtering).
 *
 * The existing app runs a single device (legacy `_id: "default"` Settings
 * document). A seeded profileId of "main" preserves that behaviour: rules with
 * an empty `profileIds` array apply to every profile, including "main".
 */

/**
 * Icons a device can be shown with. Semantic rather than key-derived, because a
 * device the grower has renamed no longer matches its key: a `uv` channel
 * rewired as a compost mixer should not keep showing a UV lamp.
 */
export const DEVICE_ICON_IDS = [
  "fan",
  "cooling",
  "heat",
  "mist",
  "light",
  "pump",
  "device",
] as const;
export type DeviceIconId = (typeof DEVICE_ICON_IDS)[number];

/**
 * The four channels as shipped. `key` is the stable internal identifier and must
 * never change: rules (`actions.turnOn`), crop stage plans (`devicesAuto`) and
 * every DeviceStateHistory record reference it. `label` and `icon` are the
 * grower's to rename freely.
 */
export const DEFAULT_RELAY_MAP = [
  { key: "fan",        index: 0, label: "Exhaust Fan",   icon: "fan" },
  { key: "ac",         index: 1, label: "AC Compressor", icon: "cooling" },
  { key: "mist_maker", index: 2, label: "Mist Maker",    icon: "mist" },
  { key: "uv",         index: 3, label: "UV-C Light",    icon: "light" },
] as const;
export type RelayKey = (typeof DEFAULT_RELAY_MAP)[number]["key"];

const relayMapEntrySchema = new Schema(
  {
    key:   { type: String, required: true }, // logical key referenced by rules
    index: { type: Number, required: true }, // hardware channel 0..RELAY_COUNT-1
    label: { type: String, default: "" },    // human-readable, grower-editable
    icon:  { type: String, default: "device", enum: DEVICE_ICON_IDS },
    enabled: { type: Boolean, required: true, default: true },
    // Last commanded state, used for devices without a legacy Relay document
    // (e.g. UV-C). Legacy devices keep their state in the Relay collection.
    state: { type: Boolean, default: false },
  },
  { _id: false },
);

const deviceProfileSchema = new Schema(
  {
    profileId:    { type: String, required: true, unique: true },
    name:         { type: String, required: true },
    description:  { type: String, default: "" },
    enabled:      { type: Boolean, required: true, default: true },
    relayMap:     { type: [relayMapEntrySchema], required: true, default: DEFAULT_RELAY_MAP },
    ruleIds:      { type: [String], required: true, default: [] },
    createdAt:    { type: Date, default: () => new Date() },
    updatedAt:    { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export type DeviceProfileDocument = InferSchemaType<typeof deviceProfileSchema>;

export const DeviceProfileModel = model("DeviceProfile", deviceProfileSchema);