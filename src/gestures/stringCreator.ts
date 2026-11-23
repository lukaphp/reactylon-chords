import type { TrackedHand, Vec2 } from '../tracking/types';
import type { PinchState } from './pinch';
import { distance2D } from '../strings/collision';
import { lengthToPitch, stringLength, type TuningConfig } from '../strings/tuning';

export const MIN_STRING_LENGTH = 0.22;
const POST_COMMIT_COOLDOWN_MS = 450;
const SNAPSHOT_BUFFER_SIZE = 3;
const SNAP_ANGLE_RAD = (6 * Math.PI) / 180; // ±6 degrees magnetic snap

export type SnapAxis = 'horizontal' | 'vertical' | null;

/**
 * Applies gentle ±6° magnetic snap to horizontal or vertical alignment around midpoint.
 */
export function snapEndpointsSymmetric(
  a: Vec2,
  b: Vec2,
  enabled: boolean,
): { a: Vec2; b: Vec2; snappedAxis: SnapAxis } {
  if (!enabled) return { a, b, snappedAxis: null };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < MIN_STRING_LENGTH * 0.6) return { a, b, snappedAxis: null };

  const angleFromHoriz = Math.atan2(Math.abs(dy), Math.abs(dx));
  if (angleFromHoriz <= SNAP_ANGLE_RAD) {
    const midY = (a.y + b.y) * 0.5;
    return {
      a: { x: a.x, y: midY },
      b: { x: b.x, y: midY },
      snappedAxis: 'horizontal',
    };
  }

  const angleFromVert = Math.atan2(Math.abs(dx), Math.abs(dy));
  if (angleFromVert <= SNAP_ANGLE_RAD) {
    const midX = (a.x + b.x) * 0.5;
    return {
      a: { x: midX, y: a.y },
      b: { x: midX, y: b.y },
      snappedAxis: 'vertical',
    };
  }

  return { a, b, snappedAxis: null };
}

/**
 * Applies gentle ±6° magnetic snap for a single dragged endpoint relative to a fixed anchor.
 */
export function snapSingleEndpoint(
  target: Vec2,
  fixed: Vec2,
  enabled: boolean,
): { point: Vec2; snappedAxis: SnapAxis } {
  if (!enabled) return { point: target, snappedAxis: null };
  const dx = target.x - fixed.x;
  const dy = target.y - fixed.y;
  const len = Math.hypot(dx, dy);
  if (len < MIN_STRING_LENGTH * 0.6) return { point: target, snappedAxis: null };

  const angleFromHoriz = Math.atan2(Math.abs(dy), Math.abs(dx));
  if (angleFromHoriz <= SNAP_ANGLE_RAD) {
    return { point: { x: target.x, y: fixed.y }, snappedAxis: 'horizontal' };
  }

  const angleFromVert = Math.atan2(Math.abs(dx), Math.abs(dy));
  if (angleFromVert <= SNAP_ANGLE_RAD) {
    return { point: { x: fixed.x, y: target.y }, snappedAxis: 'vertical' };
  }

  return { point: target, snappedAxis: null };
}

interface AnchorSnapshot {
  a: Vec2;
  b: Vec2;
}

export interface TwoHandReadyHint {
  visible: boolean;
  position: Vec2;
  /** Number of hands currently pinching while close together (0, 1, or 2). */
  pinchingCount: number;
}

export interface TwoHandCreationSession {
  handIdA: number;
  handIdB: number;
  anchorA: Vec2;
  anchorB: Vec2;
  note: string;
  freq: number;
  isValid: boolean;
  snappedAxis: SnapAxis;
  /** Stabilized history so finger-opening jitter at release doesn't shift the placed endpoints. */
  history: AnchorSnapshot[];
}

export interface StringCreationCommit {
  anchorA: Vec2;
  anchorB: Vec2;
  note: string;
  freq: number;
}

export interface TwoHandCreationUpdate {
  active: boolean;
  /** True during active creation OR briefly after commit to suppress accidental plucking. */
  suppressPlay: boolean;
  session: TwoHandCreationSession | null;
  readyHint: TwoHandReadyHint;
  commit: StringCreationCommit | null;
  noteChanged: boolean;
}

/**
 * Two-hand string creation:
 * 1) Bring both hands to a common point and pinch (thumb + index) with both hands.
 * 2) Pull hands apart to stretch and tune the string live between both hands (with optional ±6° magnetic snap).
 * 3) Release either hand's pinch to lock both anchors cleanly in place.
 */
export class StringCreator {
  private session: TwoHandCreationSession | null = null;
  private cooldownUntilMs = 0;

  public isActive(): boolean {
    return this.session !== null;
  }

  public isInCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  public getActiveSession(): TwoHandCreationSession | null {
    return this.session;
  }

  public cancel(): void {
    this.session = null;
  }

  public update(
    hands: readonly TrackedHand[],
    pinchesByHand: Map<number, PinchState>,
    tuning: TuningConfig,
    nowMs: number,
    disabled: boolean,
    snapEnabled = true,
  ): TwoHandCreationUpdate {
    const emptyHint: TwoHandReadyHint = {
      visible: false,
      position: { x: 0, y: 0 },
      pinchingCount: 0,
    };

    if (disabled) {
      this.session = null;
      return {
        active: false,
        suppressPlay: this.isInCooldown(nowMs),
        session: null,
        readyHint: emptyHint,
        commit: null,
        noteChanged: false,
      };
    }

    // --- Active two-hand creation session ---
    if (this.session) {
      const handA = hands.find((h) => h.id === this.session!.handIdA);
      const handB = hands.find((h) => h.id === this.session!.handIdB);

      if (!handA || !handB) {
        this.session = null;
        this.cooldownUntilMs = nowMs + 250;
        return {
          active: false,
          suppressPlay: true,
          session: null,
          readyHint: emptyHint,
          commit: null,
          noteChanged: false,
        };
      }

      const pinchA = pinchesByHand.get(handA.id);
      const pinchB = pinchesByHand.get(handB.id);
      const bothPinching = Boolean(pinchA?.isPinching && pinchB?.isPinching);

      if (!bothPinching) {
        const snap =
          this.session.history.length >= 2
            ? this.session.history[0]
            : { a: { ...this.session.anchorA }, b: { ...this.session.anchorB } };

        const len = stringLength(snap.a, snap.b);
        let commit: StringCreationCommit | null = null;
        if (len >= MIN_STRING_LENGTH) {
          const pitch = lengthToPitch(len, tuning);
          commit = {
            anchorA: { ...snap.a },
            anchorB: { ...snap.b },
            note: pitch.note,
            freq: pitch.freq,
          };
        }

        this.session = null;
        this.cooldownUntilMs = nowMs + POST_COMMIT_COOLDOWN_MS;

        return {
          active: false,
          suppressPlay: true,
          session: null,
          readyHint: emptyHint,
          commit,
          noteChanged: false,
        };
      }

      // Still pinching with both hands -> apply optional magnetic snap & update endpoints live
      const snapped = snapEndpointsSymmetric(pinchA!.point, pinchB!.point, snapEnabled);
      this.session.anchorA.x = snapped.a.x;
      this.session.anchorA.y = snapped.a.y;
      this.session.anchorB.x = snapped.b.x;
      this.session.anchorB.y = snapped.b.y;
      this.session.snappedAxis = snapped.snappedAxis;

      this.session.history.push({
        a: { x: snapped.a.x, y: snapped.a.y },
        b: { x: snapped.b.x, y: snapped.b.y },
      });
      if (this.session.history.length > SNAPSHOT_BUFFER_SIZE) {
        this.session.history.shift();
      }

      const len = stringLength(snapped.a, snapped.b);
      const wasValid = this.session.isValid;
      const prevNote = this.session.note;
      this.session.isValid = len >= MIN_STRING_LENGTH;

      const pitch = lengthToPitch(Math.max(len, MIN_STRING_LENGTH), tuning);
      this.session.note = pitch.note;
      this.session.freq = pitch.freq;

      const noteChanged =
        this.session.isValid && (!wasValid || prevNote !== this.session.note);

      return {
        active: true,
        suppressPlay: true,
        session: this.session,
        readyHint: emptyHint,
        commit: null,
        noteChanged,
      };
    }

    // --- Idle: requires 2 hands close together at a common point ---
    if (hands.length < 2 || this.isInCooldown(nowMs)) {
      return {
        active: false,
        suppressPlay: this.isInCooldown(nowMs),
        session: null,
        readyHint: emptyHint,
        commit: null,
        noteChanged: false,
      };
    }

    const h0 = hands[0];
    const h1 = hands[1];
    const p0 = pinchesByHand.get(h0.id);
    const p1 = pinchesByHand.get(h1.id);
    if (!p0 || !p1) {
      return {
        active: false,
        suppressPlay: false,
        session: null,
        readyHint: emptyHint,
        commit: null,
        noteChanged: false,
      };
    }

    const avgScale = (h0.handScale + h1.handScale) * 0.5;
    const pinchDist = distance2D(p0.point, p1.point);
    const tipDist = distance2D(h0.fingertips[8].position, h1.fingertips[8].position);
    const pairDist = Math.min(pinchDist, tipDist);

    const engageRadius = Math.max(0.22, avgScale * 1.05);
    const hintRadius = engageRadius * 1.45;

    const mid: Vec2 = {
      x: (p0.point.x + p1.point.x) * 0.5,
      y: (p0.point.y + p1.point.y) * 0.5,
    };

    const pinchingCount = (p0.isPinching ? 1 : 0) + (p1.isPinching ? 1 : 0);

    if (pairDist <= engageRadius && p0.isPinching && p1.isPinching) {
      const pitch = lengthToPitch(MIN_STRING_LENGTH, tuning);
      this.session = {
        handIdA: h0.id,
        handIdB: h1.id,
        anchorA: { x: p0.point.x, y: p0.point.y },
        anchorB: { x: p1.point.x, y: p1.point.y },
        note: pitch.note,
        freq: pitch.freq,
        isValid: false,
        snappedAxis: null,
        history: [{ a: { ...p0.point }, b: { ...p1.point } }],
      };

      return {
        active: true,
        suppressPlay: true,
        session: this.session,
        readyHint: emptyHint,
        commit: null,
        noteChanged: false,
      };
    }

    const readyHint: TwoHandReadyHint =
      pairDist <= hintRadius
        ? { visible: true, position: mid, pinchingCount }
        : emptyHint;

    return {
      active: false,
      suppressPlay: false,
      session: null,
      readyHint,
      commit: null,
      noteChanged: false,
    };
  }
}
