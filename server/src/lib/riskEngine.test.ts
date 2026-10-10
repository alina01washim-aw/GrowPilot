import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deviation,
  scoreIncident,
  findRisks,
  buildDedupeKey,
  DEFAULT_RISK_OPTIONS,
  type CurrentState,
  type HistoricalIncident,
  type MetricSample,
  type BatchOutcome,
} from "./riskEngine.ts";

// Fruiting-style bands, matching DEFAULT_STAGE_PLAN in models/cropBatch.ts.
const FRUITING_HUM = { min: 85, max: 90 };
const FRUITING_TEMP = { min: 16, max: 18 };
// Spawn run tolerates far wetter air — the case that proves band-relative
// comparison is necessary.
const SPAWN_HUM = { min: 90, max: 96 };

function sample(metric: MetricSample["metric"], value: number, band: { min: number; max: number }): MetricSample {
  return { metric, value, band };
}

function incident(over: Partial<HistoricalIncident> = {}): HistoricalIncident {
  return {
    annotationId: "a1",
    batchId: "BATCH-OLD",
    batchName: "Room 1 July fill",
    stageKey: "fruiting",
    stageLabel: "Fruiting — Flush 1",
    dayOfStage: 3,
    dayOfBatch: 30,
    severity: "critical",
    category: "humidity",
    title: "Pins aborting, air too wet",
    samples: [sample("hum", 96, FRUITING_HUM)],
    outcome: { label: "major_loss", yieldKg: 4, gradePercent: 35 },
    ...over,
  };
}

function current(over: Partial<CurrentState> = {}): CurrentState {
  return {
    batchId: "BATCH-NEW",
    stageKey: "fruiting",
    stageLabel: "Fruiting — Flush 1",
    dayOfStage: 3,
    dayOfBatch: 30,
    samples: [sample("hum", 95, FRUITING_HUM)],
    ...over,
  };
}

describe("deviation", () => {
  it("is zero anywhere inside the band, including on the edges", () => {
    assert.equal(deviation(87, FRUITING_HUM), 0);
    assert.equal(deviation(85, FRUITING_HUM), 0);
    assert.equal(deviation(90, FRUITING_HUM), 0);
  });

  it("is positive above the ceiling, measured in band-widths", () => {
    // 5-wide band, 5 above the ceiling → exactly one band-width.
    assert.equal(deviation(95, FRUITING_HUM), 1);
    assert.equal(deviation(92.5, FRUITING_HUM), 0.5);
  });

  it("is negative below the floor", () => {
    assert.equal(deviation(80, FRUITING_HUM), -1);
    assert.equal(deviation(82.5, FRUITING_HUM), -0.5);
  });

  it("reads the same raw value differently under a different stage's band", () => {
    // This is the whole point of band-relative comparison: 95% humidity is one
    // full band-width too wet in fruiting, and perfectly fine in a spawn run.
    assert.equal(deviation(95, FRUITING_HUM), 1);
    assert.equal(deviation(95, SPAWN_HUM), 0);
  });

  it("treats a zero-width band as very narrow rather than dividing by zero", () => {
    const value = deviation(21, { min: 20, max: 20 });
    assert.ok(Number.isFinite(value));
    assert.ok(value > 1000, "any deviation from an exact target should read as large");
  });

  it("returns zero for a non-finite value instead of propagating NaN", () => {
    assert.equal(deviation(NaN, FRUITING_HUM), 0);
    assert.equal(deviation(Infinity, FRUITING_HUM), 0);
  });
});

describe("scoreIncident — direction", () => {
  it("matches when both are high", () => {
    const match = scoreIncident(current(), incident());
    assert.ok(match, "expected a match");
    assert.equal(match.metrics[0]!.direction, "high");
  });

  it("refuses to match a wet past against a dry present", () => {
    // A disaster caused by air that was too wet says nothing about air that is
    // too dry, so this must be rejected outright, not merely scored low.
    const match = scoreIncident(current({ samples: [sample("hum", 78, FRUITING_HUM)] }), incident());
    assert.equal(match, null);
  });

  it("matches when both are low", () => {
    const match = scoreIncident(
      current({ samples: [sample("hum", 79, FRUITING_HUM)] }),
      incident({ samples: [sample("hum", 78, FRUITING_HUM)] }),
    );
    assert.ok(match);
    assert.equal(match.metrics[0]!.direction, "low");
  });

  it("does not match when the present is inside its band", () => {
    const match = scoreIncident(current({ samples: [sample("hum", 88, FRUITING_HUM)] }), incident());
    assert.equal(match, null);
  });

  it("does not match when the past incident was itself in band", () => {
    // Nothing to learn from a note logged while conditions were fine.
    const match = scoreIncident(
      current({ samples: [sample("hum", 95, FRUITING_HUM)] }),
      incident({ samples: [sample("hum", 88, FRUITING_HUM)] }),
    );
    assert.equal(match, null);
  });
});

describe("scoreIncident — band relativity across differing plans", () => {
  it("does not warn when the present stage tolerates the value", () => {
    // Same 95% humidity, but this batch is in a spawn run whose band allows it.
    const match = scoreIncident(
      current({
        stageKey: "spawn_run",
        stageLabel: "Spawn Run",
        samples: [sample("hum", 95, SPAWN_HUM)],
      }),
      incident(),
    );
    assert.equal(match, null);
  });
});

describe("scoreIncident — threshold behaviour", () => {
  it("ignores a present deviation well below the historical one", () => {
    // Historical was one full band-width out; 0.1 is under matchFraction 0.6.
    const match = scoreIncident(current({ samples: [sample("hum", 90.5, FRUITING_HUM)] }), incident());
    assert.equal(match, null);
  });

  it("flags the present as already worse when it exceeds the past", () => {
    const match = scoreIncident(current({ samples: [sample("hum", 99, FRUITING_HUM)] }), incident());
    assert.ok(match);
    assert.ok(match.metrics[0]!.ratio > 1, `ratio was ${match.metrics[0]!.ratio}`);
    assert.match(match.headline, /already worse than/);
  });

  it("respects a raised minScore", () => {
    const strict = { ...DEFAULT_RISK_OPTIONS, minScore: 0.99 };
    assert.equal(scoreIncident(current(), incident(), strict), null);
  });

  it("respects a lowered matchFraction", () => {
    const lenient = { ...DEFAULT_RISK_OPTIONS, matchFraction: 0.05, minScore: 0.01 };
    const match = scoreIncident(current({ samples: [sample("hum", 90.5, FRUITING_HUM)] }), incident(), lenient);
    assert.ok(match, "a lower matchFraction should let a mild deviation through");
  });
});

describe("scoreIncident — severity filter", () => {
  it("skips info-level notes by default", () => {
    assert.equal(scoreIncident(current(), incident({ severity: "info" })), null);
  });

  it("includes info when minSeverity is lowered", () => {
    const opts = { ...DEFAULT_RISK_OPTIONS, minSeverity: "info" as const, minScore: 0.01 };
    assert.ok(scoreIncident(current(), incident({ severity: "info" }), opts));
  });

  it("scores critical above warning, all else equal", () => {
    const crit = scoreIncident(current(), incident({ severity: "critical" }));
    const warn = scoreIncident(current(), incident({ severity: "warning" }));
    assert.ok(crit && warn);
    assert.ok(crit.score > warn.score);
  });
});

describe("scoreIncident — outcome weighting", () => {
  const outcomes: Array<[BatchOutcome["label"], BatchOutcome["label"]]> = [
    ["spoiled", "major_loss"],
    ["major_loss", "contaminated"],
    ["contaminated", "aborted"],
    ["aborted", "partial_loss"],
    ["partial_loss", "good"],
  ];

  for (const [worse, better] of outcomes) {
    it(`weights ${worse} above ${better}`, () => {
      const a = scoreIncident(
        current(),
        incident({ outcome: { label: worse, yieldKg: null, gradePercent: null } }),
        { ...DEFAULT_RISK_OPTIONS, minScore: 0 },
      );
      const b = scoreIncident(
        current(),
        incident({ outcome: { label: better, yieldKg: null, gradePercent: null } }),
        { ...DEFAULT_RISK_OPTIONS, minScore: 0 },
      );
      assert.ok(a && b);
      assert.ok(a.score > b.score, `${worse} ${a.score} should beat ${better} ${b.score}`);
    });
  }

  it("treats an unrecorded outcome as mid-weight, not as safe", () => {
    const unknown = scoreIncident(current(), incident({ outcome: null }), {
      ...DEFAULT_RISK_OPTIONS,
      minScore: 0,
    });
    const good = scoreIncident(
      current(),
      incident({ outcome: { label: "good", yieldKg: null, gradePercent: null } }),
      { ...DEFAULT_RISK_OPTIONS, minScore: 0 },
    );
    assert.ok(unknown && good);
    assert.ok(unknown.score > good.score, "unknown must not be treated as reassuring");
  });

  it("mentions the recorded yield in the advice", () => {
    const match = scoreIncident(current(), incident());
    assert.ok(match);
    assert.match(match.advice, /35% marketable/);
  });
});

describe("scoreIncident — stage and day alignment", () => {
  it("prefers a stage match over a bare day match", () => {
    const aligned = scoreIncident(current(), incident());
    const different = scoreIncident(current(), incident({ stageKey: "pinning" }));
    assert.ok(aligned && different);
    assert.equal(aligned.stageAligned, true);
    assert.equal(different.stageAligned, false);
    assert.ok(aligned.score > different.score);
  });

  it("decays with day distance inside the same stage", () => {
    const near = scoreIncident(current({ dayOfStage: 3 }), incident({ dayOfStage: 3 }));
    const far = scoreIncident(current({ dayOfStage: 3 }), incident({ dayOfStage: 12 }));
    assert.ok(near);
    // Far may fall under minScore entirely, which is also correct.
    if (far) assert.ok(near.score > far.score);
    assert.equal(near.dayGap, 0);
  });

  it("falls back to day-of-batch when the stages differ", () => {
    // minScore pinned: this asserts which day field is compared, not whether a
    // cross-stage match clears the default bar.
    const match = scoreIncident(
      current({ dayOfBatch: 30, dayOfStage: 3 }),
      incident({ stageKey: "pinning", dayOfBatch: 31, dayOfStage: 99 }),
      { ...DEFAULT_RISK_OPTIONS, minScore: 0 },
    );
    assert.ok(match);
    assert.equal(match.stageAligned, false);
    assert.equal(match.dayGap, 1, "should compare batch days, not stage days");
  });
});

describe("scoreIncident — corroboration", () => {
  it("scores two agreeing metrics above one", () => {
    const one = scoreIncident(current(), incident());
    const two = scoreIncident(
      current({ samples: [sample("hum", 95, FRUITING_HUM), sample("temp", 20, FRUITING_TEMP)] }),
      incident({ samples: [sample("hum", 96, FRUITING_HUM), sample("temp", 21, FRUITING_TEMP)] }),
    );
    assert.ok(one && two);
    assert.equal(two.metrics.length, 2);
    assert.ok(two.score > one.score);
  });

  it("ignores metrics the past incident never recorded", () => {
    const match = scoreIncident(
      current({ samples: [sample("hum", 95, FRUITING_HUM), sample("co2", 3000, { min: 600, max: 1000 })] }),
      incident(),
    );
    assert.ok(match);
    assert.equal(match.metrics.length, 1);
    assert.equal(match.metrics[0]!.metric, "hum");
  });
});

describe("scoreIncident — guards", () => {
  it("never matches a batch against its own notes", () => {
    assert.equal(scoreIncident(current({ batchId: "SAME" }), incident({ batchId: "SAME" })), null);
  });

  it("returns null when there are no shared metrics", () => {
    const match = scoreIncident(
      current({ samples: [sample("temp", 25, FRUITING_TEMP)] }),
      incident({ samples: [sample("hum", 96, FRUITING_HUM)] }),
    );
    assert.equal(match, null);
  });

  it("returns null when the present has no samples at all", () => {
    assert.equal(scoreIncident(current({ samples: [] }), incident()), null);
  });
});

describe("findRisks", () => {
  it("returns nothing for an empty history, rather than guessing", () => {
    assert.deepEqual(findRisks(current(), []), []);
  });

  it("sorts strongest first", () => {
    const matches = findRisks(
      current(),
      [
        incident({ annotationId: "weak", severity: "warning", outcome: { label: "partial_loss", yieldKg: null, gradePercent: null } }),
        incident({ annotationId: "strong", severity: "critical", outcome: { label: "spoiled", yieldKg: null, gradePercent: null } }),
      ],
      // Pinned so this tests ordering, not which of the two clears the bar.
      { ...DEFAULT_RISK_OPTIONS, minScore: 0 },
    );
    assert.equal(matches.length, 2);
    assert.equal(matches[0]!.incident.annotationId, "strong");
  });

  it("drops incidents that do not match while keeping those that do", () => {
    const matches = findRisks(current(), [
      incident({ annotationId: "opposite", samples: [sample("hum", 70, FRUITING_HUM)] }),
      incident({ annotationId: "real" }),
    ]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.incident.annotationId, "real");
  });
});

describe("buildDedupeKey", () => {
  it("is stable for the same situation", () => {
    const a = scoreIncident(current(), incident());
    const b = scoreIncident(current(), incident());
    assert.ok(a && b);
    assert.equal(a.dedupeKey, b.dedupeKey);
  });

  it("changes when the stage-day moves on", () => {
    const day3 = scoreIncident(current({ dayOfStage: 3 }), incident({ dayOfStage: 3 }));
    const day4 = scoreIncident(current({ dayOfStage: 4 }), incident({ dayOfStage: 3 }));
    assert.ok(day3 && day4);
    assert.notEqual(day3.dedupeKey, day4.dedupeKey);
  });

  it("changes when a different metric starts matching", () => {
    const hum = scoreIncident(current(), incident());
    const both = scoreIncident(
      current({ samples: [sample("hum", 95, FRUITING_HUM), sample("temp", 20, FRUITING_TEMP)] }),
      incident({ samples: [sample("hum", 96, FRUITING_HUM), sample("temp", 21, FRUITING_TEMP)] }),
    );
    assert.ok(hum && both);
    assert.notEqual(hum.dedupeKey, both.dedupeKey);
  });

  it("does not depend on metric ordering", () => {
    const cur = current();
    const inc = incident();
    const forward = buildDedupeKey(cur, inc, [
      { metric: "hum" } as never,
      { metric: "temp" } as never,
    ]);
    const reverse = buildDedupeKey(cur, inc, [
      { metric: "temp" } as never,
      { metric: "hum" } as never,
    ]);
    assert.equal(forward, reverse);
  });

  it("distinguishes two different source incidents", () => {
    const a = scoreIncident(current(), incident({ annotationId: "one" }));
    const b = scoreIncident(current(), incident({ annotationId: "two" }));
    assert.ok(a && b);
    assert.notEqual(a.dedupeKey, b.dedupeKey);
  });
});

describe("messaging", () => {
  it("names the past batch and its stage in the headline", () => {
    const match = scoreIncident(current(), incident());
    assert.ok(match);
    assert.match(match.headline, /Room 1 July fill/);
    assert.match(match.headline, /Fruiting/);
  });

  it("explains the deviation in real units, not band-widths", () => {
    const match = scoreIncident(current(), incident());
    assert.ok(match);
    // 95% against a 90% ceiling → 5% above.
    assert.match(match.metrics[0]!.explanation, /5%/);
    assert.match(match.metrics[0]!.explanation, /above/);
  });

  it("says so when no outcome was recorded", () => {
    const match = scoreIncident(current(), incident({ outcome: null }));
    assert.ok(match);
    assert.match(match.advice, /outcome not recorded/);
  });

  it("formats CO2 without decimals", () => {
    const match = scoreIncident(
      current({ samples: [sample("co2", 2400, { min: 600, max: 1000 })] }),
      incident({ samples: [sample("co2", 2500, { min: 600, max: 1000 })] }),
    );
    assert.ok(match);
    assert.ok(!/\d\.\d/.test(match.metrics[0]!.explanation), match.metrics[0]!.explanation);
  });
});
