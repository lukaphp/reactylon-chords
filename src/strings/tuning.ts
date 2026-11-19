import type { Vec2 } from '../tracking/types';

export type RootNote =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

export type ScaleId =
  | 'minor_pentatonic'
  | 'major_pentatonic'
  | 'natural_minor'
  | 'major'
  | 'dorian'
  | 'hirajoshi'
  | 'chromatic';

export interface ScaleDefinition {
  id: ScaleId;
  label: string;
  intervals: readonly number[];
}

export const ROOT_NOTES: readonly RootNote[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

export const SCALES: Record<ScaleId, ScaleDefinition> = {
  minor_pentatonic: {
    id: 'minor_pentatonic',
    label: 'Pentatonica minore',
    intervals: [0, 3, 5, 7, 10],
  },
  major_pentatonic: {
    id: 'major_pentatonic',
    label: 'Pentatonica maggiore',
    intervals: [0, 2, 4, 7, 9],
  },
  natural_minor: {
    id: 'natural_minor',
    label: 'Minore naturale',
    intervals: [0, 2, 3, 5, 7, 8, 10],
  },
  major: {
    id: 'major',
    label: 'Maggiore (Ionica)',
    intervals: [0, 2, 4, 5, 7, 9, 11],
  },
  dorian: {
    id: 'dorian',
    label: 'Dorica',
    intervals: [0, 2, 3, 5, 7, 9, 10],
  },
  hirajoshi: {
    id: 'hirajoshi',
    label: 'Hirajoshi',
    intervals: [0, 2, 3, 7, 8],
  },
  chromatic: {
    id: 'chromatic',
    label: 'Cromatica',
    intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
};

export interface TuningConfig {
  rootNote: RootNote;
  scaleId: ScaleId;
  /** Lowest octave covered (e.g., 3 -> C3). */
  baseOctave: number;
  /** Number of octaves covered (e.g., 2 or 3). */
  octaves: number;
  /** Reference length in scene units corresponding to the midpoint pitch. */
  referenceLength: number;
}

export const DEFAULT_TUNING: TuningConfig = {
  rootNote: 'C',
  scaleId: 'minor_pentatonic',
  baseOctave: 3,
  octaves: 3,
  referenceLength: 0.95,
};

export interface PitchResult {
  midi: number;
  freq: number;
  note: string;
  /** Normalized pitch position 0 (lowest) -> 1 (highest) for visual color mapping. */
  normalizedPitch: number;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const noteIdx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${ROOT_NOTES[noteIdx]}${octave}`;
}

export function stringLength(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Physical string law: frequency ∝ 1 / L  =>  semitones = 12 * log2(L_ref / L).
 * Quantizes the resulting pitch onto the chosen scale within [baseOctave, baseOctave + octaves].
 */
export function lengthToPitch(length: number, config: TuningConfig): PitchResult {
  const safeL = Math.max(length, 0.05);
  const rootOffset = ROOT_NOTES.indexOf(config.rootNote);
  const scale = SCALES[config.scaleId];

  const minMidi = (config.baseOctave + 1) * 12 + rootOffset;
  const maxMidi = minMidi + config.octaves * 12;
  const refMidi = minMidi + (config.octaves * 12) / 2;

  const semitonesFromRef = 12 * Math.log2(config.referenceLength / safeL);
  const targetMidi = Math.min(maxMidi, Math.max(minMidi, refMidi + semitonesFromRef));

  // Build candidate MIDI notes inside the configured octave span & scale.
  let bestMidi = minMidi;
  let bestDist = Infinity;

  for (let oct = 0; oct <= config.octaves; oct++) {
    for (const interval of scale.intervals) {
      const candidate = minMidi + oct * 12 + interval;
      if (candidate > maxMidi) continue;
      const d = Math.abs(candidate - targetMidi);
      if (d < bestDist) {
        bestDist = d;
        bestMidi = candidate;
      }
    }
  }

  const span = Math.max(1, maxMidi - minMidi);
  return {
    midi: bestMidi,
    freq: midiToFreq(bestMidi),
    note: midiToNoteName(bestMidi),
    normalizedPitch: Math.min(1, Math.max(0, (bestMidi - minMidi) / span)),
  };
}
