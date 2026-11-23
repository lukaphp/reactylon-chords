import type { Vec2 } from '../tracking/types';
import {
  ROOT_NOTES,
  SCALES,
  type TuningConfig,
} from './tuning';

export interface SavedStringSpec {
  anchorA: Vec2;
  anchorB: Vec2;
}

export interface StringPreset {
  id: string;
  name: string;
  createdAt: number;
  tuning: TuningConfig;
  strings: SavedStringSpec[];
}

export type GeneratorKind = 'harp_vertical' | 'harp_fan' | 'chord_voicing' | 'cascade';

const STORAGE_KEY = 'reactylon-chords-presets-v1';

/**
 * Computes the exact string length L that tunes to a target MIDI note under `lengthToPitch`.
 */
function midiToTargetLength(targetMidi: number, tuning: TuningConfig): number {
  const rootOffset = ROOT_NOTES.indexOf(tuning.rootNote);
  const minMidi = (tuning.baseOctave + 1) * 12 + rootOffset;
  const refMidi = minMidi + (tuning.octaves * 12) / 2;
  const semitonesFromRef = targetMidi - refMidi;
  const len = tuning.referenceLength / Math.pow(2, semitonesFromRef / 12);
  return Math.max(0.24, Math.min(1.62, len));
}

function getScaleMidiNotes(tuning: TuningConfig, count: number): number[] {
  const rootOffset = ROOT_NOTES.indexOf(tuning.rootNote);
  const scale = SCALES[tuning.scaleId];
  const minMidi = (tuning.baseOctave + 1) * 12 + rootOffset;
  const maxMidi = minMidi + tuning.octaves * 12;

  const all: number[] = [];
  for (let oct = 0; oct <= tuning.octaves; oct++) {
    for (const iv of scale.intervals) {
      const m = minMidi + oct * 12 + iv;
      if (m <= maxMidi) all.push(m);
    }
  }
  if (all.length <= count) return all;

  // Pick evenly distributed notes starting near the lower-middle register
  const start = Math.max(0, Math.floor((all.length - count) / 3));
  return all.slice(start, start + count);
}

/**
 * Generates ready-to-play string layouts tuned to the active scale.
 */
export function generateStringLayout(
  kind: GeneratorKind,
  count: number,
  tuning: TuningConfig,
): SavedStringSpec[] {
  const safeCount = Math.max(3, Math.min(10, count));

  if (kind === 'chord_voicing') {
    const scaleNotes = getScaleMidiNotes(tuning, Math.max(7, safeCount * 2));
    // Pick every second scale degree (triad / 7th / 9th chord stacked cleanly)
    const chordNotes: number[] = [];
    for (let i = 0; i < scaleNotes.length && chordNotes.length < Math.min(5, safeCount); i += 2) {
      chordNotes.push(scaleNotes[i]);
    }
    const n = chordNotes.length;
    return chordNotes.map((midi, i) => {
      const len = midiToTargetLength(midi, tuning);
      const y = -0.52 + (i / Math.max(1, n - 1)) * 1.04;
      const half = len * 0.5;
      return {
        anchorA: { x: -half, y },
        anchorB: { x: half, y },
      };
    });
  }

  const notes = getScaleMidiNotes(tuning, safeCount);
  const n = notes.length;

  if (kind === 'harp_fan') {
    return notes.map((midi, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const len = midiToTargetLength(midi, tuning);
      const xBase = -0.95 + t * 1.9;
      const angle = (0.5 - t) * 0.32; // subtle harp fan angle
      const half = len * 0.5;
      const dx = Math.sin(angle) * half;
      const dy = Math.cos(angle) * half;
      return {
        anchorA: { x: xBase - dx, y: -dy },
        anchorB: { x: xBase + dx, y: dy },
      };
    });
  }

  if (kind === 'cascade') {
    // Angled zigzag bounce platforms designed for the physical Ball Sequencer!
    return notes.slice(0, Math.min(6, n)).map((midi, i, arr) => {
      const len = Math.min(0.88, midiToTargetLength(midi, tuning));
      const t = i / Math.max(1, arr.length - 1);
      const dir = i % 2 === 0 ? 1 : -1;
      const cx = dir * -0.24;
      const cy = 0.42 - t * 0.96;
      const slope = dir * -0.24;
      const half = len * 0.5;
      const dx = Math.cos(slope) * half;
      const dy = Math.sin(slope) * half;
      return {
        anchorA: { x: cx - dx, y: cy - dy },
        anchorB: { x: cx + dx, y: cy + dy },
      };
    });
  }

  // Default: vertical parallel harp
  return notes.map((midi, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const len = midiToTargetLength(midi, tuning);
    const x = -0.95 + t * 1.9;
    const half = len * 0.5;
    return {
      anchorA: { x, y: -half },
      anchorB: { x, y: half },
    };
  });
}

export function loadSavedPresets(): StringPreset[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        Array.isArray(p.strings),
    );
  } catch {
    return [];
  }
}

export function persistPresets(presets: StringPreset[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Ignore storage quota errors gracefully
  }
}

export function exportPresetJson(preset: StringPreset): string {
  return JSON.stringify(preset, null, 2);
}

export function parsePresetJson(raw: string): StringPreset | null {
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.strings) || !data.tuning) return null;
    const validStrings: SavedStringSpec[] = [];
    for (const s of data.strings) {
      if (
        s?.anchorA &&
        s?.anchorB &&
        typeof s.anchorA.x === 'number' &&
        typeof s.anchorA.y === 'number' &&
        typeof s.anchorB.x === 'number' &&
        typeof s.anchorB.y === 'number'
      ) {
        validStrings.push({
          anchorA: { x: s.anchorA.x, y: s.anchorA.y },
          anchorB: { x: s.anchorB.x, y: s.anchorB.y },
        });
      }
    }
    return {
      id: typeof data.id === 'string' ? data.id : `preset-${Date.now()}`,
      name: typeof data.name === 'string' ? data.name : 'Preset importato',
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      tuning: data.tuning,
      strings: validStrings,
    };
  } catch {
    return null;
  }
}
