import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildSchedule,
  stageChanges,
  DAY_MS,
  type ScheduleStageInput,
  type ScheduleInput,
} from "./cropSchedule.ts";

/**
 * The crop calendar. Every date here is *derived* from `days`, so these tests are
 * really pinning down one invariant: the schedule must agree with what
 * `runStageAdvanceCheck` will actually do (`currentStageStartedAt + days`).
 *
 * Dates are fixed rather than relative to `Date.now()` so a test can never pass
 * or fail depending on the hour it runs at.
 */

const DEVICES = ["fan", "ac", "mist_maker", "uv"] as const;

// 2026-08-19T00:00:00.000Z
const START = new Date("2026-08-19T00:00:00.000Z");
const NOW = new Date("2026-08-25T00:00:00.000Z");

function stage(overrides: Partial<ScheduleStageInput> = {}): ScheduleStageInput {
  return {
    key: "spawn_run",
    label: "Spawn Run",
    days: 16,
    targets: {
      tempMin: 23,
      tempMax: 25,
      co2Min: 3000,
      co2Max: 15000,
      humidityMin: 90,
      humidityMax: 96,
    },
    devicesAuto: ["ac", "mist_maker"],
    notes: "",
    ...overrides,
  };
}

/** The three-stage plan used across most cases. */
function plan(): ScheduleStageInput[] {
  return [
    stage({ key: "spawn_run", label: "Spawn Run", days: 16 }),
    stage({ key: "case_run", label: "Case Run", days: 6 }),
    stage({
      key: "pinning",
      label: "Pinning",
      days: 5,
      devicesAuto: ["fan", "ac", "mist_maker"],
      targets: {
        tempMin: 17,
        tempMax: 19,
        co2Min: 800,
        co2Max: 1500,
        humidityMin: 88,
        humidityMax: 93,
      },
    }),
  ];
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    stages: plan(),
    status: "planned",
    currentStageIndex: 0,
    currentStageStartedAt: null,
    startedAt: null,
    plannedStartAt: START,
    stageHistory: [],
    ...overrides,
  };
}

/** yyyy-mm-dd of an ISO string, for readable assertions. */
const day = (iso: string | null) => (iso == null ? null : iso.slice(0, 10));

describe("buildSchedule — planned batch", () => {
  test("dates run consecutively from plannedStartAt", () => {
    const s = buildSchedule(input(), DEVICES, NOW);

    assert.equal(s.length, 3);
    assert.deepEqual(
      s.map((x) => [day(x.startsAt), day(x.endsAt)]),
      [
        ["2026-08-19", "2026-09-04"], // 16 days
        ["2026-09-04", "2026-09-10"], // +6
        ["2026-09-10", "2026-09-15"], // +5
      ],
    );
  });

  test("every stage is upcoming and nothing is an actual date", () => {
    const s = buildSchedule(input(), DEVICES, NOW);

    assert.deepEqual(s.map((x) => x.state), ["upcoming", "upcoming", "upcoming"]);
    assert.deepEqual(s.map((x) => x.actual), [false, false, false]);
  });

  test("falls back to now when there is no planned start date", () => {
    const s = buildSchedule(input({ plannedStartAt: null }), DEVICES, NOW);

    assert.equal(day(s[0]!.startsAt), "2026-08-25", "anchors on now");
    assert.equal(day(s[1]!.startsAt), "2026-09-10");
  });

  test("an empty plan produces an empty schedule", () => {
    assert.deepEqual(buildSchedule(input({ stages: [] }), DEVICES, NOW), []);
  });
});

describe("buildSchedule — running batch", () => {
  const running = (): ScheduleInput =>
    input({
      status: "active",
      currentStageIndex: 1,
      // Case Run entered 2 days ago.
      currentStageStartedAt: new Date("2026-08-23T00:00:00.000Z"),
      startedAt: START,
      stageHistory: [
        { index: 0, enteredAt: START },
        { index: 1, enteredAt: new Date("2026-08-23T00:00:00.000Z") },
      ],
    });

  test("anchors on the current stage's real start, not the plan", () => {
    // Spawn Run was planned for 16 days but was advanced after 4. The current
    // stage must be dated from when it actually began.
    const s = buildSchedule(running(), DEVICES, NOW);

    assert.equal(day(s[1]!.startsAt), "2026-08-23");
    assert.equal(day(s[1]!.endsAt), "2026-08-29", "6 planned days from the real start");
  });

  test("later stages project forward from the current stage", () => {
    const s = buildSchedule(running(), DEVICES, NOW);

    assert.equal(day(s[2]!.startsAt), "2026-08-29", "when Case Run ends");
    assert.equal(day(s[2]!.endsAt), "2026-09-03");
  });

  test("past stages use their recorded entry date and are marked actual", () => {
    const s = buildSchedule(running(), DEVICES, NOW);

    assert.equal(day(s[0]!.startsAt), "2026-08-19");
    assert.equal(s[0]!.actual, true);
    assert.equal(s[1]!.actual, true);
    assert.equal(s[2]!.actual, false, "not entered yet");
  });

  test("states are done / current / upcoming around currentStageIndex", () => {
    const s = buildSchedule(running(), DEVICES, NOW);

    assert.deepEqual(s.map((x) => x.state), ["done", "current", "upcoming"]);
  });

  test("a past stage with no recorded entry is projected backwards", () => {
    // Started mid-plan (no history for stage 0): its date is worked back from
    // the current stage so the calendar has no hole.
    const s = buildSchedule(
      input({
        status: "active",
        currentStageIndex: 1,
        currentStageStartedAt: new Date("2026-08-23T00:00:00.000Z"),
        startedAt: null,
        stageHistory: [{ index: 1, enteredAt: new Date("2026-08-23T00:00:00.000Z") }],
      }),
      DEVICES,
      NOW,
    );

    assert.equal(day(s[0]!.startsAt), "2026-08-07", "16 days before Case Run");
    assert.equal(s[0]!.actual, false, "projected, and must say so");
  });

  test("falls back to the recorded entry when currentStageStartedAt is missing", () => {
    const s = buildSchedule(
      input({
        status: "active",
        currentStageIndex: 1,
        currentStageStartedAt: null,
        stageHistory: [{ index: 1, enteredAt: new Date("2026-08-23T00:00:00.000Z") }],
      }),
      DEVICES,
      NOW,
    );

    assert.equal(day(s[1]!.startsAt), "2026-08-23");
  });

  test("a corrupt currentStageIndex is clamped instead of leaving holes", () => {
    const s = buildSchedule(
      input({ status: "active", currentStageIndex: 99, currentStageStartedAt: START }),
      DEVICES,
      NOW,
    );

    assert.equal(s.length, 3);
    assert.ok(
      s.every((x) => typeof x.startsAt === "string" && !Number.isNaN(Date.parse(x.startsAt))),
      "every stage still has a valid date",
    );
    assert.equal(s[2]!.state, "current", "clamped to the last stage");
  });
});

describe("buildSchedule — finished batch", () => {
  test("dates from startedAt, not a planned start it never used", () => {
    const s = buildSchedule(
      input({
        status: "completed",
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        plannedStartAt: START,
        currentStageIndex: 2,
      }),
      DEVICES,
      NOW,
    );

    assert.equal(day(s[0]!.startsAt), "2026-07-01");
    assert.deepEqual(s.map((x) => x.state), ["done", "done", "done"]);
  });

  test("an aborted batch is also all done", () => {
    const s = buildSchedule(
      input({ status: "aborted", startedAt: START, currentStageIndex: 1 }),
      DEVICES,
      NOW,
    );

    assert.deepEqual(s.map((x) => x.state), ["done", "done", "done"]);
  });
});

describe("buildSchedule — open-ended stages", () => {
  test("days = 0 has no end date", () => {
    const s = buildSchedule(
      input({ stages: [stage({ days: 0 })] }),
      DEVICES,
      NOW,
    );

    assert.equal(s[0]!.endsAt, null);
  });

  test("an open-ended stage does not advance the stages after it", () => {
    // Nothing can be projected past a stage that only a person can end, so the
    // next stage shares its start date. Better than inventing a date.
    const s = buildSchedule(
      input({ stages: [stage({ days: 0 }), stage({ label: "Next", days: 5 })] }),
      DEVICES,
      NOW,
    );

    assert.equal(day(s[0]!.startsAt), "2026-08-19");
    assert.equal(day(s[1]!.startsAt), "2026-08-19");
    assert.equal(day(s[1]!.endsAt), "2026-08-24");
  });
});

describe("buildSchedule — devicesParked", () => {
  test("lists exactly the devices the stage does not automate", () => {
    const s = buildSchedule(input(), DEVICES, NOW);

    assert.deepEqual(s[0]!.devicesParked, ["fan", "uv"]);
    assert.deepEqual(s[2]!.devicesParked, ["uv"], "pinning adds the fan");
  });

  test("a stage automating nothing parks everything", () => {
    const s = buildSchedule(
      input({ stages: [stage({ devicesAuto: [] })] }),
      DEVICES,
      NOW,
    );

    assert.deepEqual(s[0]!.devicesParked, ["fan", "ac", "mist_maker", "uv"]);
  });
});

describe("stageChanges — what happens on the day", () => {
  test("the first stage reports everything it automates as a turn-on", () => {
    const c = stageChanges(null, plan()[0]!);

    assert.deepEqual(c.devicesTurnedOn, ["ac", "mist_maker"]);
    assert.deepEqual(c.devicesTurnedOff, []);
    assert.equal(c.tempMin, null, "no previous stage to differ from");
  });

  test("reports only the targets that actually moved", () => {
    const c = stageChanges(plan()[1]!, plan()[2]!);

    assert.deepEqual(c.tempMin, { from: 23, to: 17 });
    assert.deepEqual(c.tempMax, { from: 25, to: 19 });
    assert.deepEqual(c.co2Max, { from: 15000, to: 1500 });
  });

  test("an unchanged target is null, not a no-op pair", () => {
    const a = stage({ devicesAuto: ["ac"] });
    const b = stage({ devicesAuto: ["ac"] });

    const c = stageChanges(a, b);
    assert.equal(c.tempMin, null);
    assert.equal(c.tempMax, null);
    assert.equal(c.humidityMin, null);
    assert.deepEqual(c.devicesTurnedOn, []);
    assert.deepEqual(c.devicesTurnedOff, []);
  });

  test("catches the venting transition — the fan coming on at pinning", () => {
    const c = stageChanges(plan()[1]!, plan()[2]!);

    assert.deepEqual(c.devicesTurnedOn, ["fan"]);
    assert.deepEqual(c.devicesTurnedOff, []);
  });

  test("catches a device being parked off", () => {
    const c = stageChanges(
      stage({ devicesAuto: ["fan", "ac", "mist_maker"] }),
      stage({ devicesAuto: ["ac", "mist_maker"] }),
    );

    assert.deepEqual(c.devicesTurnedOff, ["fan"]);
    assert.deepEqual(c.devicesTurnedOn, []);
  });
});

describe("buildSchedule — agreement with auto-advance", () => {
  test("the current stage's endsAt is exactly what runStageAdvanceCheck uses", () => {
    // runStageAdvanceCheck advances at currentStageStartedAt + days * DAY_MS.
    // If these ever diverge, the calendar lies about when the room re-targets.
    const startedAt = new Date("2026-08-23T09:41:00.000Z");
    const days = 6;

    const s = buildSchedule(
      input({
        status: "active",
        currentStageIndex: 1,
        currentStageStartedAt: startedAt,
        stages: [stage(), stage({ days }), stage()],
      }),
      DEVICES,
      NOW,
    );

    assert.equal(
      s[1]!.endsAt,
      new Date(startedAt.getTime() + days * DAY_MS).toISOString(),
    );
  });
});
