export type LooperMode = 'idle' | 'recording' | 'playing' | 'overdubbing';

export interface LoopedPluckEvent {
  /** Normalized position inside the loop cycle [0, 1). */
  phase: number;
  stringId: string;
  midi: number;
  freq: number;
  intensity: number;
  s: number;
  pan: number;
}

export interface LooperSnapshot {
  mode: LooperMode;
  eventCount: number;
  /** Playhead progress [0..1) inside the loop. */
  progress: number;
  /** Current beat index (0 .. totalBeats - 1). */
  currentBeat: number;
  totalBeats: number;
}

/**
 * Multi-bar Audio/MIDI Event Looper:
 * Records string plucks (including stringId, pitch, intensity, touch position s, stereo pan)
 * and replays them accurately on a BPM-synced cycle.
 */
export class EventLooper {
  private mode: LooperMode = 'idle';
  private events: LoopedPluckEvent[] = [];
  private cycleStartMs = 0;
  private prevPhase = 0;
  private currentPhase = 0;

  public getMode(): LooperMode {
    return this.mode;
  }

  public getEventCount(): number {
    return this.events.length;
  }

  public getProgress(): number {
    return this.currentPhase;
  }

  public startRecording(nowMs: number, keepExisting = false): void {
    if (!keepExisting) {
      this.events = [];
      this.cycleStartMs = nowMs;
      this.prevPhase = 0;
      this.currentPhase = 0;
      this.mode = 'recording';
    } else {
      if (this.mode === 'idle') {
        this.cycleStartMs = nowMs;
        this.prevPhase = 0;
        this.currentPhase = 0;
      }
      this.mode = 'overdubbing';
    }
  }

  public stopRecordingOrPlay(): void {
    if (this.mode === 'recording' || this.mode === 'overdubbing') {
      this.mode = this.events.length > 0 ? 'playing' : 'idle';
    } else if (this.mode === 'playing') {
      this.mode = 'idle';
    }
  }

  public togglePlay(nowMs: number): void {
    if (this.mode === 'playing') {
      this.mode = 'idle';
    } else if (this.events.length > 0) {
      this.cycleStartMs = nowMs;
      this.prevPhase = 0;
      this.currentPhase = 0;
      this.mode = 'playing';
    }
  }

  public clear(): void {
    this.events = [];
    this.mode = 'idle';
    this.prevPhase = 0;
    this.currentPhase = 0;
  }

  public recordEvent(
    event: Omit<LoopedPluckEvent, 'phase'>,
    nowMs: number,
    bpm: number,
    bars: number,
    quantizeSixteenth: boolean,
  ): void {
    if (this.mode !== 'recording' && this.mode !== 'overdubbing') return;

    const totalBeats = bars * 4;
    const cycleMs = (60_000 / Math.max(40, bpm)) * totalBeats;
    let phase = ((nowMs - this.cycleStartMs) % cycleMs) / cycleMs;
    if (phase < 0) phase += 1;

    if (quantizeSixteenth) {
      const steps = totalBeats * 4; // 16th-note grid
      phase = (Math.round(phase * steps) % steps) / steps;
    }

    this.events.push({ ...event, phase });
  }

  /**
   * Advances playhead and returns any recorded events due to fire on this frame.
   */
  public step(
    nowMs: number,
    bpm: number,
    bars: number,
  ): { dueEvents: LoopedPluckEvent[]; snapshot: LooperSnapshot } {
    const totalBeats = bars * 4;

    if (this.mode === 'idle') {
      return {
        dueEvents: [],
        snapshot: {
          mode: this.mode,
          eventCount: this.events.length,
          progress: 0,
          currentBeat: 0,
          totalBeats,
        },
      };
    }

    const cycleMs = (60_000 / Math.max(40, bpm)) * totalBeats;
    const elapsed = nowMs - this.cycleStartMs;
    const nextPhase = ((elapsed % cycleMs) + cycleMs) % cycleMs / cycleMs;

    const dueEvents: LoopedPluckEvent[] = [];

    // Auto-switch from initial first-pass recording -> playing when first bar cycle wraps
    const wrapped = nextPhase < this.prevPhase;
    if (wrapped && this.mode === 'recording') {
      this.mode = this.events.length > 0 ? 'playing' : 'recording';
    }

    if (this.mode === 'playing' || this.mode === 'overdubbing') {
      for (let i = 0; i < this.events.length; i++) {
        const ev = this.events[i];
        const hit = wrapped
          ? ev.phase >= this.prevPhase || ev.phase < nextPhase
          : ev.phase >= this.prevPhase && ev.phase < nextPhase;
        if (hit) {
          dueEvents.push(ev);
        }
      }
    }

    this.prevPhase = nextPhase;
    this.currentPhase = nextPhase;

    return {
      dueEvents,
      snapshot: {
        mode: this.mode,
        eventCount: this.events.length,
        progress: nextPhase,
        currentBeat: Math.floor(nextPhase * totalBeats),
        totalBeats,
      },
    };
  }
}
