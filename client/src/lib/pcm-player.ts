// Queued PCM playback with Web Audio. Audio chunks (base64 16-bit LE PCM at a
// fixed sample rate) arrive while the LLM is still writing; each chunk is
// decoded into an AudioBuffer and played back-to-back. stop() flushes the
// queue and kills the current source instantly — the barge-in kill-switch.

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private stopped = false;
  private sampleRate = 24000;

  onDrained: (() => void) | null = null;

  /** True while audio is queued or playing. */
  isPlaying(): boolean {
    return this.playing || this.queue.length > 0;
  }

  pushBase64(b64: string): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;

    let bytes: string;
    try {
      bytes = atob(b64);
    } catch {
      return;
    }
    const frames = Math.floor(bytes.length / 2);
    if (frames === 0) return;

    const int16 = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      int16[i] = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
    }
    const float = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      float[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, frames, this.sampleRate);
    buffer.copyToChannel(float, 0);
    this.queue.push(buffer);
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.queue = [];
    this.playing = false;
  }

  resume(): void {
    this.stopped = false;
    this.pump();
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || this.playing || this.stopped) return;
    const buffer = this.queue.shift();
    if (!buffer) {
      this.onDrained?.();
      return;
    }
    this.playing = true;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    this.source = src;
    src.onended = () => {
      this.source = null;
      this.playing = false;
      this.pump();
    };
    src.start();
  }
}