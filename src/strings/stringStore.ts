import { create } from 'zustand';
import type { Vec2 } from '../tracking/types';
import {
  DEFAULT_TUNING,
  lengthToPitch,
  stringLength,
  type RootNote,
  type ScaleId,
  type TuningConfig,
} from './tuning';

export interface StringVibration {
  /** Current peak amplitude in world units. */
  amplitude: number;
  /** Elapsed time since last pluck (seconds). */
  elapsed: number;
  /** Visual angular frequency (rad/s), scaled from audio frequency for crisp visibility. */
  omega: number;
  /** Exponential decay constant (1/s). */
  decay: number;
  /** Last pluck intensity 0..1 (for brightness/glow flash). */
  intensity: number;
  /** Timestamp (performance.now()) of last pluck for cooldown gating. */
  lastPluckMs: number;
}

export interface AirString {
  id: string;
  anchorA: Vec2;
  anchorB: Vec2;
  midi: number;
  freq: number;
  note: string;
  normalizedPitch: number;
  selected: boolean;
  /** Mutated in-place inside Babylon render loop (no React re-renders). */
  vibration: StringVibration;
}

export type DeleteButtonMode = 'near_string' | 'top_bar';

export interface StringSettings {
  tuning: TuningConfig;
  showHandOverlay: boolean;
  allFingertips: boolean;
  deleteButtonMode: DeleteButtonMode;
  /** When true (default), strings can only be resized/edited after selecting them via long-press. */
  editRequiresSelection: boolean;
  previewSoundOnDrag: boolean;
  reverbEnabled: boolean;
  intensityCurve: number;
  minIntensity: number;
  filterMinCutoff: number;
  filterBeta: number;
}

interface StringStoreState {
  strings: AirString[];
  selectedId: string | null;
  settings: StringSettings;

  addString: (anchorA: Vec2, anchorB: Vec2) => AirString;
  removeString: (id: string) => void;
  clearStrings: () => void;
  selectString: (id: string | null) => void;
  /** Updates anchors & pitch in-place without triggering a React re-render (60fps safe). */
  updateStringAnchorsInPlace: (id: string, end: 'A' | 'B', pos: Vec2) => {
    noteChanged: boolean;
    note: string;
    freq: number;
  } | null;
  /** Triggers vibration in-place without triggering a React re-render. */
  triggerVibrationInPlace: (id: string, intensity: number, nowMs: number) => void;
  updateTuning: (partial: Partial<TuningConfig>) => void;
  updateSettings: (partial: Partial<Omit<StringSettings, 'tuning'>>) => void;
}

let nextStringSeq = 1;

function createIdleVibration(): StringVibration {
  return {
    amplitude: 0,
    elapsed: 0,
    omega: 36,
    decay: 3.4,
    intensity: 0,
    lastPluckMs: -Infinity,
  };
}

/**
 * Computes visual angular frequency ω tied to audio frequency, slowed down so
 * the standing wave reads clearly at 60 fps.
 */
function freqToVisualOmega(freqHz: number): number {
  const clamped = Math.max(80, Math.min(2000, freqHz));
  const norm = Math.log2(clamped / 80) / Math.log2(2000 / 80); // 0..1
  return 26 + norm * 38; // ~4 Hz to ~10 Hz visual oscillation
}

export const useStringStore = create<StringStoreState>((set, get) => ({
  strings: [],
  selectedId: null,
  settings: {
    tuning: { ...DEFAULT_TUNING },
    showHandOverlay: true,
    allFingertips: false,
    deleteButtonMode: 'near_string',
    editRequiresSelection: true,
    previewSoundOnDrag: true,
    reverbEnabled: true,
    intensityCurve: 0.65,
    minIntensity: 0.18,
    filterMinCutoff: 1.5,
    filterBeta: 0.08,
  },

  addString: (anchorA, anchorB) => {
    const tuning = get().settings.tuning;
    const len = stringLength(anchorA, anchorB);
    const pitch = lengthToPitch(len, tuning);
    const id = `str-${nextStringSeq++}`;

    const newString: AirString = {
      id,
      anchorA: { ...anchorA },
      anchorB: { ...anchorB },
      midi: pitch.midi,
      freq: pitch.freq,
      note: pitch.note,
      normalizedPitch: pitch.normalizedPitch,
      selected: false,
      vibration: createIdleVibration(),
    };

    set((state) => ({
      strings: [...state.strings, newString],
    }));
    return newString;
  },

  removeString: (id) => {
    set((state) => ({
      strings: state.strings.filter((s) => s.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    }));
  },

  clearStrings: () => {
    set({ strings: [], selectedId: null });
  },

  selectString: (id) => {
    if (get().selectedId === id) return;
    set((state) => ({
      selectedId: id,
      strings: state.strings.map((s) =>
        s.selected === (s.id === id) ? s : { ...s, selected: s.id === id },
      ),
    }));
  },

  updateStringAnchorsInPlace: (id, end, pos) => {
    const state = get();
    const target = state.strings.find((s) => s.id === id);
    if (!target) return null;

    if (end === 'A') {
      target.anchorA.x = pos.x;
      target.anchorA.y = pos.y;
    } else {
      target.anchorB.x = pos.x;
      target.anchorB.y = pos.y;
    }

    const len = stringLength(target.anchorA, target.anchorB);
    const pitch = lengthToPitch(len, state.settings.tuning);
    const noteChanged = pitch.note !== target.note;

    target.midi = pitch.midi;
    target.freq = pitch.freq;
    target.note = pitch.note;
    target.normalizedPitch = pitch.normalizedPitch;

    return { noteChanged, note: pitch.note, freq: pitch.freq };
  },

  triggerVibrationInPlace: (id, intensity, nowMs) => {
    const target = get().strings.find((s) => s.id === id);
    if (!target) return;

    const clamped = Math.max(0.05, Math.min(1, intensity));
    const len = stringLength(target.anchorA, target.anchorB);
    // Amplitude scales gently with string length & pluck intensity
    const maxAmp = Math.min(0.14, Math.max(0.045, len * 0.1));

    target.vibration.amplitude = maxAmp * (0.25 + 0.75 * clamped);
    target.vibration.elapsed = 0;
    target.vibration.omega = freqToVisualOmega(target.freq);
    target.vibration.decay = 2.6 + (1 - clamped) * 1.4;
    target.vibration.intensity = clamped;
    target.vibration.lastPluckMs = nowMs;
  },

  updateTuning: (partial) => {
    set((state) => {
      const nextTuning: TuningConfig = { ...state.settings.tuning, ...partial };
      // Re-tune existing strings immediately when scale or root changes
      const updatedStrings = state.strings.map((s) => {
        const len = stringLength(s.anchorA, s.anchorB);
        const pitch = lengthToPitch(len, nextTuning);
        s.midi = pitch.midi;
        s.freq = pitch.freq;
        s.note = pitch.note;
        s.normalizedPitch = pitch.normalizedPitch;
        return { ...s };
      });
      return {
        strings: updatedStrings,
        settings: { ...state.settings, tuning: nextTuning },
      };
    });
  },

  updateSettings: (partial) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }));
  },
}));

/**
 * Non-reactive transient interaction state updated every frame in Babylon's render loop
 * and read directly by render components without causing React re-renders.
 */
export interface CreationPreviewState {
  active: boolean;
  anchorA: Vec2;
  anchorB: Vec2;
  note: string;
  freq: number;
  isValid: boolean;
}

export interface TwoHandReadyVisualState {
  visible: boolean;
  position: Vec2;
  pinchingCount: number;
}

export interface LongPressVisualState {
  active: boolean;
  stringId: string | null;
  progress: number;
  position: Vec2;
}

export interface DeleteHoverVisualState {
  active: boolean;
  stringId: string | null;
  progress: number;
}

export interface HoveredHandleVisualState {
  stringId: string | null;
  end: 'A' | 'B' | null;
  grabbed: boolean;
}

export const transientState: {
  creationPreview: CreationPreviewState;
  twoHandReady: TwoHandReadyVisualState;
  longPress: LongPressVisualState;
  deleteHover: DeleteHoverVisualState;
  hoveredHandle: HoveredHandleVisualState;
  activeHandPinch: Record<number, boolean>;
} = {
  creationPreview: {
    active: false,
    anchorA: { x: 0, y: 0 },
    anchorB: { x: 0, y: 0 },
    note: '',
    freq: 0,
    isValid: false,
  },
  twoHandReady: {
    visible: false,
    position: { x: 0, y: 0 },
    pinchingCount: 0,
  },
  longPress: {
    active: false,
    stringId: null,
    progress: 0,
    position: { x: 0, y: 0 },
  },
  deleteHover: {
    active: false,
    stringId: null,
    progress: 0,
  },
  hoveredHandle: {
    stringId: null,
    end: null,
    grabbed: false,
  },
  activeHandPinch: {},
};

export function computeDeleteButtonPosition(
  str: AirString,
  mode: DeleteButtonMode,
  canvasAspect: number,
): Vec2 {
  if (mode === 'top_bar') {
    return { x: 0, y: 0.76 };
  }

  const midX = (str.anchorA.x + str.anchorB.x) * 0.5;
  const midY = (str.anchorA.y + str.anchorB.y) * 0.5;
  const dx = str.anchorB.x - str.anchorA.x;
  const dy = str.anchorB.y - str.anchorA.y;
  const len = Math.max(Math.hypot(dx, dy), 1e-4);

  // Unit perpendicular vector pointing generally upward (positive Y) when possible
  let nx = -dy / len;
  let ny = dx / len;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }

  const offset = 0.21;
  const marginX = Math.max(0.2, canvasAspect - 0.16);
  const marginY = 0.82;

  let bx = midX + nx * offset;
  let by = midY + ny * offset;

  // If too close to the top edge, flip to the opposite side of the string
  if (by > marginY) {
    bx = midX - nx * offset;
    by = midY - ny * offset;
  }

  return {
    x: Math.max(-marginX, Math.min(marginX, bx)),
    y: Math.max(-marginY, Math.min(marginY, by)),
  };
}

export type { RootNote, ScaleId };
