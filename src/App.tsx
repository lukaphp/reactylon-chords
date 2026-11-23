import { useEffect, useRef, useState } from 'react';
import { HandTracker } from './tracking/HandTracker';
import {
  audioEngine,
  SOUND_PRESETS,
  type SoundPresetId,
} from './audio/audioEngine';
import { midiEngine, type MidiOutputInfo } from './audio/midiEngine';
import {
  ROOT_NOTES,
  SCALES,
  type RootNote,
  type ScaleId,
} from './strings/tuning';
import {
  exportPresetJson,
  generateStringLayout,
  parsePresetJson,
  type GeneratorKind,
} from './strings/presets';
import {
  transientState,
  useStringStore,
  type DeleteButtonMode,
} from './strings/stringStore';
import { AirScene } from './render/Scene';

type AppStatus = 'idle' | 'starting' | 'running' | 'error';
type SettingsTab = 'sound' | 'midi' | 'creative' | 'gestures';

export function App() {
  const trackerRef = useRef<HandTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new HandTracker();
  }
  const tracker = trackerRef.current;

  const [status, setStatus] = useState<AppStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('sound');
  const [looperBarOpen, setLooperBarOpen] = useState(false);

  // Web MIDI ports state
  const [midiPorts, setMidiPorts] = useState<MidiOutputInfo[]>([]);
  const [midiSupported, setMidiSupported] = useState(true);
  const [midiError, setMidiError] = useState<string | null>(null);

  // Preset save UI state
  const [presetName, setPresetName] = useState('');
  const [presetFeedback, setPresetFeedback] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Low-frequency HUD sync for looper beat indicator (12 Hz only when looper bar visible)
  const [looperHud, setLooperHud] = useState({
    mode: 'idle' as 'idle' | 'recording' | 'playing' | 'overdubbing',
    eventCount: 0,
    currentBeat: 0,
    totalBeats: 8,
  });

  const stringCount = useStringStore((s) => s.strings.length);
  const selectedId = useStringStore((s) => s.selectedId);
  const presets = useStringStore((s) => s.presets);
  const settings = useStringStore((s) => s.settings);

  const updateTuning = useStringStore((s) => s.updateTuning);
  const updateSettings = useStringStore((s) => s.updateSettings);
  const loadStringSpecs = useStringStore((s) => s.loadStringSpecs);
  const clearStrings = useStringStore((s) => s.clearStrings);
  const selectString = useStringStore((s) => s.selectString);
  const saveCurrentPreset = useStringStore((s) => s.saveCurrentPreset);
  const loadPresetById = useStringStore((s) => s.loadPresetById);
  const deletePreset = useStringStore((s) => s.deletePreset);
  const importPreset = useStringStore((s) => s.importPreset);

  // Subscribe to Web MIDI port updates
  useEffect(() => {
    return midiEngine.subscribePorts((ports, supported, err) => {
      setMidiPorts(ports);
      setMidiSupported(supported);
      setMidiError(err);
    });
  }, []);

  // Sync Audio Engine settings
  useEffect(() => {
    audioEngine.setPreset(settings.soundPreset);
  }, [settings.soundPreset]);

  useEffect(() => {
    audioEngine.setReverbEnabled(settings.reverbEnabled);
  }, [settings.reverbEnabled]);

  useEffect(() => {
    audioEngine.setDelayEnabled(settings.delayEnabled);
  }, [settings.delayEnabled]);

  useEffect(() => {
    audioEngine.setChorusEnabled(settings.chorusEnabled);
  }, [settings.chorusEnabled]);

  useEffect(() => {
    audioEngine.setShimmerEnabled(settings.shimmerEnabled);
  }, [settings.shimmerEnabled]);

  useEffect(() => {
    audioEngine.setStereoPanEnabled(settings.stereoPanEnabled);
  }, [settings.stereoPanEnabled]);

  useEffect(() => {
    audioEngine.setInternalMuted(settings.internalAudioMuted);
  }, [settings.internalAudioMuted]);

  // Sync Web MIDI settings
  useEffect(() => {
    midiEngine.configure({
      enabled: settings.midiEnabled,
      portId: settings.midiPortId,
      channel: settings.midiChannel,
      gateMs: settings.midiGateMs,
      sendTouchCC74: settings.midiSendCC74,
    });
  }, [
    settings.midiEnabled,
    settings.midiPortId,
    settings.midiChannel,
    settings.midiGateMs,
    settings.midiSendCC74,
  ]);

  // Sync One Euro Filter settings
  useEffect(() => {
    tracker.setFilterParams(settings.filterMinCutoff, settings.filterBeta);
  }, [tracker, settings.filterMinCutoff, settings.filterBeta]);

  // Poll looper HUD display at gentle 12 Hz only when looper panel is open or active
  useEffect(() => {
    if (status !== 'running') return;
    const id = window.setInterval(() => {
      const l = transientState.looper;
      setLooperHud((prev) =>
        prev.mode === l.mode &&
        prev.eventCount === l.eventCount &&
        prev.currentBeat === l.currentBeat &&
        prev.totalBeats === l.totalBeats
          ? prev
          : {
              mode: l.mode,
              eventCount: l.eventCount,
              currentBeat: l.currentBeat,
              totalBeats: l.totalBeats,
            },
      );
    }, 85);
    return () => window.clearInterval(id);
  }, [status]);

  // Keyboard shortcuts: 1-9 load presets, S = Stage Mode, B = Ball Sequencer, Space = Looper
  useEffect(() => {
    if (status !== 'running') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const list = useStringStore.getState().presets;
        if (list[idx]) {
          loadPresetById(list[idx].id);
        }
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        const cur = useStringStore.getState().settings.webcamOpacity;
        updateSettings({ webcamOpacity: cur > 0.05 ? 0 : 0.85 });
      } else if (e.key === 'b' || e.key === 'B') {
        const cur = useStringStore.getState().settings.ballSequencerEnabled;
        updateSettings({ ballSequencerEnabled: !cur });
      } else if (e.code === 'Space') {
        e.preventDefault();
        setLooperBarOpen(true);
        const mode = transientState.looper.mode;
        if (mode === 'idle') {
          transientState.commands.looperAction =
            transientState.looper.eventCount > 0 ? 'play_toggle' : 'record';
        } else {
          transientState.commands.looperAction = 'stop';
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, loadPresetById, updateSettings]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      tracker.stop();
      midiEngine.allNotesOff();
      audioEngine.dispose();
    };
  }, [tracker]);

  const handleStart = async () => {
    if (status === 'starting') return;
    setStatus('starting');
    setErrorMsg(null);
    setStatusMsg('Inizializzazione audio...');

    try {
      await audioEngine.start();
      const video = await tracker.start((msg) => setStatusMsg(msg));
      setVideoEl(video);
      setStatus('running');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Impossibile avviare webcam o audio.';
      setErrorMsg(message);
      setStatus('error');
    }
  };

  const handleGenerate = (kind: GeneratorKind, count = 6) => {
    const specs = generateStringLayout(kind, count, settings.tuning);
    loadStringSpecs(specs);
  };

  const handleSavePreset = () => {
    const saved = saveCurrentPreset(presetName);
    setPresetName('');
    setPresetFeedback(`Salvato "${saved.name}"`);
    window.setTimeout(() => setPresetFeedback(null), 2000);
  };

  const handleExportJson = () => {
    const current = {
      id: `export-${Date.now()}`,
      name: presetName.trim() || `corde-${settings.tuning.rootNote}-${settings.tuning.scaleId}`,
      createdAt: Date.now(),
      tuning: settings.tuning,
      strings: useStringStore.getState().strings.map((s) => ({
        anchorA: { x: s.anchorA.x, y: s.anchorA.y },
        anchorB: { x: s.anchorB.x, y: s.anchorB.y },
      })),
    };
    const blob = new Blob([exportPresetJson(current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const parsed = parsePresetJson(text);
    if (parsed) {
      importPreset(parsed);
      setPresetFeedback(`Importato "${parsed.name}"`);
    } else {
      setPresetFeedback('File JSON non valido');
    }
    window.setTimeout(() => setPresetFeedback(null), 2500);
  };

  const isStageMode = settings.webcamOpacity <= 0.05;

  return (
    <main className="app-root">
      <div className="canvas-stage">
        <AirScene tracker={tracker} video={videoEl} />
      </div>

      {status !== 'running' && (
        <section className="start-overlay" aria-label="Avvio Corde nell'aria">
          <div className="start-card">
            <p className="eyebrow">Reactylon · MediaPipe · Tone.js · Web MIDI</p>
            <h1>Corde nell&apos;aria</h1>
            <p className="lead">
              Disegna corde musicali nello spazio con le tue mani, suonale live
              o pilota DAW esterne via Web MIDI, con sequencer fisico e looper.
            </p>

            <ul className="gesture-guide">
              <li>
                <strong>Crea corda (2 mani):</strong> avvicina entrambe le mani
                nel punto comune, fai pinch con entrambe, allarga (con snap
                magnetico) e rilascia.
              </li>
              <li>
                <strong>Suona (1 mano):</strong> sfiora o attraversa la corda
                con l&apos;indice; la posizione lungo la corda varia il timbro.
              </li>
              <li>
                <strong>Palm Mute &amp; Espressione:</strong> pugno chiuso sulla
                corda la ferma; seconda mano aperta modula filtro / FX / MIDI CC1.
              </li>
              <li>
                <strong>Modifica o elimina:</strong> tieni l&apos;indice fermo
                (~1.2 s) per selezionare → sposta estremi, trasla dal centro o
                tocca la <strong>X</strong>.
              </li>
            </ul>

            {errorMsg && (
              <p className="error-banner" role="alert">
                {errorMsg}
              </p>
            )}

            <button
              type="button"
              className="primary-btn"
              onClick={handleStart}
              disabled={status === 'starting'}
            >
              {status === 'starting'
                ? statusMsg || 'Avvio in corso...'
                : 'Start — Webcam & Audio'}
            </button>
          </div>
        </section>
      )}

      {status === 'running' && (
        <>
          <header className="hud-bar">
            <div className="hud-pill hud-brand">
              <span className="status-dot" aria-hidden="true" />
              <span className="brand-title">Corde nell&apos;aria</span>
              <span className="hud-divider" aria-hidden="true" />
              <span className="hud-metric">
                {stringCount} {stringCount === 1 ? 'corda' : 'corde'}
              </span>
              <span className="hud-scale-tag">
                {settings.tuning.rootNote} · {SCALES[settings.tuning.scaleId].label}
              </span>
              {settings.midiEnabled && (
                <span className="hud-midi-tag">
                  MIDI ch.{settings.midiChannel}
                </span>
              )}
            </div>

            <div className="hud-actions">
              {stringCount === 0 && (
                <button
                  type="button"
                  className="hud-btn"
                  onClick={() => handleGenerate('harp_vertical', 5)}
                >
                  Arpa 5 corde
                </button>
              )}
              <button
                type="button"
                className={`hud-btn ${isStageMode ? 'is-active' : ''}`}
                onClick={() =>
                  updateSettings({ webcamOpacity: isStageMode ? 0.85 : 0 })
                }
                title="Scorciatoia: S"
              >
                Stage
              </button>
              <button
                type="button"
                className={`hud-btn ${settings.ballSequencerEnabled ? 'is-active' : ''}`}
                onClick={() =>
                  updateSettings({
                    ballSequencerEnabled: !settings.ballSequencerEnabled,
                  })
                }
                title="Scorciatoia: B"
              >
                Sfere
              </button>
              <button
                type="button"
                className={`hud-btn ${
                  looperBarOpen || looperHud.mode !== 'idle' ? 'is-active' : ''
                }`}
                onClick={() => setLooperBarOpen((v) => !v)}
                title="Scorciatoia: Spazio"
              >
                Loop{looperHud.mode === 'recording' ? ' ●' : looperHud.mode === 'playing' ? ' ▶' : ''}
              </button>
              {selectedId && (
                <button
                  type="button"
                  className="hud-btn"
                  onClick={() => selectString(null)}
                >
                  Deseleziona
                </button>
              )}
              {stringCount > 0 && (
                <button
                  type="button"
                  className="hud-btn hud-btn-danger"
                  onClick={() => {
                    midiEngine.allNotesOff();
                    clearStrings();
                  }}
                >
                  Pulisci
                </button>
              )}
              <button
                type="button"
                className={`hud-btn ${settings.showHandOverlay ? 'is-active' : ''}`}
                onClick={() =>
                  updateSettings({ showHandOverlay: !settings.showHandOverlay })
                }
              >
                Mani
              </button>
              <button
                type="button"
                className={`hud-btn ${settingsOpen ? 'is-active' : ''}`}
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
              >
                Impostazioni
              </button>
            </div>
          </header>

          {/* Compact Looper transport dock */}
          {(looperBarOpen || looperHud.mode !== 'idle') && (
            <section className="looper-dock" aria-label="Controlli Looper">
              <div className="looper-controls">
                <button
                  type="button"
                  className={`hud-btn ${
                    looperHud.mode === 'recording' ? 'is-rec' : ''
                  }`}
                  onClick={() => {
                    transientState.commands.looperAction =
                      looperHud.mode === 'recording' ? 'stop' : 'record';
                  }}
                >
                  {looperHud.mode === 'recording' ? 'Stop Rec' : '● Rec'}
                </button>
                <button
                  type="button"
                  className={`hud-btn ${
                    looperHud.mode === 'overdubbing' ? 'is-rec' : ''
                  }`}
                  disabled={looperHud.eventCount === 0}
                  onClick={() => {
                    transientState.commands.looperAction =
                      looperHud.mode === 'overdubbing' ? 'stop' : 'overdub';
                  }}
                >
                  Overdub
                </button>
                <button
                  type="button"
                  className={`hud-btn ${
                    looperHud.mode === 'playing' ? 'is-active' : ''
                  }`}
                  disabled={looperHud.eventCount === 0}
                  onClick={() => {
                    transientState.commands.looperAction = 'play_toggle';
                  }}
                >
                  {looperHud.mode === 'playing' ? '■ Stop' : '▶ Play'}
                </button>
                <button
                  type="button"
                  className="hud-btn hud-btn-danger"
                  disabled={looperHud.eventCount === 0}
                  onClick={() => {
                    transientState.commands.looperAction = 'clear';
                  }}
                >
                  Svuota
                </button>
                <span className="looper-meta">
                  {settings.looperBpm} BPM · {settings.looperBars} bar ·{' '}
                  {looperHud.eventCount} note
                </span>
              </div>
              <div className="beat-dots" aria-hidden="true">
                {Array.from({ length: looperHud.totalBeats }).map((_, i) => (
                  <span
                    key={i}
                    className={`beat-dot ${
                      i % 4 === 0 ? 'is-downbeat' : ''
                    } ${
                      looperHud.mode !== 'idle' && i === looperHud.currentBeat
                        ? 'is-now'
                        : ''
                    }`}
                  />
                ))}
              </div>
            </section>
          )}

          {settingsOpen && (
            <aside className="settings-panel" aria-label="Impostazioni strumento">
              <div className="settings-header">
                <h2>Impostazioni</h2>
                <button
                  type="button"
                  className="icon-close-btn"
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Chiudi impostazioni"
                >
                  ✕
                </button>
              </div>

              <div className="settings-tabs" role="tablist">
                {(
                  [
                    ['sound', 'Suono'],
                    ['midi', 'MIDI'],
                    ['creative', 'Creativo'],
                    ['gestures', 'Gesti'],
                  ] as const
                ).map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tabId}
                    className={`tab-btn ${activeTab === tabId ? 'is-active' : ''}`}
                    onClick={() => setActiveTab(tabId)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* TAB 1: SOUND & TUNING */}
              {activeTab === 'sound' && (
                <div className="tab-body">
                  <div className="settings-section">
                    <h3>Intonazione</h3>
                    <div className="field-row">
                      <label htmlFor="scale-select">Scala</label>
                      <select
                        id="scale-select"
                        value={settings.tuning.scaleId}
                        onChange={(e) =>
                          updateTuning({ scaleId: e.target.value as ScaleId })
                        }
                      >
                        {Object.values(SCALES).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field-grid-2">
                      <div className="field-row">
                        <label htmlFor="root-select">Nota base</label>
                        <select
                          id="root-select"
                          value={settings.tuning.rootNote}
                          onChange={(e) =>
                            updateTuning({ rootNote: e.target.value as RootNote })
                          }
                        >
                          {ROOT_NOTES.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field-row">
                        <label htmlFor="octave-select">Ottave</label>
                        <select
                          id="octave-select"
                          value={settings.tuning.octaves}
                          onChange={(e) =>
                            updateTuning({ octaves: Number(e.target.value) })
                          }
                        >
                          <option value={2}>2 ottave</option>
                          <option value={3}>3 ottave</option>
                          <option value={4}>4 ottave</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Strumento &amp; Effetti</h3>
                    <div className="field-row">
                      <label htmlFor="preset-sound-select">Timbro</label>
                      <select
                        id="preset-sound-select"
                        value={settings.soundPreset}
                        onChange={(e) =>
                          updateSettings({
                            soundPreset: e.target.value as SoundPresetId,
                          })
                        }
                      >
                        {Object.values(SOUND_PRESETS).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="check-grid-2">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={settings.reverbEnabled}
                          onChange={(e) =>
                            updateSettings({ reverbEnabled: e.target.checked })
                          }
                        />
                        <span>Riverbero</span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={settings.delayEnabled}
                          onChange={(e) =>
                            updateSettings({ delayEnabled: e.target.checked })
                          }
                        />
                        <span>Delay Stereo</span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={settings.chorusEnabled}
                          onChange={(e) =>
                            updateSettings({ chorusEnabled: e.target.checked })
                          }
                        />
                        <span>Chorus</span>
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={settings.shimmerEnabled}
                          onChange={(e) =>
                            updateSettings({ shimmerEnabled: e.target.checked })
                          }
                        />
                        <span>Shimmer +12</span>
                      </label>
                    </div>

                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.stereoPanEnabled}
                        onChange={(e) =>
                          updateSettings({ stereoPanEnabled: e.target.checked })
                        }
                      />
                      <span>Panning stereo dalla posizione X</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.harmonicsEnabled}
                        onChange={(e) =>
                          updateSettings({ harmonicsEnabled: e.target.checked })
                        }
                      />
                      <span>Armonico naturale al centro corda</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.previewSoundOnDrag}
                        onChange={(e) =>
                          updateSettings({
                            previewSoundOnDrag: e.target.checked,
                          })
                        }
                      />
                      <span>Anteprima nota al drag / creazione</span>
                    </label>
                  </div>

                  <div className="settings-section">
                    <h3>Dinamica tocco</h3>
                    <div className="field-row">
                      <label htmlFor="curve-range">
                        Curva intensità ({settings.intensityCurve.toFixed(2)})
                      </label>
                      <input
                        id="curve-range"
                        type="range"
                        min={0.3}
                        max={1.2}
                        step={0.05}
                        value={settings.intensityCurve}
                        onChange={(e) =>
                          updateSettings({
                            intensityCurve: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label htmlFor="min-int-range">
                        Soglia minima ({Math.round(settings.minIntensity * 100)}%)
                      </label>
                      <input
                        id="min-int-range"
                        type="range"
                        min={0.08}
                        max={0.45}
                        step={0.02}
                        value={settings.minIntensity}
                        onChange={(e) =>
                          updateSettings({ minIntensity: Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: WEB MIDI */}
              {activeTab === 'midi' && (
                <div className="tab-body">
                  <div className="settings-section">
                    <h3>Web MIDI Output</h3>
                    {!midiSupported && (
                      <p className="inline-note">
                        Web MIDI API non disponibile su questo browser (usa
                        Chrome/Edge su HTTPS o localhost).
                      </p>
                    )}
                    {midiError && <p className="inline-error">{midiError}</p>}

                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.midiEnabled}
                        disabled={!midiSupported}
                        onChange={(e) =>
                          updateSettings({ midiEnabled: e.target.checked })
                        }
                      />
                      <span>Abilita uscita Web MIDI</span>
                    </label>

                    <div className="field-row">
                      <label htmlFor="midi-port-select">Porta MIDI</label>
                      <div className="inline-row">
                        <select
                          id="midi-port-select"
                          value={settings.midiPortId ?? ''}
                          onChange={(e) =>
                            updateSettings({
                              midiPortId: e.target.value || null,
                            })
                          }
                          disabled={!settings.midiEnabled || midiPorts.length === 0}
                        >
                          {midiPorts.length === 0 ? (
                            <option value="">Nessuna porta rilevata</option>
                          ) : (
                            midiPorts.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))
                          )}
                        </select>
                        <button
                          type="button"
                          className="small-btn"
                          onClick={() => void midiEngine.connect()}
                        >
                          Aggiorna
                        </button>
                      </div>
                    </div>

                    <div className="field-grid-2">
                      <div className="field-row">
                        <label htmlFor="midi-ch-select">Canale MIDI</label>
                        <select
                          id="midi-ch-select"
                          value={settings.midiChannel}
                          onChange={(e) =>
                            updateSettings({
                              midiChannel: Number(e.target.value),
                            })
                          }
                        >
                          {Array.from({ length: 16 }, (_, i) => i + 1).map(
                            (ch) => (
                              <option key={ch} value={ch}>
                                Canale {ch}
                              </option>
                            ),
                          )}
                        </select>
                      </div>
                      <div className="field-row">
                        <label htmlFor="midi-gate-range">
                          Gate ({settings.midiGateMs} ms)
                        </label>
                        <input
                          id="midi-gate-range"
                          type="range"
                          min={120}
                          max={2500}
                          step={50}
                          value={settings.midiGateMs}
                          onChange={(e) =>
                            updateSettings({
                              midiGateMs: Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>

                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.midiSendCC74}
                        onChange={(e) =>
                          updateSettings({ midiSendCC74: e.target.checked })
                        }
                      />
                      <span>Invia CC 74 (Brightness) dal punto di tocco</span>
                    </label>

                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.internalAudioMuted}
                        onChange={(e) =>
                          updateSettings({
                            internalAudioMuted: e.target.checked,
                          })
                        }
                      />
                      <span>Solo MIDI (silenzia audio interno)</span>
                    </label>

                    <button
                      type="button"
                      className="small-btn full-width"
                      onClick={() => midiEngine.allNotesOff()}
                    >
                      Panic — All Notes Off (CC 123)
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 3: CREATIVE (GENERATOR, BALL SEQUENCER, LOOPER, PRESETS) */}
              {activeTab === 'creative' && (
                <div className="tab-body">
                  <div className="settings-section">
                    <h3>Generatore rapido</h3>
                    <div className="btn-grid-2">
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => handleGenerate('harp_vertical', 6)}
                      >
                        Arpa 6 corde
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => handleGenerate('harp_fan', 7)}
                      >
                        Ventaglio 7
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => handleGenerate('chord_voicing', 4)}
                      >
                        Accordo (4)
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => handleGenerate('cascade', 5)}
                      >
                        Cascata sfere
                      </button>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Sequencer fisico a sfere</h3>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.ballSequencerEnabled}
                        onChange={(e) =>
                          updateSettings({
                            ballSequencerEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>Attiva emettitore sfere (pinch sul disco per spostarlo)</span>
                    </label>
                    <div className="field-grid-2">
                      <div className="field-row">
                        <label htmlFor="ball-bpm">BPM ({settings.ballBpm})</label>
                        <input
                          id="ball-bpm"
                          type="range"
                          min={40}
                          max={200}
                          step={5}
                          value={settings.ballBpm}
                          onChange={(e) =>
                            updateSettings({ ballBpm: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="field-row">
                        <label htmlFor="ball-grav">
                          Gravità ({settings.ballGravity.toFixed(1)})
                        </label>
                        <input
                          id="ball-grav"
                          type="range"
                          min={0.5}
                          max={3.5}
                          step={0.1}
                          value={settings.ballGravity}
                          onChange={(e) =>
                            updateSettings({
                              ballGravity: Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="field-row">
                      <label htmlFor="ball-bounce">
                        Rimbalzo ({Math.round(settings.ballRestitution * 100)}%)
                      </label>
                      <input
                        id="ball-bounce"
                        type="range"
                        min={0.5}
                        max={1.04}
                        step={0.02}
                        value={settings.ballRestitution}
                        onChange={(e) =>
                          updateSettings({
                            ballRestitution: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="btn-grid-2">
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => {
                          transientState.commands.ballSpawnNow = true;
                        }}
                      >
                        Lancia 1 sfera
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => {
                          transientState.commands.ballClear = true;
                        }}
                      >
                        Svuota sfere
                      </button>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Looper Audio / MIDI</h3>
                    <div className="field-grid-2">
                      <div className="field-row">
                        <label htmlFor="loop-bpm">BPM ({settings.looperBpm})</label>
                        <input
                          id="loop-bpm"
                          type="range"
                          min={60}
                          max={180}
                          step={2}
                          value={settings.looperBpm}
                          onChange={(e) =>
                            updateSettings({ looperBpm: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="field-row">
                        <label htmlFor="loop-bars">Lunghezza</label>
                        <select
                          id="loop-bars"
                          value={settings.looperBars}
                          onChange={(e) =>
                            updateSettings({
                              looperBars: Number(e.target.value) as 2 | 4,
                            })
                          }
                        >
                          <option value={2}>2 battute</option>
                          <option value={4}>4 battute</option>
                        </select>
                      </div>
                    </div>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.looperQuantize}
                        onChange={(e) =>
                          updateSettings({ looperQuantize: e.target.checked })
                        }
                      />
                      <span>Quantizza su griglia 1/16</span>
                    </label>
                  </div>

                  <div className="settings-section">
                    <h3>Preset &amp; Layout (tasti 1–9)</h3>
                    <div className="inline-row">
                      <input
                        type="text"
                        className="text-input"
                        placeholder="Nome set..."
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                      />
                      <button
                        type="button"
                        className="small-btn"
                        onClick={handleSavePreset}
                        disabled={stringCount === 0}
                      >
                        Salva
                      </button>
                    </div>
                    {presetFeedback && (
                      <p className="inline-note">{presetFeedback}</p>
                    )}

                    {presets.length > 0 && (
                      <ul className="preset-list">
                        {presets.map((p, idx) => (
                          <li key={p.id} className="preset-item">
                            <button
                              type="button"
                              className="preset-load-btn"
                              onClick={() => loadPresetById(p.id)}
                            >
                              <span className="preset-key">{idx + 1}</span>
                              <span>{p.name}</span>
                              <small>{p.strings.length}</small>
                            </button>
                            <button
                              type="button"
                              className="preset-del-btn"
                              onClick={() => deletePreset(p.id)}
                              aria-label={`Elimina preset ${p.name}`}
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="btn-grid-2">
                      <button
                        type="button"
                        className="small-btn"
                        onClick={handleExportJson}
                        disabled={stringCount === 0}
                      >
                        Esporta JSON
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => importInputRef.current?.click()}
                      >
                        Importa JSON
                      </button>
                      <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json"
                        hidden
                        onChange={(e) => {
                          void handleImportFile(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4: GESTURES & STAGE VISUALS */}
              {activeTab === 'gestures' && (
                <div className="tab-body">
                  <div className="settings-section">
                    <h3>Stage Mode &amp; Visual</h3>
                    <div className="field-row">
                      <label htmlFor="webcam-op-range">
                        Opacità webcam ({Math.round(settings.webcamOpacity * 100)}%)
                      </label>
                      <input
                        id="webcam-op-range"
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.webcamOpacity}
                        onChange={(e) =>
                          updateSettings({
                            webcamOpacity: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.particlesEnabled}
                        onChange={(e) =>
                          updateSettings({ particlesEnabled: e.target.checked })
                        }
                      />
                      <span>Scintille al punto di impatto</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.fingerTrailsEnabled}
                        onChange={(e) =>
                          updateSettings({
                            fingerTrailsEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>Scia luminosa sulle punte delle dita</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.showHandOverlay}
                        onChange={(e) =>
                          updateSettings({ showHandOverlay: e.target.checked })
                        }
                      />
                      <span>Scheletro mani completo (debug)</span>
                    </label>
                  </div>

                  <div className="settings-section">
                    <h3>Gesti &amp; Tracking</h3>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.editRequiresSelection}
                        onChange={(e) =>
                          updateSettings({
                            editRequiresSelection: e.target.checked,
                          })
                        }
                      />
                      <span>Blocca estremi (modifica solo se selezionata)</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.snapEnabled}
                        onChange={(e) =>
                          updateSettings({ snapEnabled: e.target.checked })
                        }
                      />
                      <span>Snap magnetico ±6° (orizzontale / verticale)</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.palmMuteEnabled}
                        onChange={(e) =>
                          updateSettings({ palmMuteEnabled: e.target.checked })
                        }
                      />
                      <span>Palm Mute (pugno chiuso ferma la corda)</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.expressionHandEnabled}
                        onChange={(e) =>
                          updateSettings({
                            expressionHandEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>Mano espressiva (FX / MIDI CC1 Mod Wheel)</span>
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.allFingertips}
                        onChange={(e) =>
                          updateSettings({ allFingertips: e.target.checked })
                        }
                      />
                      <span>Suona con tutte le 5 dita</span>
                    </label>

                    <div className="field-row">
                      <label htmlFor="delete-pos-select">
                        Posizione &quot;X&quot;
                      </label>
                      <select
                        id="delete-pos-select"
                        value={settings.deleteButtonMode}
                        onChange={(e) =>
                          updateSettings({
                            deleteButtonMode: e.target.value as DeleteButtonMode,
                          })
                        }
                      >
                        <option value="near_string">Vicino alla corda</option>
                        <option value="top_bar">Fissa in alto</option>
                      </select>
                    </div>

                    <div className="field-row">
                      <label htmlFor="cutoff-range">
                        1€ Filter minCutoff ({settings.filterMinCutoff.toFixed(1)}{' '}
                        Hz)
                      </label>
                      <input
                        id="cutoff-range"
                        type="range"
                        min={0.4}
                        max={4.0}
                        step={0.1}
                        value={settings.filterMinCutoff}
                        onChange={(e) =>
                          updateSettings({
                            filterMinCutoff: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}

          <footer className="hud-hint">
            <span>
              <strong>2 mani pinch → allarga</strong>: crea ·{' '}
              <strong>1 mano</strong>: suona · <strong>Pugno</strong>: mute ·{' '}
              <strong>Tieni 1.2 s</strong>: seleziona (estremi / centro / X) ·{' '}
              <strong>S</strong>: Stage · <strong>B</strong>: Sfere ·{' '}
              <strong>1–9</strong>: Preset
            </span>
          </footer>
        </>
      )}
    </main>
  );
}

export default App;
