import type { Vec2 } from '../tracking/types';
import { MIN_STRING_LENGTH } from './stringCreator';
import { distance2D } from '../strings/collision';

export interface AnchorDragSession {
  handId: number;
  stringId: string;
  end: 'A' | 'B';
}

/**
 * Manages grabbing and dragging an existing string anchor handle per hand.
 */
export class AnchorDragController {
  private sessions = new Map<number, AnchorDragSession>();

  public isActive(handId: number): boolean {
    return this.sessions.has(handId);
  }

  public getSession(handId: number): AnchorDragSession | null {
    return this.sessions.get(handId) ?? null;
  }

  public isStringBeingDragged(stringId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.stringId === stringId) return true;
    }
    return false;
  }

  public start(handId: number, stringId: string, end: 'A' | 'B'): AnchorDragSession {
    const session: AnchorDragSession = { handId, stringId, end };
    this.sessions.set(handId, session);
    return session;
  }

  /**
   * Computes a clamped target position for the dragged anchor so the string never
   * collapses below MIN_STRING_LENGTH.
   */
  public clampPosition(target: Vec2, fixedAnchor: Vec2): Vec2 {
    const dist = distance2D(target, fixedAnchor);
    if (dist >= MIN_STRING_LENGTH) {
      return target;
    }
    if (dist < 1e-5) {
      return { x: fixedAnchor.x + MIN_STRING_LENGTH, y: fixedAnchor.y };
    }
    const scale = MIN_STRING_LENGTH / dist;
    return {
      x: fixedAnchor.x + (target.x - fixedAnchor.x) * scale,
      y: fixedAnchor.y + (target.y - fixedAnchor.y) * scale,
    };
  }

  /** Safely releases drag (both on pinch release and on hand lost; anchor stays where it is). */
  public end(handId: number): AnchorDragSession | null {
    const session = this.sessions.get(handId) ?? null;
    this.sessions.delete(handId);
    return session;
  }
}
