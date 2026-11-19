# Corde nell'aria

Strumento musicale interattivo in realtà aumentata 2D basato su **Reactylon (Babylon.js)**, **MediaPipe HandLandmarker** e **Tone.js**.

Disegna corde luminose nell'aria davanti alla webcam, intonale cambiandone la lunghezza e pizzicale al volo.

## Stack

- **Vite + React 19 + TypeScript**
- **Reactylon + Babylon.js** (`MeshBuilder.CreateLines` updatable + `GlowLayer` neon + camera ortografica)
- **@mediapipe/tasks-vision** (`HandLandmarker` in modalità `VIDEO`, 2 mani, delegate GPU con fallback CPU + One Euro Filter sui landmark)
- **Tone.js** (pool polifonico da 16 `Tone.PluckSynth` Karplus-Strong + `Tone.Reverb`)
- **Zustand** per lo stato reattivo della lista corde e delle impostazioni

## Gesti

- **Crea corda (2 mani):** avvicina entrambe le mani in un punto comune, fai *pinch* (pollice + indice) con entrambe, allarga per tendere la corda e rilascia per fissarla.
- **Suona (1 mano):** sfiora o attraversa la corda con la punta dell'indice (o con tutte le 5 dita abilitando l'opzione). La velocità 2D controlla volume, ampiezza della vibrazione e brillantezza del timbro.
- **Modifica o elimina:** tieni l'indice fermo sulla corda per ~1.2 s fino a selezionarla, quindi trascina uno dei due estremi con *pinch* per cambiare intonazione oppure tocca/fai *pinch* sulla **X** per eliminarla.

## Avvio locale

```bash
npm install
npm run dev
```

Apri `http://localhost:5173` (webcam e Web Audio richiedono `localhost` o HTTPS) e clicca **Start — Webcam & Audio**.

## Build di produzione

```bash
npm run build
npm run preview
```
