import type { Vec2 } from '../tracking/types';
import { MIN_STRING_LENGTH, snapSingleEndpoint } from './stringCreator';
import { distance2D } from '../strings/collision';

export type DragMode = 'A' | 'B' | 'body';

export interface AnchorDragSession {
  handId: number;
  stringId: string;
  mode: DragMode;
  /** Used when mode === 'body' to translate the entire string preserving length & pitch. */
  startPinch: Vec2;
  origA: Vec2;
  origB: Vec2;
}

/**
 * Manages grabbing and dragging an existing string anchor handle ('A' | 'B')
 * OR translating an entire selected string ('body') without changing its length/pitch.
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

  public startHandle(
    handId: number,
    stringId: string,
    end: 'A' | 'B',
  ): AnchorDragSession {
    const session: AnchorDragSession = {
      handId,
      stringId,
      mode: end,
      startPinch: { x: 0, y: 0 },
      origA: { x: 0, y: 0 },
      origB: { x: 0, y: 0 },
    };
    this.sessions.set(handId, session);
    return session;
  }

  public startBodyMove(
    handId: number,
    stringId: string,
    startPinch: Vec2,
    origA: Vec2,
    origB: Vec2,
  ): AnchorDragSession {
    const session: AnchorDragSession = {
      handId,
      stringId,
      mode: 'body',
      startPinch: { ...startPinch },
      origA: { ...origA },
      origB: { ...origB },
    };
    this.sessions.set(handId, session);
    return session;
  }

  public computeTranslatedAnchors(
    session: AnchorDragSession,
    currentPinch: Vec2,
  ): { anchorA: Vec2; anchorB: Vec2 } {
    const dx = currentPinch.x - session.startPinch.x;
    const dy = currentPinch.y - session.startPinch.y;
    return {
      anchorA: { x: session.origA.x + dx, y: session.origA.y + dy },
      anchorB: { x: session.origB.x + dx, y: session.origB.y + dy },
    };
  }

  /**
   * Computes a clamped (and optionally ±6° snapped) target position for a dragged anchor
   * so the string never collapses below MIN_STRING_LENGTH.
   */
  public clampAndSnapPosition(
    target: Vec2,
    fixedAnchor: Vec2,
    snapEnabled: boolean,
  ): Vec2 {
    const snapped = snapSingleEndpoint(target, fixedAnchor, snapEnabled).point;
    const dist = distance2D(snapped, fixedAnchor);
    if (dist >= MIN_STRING_LENGTH) {
      return snapped;
    }
    if (dist < 1e-5) {
      return { x: fixedAnchor.x + MIN_STRING_LENGTH, y: fixedAnchor.y };
    }
    const scale = MIN_STRING_LENGTH / dist;
    return {
      x: fixedAnchor.x + (snapped.x - fixedAnchor.x) * scale,
      y: fixedAnchor.y + (snapped.y - fixedAnchor.y) * scale,
    };
  }

  /** Safely releases drag (both on pinch release and on hand lost; anchor stays where it is). */
  public end(handId: number): AnchorDragSession | null {
    const session = this.sessions.get(handId) ?? null;
    this.sessions.delete(handId);
    return session;
  }
}
