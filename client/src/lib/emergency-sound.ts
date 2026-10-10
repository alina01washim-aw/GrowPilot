export type AlertSoundMode = "ambulance" | "beep";

export class EmergencySound {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeOsc: OscillatorNode | null = null;
  private running = false;
  private mode: AlertSoundMode = "ambulance";
  // Generation counter: stop() bumps it so any start() that is still awaiting
  // AudioContext.resume() aborts instead of reviving the siren after mute.
  private gen = 0;

  setMode(mode: AlertSoundMode) {
    this.mode = mode;
    if (this.running) {
      this.stop();
      void this.start();
    }
  }

  async start(): Promise<boolean> {
    if (this.running) return true;
    const gen = ++this.gen;

    try {
      this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      // A mute/snooze/cleanup happened while we were resuming — abort silently.
      // Return true (not false): the sound was stopped on purpose, it is not
      // blocked by the browser, so don't surface the "Enable Sound" prompt.
      if (gen !== this.gen || !this.ctx) return true;

      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.mode === "ambulance" ? 0.12 : 0.18;
      this.gain.connect(this.ctx.destination);

      if (this.mode === "ambulance") {
        this.playAmbulanceCycle();
        this.interval = setInterval(() => this.playAmbulanceCycle(), 900);
      } else {
        this.playBeep();
        this.interval = setInterval(() => this.playBeep(), 700);
      }

      this.running = true;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  stop() {
    this.gen++; // invalidate any in-flight start()
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.activeOsc?.stop();
    this.activeOsc = null;
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
  }

  private playBeep() {
    if (!this.ctx || !this.gain) return;

    this.activeOsc?.stop();
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 880;
    osc.connect(this.gain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
    this.activeOsc = osc;
  }

  /** Alternating high/low sweep — ambulance-style siren */
  private playAmbulanceCycle() {
    if (!this.ctx || !this.gain) return;

    this.activeOsc?.stop();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.connect(this.gain);

    const t = this.ctx.currentTime;
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.linearRampToValueAtTime(920, t + 0.35);
    osc.frequency.linearRampToValueAtTime(520, t + 0.7);
    osc.frequency.linearRampToValueAtTime(920, t + 1.05);
    osc.frequency.linearRampToValueAtTime(520, t + 1.4);

    osc.start(t);
    osc.stop(t + 1.4);
    this.activeOsc = osc;
  }
}
