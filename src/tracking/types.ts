export interface Vec2 {
  x: number;
  y: number;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
}

export interface FingertipKinematics {
  landmarkIndex: number;
  position: Vec2;
  prevPosition: Vec2;
  /** Smoothed 2D speed in world units / second (last 3 frames). */
  speed: number;
  /** Speed normalized by handScale (hand-scales / second). */
  normalizedSpeed: number;
}

export interface TrackedHand {
  /** Stable slot ID (0 or 1) across frames. */
  id: number;
  handedness: 'Left' | 'Right' | 'Unknown';
  /** 21 landmarks converted to mirrored 2D orthographic scene coordinates (filtered). */
  landmarks: Vec2[];
  /** Raw normalized landmarks (0..1) from MediaPipe. */
  rawLandmarks: NormalizedLandmark[];
  /** Distance from wrist (0) to index MCP (5) in scene units, for scale-invariant gestures. */
  handScale: number;
  /** Pinch midpoint between thumb tip (4) and index tip (8). */
  pinchMidpoint: Vec2;
  /** Pinch distance divided by handScale. */
  pinchRatio: number;
  /** Kinematics for fingertips [4, 8, 12, 16, 20]. */
  fingertips: Record<number, FingertipKinematics>;
  lastSeenMs: number;
}

export interface HandFrame {
  timestampMs: number;
  hands: TrackedHand[];
}

export interface ViewportProjection {
  canvasWidth: number;
  canvasHeight: number;
  canvasAspect: number;
  videoWidth: number;
  videoHeight: number;
  videoAspect: number;
  /** Video plane width in orthographic scene units (ortho height = 2). */
  planeWidth: number;
  /** Video plane height in orthographic scene units (ortho height = 2). */
  planeHeight: number;
}

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIP_INDICES = [4, 8, 12, 16, 20] as const;

export function computeViewportProjection(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
): ViewportProjection {
  const safeCW = Math.max(1, canvasWidth);
  const safeCH = Math.max(1, canvasHeight);
  const safeVW = Math.max(1, videoWidth);
  const safeVH = Math.max(1, videoHeight);

  const canvasAspect = safeCW / safeCH;
  const videoAspect = safeVW / safeVH;

  // Orthographic vertical span is [-1, +1] -> total height = 2, width = 2 * canvasAspect.
  // Use "cover" scaling so the mirrored webcam fills the viewport without distortion.
  let planeWidth: number;
  let planeHeight: number;
  if (canvasAspect >= videoAspect) {
    planeWidth = 2 * canvasAspect;
    planeHeight = planeWidth / videoAspect;
  } else {
    planeHeight = 2;
    planeWidth = planeHeight * videoAspect;
  }

  return {
    canvasWidth: safeCW,
    canvasHeight: safeCH,
    canvasAspect,
    videoWidth: safeVW,
    videoHeight: safeVH,
    videoAspect,
    planeWidth,
    planeHeight,
  };
}

/**
 * Converts a normalized MediaPipe landmark (0..1, top-left origin)
 * into mirrored 2D orthographic scene space (+X right, +Y up).
 */
export function normalizedToScene(
  nx: number,
  ny: number,
  proj: ViewportProjection,
): Vec2 {
  const mirroredX = 1 - nx;
  return {
    x: (mirroredX - 0.5) * proj.planeWidth,
    y: (0.5 - ny) * proj.planeHeight,
  };
}
