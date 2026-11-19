import type { TrackedHand, Vec2 } from '../tracking/types';
import type { PinchState } from './pinch';
import { distance2D } from '../strings/collision';
import { lengthToPitch, stringLength, type TuningConfig } from '../strings/tuning';

export const MIN_STRING_LENGTH = 0.22;
const POST_COMMIT_COOLDOWN_MS = 450;
const SNAPSHOT_BUFFER_SIZE = 3;

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
 * 2) Pull hands apart to stretch and tune the string live between both hands.
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

      // If either hand disappears from tracking, cancel safely
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
        // Commit using stabilized snapshot from ~2 frames before finger opening
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

      // Still pinching with both hands -> update endpoints live
      const posA = pinchA!.point;
      const posB = pinchB!.point;
      this.session.anchorA.x = posA.x;
      this.session.anchorA.y = posA.y;
      this.session.anchorB.x = posB.x;
      this.session.anchorB.y = posB.y;

      this.session.history.push({
        a: { x: posA.x, y: posA.y },
        b: { x: posB.x, y: posB.y },
      });
      if (this.session.history.length > SNAPSHOT_BUFFER_SIZE) {
        this.session.history.shift();
      }

      const len = stringLength(posA, posB);
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
    // Distance between the two hands' pinch points (and also check index tips directly)
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

    // Engage creation when both hands meet at a common point and both pinch
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

    // Show magnetic common-point halo when the two hands approach each other
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
