/**
 * The legacy min/max threshold bands.
 *
 * This is the fallback that decides a relay whenever no automation rule has an
 * opinion about it, so it is worth keeping honest and separately testable.
 * Dependency-free on purpose — see `cropSchedule.ts` and `activeStage.ts` for the
 * same pattern.
 *
 * Each parameter has an ideal band [min, max] and the relay only changes state
 * when a reading leaves that band. A reading *inside* the band returns null,
 * meaning "no opinion, leave the relay alone". That is what makes it hysteretic
 * rather than a thermostat that chatters around a single setpoint:
 *
 *   ac         ON when temp > tempMax        | OFF when temp < tempMin
 *   fan        ON when co2  > co2Max         | OFF when co2  < co2Min
 *   mist_maker ON when hum  < humidityMin    | OFF when hum  > humidityMax
 *
 * Note `mist_maker` is inverted: humidity too *low* is what calls for misting.
 */

/** Devices the legacy bands can decide. `uv` has no band — only rules drive it. */
export const THRESHOLD_DEVICES = ["ac", "fan", "mist_maker"] as const;

export type ThresholdDevice = (typeof THRESHOLD_DEVICES)[number];

export interface ThresholdBands {
  tempMin: number;
  tempMax: number;
  co2Min: number;
  co2Max: number;
  humidityMin: number;
  humidityMax: number;
}

/**
 * null = the reading is inside the band (or its sensor is offline), so the relay
 * is left exactly as it is. A missing sensor must never drive a relay.
 */
export function thresholdDecisions(
  values: Partial<Record<string, number>>,
  s: ThresholdBands,
): Record<ThresholdDevice, boolean | null> {
  const temp = values["air_temp"];
  const co2 = values["co2"];
  const hum = values["humidity"];

  return {
    ac: temp == null ? null : temp > s.tempMax ? true : temp < s.tempMin ? false : null,
    fan: co2 == null ? null : co2 > s.co2Max ? true : co2 < s.co2Min ? false : null,
    mist_maker:
      hum == null ? null : hum < s.humidityMin ? true : hum > s.humidityMax ? false : null,
  };
}
