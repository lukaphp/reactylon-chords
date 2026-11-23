import type { TrackedHand } from '../tracking/types';
import type { AirString } from '../strings/stringStore';
import type { PinchState } from './pinch';
import { hitTestStrings } from '../strings/collision';
import { getPalmCenter, isHandFist } from './palmMute';

export interface ExpressionResult {
  active: boolean;
  /** Smoothed normalized expression level [0..1] (maps to Mod Wheel CC1 & FX swell). */
  value: number;
  handId: number | null;
}

/**
 * Open Expressive Hand Controller:
 * When 2 hands are visible (and not creating/dragging), an open non-playing hand held away
 * from strings acts as a smooth vertical Mod Wheel / FX swell controller (bottom = 0, top = 1).
 */
export class ExpressionHandController {
  private smoothedValue = 0;

  public update(
    hands: readonly TrackedHand[],
    pinchesByHand: Map<number, PinchState>,
    strings: readonly AirString[],
    enabled: boolean,
    suppress: boolean,
  ): ExpressionResult {
    if (!enabled || suppress || hands.length < 2) {
      this.smoothedValue *= 0.9;
      if (this.smoothedValue < 0.005) this.smoothedValue = 0;
      return { active: false, value: this.smoothedValue, handId: null };
    }

    // Prefer a Left hand (or whichever open hand is furthest from strings and not pinching/fist)
    let candidate: TrackedHand | null = null;
    let bestScore = -Infinity;

    for (const hand of hands) {
      const pinch = pinchesByHand.get(hand.id);
      if (pinch?.isPinching || isHandFist(hand)) continue;

      const palm = getPalmCenter(hand);
      const indexTip = hand.fingertips[8].position;

      // Hand must be clearly away from strings (so it's modulating, not plucking)
      const nearString =
        hitTestStrings(indexTip, strings, 0.16) ||
        hitTestStrings(palm, strings, 0.18);
      if (nearString) continue;

      // Prefer the steadier hand (lower index speed) and slightly prefer Left hand
      const speed = hand.fingertips[8].normalizedSpeed;
      if (speed > 4.5) continue;

      const score = (hand.handedness === 'Left' ? 1 : 0) - speed * 0.25;
      if (score > bestScore) {
        bestScore = score;
        candidate = hand;
      }
    }

    if (!candidate) {
      this.smoothedValue *= 0.92;
      if (this.smoothedValue < 0.005) this.smoothedValue = 0;
      return { active: false, value: this.smoothedValue, handId: null };
    }

    const palm = getPalmCenter(candidate);
    // Map vertical range [-0.65 .. +0.65] -> [0 .. 1]
    const raw = Math.max(0, Math.min(1, (palm.y + 0.65) / 1.3));
    this.smoothedValue += (raw - this.smoothedValue) * 0.16;

    return {
      active: true,
      value: this.smoothedValue,
      handId: candidate.id,
    };
  }
}
