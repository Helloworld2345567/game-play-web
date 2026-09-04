export type StackSoundCue = "start" | "place" | "perfect" | "miss";

const CUE_NOTES: Readonly<Record<StackSoundCue, readonly number[]>> = {
  start: [261.63, 392],
  place: [329.63],
  perfect: [523.25, 659.25, 783.99],
  miss: [196, 146.83],
};

/** Small synthesized cues keep the game responsive without loading audio files. */
export class StackSound {
  private context: AudioContext | null = null;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.context?.state === "running") {
      void this.context.suspend();
    }
  }

  async prime(): Promise<void> {
    if (!this.enabled) return;
    if (this.context === null) this.context = new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
  }

  play(cue: StackSoundCue, streak = 0): void {
    if (!this.enabled) return;
    void this.prime().then(() => {
      const context = this.context;
      if (context === null) return;
      const notes = CUE_NOTES[cue];
      const startAt = context.currentTime;
      const streakLift = cue === "perfect" ? Math.min(streak, 6) * 11 : 0;

      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = startAt + index * 0.055;
        const duration = cue === "miss" ? 0.18 : 0.11;
        oscillator.type = cue === "miss" ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(frequency + streakLift, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.055, noteStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + duration + 0.01);
      });
    }).catch(() => {
      // Browsers may decline audio until a direct user gesture; gameplay continues.
    });
  }

  dispose(): void {
    if (this.context !== null) void this.context.close();
    this.context = null;
  }
}
