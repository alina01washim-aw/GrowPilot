import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  stepRule,
  IDLE_LATCH,
  type EvaluableRule,
  type LatchState,
  type SensorValues,
} from "./ruleLatchMachine.ts";

/**
 * These cover `stepRule`, the pure transcription of the firmware's latch state
 * machine (`firmware/src/rule_engine.cpp`, RuleEngine::evaluate). They are the
 * real proof for the hysteresis and dwell behaviour, because the ESP32 and the
 * MQTT broker are not reachable from a test run.
 *
 * Imported from `ruleLatchMachine.ts` rather than `ruleEvaluator.ts` on purpose:
 * the machine has no runtime imports, so a test never has to load mongoose.
 *
 * The canonical rule below is the one the venting logic actually looks like:
 * latch the fan ON above 1200 ppm, release it below 800 ppm. The gap between
 * those two numbers *is* the deadband, and it only works if the latch is kept.
 */

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: "r1",
    name: "Vent on CO2",
    triggerMode: "all",
    triggers: [{ sensor: "co2", operator: ">", value: 1200 }],
    cutoffMode: "any",
    cutoffs: [{ sensor: "co2", operator: "<", value: 800 }],
    turnOn: ["fan"],
    turnOff: [],
    release: ["fan"],
    minOnMs: 0,
    minOffMs: 0,
    cooldownMs: 0,
    ...overrides,
  };
}

const co2 = (ppm: number): SensorValues => ({ co2: ppm });

const T0 = 1_700_000_000_000;

function activeLatch(since = T0, lastAction = T0): LatchState {
  return { groupActive: true, groupActiveSince: since, lastActionAt: lastAction };
}

describe("stepRule — latching hysteresis", () => {
  test("activates when the triggers fire", () => {
    const r = stepRule(rule(), IDLE_LATCH, co2(1300), T0);

    assert.equal(r.transition, "activated");
    assert.equal(r.latch.groupActive, true);
    assert.equal(r.latch.groupActiveSince, T0);
    assert.deepEqual(r.claims, [{ device: "fan", on: true }]);
  });

  test("does nothing while the triggers do not fire", () => {
    const r = stepRule(rule(), IDLE_LATCH, co2(900), T0);

    assert.equal(r.transition, "idle");
    assert.equal(r.latch.groupActive, false);
    assert.deepEqual(r.claims, []);
  });

  test("HOLDS when the trigger drops but no cutoff has fired", () => {
    // The whole point of the latch. CO2 at 1000 is below the 1200 trigger but
    // above the 800 cutoff, so the fan must stay on. A stateless evaluator
    // would release it here and short-cycle the device.
    const r = stepRule(rule(), activeLatch(), co2(1000), T0 + 60_000);

    assert.equal(r.transition, "held");
    assert.equal(r.latch.groupActive, true);
    assert.deepEqual(r.claims, [{ device: "fan", on: true }]);
  });

  test("releases only once a cutoff fires", () => {
    const r = stepRule(rule(), activeLatch(), co2(700), T0 + 60_000);

    assert.equal(r.transition, "released");
    assert.equal(r.latch.groupActive, false);
    assert.equal(r.latch.groupActiveSince, null);
    assert.equal(r.latch.lastActionAt, T0 + 60_000);
    assert.deepEqual(r.claims, [{ device: "fan", on: false }]);
  });

  test("a latched group stays latched even when the trigger fires again", () => {
    const r = stepRule(rule(), activeLatch(), co2(1500), T0 + 60_000);

    assert.equal(r.transition, "held");
    assert.equal(r.latch.groupActiveSince, T0, "must not restart the minOn window");
  });

  test("releases turnOff devices via the release list, not the turnOn list", () => {
    const r = stepRule(
      rule({ turnOn: ["fan", "ac"], release: ["fan"] }),
      activeLatch(),
      co2(700),
      T0 + 1,
    );

    assert.deepEqual(r.claims, [{ device: "fan", on: false }], "ac has no release entry");
  });

  test("a rule with a turnOff action claims that device off on activation", () => {
    const r = stepRule(
      rule({ turnOn: ["fan"], turnOff: ["mist_maker"] }),
      IDLE_LATCH,
      co2(1300),
      T0,
    );

    assert.deepEqual(r.claims, [
      { device: "fan", on: true },
      { device: "mist_maker", on: false },
    ]);
  });
});

describe("stepRule — dwell windows", () => {
  test("minOnMs blocks the release until the group has been held long enough", () => {
    const r = rule({ minOnMs: 600_000 }); // 10 minutes minimum on
    const held = stepRule(r, activeLatch(), co2(700), T0 + 120_000);

    assert.equal(held.transition, "held", "cutoff fired but only 2 min of 10 elapsed");
    assert.equal(held.latch.groupActive, true);
    assert.equal(held.blockedUntil, T0 + 600_000);

    const released = stepRule(r, activeLatch(), co2(700), T0 + 600_000);
    assert.equal(released.transition, "released", "exactly at the boundary releases");
  });

  test("minOffMs blocks re-activation until the relays have been off long enough", () => {
    const r = rule({ minOffMs: 300_000 });
    const latch: LatchState = {
      groupActive: false,
      groupActiveSince: null,
      lastActionAt: T0,
    };

    const blocked = stepRule(r, latch, co2(1300), T0 + 60_000);
    assert.equal(blocked.transition, "blocked");
    assert.equal(blocked.latch.groupActive, false);
    assert.deepEqual(blocked.claims, [], "a blocked rule commands nothing");
    assert.equal(blocked.blockedUntil, T0 + 300_000);

    const allowed = stepRule(r, latch, co2(1300), T0 + 300_000);
    assert.equal(allowed.transition, "activated");
  });

  test("cooldownMs and minOffMs both apply — the longer one wins", () => {
    const r = rule({ minOffMs: 60_000, cooldownMs: 300_000 });
    const latch: LatchState = {
      groupActive: false,
      groupActiveSince: null,
      lastActionAt: T0,
    };

    assert.equal(stepRule(r, latch, co2(1300), T0 + 120_000).transition, "blocked");
    assert.equal(stepRule(r, latch, co2(1300), T0 + 300_000).transition, "activated");
  });

  test("a rule that has never acted is not dwell-blocked", () => {
    const r = rule({ minOffMs: 300_000, cooldownMs: 300_000 });

    assert.equal(stepRule(r, IDLE_LATCH, co2(1300), T0).transition, "activated");
  });

  test("zero dwell releases immediately on the cutoff", () => {
    const r = stepRule(rule(), activeLatch(T0, T0), co2(700), T0);

    assert.equal(r.transition, "released");
  });
});

describe("stepRule — condition matching", () => {
  test("an offline sensor evaluates false and never flips a relay", () => {
    // No co2 key at all: the trigger cannot fire.
    assert.equal(stepRule(rule(), IDLE_LATCH, {}, T0).transition, "idle");

    // And an offline sensor must not release a latched group either — that
    // would turn the fan off every time the SCD40 dropped off the bus.
    const held = stepRule(rule(), activeLatch(), {}, T0 + 60_000);
    assert.equal(held.transition, "held");
    assert.equal(held.latch.groupActive, true);
  });

  test("triggerMode all requires every condition", () => {
    const r = rule({
      triggerMode: "all",
      triggers: [
        { sensor: "co2", operator: ">", value: 1200 },
        { sensor: "air_temp", operator: ">", value: 20 },
      ],
    });

    assert.equal(stepRule(r, IDLE_LATCH, { co2: 1300, air_temp: 18 }, T0).transition, "idle");
    assert.equal(
      stepRule(r, IDLE_LATCH, { co2: 1300, air_temp: 22 }, T0).transition,
      "activated",
    );
  });

  test("triggerMode any requires only one condition", () => {
    const r = rule({
      triggerMode: "any",
      triggers: [
        { sensor: "co2", operator: ">", value: 1200 },
        { sensor: "air_temp", operator: ">", value: 20 },
      ],
    });

    assert.equal(
      stepRule(r, IDLE_LATCH, { co2: 900, air_temp: 22 }, T0).transition,
      "activated",
    );
  });

  test("an empty trigger list never fires", () => {
    const r = rule({ triggers: [] });

    assert.equal(stepRule(r, IDLE_LATCH, co2(9999), T0).transition, "idle");
  });

  test("an empty cutoff list never releases", () => {
    const r = rule({ cutoffs: [] });

    // Latched forever until something else intervenes — matches the firmware,
    // and is why the rule builder should push growers to set a cutoff.
    assert.equal(stepRule(r, activeLatch(), co2(0), T0 + 86_400_000).transition, "held");
  });

  test("every operator behaves", () => {
    const cases: Array<[string, number, boolean]> = [
      [">", 10, false],
      [">", 4, true],
      [">=", 5, true],
      ["<", 10, true],
      ["<=", 5, true],
      ["==", 5, true],
      ["==", 6, false],
      ["!=", 6, true],
      ["!=", 5, false],
    ];

    for (const [operator, value, expected] of cases) {
      const r = rule({ triggers: [{ sensor: "co2", operator, value }] });
      const fired = stepRule(r, IDLE_LATCH, co2(5), T0).transition === "activated";
      assert.equal(fired, expected, `co2=5 ${operator} ${value}`);
    }
  });

  test("a cutoff on a different sensor than the trigger still releases", () => {
    // "Vent on CO2, but stop if the compost gets too cold" — the cross-sensor
    // safety cutoff that the old threshold-only path could not express.
    const r = rule({
      cutoffs: [{ sensor: "compost_temp", operator: "<", value: 15 }],
    });

    const released = stepRule(r, activeLatch(), { co2: 1500, compost_temp: 12 }, T0 + 1);
    assert.equal(released.transition, "released");
    assert.deepEqual(released.claims, [{ device: "fan", on: false }]);
  });
});
