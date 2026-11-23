import * as Tone from 'tone';

export type SoundPresetId =
  | 'harp'
  | 'koto'
  | 'bass'
  | 'kalimba'
  | 'pad'
  | 'laser';

export interface SoundPresetDefinition {
  id: SoundPresetId;
  label: string;
  engine: 'pluck' | 'fm' | 'am' | 'laser';
}

export const SOUND_PRESETS: Record<SoundPresetId, SoundPresetDefinition> = {
  harp: { id: 'harp', label: 'Arpa Nylon (Karplus)', engine: 'pluck' },
  koto: { id: 'koto', label: 'Koto Brillante', engine: 'pluck' },
  bass: { id: 'bass', label: 'Basso Acustico', engine: 'pluck' },
  kalimba: { id: 'kalimba', label: 'Kalimba / Campane FM', engine: 'fm' },
  pad: { id: 'pad', label: 'Pad Celestiale AM', engine: 'am' },
  laser: { id: 'laser', label: 'Laser Synth', engine: 'laser' },
};

export interface PluckAudioOptions {
  /** Stereo pan [-1 left .. +1 right] derived from string X position. */
  pan?: number;
  /** Touch point along the string [0..1]: center = warm, edges = bright. */
  s?: number;
  /** String ID for selective Palm Mute damping. */
  stringId?: string;
  /** Optional natural harmonic mode when touching exact midpoint. */
  harmonicsEnabled?: boolean;
}

interface PluckVoice {
  synth: Tone.PluckSynth;
  gain: Tone.Gain;
  panner: Tone.Panner;
  ownerStringId: string | null;
}

interface SynthVoice {
  fm: Tone.FMSynth;
  am: Tone.AMSynth;
  laser: Tone.MonoSynth;
  gain: Tone.Gain;
  panner: Tone.Panner;
  ownerStringId: string | null;
}

const PLUCK_POOL_SIZE = 16;
const SYNTH_POOL_SIZE = 10;

/**
 * Low-latency polyphonic audio engine:
 * - Multiple sound presets (Karplus-Strong Pluck + FM Kalimba + AM Pad + Laser MonoSynth)
 * - Per-voice stereo panning tied to string X position
 * - Touch-point timbre (sul ponticello / sul tasto / optional center harmonic)
 * - Master FX rack: Filter (expression-modulated) -> Chorus -> PingPongDelay -> Reverb (+ Shimmer) -> Limiter
 * - Per-string Palm Mute damping + Mute Internal Audio for pure Web MIDI mode
 */
class AudioEngine {
  private pluckVoices: PluckVoice[] = [];
  private synthVoices: SynthVoice[] = [];
  private masterFilter: Tone.Filter | null = null;
  private chorus: Tone.Chorus | null = null;
  private delay: Tone.PingPongDelay | null = null;
  private reverb: Tone.Reverb | null = null;
  private shimmerShift: Tone.PitchShift | null = null;
  private shimmerGain: Tone.Gain | null = null;
  private limiter: Tone.Limiter | null = null;

  private started = false;
  private nextPluckIdx = 0;
  private nextSynthIdx = 0;

  private preset: SoundPresetId = 'harp';
  private reverbEnabled = true;
  private delayEnabled = false;
  private chorusEnabled = false;
  private shimmerEnabled = false;
  private stereoPanEnabled = true;
  private internalMuted = false;
  private expressionAmount = 0; // 0..1 from expressive hand

  public isStarted(): boolean {
    return this.started;
  }

  public async start(): Promise<void> {
    if (this.started) {
      if (Tone.getContext().state !== 'running') {
        await Tone.start();
      }
      return;
    }

    const lowLatencyContext = new Tone.Context({
      latencyHint: 'interactive',
      lookAhead: 0.01,
    });
    Tone.setContext(lowLatencyContext);
    await Tone.start();

    this.limiter = new Tone.Limiter(-1.5).toDestination();
    this.reverb = new Tone.Reverb({
      decay: 2.6,
      preDelay: 0.015,
      wet: this.reverbEnabled ? 0.28 : 0,
    }).connect(this.limiter);

    // Parallel shimmer (+12 semitones octave bloom into reverb)
    this.shimmerGain = new Tone.Gain(this.shimmerEnabled ? 0.28 : 0).connect(this.reverb);
    this.shimmerShift = new Tone.PitchShift({ pitch: 12, windowSize: 0.08 }).connect(
      this.shimmerGain,
    );

    this.delay = new Tone.PingPongDelay({
      delayTime: '8n.',
      feedback: 0.34,
      wet: this.delayEnabled ? 0.26 : 0,
    }).connect(this.reverb);
    this.delay.connect(this.shimmerShift);

    this.chorus = new Tone.Chorus({
      frequency: 2.2,
      delayTime: 3.5,
      depth: 0.6,
      wet: this.chorusEnabled ? 0.35 : 0,
    })
      .start()
      .connect(this.delay);

    this.masterFilter = new Tone.Filter({
      type: 'lowpass',
      frequency: 9500,
      Q: 1.0,
    }).connect(this.chorus);

    // 16-voice Karplus-Strong PluckSynth pool
    this.pluckVoices = [];
    for (let i = 0; i < PLUCK_POOL_SIZE; i++) {
      const panner = new Tone.Panner(0).connect(this.masterFilter);
      const gain = new Tone.Gain(0.75).connect(panner);
      const synth = new Tone.PluckSynth({
        attackNoise: 1.2,
        dampening: 3800,
        resonance: 0.97,
        release: 1.4,
      }).connect(gain);
      this.pluckVoices.push({ synth, gain, panner, ownerStringId: null });
    }

    // 10-voice multi-engine synth pool (FM / AM / Laser)
    this.synthVoices = [];
    for (let i = 0; i < SYNTH_POOL_SIZE; i++) {
      const panner = new Tone.Panner(0).connect(this.masterFilter);
      const gain = new Tone.Gain(0.55).connect(panner);

      const fm = new Tone.FMSynth({
        harmonicity: 3.01,
        modulationIndex: 7,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 0.9, sustain: 0.05, release: 1.4 },
        modulation: { type: 'triangle' },
        modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3 },
      }).connect(gain);

      const am = new Tone.AMSynth({
        harmonicity: 2,
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.09, decay: 0.6, sustain: 0.45, release: 1.9 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.25, decay: 0.4, sustain: 0.6, release: 1.6 },
      }).connect(gain);

      const laser = new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { Q: 4, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.004, decay: 0.45, sustain: 0.12, release: 0.8 },
        filterEnvelope: {
          attack: 0.004,
          decay: 0.32,
          sustain: 0.15,
          release: 0.6,
          baseFrequency: 280,
          octaves: 3.8,
        },
      }).connect(gain);

      this.synthVoices.push({ fm, am, laser, gain, panner, ownerStringId: null });
    }

    this.started = true;
    this.applyExpression();
  }

  public setPreset(preset: SoundPresetId): void {
    this.preset = preset;
  }

  public setInternalMuted(muted: boolean): void {
    this.internalMuted = muted;
  }

  public setStereoPanEnabled(enabled: boolean): void {
    this.stereoPanEnabled = enabled;
  }

  public setReverbEnabled(enabled: boolean): void {
    this.reverbEnabled = enabled;
    this.applyExpression();
  }

  public setDelayEnabled(enabled: boolean): void {
    this.delayEnabled = enabled;
    if (this.delay) {
      this.delay.wet.rampTo(enabled ? 0.28 : 0, 0.08);
    }
  }

  public setChorusEnabled(enabled: boolean): void {
    this.chorusEnabled = enabled;
    if (this.chorus) {
      this.chorus.wet.rampTo(enabled ? 0.36 : 0, 0.08);
    }
  }

  public setShimmerEnabled(enabled: boolean): void {
    this.shimmerEnabled = enabled;
    this.applyExpression();
  }

  /**
   * Real-time expression modulation [0..1] from the open expressive hand:
   * Opens filter brightness and swells reverb/shimmer atmospherics.
   */
  public setExpression(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (Math.abs(clamped - this.expressionAmount) < 0.01) return;
    this.expressionAmount = clamped;
    this.applyExpression();
  }

  private applyExpression(): void {
    if (!this.started) return;
    const expr = this.expressionAmount;
    if (this.masterFilter) {
      // Base 8.5kHz -> opens up to 16kHz with slight resonant sheen
      this.masterFilter.frequency.rampTo(7500 + expr * 8500, 0.06);
      this.masterFilter.Q.rampTo(0.9 + expr * 2.4, 0.06);
    }
    if (this.reverb) {
      const baseWet = this.reverbEnabled ? 0.28 : 0;
      const wet = Math.min(0.82, baseWet + expr * 0.42);
      this.reverb.wet.rampTo(wet, 0.08);
    }
    if (this.shimmerGain) {
      const baseShimmer = this.shimmerEnabled ? 0.3 : 0;
      const level = Math.min(0.65, baseShimmer + expr * 0.32);
      this.shimmerGain.gain.rampTo(level, 0.08);
    }
  }

  /**
   * Plucks a note/frequency with intensity ∈ [0, 1], optional stereo pan & touch point s ∈ [0, 1].
   */
  public pluck(
    noteOrFreq: string | number,
    intensity: number,
    options: PluckAudioOptions = {},
  ): void {
    if (!this.started || this.internalMuted) return;

    const clamped = Math.max(0.05, Math.min(1, intensity));
    const pan = this.stereoPanEnabled
      ? Math.max(-0.85, Math.min(0.85, options.pan ?? 0))
      : 0;
    const s = options.s ?? 0.5;
    // Edge proximity: 0 at string center (sul tasto = warm), 1 near anchor (sul ponticello = bright)
    const edgeFactor = Math.min(1, Math.abs(s - 0.5) * 2);

    // Optional natural harmonic at exact center (|s - 0.5| < 0.055)
    let playFreq: string | number = noteOrFreq;
    let isHarmonic = false;
    if (
      options.harmonicsEnabled &&
      typeof noteOrFreq === 'number' &&
      Math.abs(s - 0.5) < 0.055
    ) {
      playFreq = noteOrFreq * 2;
      isHarmonic = true;
    }

    const now = Tone.now();
    const def = SOUND_PRESETS[this.preset];

    if (def.engine === 'pluck') {
      const voice = this.pluckVoices[this.nextPluckIdx];
      this.nextPluckIdx = (this.nextPluckIdx + 1) % this.pluckVoices.length;
      voice.ownerStringId = options.stringId ?? null;

      voice.panner.pan.setValueAtTime(pan, now);
      const targetGain = 0.16 + 0.8 * clamped;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(targetGain, now);

      if (this.preset === 'koto') {
        voice.synth.attackNoise = 1.4 + 3.2 * clamped + edgeFactor * 1.4;
        voice.synth.dampening = 3200 + 3400 * clamped + edgeFactor * 1200;
        voice.synth.resonance = 0.92 + 0.045 * clamped;
      } else if (this.preset === 'bass') {
        const bassFreq = typeof playFreq === 'number' ? playFreq * 0.5 : playFreq;
        playFreq = bassFreq;
        voice.synth.attackNoise = 0.4 + 1.2 * clamped + edgeFactor * 0.5;
        voice.synth.dampening = 900 + 1800 * clamped + edgeFactor * 700;
        voice.synth.resonance = 0.96 + 0.032 * clamped;
      } else {
        // Harp nylon (default)
        voice.synth.attackNoise = 0.45 + 2.2 * clamped + edgeFactor * 0.9;
        voice.synth.dampening =
          (isHarmonic ? 4600 : 1800) + 3800 * clamped + edgeFactor * 1400;
        voice.synth.resonance = 0.945 + 0.042 * clamped;
      }

      voice.synth.triggerAttack(playFreq, now);
      return;
    }

    // Synth pool voices (FM Kalimba / AM Pad / Laser)
    const voice = this.synthVoices[this.nextSynthIdx];
    this.nextSynthIdx = (this.nextSynthIdx + 1) % this.synthVoices.length;
    voice.ownerStringId = options.stringId ?? null;

    voice.panner.pan.setValueAtTime(pan, now);
    const targetGain = 0.12 + 0.55 * clamped;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(targetGain, now);

    if (def.engine === 'fm') {
      voice.fm.modulationIndex.setValueAtTime(
        3 + clamped * 10 + edgeFactor * 6,
        now,
      );
      voice.fm.harmonicity.setValueAtTime(isHarmonic ? 4 : 3.01, now);
      voice.fm.triggerAttackRelease(playFreq, 0.35 + clamped * 0.45, now, clamped);
    } else if (def.engine === 'am') {
      voice.am.harmonicity.setValueAtTime(1.5 + edgeFactor * 1.5, now);
      voice.am.triggerAttackRelease(playFreq, 0.9 + clamped * 0.8, now, clamped);
    } else {
      voice.laser.filterEnvelope.baseFrequency = 220 + edgeFactor * 520;
      voice.laser.triggerAttackRelease(playFreq, 0.25 + clamped * 0.35, now, clamped);
    }
  }

  /**
   * Palm Mute: immediately damps any active voice owned by the given stringId.
   */
  public muteString(stringId: string): void {
    if (!this.started) return;
    const now = Tone.now();

    for (const v of this.pluckVoices) {
      if (v.ownerStringId === stringId) {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0.0001, now, 0.012);
        v.ownerStringId = null;
      }
    }

    for (const v of this.synthVoices) {
      if (v.ownerStringId === stringId) {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0.0001, now, 0.015);
        v.fm.triggerRelease(now);
        v.am.triggerRelease(now);
        v.laser.triggerRelease(now);
        v.ownerStringId = null;
      }
    }
  }

  public dispose(): void {
    for (const v of this.pluckVoices) {
      v.synth.dispose();
      v.gain.dispose();
      v.panner.dispose();
    }
    for (const v of this.synthVoices) {
      v.fm.dispose();
      v.am.dispose();
      v.laser.dispose();
      v.gain.dispose();
      v.panner.dispose();
    }
    this.pluckVoices = [];
    this.synthVoices = [];
    this.masterFilter?.dispose();
    this.chorus?.dispose();
    this.delay?.dispose();
    this.shimmerShift?.dispose();
    this.shimmerGain?.dispose();
    this.reverb?.dispose();
    this.limiter?.dispose();
    this.masterFilter = null;
    this.chorus = null;
    this.delay = null;
    this.shimmerShift = null;
    this.shimmerGain = null;
    this.reverb = null;
    this.limiter = null;
    this.started = false;
  }
}

export const audioEngine = new AudioEngine();
