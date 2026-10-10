import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * AUTO/MANUAL mode of one device as it was just before an emergency stop.
 * Resume restores these instead of forcing every device back to AUTO, so a
 * device the operator had deliberately parked in MANUAL is not restarted.
 */
const stoppedDeviceModeSchema = new Schema(
  {
    key: { type: String, required: true },
    mode: { type: String, required: true, enum: ["auto", "manual"] },
  },
  { _id: false },
);

/**
 * Singleton settings document (always _id = "default").
 *
 * Range-based hysteresis control — each parameter has a min and max that
 * define the ideal band for button mushroom cultivation:
 *
 *   Fridge ON  when temp  > tempMax  |  OFF when temp  < tempMin
 *   Fan    ON  when co2   > co2Max   |  OFF when co2   < co2Min
 *   Mist   ON  when hum   < humMin   |  OFF when hum   > humMax
 *
 * Readings inside the band leave the relay unchanged (true hysteresis).
 *
 * Button mushroom defaults:
 *   Temp    21 – 23 °C
 *   CO2    700 – 1200 ppm
 *   Humidity 85 – 95 %
 */
const settingsSchema = new Schema({
  _id:         { type: String,  default: "default" },
  tempMin:     { type: Number,  required: true, default: 21  },
  tempMax:     { type: Number,  required: true, default: 23  },
  co2Min:      { type: Number,  required: true, default: 700  },
  co2Max:      { type: Number,  required: true, default: 1200 },
  humidityMin: { type: Number,  required: true, default: 85  },
  humidityMax: { type: Number,  required: true, default: 95  },
  // ─── VPD targets (surface VPD status indicator, kPa) ───────────────────────
  vpdTargetMin:       { type: Number, required: true, default: 0.15 },
  vpdTargetMax:       { type: Number, required: true, default: 0.35 },
  vpdWarningMargin:   { type: Number, required: true, default: 0.05 },
  automationPaused: { type: Boolean, required: true, default: false },
  // Set when an emergency stop pauses automation; consumed and cleared by
  // resume. Null means "no stop snapshot recorded" (resume falls back to AUTO).
  stoppedAt:        { type: Date,    default: null },
  stoppedModes:     { type: [stoppedDeviceModeSchema], default: [] },
  // ─── Device profile (editable from the dashboard) ──────────────────────────
  deviceName:        { type: String,  default: "Mushking IoT" },
  wifiSsid:          { type: String,  default: "" },
  wifiPassword:      { type: String,  default: "" },
  backupWifiSsid:    { type: String,  default: "" },
  backupWifiPassword:{ type: String,  default: "" },
  mqttHost:          { type: String,  default: "" },
  mqttPort:          { type: Number,  default: 1883 },
  mqttUsername:      { type: String,  default: "" },
  mqttPassword:      { type: String,  default: "" },
  updatedAt:   { type: Date,    required: true, default: () => new Date() },
});

export type SettingsDocument = InferSchemaType<typeof settingsSchema>;
export const SettingsModel = model("Settings", settingsSchema);
