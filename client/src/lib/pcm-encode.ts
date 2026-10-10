/**
 * Audio maths for the realtime voice call. Pure and zero-import so it can be
 * unit-tested with `node --test`; the browser-only parts (AudioContext,
 * getUserMedia, btoa) live in `mic-stream.ts`.
 *
 * The Live API wants mono 16-bit little-endian PCM at 16 kHz. Microphones
 * almost always hand us 48 kHz Float32, so every frame needs resampling and
 * requantising before it goes on the wire.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Resamples mono Float32 audio to 16 kHz.
 *
 * For an integer decimation factor (48k→16k is the overwhelmingly common case,
 * factor 3) each output sample is the *mean* of the samples it replaces rather
 * than the first of them. Dropping samples outright is cheaper but aliases
 * everything above 8 kHz back down into the speech band as harsh artefacts,
 * which measurably hurts recognition. Averaging is a crude box low-pass — not a
 * proper windowed-sinc filter, but it removes the worst of the aliasing for a
 * few arithmetic operations per sample.
 *
 * Non-integer ratios (44.1 kHz hardware) fall back to linear interpolation.
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new RangeError(`Invalid input sample rate: ${inputRate}`);
  }
  if (input.length === 0) return new Float32Array(0);
  // Already at (or below) target: nothing useful to do. Upsampling would invent
  // detail that is not there, and the API accepts 16 kHz only, so a lower-rate
  // device is a configuration problem to surface, not to paper over.
  if (inputRate === TARGET_SAMPLE_RATE) return input;

  const ratio = inputRate / TARGET_SAMPLE_RATE;

  if (Number.isInteger(ratio)) {
    const factor = ratio;
    const outLength = Math.floor(input.length / factor);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      let sum = 0;
      const base = i * factor;
      for (let j = 0; j < factor; j++) sum += input[base + j]!;
      out[i] = sum / factor;
    }
    return out;
  }

  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, input.length - 1);
    const weight = position - low;
    out[i] = input[low]! * (1 - weight) + input[high]! * weight;
  }
  return out;
}

/**
 * Float32 [-1, 1] → Int16. Clamps before scaling: a sample slightly outside the
 * nominal range (autoGainControl and browser AEC both overshoot occasionally)
 * would otherwise wrap around and become a loud click at the opposite polarity.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]!));
    // Asymmetric on purpose: Int16 runs -32768..32767, so the two directions
    // need different multipliers to reach full scale without overflowing.
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** Int16 samples → little-endian bytes, ready to base64-encode. */
export function pcm16ToBytes(input: Int16Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const value = input[i]!;
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return out;
}

/**
 * Root-mean-square level of a frame, used for the local speech-onset check.
 *
 * This is not a replacement for the server's voice-activity detection — it only
 * decides when to *stop playback locally*, so the assistant goes quiet the
 * instant the user starts talking instead of waiting for the round trip. The
 * server's VAD remains the authority on where a turn actually begins and ends.
 */
export function frameRms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
  return Math.sqrt(sum / input.length);
}

/**
 * Hysteretic speech-onset detector over successive RMS values.
 *
 * Two thresholds, not one: a single threshold chatters on and off around the
 * boundary, and each spurious "on" would cut the assistant off mid-word. Speech
 * has to cross the higher bar to start, and fall below the lower bar for
 * `hangoverFrames` before we call it silence.
 */
export class SpeechGate {
  // Written out longhand rather than as constructor parameter properties: Node's
  // type-stripping loader rejects those (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX),
  // which would make this whole module untestable under `node --test`.
  private speaking = false;
  private quietFrames = 0;
  private readonly onThreshold: number;
  private readonly offThreshold: number;
  private readonly hangoverFrames: number;

  constructor(onThreshold = 0.02, offThreshold = 0.01, hangoverFrames = 8) {
    this.onThreshold = onThreshold;
    this.offThreshold = offThreshold;
    this.hangoverFrames = hangoverFrames;
  }

  /** Returns true on the frame speech starts, so callers can act on the edge. */
  push(rms: number): { speaking: boolean; started: boolean; stopped: boolean } {
    if (!this.speaking) {
      if (rms >= this.onThreshold) {
        this.speaking = true;
        this.quietFrames = 0;
        return { speaking: true, started: true, stopped: false };
      }
      return { speaking: false, started: false, stopped: false };
    }

    if (rms < this.offThreshold) {
      this.quietFrames += 1;
      if (this.quietFrames >= this.hangoverFrames) {
        this.speaking = false;
        this.quietFrames = 0;
        return { speaking: false, started: false, stopped: true };
      }
    } else {
      this.quietFrames = 0;
    }
    return { speaking: true, started: false, stopped: false };
  }

  reset(): void {
    this.speaking = false;
    this.quietFrames = 0;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }
}
