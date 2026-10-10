import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Dynamically-configurable automation rule.
 *
 * This document is the single source of truth for edge-executed automation.
 * The server stores it here, then serializes it to a compact wire format that
 * is published (retained) to the ESP device(s). The ESP parses the JSON with
 * ArduinoJson, recompiles it into an internal rule table and re-executes it in
 * loop() — no firmware re-flash required.
 *
 * Hysteresis / short-cycle protection is expressed structurally instead of in
 * code:
 *
 *   triggers  → the group is latched ON   only while EVERY trigger holds
 *   cutoffs   → the group is released OFF when ANY cutoff fires
 *
 * Because the cutoff threshold (e.g. temp >= 25) differs from the trigger
 * threshold (temp < 30), a relay that is ON is never turned back off by the
 * same boundary it was turned on by — a 5 °C deadband in this example.
 * `minOnMs` / `minOffMs` additionally guarantee a minimum dwell time in each
 * state so even a flaky sensor reading cannot cause rapid relay cycling.
 */

export const SENSOR_KEYS = [
  "air_temp",     // SHT40 ambient temperature (°C)
  "humidity",     // SHT40 relative humidity (%)
  "co2",          // SCD40 CO2 (ppm)
  "scd_temp",     // SCD40 onboard temperature (°C)
  "scd_hum",      // SCD40 onboard humidity (%)
  "compost_temp", // DS18B20 compost temperature (°C)
] as const;
export type SensorKey = (typeof SENSOR_KEYS)[number];

export const RULE_OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const MATCH_MODES = ["all", "any"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

const conditionSchema = new Schema(
  {
    sensor:   { type: String, required: true, enum: SENSOR_KEYS },
    operator: { type: String, required: true, enum: RULE_OPERATORS },
    value:    { type: Number, required: true },
  },
  { _id: false },
);

const automationRuleSchema = new Schema(
  {
    // ─── Identity & scope ────────────────────────────────────────────────────
    name:       { type: String, required: true },
    enabled:    { type: Boolean, required: true, default: true },
    // Lower number wins first when two rules conflict for the same relay.
    priority:   { type: Number, required: true, default: 100 },
    // Empty array = applies to every device profile (global rule).
    profileIds: { type: [String], default: [] },
    // Crop stage keys this rule is scoped to (see models/cropBatch.ts). Empty =
    // active in every stage. A stage-scoped rule is left out of the payload
    // published to the ESP while a different stage is running, so the grower
    // authors "vent hard during fruiting" once and it simply stops applying
    // during the spawn run.
    stageKeys: { type: [String], default: [] },

    // ─── IF block: when does the group get activated? ────────────────────────
    triggerMode:  { type: String, required: true, enum: MATCH_MODES, default: "all" },
    triggers:     { type: [conditionSchema], required: true, default: [] },

    // ─── THEN block: group action executed when triggers fire ────────────────
    actions: {
      turnOn:  { type: [String], required: true, default: [] }, // relay keys
      turnOff: { type: [String], required: true, default: [] }, // relay keys
    },

    // ─── STOP / target block: when does the group get released? ──────────────
    cutoffMode: { type: String, required: true, enum: MATCH_MODES, default: "any" },
    cutoffs:    { type: [conditionSchema], required: true, default: [] },
    offActions: {
      turnOff: { type: [String], required: true, default: [] }, // relay keys
    },

    // ─── Anti short-cycle / dwell timers (ms) ────────────────────────────────
    minOnMs:    { type: Number, default: 0 }, // minimum time group stays ON
    minOffMs:   { type: Number, default: 0 }, // minimum time relays stay OFF
    cooldownMs: { type: Number, default: 0 }, // re-evaluation cooldown after change

    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export type AutomationRuleDocument = InferSchemaType<typeof automationRuleSchema>;

export const AutomationRuleModel = model("AutomationRule", automationRuleSchema);