import type { Vec2 } from '../tracking/types';
import { distance2D, hitTestStrings } from '../strings/collision';
import {
  computeDeleteButtonPosition,
  type AirString,
  type DeleteButtonMode,
} from '../strings/stringStore';

export const LONG_PRESS_DURATION_MS = 1200;
export const DELETE_DWELL_DURATION_MS = 380;
export const SELECTION_TIMEOUT_MS = 4000;
export const DELETE_BUTTON_HIT_RADIUS = 0.125;
const LONG_PRESS_HIT_RADIUS = 0.085;
const LONG_PRESS_MOVE_TOLERANCE = 0.09;

interface DwellState {
  stringId: string;
  startMs: number;
  anchorPoint: Vec2;
  progress: number;
}

interface DeleteDwellState {
  stringId: string;
  startMs: number;
  progress: number;
}

export interface LongPressUpdateResult {
  /** Non-null on the exact frame a string completes long press and becomes selected. */
  newlySelectedId: string | null;
  /** Active long-press visual progress ring state. */
  ring: {
    active: boolean;
    stringId: string | null;
    progress: number;
    position: Vec2;
  };
}

export interface DeleteCheckResult {
  hovering: boolean;
  progress: number;
  confirmedDeleteId: string | null;
}

/**
 * Handles finger dwell on a string (long press -> selection),
 * delete "X" dwell/pinch confirmation, and 4s auto-deselection timeout.
 */
export class LongPressController {
  private dwellByHand = new Map<number, DwellState>();
  private deleteDwellByHand = new Map<number, DeleteDwellState>();
  private selectedSinceMs = 0;

  public notifySelected(nowMs: number): void {
    this.selectedSinceMs = nowMs;
  }

  public isSelectionExpired(
    selectedId: string | null,
    nowMs: number,
    isHoveringDelete: boolean,
  ): boolean {
    if (!selectedId) return false;
    if (isHoveringDelete) {
      // Keep selection alive while the user is actively aiming at the X button
      this.selectedSinceMs = nowMs;
      return false;
    }
    return nowMs - this.selectedSinceMs >= SELECTION_TIMEOUT_MS;
  }

  public clearHand(handId: number): void {
    this.dwellByHand.delete(handId);
    this.deleteDwellByHand.delete(handId);
  }

  public isDwelling(handId: number): boolean {
    return this.dwellByHand.has(handId);
  }

  public updateStringDwell(
    handId: number,
    fingerPos: Vec2,
    strings: readonly AirString[],
    selectedId: string | null,
    nowMs: number,
    disabled: boolean,
  ): LongPressUpdateResult {
    if (disabled || strings.length === 0) {
      this.dwellByHand.delete(handId);
      return {
        newlySelectedId: null,
        ring: { active: false, stringId: null, progress: 0, position: fingerPos },
      };
    }

    const hit = hitTestStrings(fingerPos, strings, LONG_PRESS_HIT_RADIUS);
    if (!hit || hit.stringId === selectedId) {
      this.dwellByHand.delete(handId);
      return {
        newlySelectedId: null,
        ring: { active: false, stringId: null, progress: 0, position: fingerPos },
      };
    }

    const existing = this.dwellByHand.get(handId);
    if (
      !existing ||
      existing.stringId !== hit.stringId ||
      distance2D(fingerPos, existing.anchorPoint) > LONG_PRESS_MOVE_TOLERANCE
    ) {
      this.dwellByHand.set(handId, {
        stringId: hit.stringId,
        startMs: nowMs,
        anchorPoint: { ...hit.closestPoint },
        progress: 0,
      });
      return {
        newlySelectedId: null,
        ring: {
          active: true,
          stringId: hit.stringId,
          progress: 0,
          position: hit.closestPoint,
        },
      };
    }

    const elapsed = nowMs - existing.startMs;
    const progress = Math.min(1, elapsed / LONG_PRESS_DURATION_MS);
    existing.progress = progress;

    if (progress >= 1) {
      this.dwellByHand.delete(handId);
      this.selectedSinceMs = nowMs;
      return {
        newlySelectedId: hit.stringId,
        ring: { active: false, stringId: null, progress: 0, position: hit.closestPoint },
      };
    }

    return {
      newlySelectedId: null,
      ring: {
        active: elapsed > 140, // slight grace period so quick plucks never flash the ring
        stringId: hit.stringId,
        progress,
        position: existing.anchorPoint,
      },
    };
  }

  /**
   * Checks whether a hand's index fingertip (dwell) or pinch hits the selected string's "X" button.
   */
  public checkDeleteButton(
    handId: number,
    fingerPos: Vec2,
    pinchPoint: Vec2,
    pinchJustStarted: boolean,
    selectedString: AirString | null,
    mode: DeleteButtonMode,
    canvasAspect: number,
    nowMs: number,
  ): DeleteCheckResult {
    if (!selectedString) {
      this.deleteDwellByHand.delete(handId);
      return { hovering: false, progress: 0, confirmedDeleteId: null };
    }

    const btnPos = computeDeleteButtonPosition(selectedString, mode, canvasAspect);

    // Immediate confirm on pinch directly over the X button
    if (pinchJustStarted && distance2D(pinchPoint, btnPos) <= DELETE_BUTTON_HIT_RADIUS * 1.15) {
      this.deleteDwellByHand.delete(handId);
      return {
        hovering: true,
        progress: 1,
        confirmedDeleteId: selectedString.id,
      };
    }

    // Short dwell of index fingertip over the X button
    const fingerOnBtn = distance2D(fingerPos, btnPos) <= DELETE_BUTTON_HIT_RADIUS;
    if (!fingerOnBtn) {
      this.deleteDwellByHand.delete(handId);
      return { hovering: false, progress: 0, confirmedDeleteId: null };
    }

    const existing = this.deleteDwellByHand.get(handId);
    if (!existing || existing.stringId !== selectedString.id) {
      this.deleteDwellByHand.set(handId, {
        stringId: selectedString.id,
        startMs: nowMs,
        progress: 0,
      });
      return { hovering: true, progress: 0, confirmedDeleteId: null };
    }

    const progress = Math.min(1, (nowMs - existing.startMs) / DELETE_DWELL_DURATION_MS);
    existing.progress = progress;

    if (progress >= 1) {
      this.deleteDwellByHand.delete(handId);
      return {
        hovering: true,
        progress: 1,
        confirmedDeleteId: selectedString.id,
      };
    }

    return { hovering: true, progress, confirmedDeleteId: null };
  }
}
