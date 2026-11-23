export interface MidiOutputInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiNoteOptions {
  /** Touch position along string [0..1] for CC 74 brightness mapping. */
  s?: number;
  /** Note duration before automatic Note Off (ms). */
  gateMs?: number;
  /** Optional string ID to enable immediate Palm Mute Note Off. */
  stringId?: string;
}

interface ActiveMidiNote {
  channel: number;
  note: number;
  timerId: number;
  stringId?: string;
}

type PortsListener = (ports: MidiOutputInfo[], supported: boolean, error: string | null) => void;

/**
 * Web MIDI API Output Engine:
 * Sends Note On / Note Off, CC 74 (touch position brightness), and CC 1 (expressive hand mod wheel).
 */
class MidiEngine {
  private access: MIDIAccess | null = null;
  private enabled = false;
  private selectedPortId: string | null = null;
  private channel = 0; // 0..15 (displayed as 1..16)
  private defaultGateMs = 650;
  private sendTouchCC74 = true;

  private activeNotes = new Map<string, ActiveMidiNote>();
  private listeners = new Set<PortsListener>();
  private lastCCSentMs = new Map<number, number>();
  private lastCCValue = new Map<number, number>();
  private lastError: string | null = null;

  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getOutputs(): MidiOutputInfo[] {
    if (!this.access) return [];
    const list: MidiOutputInfo[] = [];
    for (const out of this.access.outputs.values()) {
      list.push({
        id: out.id,
        name: out.name || `MIDI Out (${out.id})`,
        manufacturer: out.manufacturer || '',
      });
    }
    return list;
  }

  public subscribePorts(listener: PortsListener): () => void {
    this.listeners.add(listener);
    listener(this.getOutputs(), this.isSupported(), this.lastError);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async connect(): Promise<MidiOutputInfo[]> {
    if (!this.isSupported()) {
      this.lastError = 'Web MIDI API non supportata da questo browser (usa Chrome/Edge).';
      this.emitPorts();
      return [];
    }

    try {
      if (!this.access) {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        this.access.onstatechange = () => {
          this.ensureValidSelectedPort();
          this.emitPorts();
        };
      }
      this.lastError = null;
      this.ensureValidSelectedPort();
      this.emitPorts();
      return this.getOutputs();
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : 'Accesso Web MIDI negato.';
      this.emitPorts();
      return [];
    }
  }

  public configure(opts: {
    enabled?: boolean;
    portId?: string | null;
    channel?: number; // 1..16
    gateMs?: number;
    sendTouchCC74?: boolean;
  }): void {
    if (opts.enabled !== undefined) {
      if (!opts.enabled && this.enabled) {
        this.allNotesOff();
      }
      this.enabled = opts.enabled;
      if (opts.enabled && !this.access) {
        void this.connect();
      }
    }
    if (opts.portId !== undefined) {
      if (opts.portId !== this.selectedPortId) {
        this.allNotesOff();
        this.selectedPortId = opts.portId;
      }
    }
    if (opts.channel !== undefined) {
      const nextCh = Math.max(0, Math.min(15, Math.round(opts.channel) - 1));
      if (nextCh !== this.channel) {
        this.allNotesOff();
        this.channel = nextCh;
      }
    }
    if (opts.gateMs !== undefined) {
      this.defaultGateMs = Math.max(80, Math.min(4000, opts.gateMs));
    }
    if (opts.sendTouchCC74 !== undefined) {
      this.sendTouchCC74 = opts.sendTouchCC74;
    }
  }

  public sendNote(
    midiNote: number,
    intensity: number,
    options: MidiNoteOptions = {},
  ): void {
    if (!this.enabled) return;
    const output = this.getActiveOutput();
    if (!output) return;

    const note = Math.max(0, Math.min(127, Math.round(midiNote)));
    const velocity = Math.max(1, Math.min(127, Math.round(intensity * 127)));
    const ch = this.channel;
    const key = `${ch}:${note}`;

    // Send Note Off first if re-triggering the same note to avoid stuck notes in DAWs
    const existing = this.activeNotes.get(key);
    if (existing) {
      window.clearTimeout(existing.timerId);
      output.send([0x80 | ch, note, 0]);
      this.activeNotes.delete(key);
    }

    // Map touch position s ∈ [0..1] to CC 74 Brightness (edges brighter, center warmer)
    if (this.sendTouchCC74 && options.s !== undefined) {
      const edge = Math.min(1, Math.abs(options.s - 0.5) * 2);
      const brightness = Math.round(36 + edge * 91);
      output.send([0xb0 | ch, 74, brightness]);
    }

    output.send([0x90 | ch, note, velocity]);

    const gateMs = options.gateMs ?? this.defaultGateMs;
    const timerId = window.setTimeout(() => {
      const out = this.getActiveOutput();
      out?.send([0x80 | ch, note, 0]);
      this.activeNotes.delete(key);
    }, gateMs);

    this.activeNotes.set(key, {
      channel: ch,
      note,
      timerId,
      stringId: options.stringId,
    });
  }

  /** Immediately sends Note Off for any active MIDI note triggered by a muted string. */
  public stopStringNote(stringId: string): void {
    if (!this.enabled) return;
    const output = this.getActiveOutput();
    for (const [key, entry] of Array.from(this.activeNotes.entries())) {
      if (entry.stringId === stringId) {
        window.clearTimeout(entry.timerId);
        output?.send([0x80 | entry.channel, entry.note, 0]);
        this.activeNotes.delete(key);
      }
    }
  }

  /** Throttled continuous CC sender (e.g. CC 1 Mod Wheel / CC 11 Expression). */
  public sendCC(ccNumber: number, normalizedValue: number): void {
    if (!this.enabled) return;
    const output = this.getActiveOutput();
    if (!output) return;

    const cc = Math.max(0, Math.min(127, Math.round(ccNumber)));
    const val = Math.max(0, Math.min(127, Math.round(normalizedValue * 127)));
    const now = performance.now();

    if (
      this.lastCCValue.get(cc) === val ||
      now - (this.lastCCSentMs.get(cc) ?? 0) < 28
    ) {
      return;
    }

    this.lastCCValue.set(cc, val);
    this.lastCCSentMs.set(cc, now);
    output.send([0xb0 | this.channel, cc, val]);
  }

  public allNotesOff(): void {
    const output = this.getActiveOutput();
    for (const entry of this.activeNotes.values()) {
      window.clearTimeout(entry.timerId);
      output?.send([0x80 | entry.channel, entry.note, 0]);
    }
    this.activeNotes.clear();
    if (output) {
      output.send([0xb0 | this.channel, 123, 0]);
    }
  }

  private getActiveOutput(): MIDIOutput | null {
    if (!this.access) return null;
    if (this.selectedPortId) {
      const port = this.access.outputs.get(this.selectedPortId);
      if (port && port.state === 'connected') return port;
    }
    for (const port of this.access.outputs.values()) {
      if (port.state === 'connected') return port;
    }
    return null;
  }

  private ensureValidSelectedPort(): void {
    if (!this.access) return;
    if (this.selectedPortId && this.access.outputs.has(this.selectedPortId)) {
      return;
    }
    const first = this.access.outputs.values().next().value as MIDIOutput | undefined;
    this.selectedPortId = first ? first.id : null;
  }

  private emitPorts(): void {
    const ports = this.getOutputs();
    for (const listener of this.listeners) {
      listener(ports, this.isSupported(), this.lastError);
    }
  }
}

export const midiEngine = new MidiEngine();
