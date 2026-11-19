import type { TrackedHand, Vec2 } from '../tracking/types';

/**
 * Hysteresis thresholds relative to handScale (wrist 0 -> index MCP 5).
 * Enter pinch when thumb-index distance < 34% of hand scale; release above 48%.
 */
const PINCH_ENTER_RATIO = 0.34;
const PINCH_EXIT_RATIO = 0.48;

export interface PinchState {
  isPinching: boolean;
  justStarted: boolean;
  justEnded: boolean;
  point: Vec2;
  ratio: number;
}

export class PinchDetector {
  private pinchingByHand = new Map<number, boolean>();

  public update(hand: TrackedHand): PinchState {
    const prev = this.pinchingByHand.get(hand.id) ?? false;
    let next = prev;

    if (!prev && hand.pinchRatio < PINCH_ENTER_RATIO) {
      next = true;
    } else if (prev && hand.pinchRatio > PINCH_EXIT_RATIO) {
      next = false;
    }

    this.pinchingByHand.set(hand.id, next);

    return {
      isPinching: next,
      justStarted: !prev && next,
      justEnded: prev && !next,
      point: hand.pinchMidpoint,
      ratio: hand.pinchRatio,
    };
  }

  public resetHand(handId: number): void {
    this.pinchingByHand.set(handId, false);
  }
}
