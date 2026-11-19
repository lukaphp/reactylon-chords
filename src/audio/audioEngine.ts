import * as Tone from 'tone';

interface Voice {
  synth: Tone.PluckSynth;
  gain: Tone.Gain;
  lastUsedMs: number;
}

const POOL_SIZE = 16;

/**
 * Low-latency polyphonic Karplus-Strong plucked string engine using a pool of Tone.PluckSynth.
 */
class AudioEngine {
  private voices: Voice[] = [];
  private reverb: Tone.Reverb | null = null;
  private limiter: Tone.Limiter | null = null;
  private started = false;
  private reverbEnabled = true;
  private nextVoiceIndex = 0;

  public isStarted(): boolean {
    return this.started;
  }

  /**
   * Must be invoked inside a direct user gesture (e.g. "Start" button click).
   */
  public async start(): Promise<void> {
    if (this.started) {
      if (Tone.getContext().state !== 'running') {
        await Tone.start();
      }
      return;
    }

    // Configure interactive low-latency Web Audio context before creating nodes.
    const lowLatencyContext = new Tone.Context({
      latencyHint: 'interactive',
      lookAhead: 0.01,
    });
    Tone.setContext(lowLatencyContext);
    await Tone.start();

    this.limiter = new Tone.Limiter(-1.5).toDestination();
    this.reverb = new Tone.Reverb({
      decay: 2.3,
      preDelay: 0.015,
      wet: this.reverbEnabled ? 0.28 : 0,
    }).connect(this.limiter);

    this.voices = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const gain = new Tone.Gain(0.7).connect(this.reverb);
      const synth = new Tone.PluckSynth({
        attackNoise: 1.2,
        dampening: 3800,
        resonance: 0.97,
        release: 1.4,
      }).connect(gain);

      this.voices.push({
        synth,
        gain,
        lastUsedMs: 0,
      });
    }

    this.started = true;
  }

  public setReverbEnabled(enabled: boolean): void {
    this.reverbEnabled = enabled;
    if (this.reverb) {
      this.reverb.wet.rampTo(enabled ? 0.28 : 0, 0.08);
    }
  }

  /**
   * Plucks a note/frequency with intensity ∈ [0, 1].
   * Intensity modulates output gain, attackNoise brightness, lowpass dampening, and resonance.
   */
  public pluck(noteOrFreq: string | number, intensity: number): void {
    if (!this.started || this.voices.length === 0) return;

    const clamped = Math.max(0.05, Math.min(1, intensity));
    const voice = this.acquireVoice();
    const now = Tone.now();

    // Gain curve: soft touches are audible and gentle; hard swipes ring out boldly
    const targetGain = 0.14 + 0.82 * clamped;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(targetGain, now);

    // Expressive Karplus-Strong timbral modulation
    voice.synth.attackNoise = 0.45 + 2.4 * clamped;
    voice.synth.dampening = 1900 + 4400 * clamped;
    voice.synth.resonance = 0.94 + 0.045 * clamped;

    voice.synth.triggerAttack(noteOrFreq, now);
    voice.lastUsedMs = performance.now();
  }

  public dispose(): void {
    for (const v of this.voices) {
      v.synth.dispose();
      v.gain.dispose();
    }
    this.voices = [];
    this.reverb?.dispose();
    this.reverb = null;
    this.limiter?.dispose();
    this.limiter = null;
    this.started = false;
  }

  private acquireVoice(): Voice {
    // Round-robin through the 16-voice pool so simultaneous chords never cut each other off
    const voice = this.voices[this.nextVoiceIndex];
    this.nextVoiceIndex = (this.nextVoiceIndex + 1) % this.voices.length;
    return voice;
  }
}

export const audioEngine = new AudioEngine();
