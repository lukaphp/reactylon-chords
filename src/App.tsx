import { useEffect, useRef, useState } from 'react';
import { HandTracker } from './tracking/HandTracker';
import { audioEngine } from './audio/audioEngine';
import {
  ROOT_NOTES,
  SCALES,
  type RootNote,
  type ScaleId,
} from './strings/tuning';
import { useStringStore, type DeleteButtonMode } from './strings/stringStore';
import { AirScene } from './render/Scene';

type AppStatus = 'idle' | 'starting' | 'running' | 'error';

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

  const stringCount = useStringStore((s) => s.strings.length);
  const selectedId = useStringStore((s) => s.selectedId);
  const settings = useStringStore((s) => s.settings);
  const updateTuning = useStringStore((s) => s.updateTuning);
  const updateSettings = useStringStore((s) => s.updateSettings);
  const addString = useStringStore((s) => s.addString);
  const clearStrings = useStringStore((s) => s.clearStrings);
  const selectString = useStringStore((s) => s.selectString);

  // Sync audio reverb & One Euro Filter settings into engine / tracker
  useEffect(() => {
    audioEngine.setReverbEnabled(settings.reverbEnabled);
  }, [settings.reverbEnabled]);

  useEffect(() => {
    tracker.setFilterParams(settings.filterMinCutoff, settings.filterBeta);
  }, [tracker, settings.filterMinCutoff, settings.filterBeta]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      tracker.stop();
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

  const handleSpawnDemoHarp = () => {
    clearStrings();
    // Create 4 evenly spaced vertical harp strings of varying lengths (low -> high)
    const specs: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: -0.78, y: -0.68 }, { x: -0.78, y: 0.68 }],
      [{ x: -0.26, y: -0.52 }, { x: -0.26, y: 0.52 }],
      [{ x: 0.26, y: -0.38 }, { x: 0.26, y: 0.38 }],
      [{ x: 0.78, y: -0.26 }, { x: 0.78, y: 0.26 }],
    ];
    for (const [a, b] of specs) {
      addString(a, b);
    }
  };

  return (
    <main className="app-root">
      <div className="canvas-stage">
        <AirScene tracker={tracker} video={videoEl} />
      </div>

      {status !== 'running' && (
        <section className="start-overlay" aria-label="Avvio Corde nell'aria">
          <div className="start-card">
            <p className="eyebrow">Reactylon · MediaPipe · Tone.js</p>
            <h1>Corde nell&apos;aria</h1>
            <p className="lead">
              Disegna corde musicali nello spazio con le tue mani, cambia la
              lunghezza per intonarle e pizzicale al volo.
            </p>

            <ul className="gesture-guide">
              <li>
                <strong>Crea corda (2 mani):</strong> avvicina entrambe le mani
                in un punto comune, fai pinch con entrambe, allarga per tendere
                la corda e rilascia per fissarla.
              </li>
              <li>
                <strong>Suona (1 mano):</strong> sfiora o attraversa la corda
                con l&apos;indice — le corde restano bloccate così non le sposti
                per sbaglio.
              </li>
              <li>
                <strong>Modifica o elimina:</strong> tieni l&apos;indice fermo
                sulla corda (~1.2 s) per selezionarla, poi trascina un estremo
                con pinch o tocca la <strong>X</strong>.
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
            </div>

            <div className="hud-actions">
              {stringCount === 0 && (
                <button
                  type="button"
                  className="hud-btn"
                  onClick={handleSpawnDemoHarp}
                >
                  Arpa demo
                </button>
              )}
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
                  onClick={clearStrings}
                >
                  Pulisci ({stringCount})
                </button>
              )}
              <button
                type="button"
                className={`hud-btn ${settings.showHandOverlay ? 'is-active' : ''}`}
                onClick={() =>
                  updateSettings({ showHandOverlay: !settings.showHandOverlay })
                }
                aria-pressed={settings.showHandOverlay}
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
                <h3>Dinamica &amp; Audio</h3>

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
                      updateSettings({ intensityCurve: Number(e.target.value) })
                    }
                  />
                </div>

                <div className="field-row">
                  <label htmlFor="min-int-range">
                    Soglia minima tocco ({Math.round(settings.minIntensity * 100)}%)
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

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.reverbEnabled}
                    onChange={(e) =>
                      updateSettings({ reverbEnabled: e.target.checked })
                    }
                  />
                  <span>Riverbero ambiente</span>
                </label>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.previewSoundOnDrag}
                    onChange={(e) =>
                      updateSettings({ previewSoundOnDrag: e.target.checked })
                    }
                  />
                  <span>Anteprima nota durante il drag</span>
                </label>
              </div>

              <div className="settings-section">
                <h3>Interazione &amp; Tracking</h3>

                <div className="field-row">
                  <label htmlFor="delete-pos-select">Posizione &quot;X&quot;</label>
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
                    checked={settings.allFingertips}
                    onChange={(e) =>
                      updateSettings({ allFingertips: e.target.checked })
                    }
                  />
                  <span>Suona con tutte le 5 dita</span>
                </label>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.showHandOverlay}
                    onChange={(e) =>
                      updateSettings({ showHandOverlay: e.target.checked })
                    }
                  />
                  <span>Mostra scheletro mani (debug)</span>
                </label>

                <div className="field-row">
                  <label htmlFor="cutoff-range">
                    1€ Filter minCutoff ({settings.filterMinCutoff.toFixed(1)} Hz)
                  </label>
                  <input
                    id="cutoff-range"
                    type="range"
                    min={0.4}
                    max={4.0}
                    step={0.1}
                    value={settings.filterMinCutoff}
                    onChange={(e) =>
                      updateSettings({ filterMinCutoff: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
            </aside>
          )}

          <footer className="hud-hint">
            <span>
              <strong>2 mani unite + pinch → allarga</strong>: crea corda ·{' '}
              <strong>1 mano</strong>: suona (corde protette) ·{' '}
              <strong>Tieni 1.2 s</strong>: seleziona per modificare/eliminare
            </span>
          </footer>
        </>
      )}
    </main>
  );
}

export default App;
