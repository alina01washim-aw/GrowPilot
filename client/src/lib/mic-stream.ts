import {
  downsampleTo16k,
  floatToPcm16,
  pcm16ToBytes,
  frameRms,
  SpeechGate,
} from "./pcm-encode";

/**
 * Continuous microphone capture for the realtime voice call.
 *
 * The single most important property here: the stream is opened once and never
 * stopped for the duration of the call. The previous implementation created a
 * fresh browser `SpeechRecognition` per utterance, and because Chrome silently
 * fails a restart that follows too closely it needed 400-700 ms re-arm delays —
 * windows in which the microphone was genuinely deaf. Speaking immediately after
 * the assistant stopped simply did not register. One long-lived stream removes
 * that failure mode entirely.
 *
 * `echoCancellation` is the other half. Without it the microphone hears the
 * assistant's own voice from the speakers, which is why barge-in previously
 * needed an "ignore anything under two characters" guard — a heuristic that also
 * discarded "no", "stop" and "ruko", the words people actually interrupt with.
 * Browser AEC removes the assistant's audio from the captured signal, so short
 * interjections can be trusted.
 */

const WORKLET_FRAME_SAMPLES = 4096; // ~85 ms at 48 kHz

/**
 * Worklet source, compiled from a string into a blob URL.
 *
 * Inlined rather than shipped as a separate asset so it needs no bundler-specific
 * URL handling and cannot get out of step with this file. The worklet stays
 * deliberately dumb — it buffers and forwards raw frames, and all the arithmetic
 * happens on the main thread in `pcm-encode.ts` where it is unit-tested.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions.frameSize;
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.frameSize) {
        // Copy: the buffer is reused immediately after posting.
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export interface MicStreamHandlers {
  /** Base64 PCM16 mono @16 kHz, ready for the socket. */
  onFrame: (base64: string) => void;
  /** Local speech onset — fires within roughly one frame of the user starting. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (err: Error) => void;
}

export interface MicStream {
  stop: () => void;
  /** True while the local gate believes the user is talking. */
  isSpeaking: () => boolean;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked to stay clear of the argument-count limit on very large frames.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Opens the microphone and streams encoded frames until `stop()`.
 *
 * Throws if permission is denied or the browser has no `getUserMedia`, so the
 * caller can surface a real message rather than a call that silently never hears
 * anything.
 */
export async function startMicStream(handlers: MicStreamHandlers): Promise<MicStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot access the microphone.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  // Let the context pick the hardware's native rate. Forcing 16 kHz here makes
  // some browsers resample with a low-quality path before AEC runs, which hurts
  // both cancellation and recognition; we downsample ourselves afterwards.
  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const gate = new SpeechGate();
  let stopped = false;

  const handleFrame = (input: Float32Array): void => {
    if (stopped) return;

    const level = frameRms(input);
    const gateState = gate.push(level);
    if (gateState.started) handlers.onSpeechStart?.();
    if (gateState.stopped) handlers.onSpeechEnd?.();

    const resampled = downsampleTo16k(input, ctx.sampleRate);
    if (resampled.length === 0) return;
    handlers.onFrame(toBase64(pcm16ToBytes(floatToPcm16(resampled))));
  };

  // Muted sink: an AudioWorkletNode only runs while connected to the graph, but
  // routing the microphone to the speakers would create a feedback loop.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  let node: AudioNode;
  let workletUrl: string | null = null;

  if (ctx.audioWorklet) {
    workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    await ctx.audioWorklet.addModule(workletUrl);
    const worklet = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { frameSize: WORKLET_FRAME_SAMPLES },
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      handleFrame(event.data);
    };
    worklet.onprocessorerror = () => {
      handlers.onError?.(new Error("Microphone processing failed."));
    };
    node = worklet;
  } else {
    // ScriptProcessorNode is deprecated and runs on the main thread, but it is
    // the only fallback on older Safari. Same callback, worse jitter.
    const legacy = ctx.createScriptProcessor(WORKLET_FRAME_SAMPLES, 1, 1);
    legacy.onaudioprocess = (event) => {
      handleFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    node = legacy;
  }

  source.connect(node);
  node.connect(sink);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      for (const track of stream.getTracks()) track.stop();
      if (workletUrl) URL.revokeObjectURL(workletUrl);
      void ctx.close().catch(() => undefined);
    },
    isSpeaking: () => gate.isSpeaking(),
  };
}
