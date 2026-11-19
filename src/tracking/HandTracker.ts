import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroFilter2D } from './oneEuroFilter';
import {
  computeViewportProjection,
  FINGERTIP_INDICES,
  normalizedToScene,
  type FingertipKinematics,
  type HandFrame,
  type NormalizedLandmark,
  type TrackedHand,
  type Vec2,
  type ViewportProjection,
} from './types';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL_WASM_ROOT = '/mediapipe-wasm';
const HAND_RESET_TIMEOUT_MS = 280;
const VELOCITY_HISTORY_LEN = 3;

interface SlotState {
  id: number;
  filters: OneEuroFilter2D[];
  lastSeenMs: number;
  lastWrist: Vec2 | null;
  handedness: 'Left' | 'Right' | 'Unknown';
  prevTips: Record<number, Vec2>;
  speedHistory: Record<number, number[]>;
}

function createSlot(id: number, minCutoff: number, beta: number): SlotState {
  const filters: OneEuroFilter2D[] = [];
  for (let i = 0; i < 21; i++) {
    filters.push(new OneEuroFilter2D(minCutoff, beta, 1.0));
  }
  return {
    id,
    filters,
    lastSeenMs: -Infinity,
    lastWrist: null,
    handedness: 'Unknown',
    prevTips: {},
    speedHistory: {},
  };
}

function dist2D(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Non-reactive HandTracker: owns webcam stream, hidden <video>, MediaPipe HandLandmarker,
 * One Euro Filters, and writes the latest HandFrame into a mutable field read by Babylon's render loop.
 */
export class HandTracker {
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: HandLandmarker | null = null;
  private rafId: number | null = null;
  private lastVideoTime = -1;
  private running = false;

  private minCutoff = 1.5;
  private beta = 0.08;
  private slots: [SlotState, SlotState];

  /** Non-reactive latest frame read by Babylon scene.onBeforeRenderObservable. */
  public latestFrame: HandFrame = { timestampMs: 0, hands: [] };

  /** Current orthographic projection mapping normalized video coords -> 2D scene coords. */
  public projection: ViewportProjection = computeViewportProjection(
    window.innerWidth || 1280,
    window.innerHeight || 720,
    1280,
    720,
  );

  constructor() {
    this.slots = [
      createSlot(0, this.minCutoff, this.beta),
      createSlot(1, this.minCutoff, this.beta),
    ];
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.video;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public updateCanvasSize(canvasWidth: number, canvasHeight: number): void {
    const vw = this.video?.videoWidth || this.projection.videoWidth;
    const vh = this.video?.videoHeight || this.projection.videoHeight;
    this.projection = computeViewportProjection(canvasWidth, canvasHeight, vw, vh);
  }

  public setFilterParams(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
    for (const slot of this.slots) {
      for (const f of slot.filters) {
        f.setParams(minCutoff, beta, 1.0);
      }
    }
  }

  public async start(
    onStatus?: (message: string) => void,
  ): Promise<HTMLVideoElement> {
    if (this.running && this.video) {
      return this.video;
    }

    onStatus?.('Richiesta accesso webcam...');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 24 },
        facingMode: 'user',
      },
      audio: false,
    });
    this.stream = stream;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Errore caricamento stream webcam'));
    });
    await video.play();
    this.video = video;

    this.projection = computeViewportProjection(
      window.innerWidth || 1280,
      window.innerHeight || 720,
      video.videoWidth || 1280,
      video.videoHeight || 720,
    );

    onStatus?.('Caricamento modello MediaPipe HandLandmarker...');
    const vision = await FilesetResolver.forVisionTasks(LOCAL_WASM_ROOT);

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch {
      onStatus?.('GPU non disponibile per MediaPipe, fallback su CPU...');
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }

    this.running = true;
    this.lastVideoTime = -1;
    onStatus?.('Pronto');
    this.loop();
    return video;
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.latestFrame = { timestampMs: performance.now(), hands: [] };
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const video = this.video;
    const landmarker = this.landmarker;
    if (!video || !landmarker || video.readyState < 2) return;

    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    const nowMs = performance.now();
    const result = landmarker.detectForVideo(video, nowMs);

    const rawHands = result.landmarks ?? [];
    const handednesses = result.handednesses ?? [];

    if (rawHands.length === 0) {
      this.latestFrame = { timestampMs: nowMs, hands: [] };
      return;
    }

    // Match detected hands to persistent slots (0 / 1) by nearest wrist to avoid ID swaps.
    const candidates = rawHands.map((lm, idx) => {
      const wristScene = normalizedToScene(lm[0].x, lm[0].y, this.projection);
      const rawLabel = handednesses[idx]?.[0]?.categoryName;
      // Because camera is mirrored, flip MediaPipe's label for intuitive user perspective.
      const handedness: 'Left' | 'Right' | 'Unknown' =
        rawLabel === 'Left' ? 'Right' : rawLabel === 'Right' ? 'Left' : 'Unknown';
      return { lm, wristScene, handedness };
    });

    const assignedSlots: number[] = [];
    const usedSlots = new Set<number>();

    if (candidates.length === 2) {
      const s0 = this.slots[0];
      const s1 = this.slots[1];
      const dDirect =
        (s0.lastWrist ? dist2D(candidates[0].wristScene, s0.lastWrist) : 0) +
        (s1.lastWrist ? dist2D(candidates[1].wristScene, s1.lastWrist) : 0);
      const dSwap =
        (s1.lastWrist ? dist2D(candidates[0].wristScene, s1.lastWrist) : 0) +
        (s0.lastWrist ? dist2D(candidates[1].wristScene, s0.lastWrist) : 0);

      if (dSwap < dDirect) {
        assignedSlots.push(1, 0);
      } else {
        assignedSlots.push(0, 1);
      }
    } else {
      const c = candidates[0];
      let bestSlot = 0;
      let bestScore = Infinity;
      for (const slot of this.slots) {
        if (usedSlots.has(slot.id)) continue;
        const recent = nowMs - slot.lastSeenMs < HAND_RESET_TIMEOUT_MS * 2;
        if (recent && slot.lastWrist) {
          const score = dist2D(c.wristScene, slot.lastWrist);
          if (score < bestScore) {
            bestScore = score;
            bestSlot = slot.id;
          }
        } else if (bestScore === Infinity && slot.handedness === c.handedness) {
          bestSlot = slot.id;
        }
      }
      assignedSlots.push(bestSlot);
    }

    const trackedHands: TrackedHand[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const slot = this.slots[assignedSlots[i]];
      const { lm, handedness } = candidates[i];
      const dtMs = nowMs - slot.lastSeenMs;
      const isFresh = dtMs > HAND_RESET_TIMEOUT_MS;

      if (isFresh) {
        for (const f of slot.filters) f.reset();
        slot.prevTips = {};
        slot.speedHistory = {};
      }

      const dtSec = Math.max(dtMs / 1000, 1 / 120);
      const filteredLandmarks: Vec2[] = new Array(21);
      const rawNormalized: NormalizedLandmark[] = new Array(21);

      for (let j = 0; j < 21; j++) {
        const raw = lm[j];
        rawNormalized[j] = { x: raw.x, y: raw.y, z: raw.z };
        const scenePt = normalizedToScene(raw.x, raw.y, this.projection);
        filteredLandmarks[j] = slot.filters[j].filter(scenePt, nowMs);
      }

      const wrist = filteredLandmarks[0];
      const indexMcp = filteredLandmarks[5];
      const handScale = Math.max(dist2D(wrist, indexMcp), 0.06);

      const thumbTip = filteredLandmarks[4];
      const indexTip = filteredLandmarks[8];
      const pinchMidpoint: Vec2 = {
        x: (thumbTip.x + indexTip.x) * 0.5,
        y: (thumbTip.y + indexTip.y) * 0.5,
      };
      const pinchRatio = dist2D(thumbTip, indexTip) / handScale;

      const fingertips: Record<number, FingertipKinematics> = {};
      for (const tipIdx of FINGERTIP_INDICES) {
        const curr = filteredLandmarks[tipIdx];
        const prev = slot.prevTips[tipIdx] ?? curr;
        const instantSpeed = isFresh ? 0 : dist2D(curr, prev) / dtSec;

        const hist = slot.speedHistory[tipIdx] ?? [];
        hist.push(instantSpeed);
        if (hist.length > VELOCITY_HISTORY_LEN) hist.shift();
        slot.speedHistory[tipIdx] = hist;

        let sum = 0;
        for (let k = 0; k < hist.length; k++) sum += hist[k];
        const smoothedSpeed = sum / hist.length;

        fingertips[tipIdx] = {
          landmarkIndex: tipIdx,
          position: curr,
          prevPosition: prev,
          speed: smoothedSpeed,
          normalizedSpeed: smoothedSpeed / handScale,
        };
        slot.prevTips[tipIdx] = curr;
      }

      slot.lastSeenMs = nowMs;
      slot.lastWrist = wrist;
      slot.handedness = handedness;

      trackedHands.push({
        id: slot.id,
        handedness,
        landmarks: filteredLandmarks,
        rawLandmarks: rawNormalized,
        handScale,
        pinchMidpoint,
        pinchRatio,
        fingertips,
        lastSeenMs: nowMs,
      });
    }

    this.latestFrame = {
      timestampMs: nowMs,
      hands: trackedHands,
    };
  };
}
