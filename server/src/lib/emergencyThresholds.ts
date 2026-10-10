import { AutomationRuleModel } from "../models/automationRule";
import { getSettings } from "./settingsControl";

export interface EmergencyThresholds {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
  derivedFromRules: boolean;
}

/**
 * Derives emergency alert thresholds from enabled automation rules.
 * Falls back to settings thresholds if no rules define a particular threshold.
 *
 * The automation rules use a trigger/cutoff hysteresis model:
 * - Triggers: when ALL triggers hold, the rule turns ON (activates device)
 * - Cutoffs: when ANY cutoff fires, the rule turns OFF (deactivates device)
 *
 * SAFE RANGE DERIVATION:
 * For each rule, the "safe range" is the range where the device operates normally
 * (cycling between trigger ON and cutoff OFF). Emergency fires when readings are
 * OUTSIDE the union of all rules' safe ranges.
 *
 * Rule patterns and their safe range extraction:
 *
 * HEATING (device ON when cold, OFF when warm):
 *   Rule: "if temp < 17 then stop temp >= 15"
 *   - Trigger: temp < 17 → ON when cold (value = upper safe bound = 17)
 *   - Cutoff: temp >= 15 → OFF when warm (value = lower safe bound = 15)
 *   - Safe range: 15 to 17 → Emergency: below 15 (too cold), above 17 (too warm)
 *
 * COOLING (device ON when hot, OFF when cold):
 *   Rule: "if temp >= 18 then stop temp <= 15"
 *   - Trigger: temp >= 18 → ON when hot (value = upper safe bound = 18)
 *   - Cutoff: temp <= 15 → OFF when cold (value = lower safe bound = 15)
 *   - Safe range: 15 to 18 → Emergency: below 15 (too cold), above 18 (too warm)
 *
 * MISTING (device ON when dry, OFF when humid):
 *   Rule: "if hum <= 85 then stop hum >= 90"
 *   - Trigger: hum <= 85 → ON when dry (value = lower safe bound = 85)
 *   - Cutoff: hum >= 90 → OFF when humid (value = upper safe bound = 90)
 *   - Safe range: 85 to 90 → Emergency: below 85 (too dry), above 90 (too humid)
 *
 * DEHUMIDIFYING (device ON when humid, OFF when dry):
 *   Rule: "if hum >= 90 then stop hum <= 85"
 *   - Trigger: hum >= 90 → ON when humid (value = upper safe bound = 90)
 *   - Cutoff: hum <= 85 → OFF when dry (value = lower safe bound = 85)
 *   - Safe range: 85 to 90 → Emergency: below 85 (too dry), above 90 (too humid)
 *
 * EXHAUST (device ON when CO2 high, OFF when CO2 low):
 *   Rule: "if co2 >= 1000 then stop co2 <= 800"
 *   - Trigger: co2 >= 1000 → ON when high (value = upper safe bound = 1000)
 *   - Cutoff: co2 <= 800 → OFF when low (value = lower safe bound = 800)
 *   - Safe range: 800 to 1000 → Emergency: below 800 (too low), above 1000 (too high)
 *
 * CO2 INJECTION (device ON when CO2 low, OFF when CO2 high):
 *   Rule: "if co2 <= 800 then stop co2 >= 1000"
 *   - Trigger: co2 <= 800 → ON when low (value = lower safe bound = 800)
 *   - Cutoff: co2 >= 1000 → OFF when high (value = upper safe bound = 1000)
 *   - Safe range: 800 to 1000 → Emergency: below 800 (too low), above 1000 (too high)
 *
 * OPERATOR → BOUND MAPPING:
 *
 * TEMP (heating/cooling): the safe zone's HOT edge is the tempMax, COLD edge is tempMin.
 *   Heating: trigger "< 17" turns heater ON when cold → 17 is the upper edge → tempMax
 *   Cooling: trigger ">= 18" turns cooler ON when hot  → 18 is the upper edge → tempMax
 *   Heating cutoff ">= 15" turns heater OFF when warm → 15 is the lower edge → tempMin
 *   Cooling cutoff "<= 15" turns cooler OFF when cold → 15 is the lower edge → tempMin
 *   So for TEMP:  every trigger value → tempMax, every cutoff value → tempMin
 *
 * HUMIDITY (misting/dehumidifying): the safe zone's DRY edge is humidityMin, WET edge is humidityMax.
 *   Misting trigger "<= 85" turns mister ON when dry  → 85 is the dry edge → humidityMin
 *   Dehumid trigger ">= 90" turns dehum ON when wet  → 90 is the wet edge → humidityMax
 *   Misting cutoff ">= 90" turns mister OFF when wet → 90 is the wet edge → humidityMax
 *   Dehum cutoff "<= 85" turns dehum OFF when dry    → 85 is the dry edge → humidityMin
 *   So for HUMIDITY the operator alone decides the edge, for BOTH triggers and cutoffs:
 *                     "<"/"<=" → humidityMin (dry edge), ">"/">=" → humidityMax (wet edge)
 *
 * CO2 (exhaust/injection): the safe zone's LOW edge is co2Min, HIGH edge is co2Max.
 *   Exhaust trigger ">= 1000" turns fan ON when high  → 1000 is the high edge → co2Max
 *   Injection trigger "<= 800" turns valve ON when low → 800 is the low edge → co2Min
 *   Exhaust cutoff "<= 800" turns fan OFF when low   → 800 is the low edge → co2Min
 *   Injection cutoff ">= 1000" turns valve OFF when high → 1000 is the high edge → co2Max
 *   So for CO2 the operator alone decides the edge, for BOTH triggers and cutoffs:
 *                "<"/"<=" → co2Min (low edge), ">"/">=" → co2Max (high edge)
 *
 * Note: triggers activate the device (push toward a boundary), cutoffs deactivate it
 * (release when the boundary is reached). Triggers set the "ceiling" of the safe zone,
 * cutoffs set the "floor" — so the emergency alert fires outside this envelope.
 */
export async function getEmergencyThresholds(): Promise<EmergencyThresholds> {
  const settings = await getSettings();

  const rules = await AutomationRuleModel.find({ enabled: true }).lean();

  // Collect all threshold values from rules
  const tempMinValues: number[] = [];
  const tempMaxValues: number[] = [];
  const humidityMinValues: number[] = [];
  const humidityMaxValues: number[] = [];
  const co2MinValues: number[] = [];
  const co2MaxValues: number[] = [];

  for (const rule of rules) {
    for (const trigger of rule.triggers || []) {
      const value = trigger.value;
      switch (trigger.sensor) {
        case "air_temp":
          tempMaxValues.push(value);
          break;
        case "humidity":
          if (trigger.operator === "<" || trigger.operator === "<=") {
            humidityMinValues.push(value);
          } else {
            humidityMaxValues.push(value);
          }
          break;
        case "co2":
          if (trigger.operator === "<" || trigger.operator === "<=") {
            co2MinValues.push(value);
          } else {
            co2MaxValues.push(value);
          }
          break;
      }
    }

    for (const cutoff of rule.cutoffs || []) {
      const value = cutoff.value;
      switch (cutoff.sensor) {
        case "air_temp":
          tempMinValues.push(value);
          break;
        case "humidity":
          if (cutoff.operator === "<" || cutoff.operator === "<=") {
            humidityMinValues.push(value);
          } else {
            humidityMaxValues.push(value);
          }
          break;
        case "co2":
          if (cutoff.operator === "<" || cutoff.operator === "<=") {
            co2MinValues.push(value);
          } else {
            co2MaxValues.push(value);
          }
          break;
      }
    }
  }

  const tempMin =
    tempMinValues.length > 0 ? Math.min(...tempMinValues) : settings.tempMin;
  const tempMax =
    tempMaxValues.length > 0 ? Math.max(...tempMaxValues) : settings.tempMax;
  const humidityMin =
    humidityMinValues.length > 0
      ? Math.min(...humidityMinValues)
      : settings.humidityMin;
  const humidityMax =
    humidityMaxValues.length > 0
      ? Math.max(...humidityMaxValues)
      : settings.humidityMax;
  const co2Min =
    co2MinValues.length > 0 ? Math.min(...co2MinValues) : settings.co2Min;
  const co2Max =
    co2MaxValues.length > 0 ? Math.max(...co2MaxValues) : settings.co2Max;

  const derivedFromRules =
    tempMinValues.length > 0 ||
    tempMaxValues.length > 0 ||
    humidityMinValues.length > 0 ||
    humidityMaxValues.length > 0 ||
    co2MinValues.length > 0 ||
    co2MaxValues.length > 0;

  return {
    tempMin,
    tempMax,
    co2Min,
    co2Max,
    humidityMin,
    humidityMax,
    derivedFromRules,
  };
}
