# Roadmap — Corde nell'aria

Raccolta strutturata delle feature e dei miglioramenti pianificati per evolvere lo strumento.

---

## 1. Audio & Connettività

### 1.1 Web MIDI Output (`navigator.requestMIDIAccess`)
**Stato:** Implementato ✅  
**Obiettivo:** Pilotare sintetizzatori esterni, VST e DAW (Logic Pro, Ableton Live, GarageBand, Kontakt, synth hardware via IAC Driver / USB-MIDI).
- **Modulo dedicato:** `src/audio/midiEngine.ts`.
- **Connessione & permessi:** `navigator.requestMIDIAccess({ sysex: false })` + listener `onstatechange` per hot-plug dispositivi.
- **Messaggi MIDI:**
  - `Note On` (`0x90 | channel`, `str.midi`, `velocity = clamp(round(intensity * 127), 1, 127)`).
  - `Note Off` (`0x80 | channel`, `str.midi`, `0`) schedulato dopo gate/release configurabile + invio `Note Off` preventivo su re-trigger della stessa nota + `All Notes Off` (`CC 123`) su clear/cleanup.
- **Impostazioni UI:** toggle attiva MIDI, selettore porta di uscita, canale MIDI (1–16), durata gate, toggle *Solo MIDI* (disattiva audio interno Tone.js).
- **Estensioni:** invio `CC` dinamici (`CC 74` da punto di tocco `s`, `CC 1` da mano espressiva) ed eventuale MPE / pitch bend live.

### 1.2 Espansione motori sonori & Effetti (opzionale in parallelo al MIDI)
**Stato:** Implementato ✅  
- Preset sintetizzatori Tone.js aggiuntivi (`FMSynth` per kalimba/marimba/campane, `AMSynth`/pad, preset multipli Karplus-Strong) e/o campioni reali (`Tone.Sampler` / `smplr`).
- Catena effetti configurabile (`PingPongDelay`, `Chorus`, `Distortion`, Shimmer Reverb).

---

## 2. Espressività Musicale

### 2.1 Timbro & MIDI CC dal punto di tocco (`s ∈ [0, 1]`)
**Stato:** Implementato ✅  
- Sfruttare il parametro `s` già restituito da `collision.ts`:
  - Tocco vicino agli estremi (`s < 0.2` o `s > 0.8`) → suono più brillante/nasale (*sul ponticello*), `dampening` alto.
  - Tocco al centro (`s ≈ 0.5`) → suono caldo e rotondo (*sul tasto*) o armonico naturale opzionale.
  - In modalità Web MIDI: mappatura di `s` (distanza dal centro) su `CC 74` (Brightness / Filter Cutoff).

### 2.2 Mano espressiva come controller live (Mod Wheel / Effetti)
**Stato:** Implementato ✅  
- Quando una mano suona e l'altra mano resta aperta/sollevata nello spazio, l'altezza Y (o l'apertura della mano) modula in tempo reale un parametro espressivo:
  - Interno: wet riverbero, cutoff filtro o sustain/resonance.
  - Web MIDI: invio continuo (throttled) di `CC 1` (Modulation Wheel) o `CC 11` (Expression).

### 2.3 Palm Mute / Stop corde
**Stato:** Implementato ✅  
- Chiudere la mano a pugno (o sovrapporre il palmo aperto fermo) sopra una corda vibrante smorza istantaneamente l'ampiezza visiva (`vibration.amplitude → 0`), tronca la coda audio sulla voce associata e invia subito `Note Off` via MIDI.

### 2.4 Panning stereo dalla posizione X della corda
**Stato:** Implementato ✅  
- Mappare la coordinata X media della corda (`[-aspect, +aspect]`) su un `Tone.Panner` per voce (`[-0.85, +0.85]`): le corde a sinistra suonano a sinistra, quelle a destra a destra.

---

## 3. Creazione Rapida, Editing & Layout

### 3.1 Snap magnetico (verticale / orizzontale)
**Stato:** Implementato ✅  
- Durante la creazione a 2 mani (e il drag degli estremi), se l'angolo della corda rientra entro ±6° dall'orizzontale o dalla verticale, applicare uno snap morbido con feedback visivo per costruire arpe perfettamente allineate. Toggle attivabile/disattivabile nelle Impostazioni.

### 3.2 Spostamento corda intera
**Stato:** Implementato ✅  
- Su una corda **selezionata**, fare pinch vicino al segmento centrale (lontano dagli estremi e dalla X) permette di traslare contemporaneamente `anchorA` e `anchorB` mantenendo invariate lunghezza e intonazione.

### 3.3 Preset & Layout salvabili (`localStorage` + JSON + hotkey `1–9`)
**Stato:** Implementato ✅  
- Salvare e richiamare rapidamente configurazioni di corde + scala/nota base:
  - Persistenza locale in `localStorage` con slot rapidi richiamabili anche da tastiera (`1`–`9`).
  - Export/Import in formato `.json` per condividere o archiviare set live.

### 3.4 Generatore rapido di Arpa / Accordo
**Stato:** Implementato ✅  
- Controllo UI (o gesto dedicato) per generare automaticamente un ventaglio o una griglia di `N` corde già accordate sulla scala o su un accordo scelto (es. triade, settima, pentatonica completa).

---

## 4. Modalità Creative & Generative

### 4.1 Sequencer fisico a sfere (stile *Electroplankton*)
**Stato:** Implementato ✅  
- Emettitori configurabili rilasciano sfere luminose soggette a gravità 2D nello spazio ortografico.
- Quando una sfera colpisce una corda:
  - Rimbalza fisicamente in base alla normale/inclinazione della corda (con elasticità regolabile).
  - Pizzica la corda con intensità proporzionale alla velocità d'impatto, attivando vibrazione visiva, suono interno e **output Web MIDI**.
- Controlli: attiva/disattiva emettitore, BPM/intervallo di spawn, gravità, posizionamento emettitore con mano/mouse.

### 4.2 Looper Audio / MIDI (2–4 battute)
**Stato:** Implementato ✅  
- Registratore di eventi (`timestamp`, `stringId`, `midi`, `intensity`, `s`) quantizzabili o liberi su un ciclo a BPM configurabile (con metronomo visivo discreto nell'HUD).
- Permette di stratificare arpeggi e improvvisarci sopra dal vivo, pilotando sia Tone.js sia Web MIDI.

---

## 5. Visual & Stage Mode

### 5.1 Opacità sfondo webcam (`0%–100%`) / Stage Mode
**Stato:** Implementato ✅  
- Slider in Impostazioni + scorciatoia rapida per regolare l'opacità/luminosità di `VideoBackground` fino a `0%` (sfondo nero puro stile *laser harp*, ideale per performance dal vivo, proiezioni o registrazioni).

### 5.2 Particelle / Scintille al punto di impatto `s`
**Stato:** Implementato ✅  
- Al momento del pluck, emettere un breve burst di particelle luminose dal punto esatto di contatto `s` sulla corda, con colore ereditato dalla corda e quantità/velocità proporzionali all'intensità del tocco.

### 5.3 Scia luminosa sulle punte delle dita
**Stato:** Implementato ✅  
- Trail fluido (breve coda di 6–10 posizioni) sulle punte attive, particolarmente utile in *Stage Mode* quando la webcam è nascosta e per leggere a colpo d'occhio la velocità del gesto.
