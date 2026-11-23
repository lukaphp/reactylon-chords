import type { TrackedHand, Vec2 } from '../tracking/types';
import type { AirString } from '../strings/stringStore';
import { distance2D, hitTestStrings } from '../strings/collision';

const FIST_FINGER_TIPS = [8, 12, 16, 20] as const;
const FIST_MCP_INDICES = [5, 9, 13, 17] as const;
const PALM_MUTE_RADIUS = 0.135;

export interface PalmMuteResult {
  isFist: boolean;
  palmCenter: Vec2;
  mutedStringIds: string[];
}

/**
 * Computes approximate palm center from wrist (0) and MCP knuckles (5, 9, 13, 17).
 */
export function getPalmCenter(hand: TrackedHand): Vec2 {
  const lm = hand.landmarks;
  if (lm.length < 21) return hand.pinchMidpoint;
  const x = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
  const y = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
  return { x, y };
}

/**
 * Detects a closed fist posture: all 4 fingertips (index, middle, ring, pinky)
 * are curled closely toward the palm center relative to handScale.
 */
export function isHandFist(hand: TrackedHand): boolean {
  const lm = hand.landmarks;
  if (lm.length < 21) return false;

  const palm = getPalmCenter(hand);
  const wrist = lm[0];
  let curledCount = 0;

  for (let i = 0; i < FIST_FINGER_TIPS.length; i++) {
    const tip = lm[FIST_FINGER_TIPS[i]];
    const mcp = lm[FIST_MCP_INDICES[i]];
    const tipToPalm = distance2D(tip, palm);
    const tipToWrist = distance2D(tip, wrist);
    const mcpToWrist = distance2D(mcp, wrist);

    // Finger is curled if fingertip is closer to palm than 0.92 * handScale
    // or pulled back below/near its own knuckle relative to the wrist
    if (tipToPalm < hand.handScale * 0.92 || tipToWrist < mcpToWrist * 1.12) {
      curledCount++;
    }
  }

  return curledCount >= 4;
}

/**
 * Checks if a closed fist overlaps any currently vibrating strings to immediately damp them.
 */
export function detectPalmMute(
  hand: TrackedHand,
  strings: readonly AirString[],
): PalmMuteResult {
  const palmCenter = getPalmCenter(hand);
  const fist = isHandFist(hand);
  if (!fist || strings.length === 0) {
    return { isFist: fist, palmCenter, mutedStringIds: [] };
  }

  const mutedStringIds: string[] = [];
  for (const str of strings) {
    if (str.vibration.amplitude <= 0.0005) continue;
    const hit = hitTestStrings(palmCenter, [str], Math.max(PALM_MUTE_RADIUS, hand.handScale * 0.65));
    if (hit) {
      mutedStringIds.push(str.id);
    }
  }

  return { isFist: true, palmCenter, mutedStringIds };
}
