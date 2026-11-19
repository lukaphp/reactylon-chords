import type { Vec2 } from '../tracking/types';

export interface SegmentProjection {
  distance: number;
  /** Parameter t ∈ [0, 1] along segment AB. */
  t: number;
  closestPoint: Vec2;
}

export interface HandleHit {
  stringId: string;
  end: 'A' | 'B';
  distance: number;
  position: Vec2;
}

export interface StringBodyHit {
  stringId: string;
  distance: number;
  t: number;
  closestPoint: Vec2;
}

export interface PluckCollisionResult {
  hit: boolean;
  /** Exact crossing or closest point parameter s ∈ [0, 1] along the string. */
  s: number;
  crossed: boolean;
  distance: number;
}

export function distance2D(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Shortest distance and projection of point P onto segment AB.
 */
export function projectPointOnSegment(p: Vec2, a: Vec2, b: Vec2): SegmentProjection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-8) {
    return {
      distance: Math.hypot(p.x - a.x, p.y - a.y),
      t: 0,
      closestPoint: { x: a.x, y: a.y },
    };
  }

  const rawT = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;

  return {
    distance: Math.hypot(p.x - cx, p.y - cy),
    t,
    closestPoint: { x: cx, y: cy },
  };
}

/**
 * Checks proper intersection between finger motion segment (p1 -> p2) and string segment (a -> b).
 * Returns parameter s ∈ [0, 1] along AB if intersecting, or null otherwise.
 */
export function segmentIntersectionParam(
  p1: Vec2,
  p2: Vec2,
  a: Vec2,
  b: Vec2,
): number | null {
  const rX = p2.x - p1.x;
  const rY = p2.y - p1.y;
  const sX = b.x - a.x;
  const sY = b.y - a.y;

  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-8) return null;

  const qpX = a.x - p1.x;
  const qpY = a.y - p1.y;

  const u = (qpX * sY - qpY * sX) / denom; // along finger path p1->p2
  const v = (qpX * rY - qpY * rX) / denom; // along string a->b

  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    return v;
  }
  return null;
}

/**
 * Combined pluck collision check:
 * 1) Swept segment intersection (catches fast hand movements that skip frames)
 * 2) Point-to-segment proximity (catches gentle/slow touches)
 */
export function testFingerStringCollision(
  prevPos: Vec2,
  currPos: Vec2,
  anchorA: Vec2,
  anchorB: Vec2,
  touchRadius = 0.05,
): PluckCollisionResult {
  const crossS = segmentIntersectionParam(prevPos, currPos, anchorA, anchorB);
  if (crossS !== null) {
    return { hit: true, s: crossS, crossed: true, distance: 0 };
  }

  const proj = projectPointOnSegment(currPos, anchorA, anchorB);
  if (proj.distance <= touchRadius) {
    return { hit: true, s: proj.t, crossed: false, distance: proj.distance };
  }

  return { hit: false, s: proj.t, crossed: false, distance: proj.distance };
}

/**
 * Priority 1 hit-test: anchor handles (generous radius).
 */
export function hitTestHandles<T extends { id: string; anchorA: Vec2; anchorB: Vec2 }>(
  point: Vec2,
  strings: readonly T[],
  radius = 0.13,
): HandleHit | null {
  let best: HandleHit | null = null;
  for (const s of strings) {
    const dA = distance2D(point, s.anchorA);
    if (dA <= radius && (!best || dA < best.distance)) {
      best = { stringId: s.id, end: 'A', distance: dA, position: s.anchorA };
    }
    const dB = distance2D(point, s.anchorB);
    if (dB <= radius && (!best || dB < best.distance)) {
      best = { stringId: s.id, end: 'B', distance: dB, position: s.anchorB };
    }
  }
  return best;
}

/**
 * Priority 2 hit-test: string body segments.
 */
export function hitTestStrings<T extends { id: string; anchorA: Vec2; anchorB: Vec2 }>(
  point: Vec2,
  strings: readonly T[],
  radius = 0.085,
): StringBodyHit | null {
  let best: StringBodyHit | null = null;
  for (const s of strings) {
    const proj = projectPointOnSegment(point, s.anchorA, s.anchorB);
    if (proj.distance <= radius && (!best || proj.distance < best.distance)) {
      best = {
        stringId: s.id,
        distance: proj.distance,
        t: proj.t,
        closestPoint: proj.closestPoint,
      };
    }
  }
  return best;
}

/**
 * Maps normalized 2D finger speed (hand-scales / sec) to pluck intensity ∈ [minIntensity, 1].
 * Even the gentlest touch produces minIntensity > 0.
 */
export function mapSpeedToIntensity(
  normalizedSpeed: number,
  minIntensity = 0.18,
  curveExponent = 0.65,
  maxNormalizedSpeed = 14,
): number {
  const clampedMin = Math.max(0.05, Math.min(0.8, minIntensity));
  const norm = Math.max(0, Math.min(1, normalizedSpeed / maxNormalizedSpeed));
  const curved = Math.pow(norm, Math.max(0.15, curveExponent));
  return clampedMin + (1 - clampedMin) * curved;
}
