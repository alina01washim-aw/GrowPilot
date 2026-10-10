import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  downsampleTo16k,
  floatToPcm16,
  pcm16ToBytes,
  frameRms,
  SpeechGate,
  TARGET_SAMPLE_RATE,
} from "./pcm-encode.ts";

describe("downsampleTo16k — integer decimation", () => {
  it("48k to 16k yields exactly a third of the samples", () => {
    const input = new Float32Array(4800); // 100 ms at 48 kHz
    const out = downsampleTo16k(input, 48_000);
    assert.equal(out.length, 1600); // 100 ms at 16 kHz
  });

  it("averages each group rather than dropping samples, to limit aliasing", () => {
    // Groups of 3: [0, 0.3, 0.6] and [0.9, 0.6, 0.3] → means 0.3 and 0.6.
    const input = new Float32Array([0, 0.3, 0.6, 0.9, 0.6, 0.3]);
    const out = downsampleTo16k(input, 48_000);
    assert.equal(out.length, 2);
    assert.ok(Math.abs(out[0]! - 0.3) < 1e-6, `got ${out[0]}`);
    assert.ok(Math.abs(out[1]! - 0.6) < 1e-6, `got ${out[1]}`);
  });

  it("a constant signal survives resampling unchanged", () => {
    const input = new Float32Array(300).fill(0.5);
    const out = downsampleTo16k(input, 48_000);
    assert.equal(out.length, 100);
    for (const sample of out) assert.ok(Math.abs(sample - 0.5) < 1e-6);
  });

  it("handles 32k (factor 2)", () => {
    const out = downsampleTo16k(new Float32Array(320), 32_000);
    assert.equal(out.length, 160);
  });

  it("discards a trailing partial group instead of emitting a short sample", () => {
    // 7 samples at factor 3 → 2 full groups, 1 leftover sample dropped.
    const out = downsampleTo16k(new Float32Array(7), 48_000);
    assert.equal(out.length, 2);
  });
});

describe("downsampleTo16k — non-integer ratios", () => {
  it("44.1k interpolates to roughly the right length", () => {
    const out = downsampleTo16k(new Float32Array(4410), 44_100);
    // 4410 / (44100/16000) = 1600
    assert.equal(out.length, 1600);
  });

  it("interpolates linearly between neighbours", () => {
    // ratio 1.5: output index 1 sits at input position 1.5, midway between
    // input[1]=1 and input[2]=0 → 0.5
    const input = new Float32Array([0, 1, 0, 1, 0, 1]);
    const out = downsampleTo16k(input, TARGET_SAMPLE_RATE * 1.5);
    assert.ok(Math.abs(out[1]! - 0.5) < 1e-6, `got ${out[1]}`);
  });

  it("never reads past the end of the input", () => {
    const out = downsampleTo16k(new Float32Array([1, 1, 1]), TARGET_SAMPLE_RATE * 1.5);
    for (const sample of out) assert.ok(Number.isFinite(sample));
  });
});

describe("downsampleTo16k — edges", () => {
  it("passes 16k through untouched", () => {
    const input = new Float32Array([0.1, 0.2]);
    assert.equal(downsampleTo16k(input, 16_000), input);
  });

  it("returns empty for empty input", () => {
    assert.equal(downsampleTo16k(new Float32Array(0), 48_000).length, 0);
  });

  it("rejects a nonsensical sample rate rather than producing garbage", () => {
    assert.throws(() => downsampleTo16k(new Float32Array(10), 0), RangeError);
    assert.throws(() => downsampleTo16k(new Float32Array(10), -48_000), RangeError);
    assert.throws(() => downsampleTo16k(new Float32Array(10), NaN), RangeError);
  });
});

describe("floatToPcm16", () => {
  it("maps full scale to the Int16 bounds", () => {
    const out = floatToPcm16(new Float32Array([1, -1, 0]));
    assert.equal(out[0], 32767);
    assert.equal(out[1], -32768);
    assert.equal(out[2], 0);
  });

  it("clamps overshoot instead of wrapping to the opposite polarity", () => {
    // Without clamping these wrap and become loud clicks of inverted sign —
    // browser AGC and AEC do overshoot occasionally.
    const out = floatToPcm16(new Float32Array([1.4, -1.4, 8, -8]));
    assert.equal(out[0], 32767);
    assert.equal(out[1], -32768);
    assert.equal(out[2], 32767);
    assert.equal(out[3], -32768);
  });

  it("keeps mid-scale roughly proportional", () => {
    const out = floatToPcm16(new Float32Array([0.5, -0.5]));
    assert.ok(Math.abs(out[0]! - 16384) <= 1, `got ${out[0]}`);
    assert.ok(Math.abs(out[1]! + 16384) <= 1, `got ${out[1]}`);
  });

  it("handles empty input", () => {
    assert.equal(floatToPcm16(new Float32Array(0)).length, 0);
  });
});

describe("pcm16ToBytes", () => {
  it("writes little-endian pairs", () => {
    const out = pcm16ToBytes(new Int16Array([0x0102]));
    assert.equal(out.length, 2);
    assert.equal(out[0], 0x02); // low byte first
    assert.equal(out[1], 0x01);
  });

  it("encodes negative values in two's complement", () => {
    const out = pcm16ToBytes(new Int16Array([-1]));
    assert.equal(out[0], 0xff);
    assert.equal(out[1], 0xff);
  });

  it("produces two bytes per sample", () => {
    assert.equal(pcm16ToBytes(new Int16Array(160)).length, 320);
  });
});

describe("frameRms", () => {
  it("is zero for silence", () => {
    assert.equal(frameRms(new Float32Array(100)), 0);
  });

  it("equals the amplitude of a constant signal", () => {
    assert.ok(Math.abs(frameRms(new Float32Array(50).fill(0.5)) - 0.5) < 1e-6);
  });

  it("ignores sign", () => {
    const positive = frameRms(new Float32Array([0.4, 0.4]));
    const alternating = frameRms(new Float32Array([0.4, -0.4]));
    assert.ok(Math.abs(positive - alternating) < 1e-6);
  });

  it("is zero for an empty frame rather than NaN", () => {
    assert.equal(frameRms(new Float32Array(0)), 0);
  });
});

describe("SpeechGate — hysteresis", () => {
  it("reports the onset edge exactly once", () => {
    const gate = new SpeechGate(0.02, 0.01, 3);
    assert.deepEqual(gate.push(0.001), { speaking: false, started: false, stopped: false });
    assert.deepEqual(gate.push(0.05), { speaking: true, started: true, stopped: false });
    // Still speaking, but the edge has passed — a second "started" would cut the
    // assistant off twice.
    assert.deepEqual(gate.push(0.05), { speaking: true, started: false, stopped: false });
  });

  it("does not open on a level between the two thresholds", () => {
    const gate = new SpeechGate(0.02, 0.01, 3);
    assert.equal(gate.push(0.015).started, false);
    assert.equal(gate.isSpeaking(), false);
  });

  it("stays open through a dip that lasts less than the hangover", () => {
    const gate = new SpeechGate(0.02, 0.01, 3);
    gate.push(0.05);
    gate.push(0.001); // 1
    gate.push(0.001); // 2 — still under the hangover
    assert.equal(gate.isSpeaking(), true);
    gate.push(0.05); // loud again, counter resets
    gate.push(0.001);
    gate.push(0.001);
    assert.equal(gate.isSpeaking(), true, "the quiet counter must reset on loud frames");
  });

  it("closes once quiet persists for the hangover", () => {
    const gate = new SpeechGate(0.02, 0.01, 3);
    gate.push(0.05);
    gate.push(0.001);
    gate.push(0.001);
    const result = gate.push(0.001);
    assert.deepEqual(result, { speaking: false, started: false, stopped: true });
    assert.equal(gate.isSpeaking(), false);
  });

  it("can reopen after closing", () => {
    const gate = new SpeechGate(0.02, 0.01, 1);
    gate.push(0.05);
    gate.push(0.001);
    assert.equal(gate.isSpeaking(), false);
    assert.equal(gate.push(0.05).started, true);
  });

  it("reset clears state mid-utterance", () => {
    const gate = new SpeechGate(0.02, 0.01, 3);
    gate.push(0.05);
    assert.equal(gate.isSpeaking(), true);
    gate.reset();
    assert.equal(gate.isSpeaking(), false);
    // A fresh onset must be reported again after reset.
    assert.equal(gate.push(0.05).started, true);
  });
});
