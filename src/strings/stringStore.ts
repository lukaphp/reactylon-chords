import { create } from 'zustand';
import type { Vec2 } from '../tracking/types';
import type { SoundPresetId } from '../audio/audioEngine';
import type { SnapAxis } from '../gestures/stringCreator';
import type { LooperMode } from '../creative/looper';
import {
  DEFAULT_TUNING,
  lengthToPitch,
  stringLength,
  type RootNote,
  type ScaleId,
  type TuningConfig,
} from './tuning';
import {
  loadSavedPresets,
  persistPresets,
  type SavedStringSpec,
  type StringPreset,
} from './presets';

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
  // Audio & FX
  soundPreset: SoundPresetId;
  reverbEnabled: boolean;
  delayEnabled: boolean;
  chorusEnabled: boolean;
  shimmerEnabled: boolean;
  stereoPanEnabled: boolean;
  harmonicsEnabled: boolean;
  previewSoundOnDrag: boolean;
  // Web MIDI
  midiEnabled: boolean;
  midiPortId: string | null;
  midiChannel: number;
  midiGateMs: number;
  midiSendCC74: boolean;
  internalAudioMuted: boolean;
  // Gestures & Editing
  editRequiresSelection: boolean;
  snapEnabled: boolean;
  palmMuteEnabled: boolean;
  expressionHandEnabled: boolean;
  allFingertips: boolean;
  deleteButtonMode: DeleteButtonMode;
  intensityCurve: number;
  minIntensity: number;
  filterMinCutoff: number;
  filterBeta: number;
  // Creative modes
  ballSequencerEnabled: boolean;
  ballBpm: number;
  ballGravity: number;
  ballRestitution: number;
  ballEmitterX: number;
  ballEmitterY: number;
  looperBpm: number;
  looperBars: 2 | 4;
  looperQuantize: boolean;
  // Visual & Stage Mode
  showHandOverlay: boolean;
  webcamOpacity: number;
  particlesEnabled: boolean;
  fingerTrailsEnabled: boolean;
}

interface StringStoreState {
  strings: AirString[];
  selectedId: string | null;
  presets: StringPreset[];
  settings: StringSettings;

  addString: (anchorA: Vec2, anchorB: Vec2) => AirString;
  removeString: (id: string) => void;
  clearStrings: () => void;
  selectString: (id: string | null) => void;
  loadStringSpecs: (specs: readonly SavedStringSpec[], tuning?: TuningConfig) => void;

  /** Updates one anchor & pitch in-place without triggering a React re-render (60fps safe). */
  updateStringAnchorsInPlace: (id: string, end: 'A' | 'B', pos: Vec2) => {
    noteChanged: boolean;
    note: string;
    freq: number;
  } | null;
  /** Translates both anchors in-place preserving exact length & pitch (zero React re-renders). */
  translateStringInPlace: (id: string, anchorA: Vec2, anchorB: Vec2) => void;
  /** Triggers vibration in-place without triggering a React re-render. */
  triggerVibrationInPlace: (id: string, intensity: number, nowMs: number) => void;
  /** Immediately damps visual vibration (Palm Mute). */
  dampVibrationInPlace: (id: string) => void;

  updateTuning: (partial: Partial<TuningConfig>) => void;
  updateSettings: (partial: Partial<Omit<StringSettings, 'tuning'>>) => void;

  saveCurrentPreset: (name: string) => StringPreset;
  loadPresetById: (id: string) => boolean;
  deletePreset: (id: string) => void;
  importPreset: (preset: StringPreset) => void;
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

function freqToVisualOmega(freqHz: number): number {
  const clamped = Math.max(80, Math.min(2000, freqHz));
  const norm = Math.log2(clamped / 80) / Math.log2(2000 / 80);
  return 26 + norm * 38;
}

function buildAirString(anchorA: Vec2, anchorB: Vec2, tuning: TuningConfig): AirString {
  const len = stringLength(anchorA, anchorB);
  const pitch = lengthToPitch(len, tuning);
  return {
    id: `str-${nextStringSeq++}`,
    anchorA: { x: anchorA.x, y: anchorA.y },
    anchorB: { x: anchorB.x, y: anchorB.y },
    midi: pitch.midi,
    freq: pitch.freq,
    note: pitch.note,
    normalizedPitch: pitch.normalizedPitch,
    selected: false,
    vibration: createIdleVibration(),
  };
}

export const useStringStore = create<StringStoreState>((set, get) => ({
  strings: [],
  selectedId: null,
  presets: typeof window !== 'undefined' ? loadSavedPresets() : [],
  settings: {
    tuning: { ...DEFAULT_TUNING },
    soundPreset: 'harp',
    reverbEnabled: true,
    delayEnabled: false,
    chorusEnabled: false,
    shimmerEnabled: false,
    stereoPanEnabled: true,
    harmonicsEnabled: false,
    previewSoundOnDrag: true,
    midiEnabled: false,
    midiPortId: null,
    midiChannel: 1,
    midiGateMs: 650,
    midiSendCC74: true,
    internalAudioMuted: false,
    editRequiresSelection: true,
    snapEnabled: true,
    palmMuteEnabled: true,
    expressionHandEnabled: true,
    allFingertips: false,
    deleteButtonMode: 'near_string',
    intensityCurve: 0.65,
    minIntensity: 0.18,
    filterMinCutoff: 1.5,
    filterBeta: 0.08,
    ballSequencerEnabled: false,
    ballBpm: 110,
    ballGravity: 1.6,
    ballRestitution: 0.88,
    ballEmitterX: 0,
    ballEmitterY: 0.78,
    looperBpm: 110,
    looperBars: 2,
    looperQuantize: true,
    showHandOverlay: true,
    webcamOpacity: 0.85,
    particlesEnabled: true,
    fingerTrailsEnabled: true,
  },

  addString: (anchorA, anchorB) => {
    const tuning = get().settings.tuning;
    const newString = buildAirString(anchorA, anchorB, tuning);
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

  loadStringSpecs: (specs, tuningOverride) => {
    set((state) => {
      const nextTuning = tuningOverride
        ? { ...state.settings.tuning, ...tuningOverride }
        : state.settings.tuning;
      const nextStrings = specs.map((spec) =>
        buildAirString(spec.anchorA, spec.anchorB, nextTuning),
      );
      return {
        strings: nextStrings,
        selectedId: null,
        settings: { ...state.settings, tuning: nextTuning },
      };
    });
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

  translateStringInPlace: (id, anchorA, anchorB) => {
    const target = get().strings.find((s) => s.id === id);
    if (!target) return;
    target.anchorA.x = anchorA.x;
    target.anchorA.y = anchorA.y;
    target.anchorB.x = anchorB.x;
    target.anchorB.y = anchorB.y;
  },

  triggerVibrationInPlace: (id, intensity, nowMs) => {
    const target = get().strings.find((s) => s.id === id);
    if (!target) return;

    const clamped = Math.max(0.05, Math.min(1, intensity));
    const len = stringLength(target.anchorA, target.anchorB);
    const maxAmp = Math.min(0.14, Math.max(0.045, len * 0.1));

    target.vibration.amplitude = maxAmp * (0.25 + 0.75 * clamped);
    target.vibration.elapsed = 0;
    target.vibration.omega = freqToVisualOmega(target.freq);
    target.vibration.decay = 2.6 + (1 - clamped) * 1.4;
    target.vibration.intensity = clamped;
    target.vibration.lastPluckMs = nowMs;
  },

  dampVibrationInPlace: (id) => {
    const target = get().strings.find((s) => s.id === id);
    if (!target) return;
    target.vibration.amplitude *= 0.18;
    if (target.vibration.amplitude < 0.002) {
      target.vibration.amplitude = 0;
    }
    target.vibration.intensity = 0;
  },

  updateTuning: (partial) => {
    set((state) => {
      const nextTuning: TuningConfig = { ...state.settings.tuning, ...partial };
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

  saveCurrentPreset: (name) => {
    const state = get();
    const trimmed = name.trim() || `Set ${state.presets.length + 1}`;
    const preset: StringPreset = {
      id: `preset-${Date.now()}`,
      name: trimmed,
      createdAt: Date.now(),
      tuning: { ...state.settings.tuning },
      strings: state.strings.map((s) => ({
        anchorA: { x: s.anchorA.x, y: s.anchorA.y },
        anchorB: { x: s.anchorB.x, y: s.anchorB.y },
      })),
    };
    const nextPresets = [...state.presets, preset].slice(-9);
    persistPresets(nextPresets);
    set({ presets: nextPresets });
    return preset;
  },

  loadPresetById: (id) => {
    const preset = get().presets.find((p) => p.id === id);
    if (!preset) return false;
    get().loadStringSpecs(preset.strings, preset.tuning);
    return true;
  },

  deletePreset: (id) => {
    const nextPresets = get().presets.filter((p) => p.id !== id);
    persistPresets(nextPresets);
    set({ presets: nextPresets });
  },

  importPreset: (preset) => {
    const nextPresets = [...get().presets, preset].slice(-9);
    persistPresets(nextPresets);
    set({ presets: nextPresets });
    get().loadStringSpecs(preset.strings, preset.tuning);
  },
}));

/**
 * Non-reactive transient interaction & creative state updated every frame in Babylon's render loop
 * and read directly by render components without causing React re-renders.
 */
export interface CreationPreviewState {
  active: boolean;
  anchorA: Vec2;
  anchorB: Vec2;
  note: string;
  freq: number;
  isValid: boolean;
  snappedAxis: SnapAxis;
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
  end: 'A' | 'B' | 'body' | null;
  grabbed: boolean;
}

export interface ImpactBurstEvent {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
}

export interface BallVisualSnapshot {
  x: number;
  y: number;
  radius: number;
}

export const transientState: {
  creationPreview: CreationPreviewState;
  twoHandReady: TwoHandReadyVisualState;
  longPress: LongPressVisualState;
  deleteHover: DeleteHoverVisualState;
  hoveredHandle: HoveredHandleVisualState;
  activeHandPinch: Record<number, boolean>;
  pendingImpacts: ImpactBurstEvent[];
  expression: { active: boolean; value: number };
  balls: BallVisualSnapshot[];
  looper: {
    mode: LooperMode;
    eventCount: number;
    progress: number;
    currentBeat: number;
    totalBeats: number;
  };
  /** Imperative command bridge from HUD buttons -> render-loop controllers. */
  commands: {
    looperAction: null | 'record' | 'overdub' | 'play_toggle' | 'stop' | 'clear';
    ballSpawnNow: boolean;
    ballClear: boolean;
  };
} = {
  creationPreview: {
    active: false,
    anchorA: { x: 0, y: 0 },
    anchorB: { x: 0, y: 0 },
    note: '',
    freq: 0,
    isValid: false,
    snappedAxis: null,
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
  pendingImpacts: [],
  expression: { active: false, value: 0 },
  balls: [],
  looper: {
    mode: 'idle',
    eventCount: 0,
    progress: 0,
    currentBeat: 0,
    totalBeats: 8,
  },
  commands: {
    looperAction: null,
    ballSpawnNow: false,
    ballClear: false,
  },
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

  if (by > marginY) {
    bx = midX - nx * offset;
    by = midY - ny * offset;
  }

  return {
    x: Math.max(-marginX, Math.min(marginX, bx)),
    y: Math.max(-marginY, Math.min(marginY, by)),
  };
}

export type { RootNote, ScaleId, SoundPresetId, StringPreset };
