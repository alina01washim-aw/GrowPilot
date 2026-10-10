import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { thresholdDecisions, type ThresholdBands } from "./thresholdBands.ts";

/**
 * The fallback that decides a relay when no automation rule has an opinion.
 *
 * The property that matters is hysteresis: a reading *inside* the band must
 * return null ("leave it alone"), never a state. If it returned a state, the
 * relay would be re-commanded on every sensor message and the compressor would
 * chatter around the setpoint.
 */

const BANDS: ThresholdBands = {
  tempMin: 16,
  tempMax: 18,
  co2Min: 600,
  co2Max: 1000,
  humidityMin: 85,
  humidityMax: 90,
};

describe("thresholdDecisions — inside the band", () => {
  test("mid-band leaves every device alone", () => {
    const d = thresholdDecisions({ air_temp: 17, co2: 800, humidity: 87 }, BANDS);

    assert.deepEqual(d, { ac: null, fan: null, mist_maker: null });
  });

  test("exactly on either edge is still inside the band", () => {
    // Strict comparisons on purpose: at tempMax the room is not yet too warm.
    const low = thresholdDecisions({ air_temp: 16, co2: 600, humidity: 85 }, BANDS);
    const high = thresholdDecisions({ air_temp: 18, co2: 1000, humidity: 90 }, BANDS);

    assert.deepEqual(low, { ac: null, fan: null, mist_maker: null });
    assert.deepEqual(high, { ac: null, fan: null, mist_maker: null });
  });
});

describe("thresholdDecisions — leaving the band", () => {
  test("too warm turns the compressor on, too cold turns it off", () => {
    assert.equal(thresholdDecisions({ air_temp: 18.1 }, BANDS).ac, true);
    assert.equal(thresholdDecisions({ air_temp: 15.9 }, BANDS).ac, false);
  });

  test("too much CO2 turns the fan on, too little turns it off", () => {
    assert.equal(thresholdDecisions({ co2: 1001 }, BANDS).fan, true);
    assert.equal(thresholdDecisions({ co2: 599 }, BANDS).fan, false);
  });

  test("misting is inverted — dry air turns it ON", () => {
    // The one band whose direction is easy to get backwards.
    assert.equal(thresholdDecisions({ humidity: 84 }, BANDS).mist_maker, true);
    assert.equal(thresholdDecisions({ humidity: 91 }, BANDS).mist_maker, false);
  });
});

describe("thresholdDecisions — missing sensors", () => {
  test("an absent sensor yields no decision for its device", () => {
    const d = thresholdDecisions({}, BANDS);

    assert.deepEqual(d, { ac: null, fan: null, mist_maker: null });
  });

  test("one dead sensor does not stop the others deciding", () => {
    // SHT40 offline, SCD40 still reporting: the fan must still vent.
    const d = thresholdDecisions({ co2: 1500 }, BANDS);

    assert.equal(d.ac, null, "no air temp — must not guess");
    assert.equal(d.mist_maker, null, "no humidity — must not guess");
    assert.equal(d.fan, true);
  });

  test("the SCD40's own temp/humidity are not substituted for the SHT40's", () => {
    // Different sensors in different places. scd_temp must never drive the AC.
    const d = thresholdDecisions({ scd_temp: 30, scd_hum: 20 }, BANDS);

    assert.equal(d.ac, null);
    assert.equal(d.mist_maker, null);
  });
});

describe("thresholdDecisions — degenerate bands", () => {
  test("a zero-width band still only acts outside it", () => {
    const tight: ThresholdBands = { ...BANDS, tempMin: 17, tempMax: 17 };

    assert.equal(thresholdDecisions({ air_temp: 17 }, tight).ac, null);
    assert.equal(thresholdDecisions({ air_temp: 17.1 }, tight).ac, true);
    assert.equal(thresholdDecisions({ air_temp: 16.9 }, tight).ac, false);
  });

  test("a wide CO2 ceiling never trips the fan — how the spawn run is held", () => {
    // Spawn run deliberately runs CO2-rich; the band is set so the fan is silent.
    const spawnRun: ThresholdBands = { ...BANDS, co2Min: 3000, co2Max: 15000 };

    assert.equal(thresholdDecisions({ co2: 9000 }, spawnRun).fan, null);
  });
});
