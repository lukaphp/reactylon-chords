import type { Vec2 } from '../tracking/types';
import type { AirString } from '../strings/stringStore';
import {
  projectPointOnSegment,
  segmentIntersectionParam,
} from '../strings/collision';

export interface SequencerBall {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  ageSec: number;
  bounces: number;
  /** Cooldown per string so a ball never double-triggers the same string on consecutive frames. */
  lastHitStringId: string | null;
  lastHitMs: number;
}

export interface BallImpactEvent {
  string: AirString;
  s: number;
  intensity: number;
  position: Vec2;
}

export interface BallSequencerConfig {
  enabled: boolean;
  bpm: number;
  gravity: number; // world units / s^2
  restitution: number; // 0.5..1.05
  emitter: Vec2;
}

const MAX_BALLS = 24;
const MAX_AGE_SEC = 9;
const MAX_BOUNCES = 14;
const BALL_RADIUS = 0.026;

/**
 * Physical 2D Ball Sequencer (Electroplankton-style):
 * Spawns luminous spheres from an emitter at BPM cadence; balls fall under gravity,
 * bounce off air strings according to their angle, and trigger audio + MIDI + vibration.
 */
export class BallSequencer {
  public balls: SequencerBall[] = [];
  private nextId = 1;
  private spawnAccumulatorSec = 0;

  public clear(): void {
    this.balls = [];
    this.spawnAccumulatorSec = 0;
  }

  public spawnBall(emitter: Vec2): void {
    if (this.balls.length >= MAX_BALLS) {
      this.balls.shift();
    }
    this.balls.push({
      id: this.nextId++,
      x: emitter.x,
      y: emitter.y,
      vx: (Math.random() - 0.5) * 0.04,
      vy: -0.05,
      radius: BALL_RADIUS,
      ageSec: 0,
      bounces: 0,
      lastHitStringId: null,
      lastHitMs: -Infinity,
    });
  }

  public step(
    dtSec: number,
    nowMs: number,
    config: BallSequencerConfig,
    strings: readonly AirString[],
    canvasAspect: number,
  ): BallImpactEvent[] {
    const impacts: BallImpactEvent[] = [];

    if (config.enabled) {
      const intervalSec = 60 / Math.max(30, Math.min(240, config.bpm));
      this.spawnAccumulatorSec += dtSec;
      if (this.spawnAccumulatorSec >= intervalSec) {
        this.spawnAccumulatorSec %= intervalSec;
        this.spawnBall(config.emitter);
      }
    } else {
      this.spawnAccumulatorSec = 0;
    }

    const boundX = canvasAspect + 0.35;
    const boundY = 1.35;

    for (let bIdx = this.balls.length - 1; bIdx >= 0; bIdx--) {
      const ball = this.balls[bIdx];
      ball.ageSec += dtSec;

      const prevX = ball.x;
      const prevY = ball.y;

      ball.vy -= config.gravity * dtSec;
      ball.x += ball.vx * dtSec;
      ball.y += ball.vy * dtSec;

      // Test collision against every string
      for (let sIdx = 0; sIdx < strings.length; sIdx++) {
        const str = strings[sIdx];
        if (ball.lastHitStringId === str.id && nowMs - ball.lastHitMs < 90) {
          continue;
        }

        const crossS = segmentIntersectionParam(
          { x: prevX, y: prevY },
          { x: ball.x, y: ball.y },
          str.anchorA,
          str.anchorB,
        );
        const proj = projectPointOnSegment(
          { x: ball.x, y: ball.y },
          str.anchorA,
          str.anchorB,
        );

        if (crossS !== null || proj.distance <= ball.radius + 0.012) {
          const hitS = crossS ?? proj.t;
          const dx = str.anchorB.x - str.anchorA.x;
          const dy = str.anchorB.y - str.anchorA.y;
          const len = Math.max(Math.hypot(dx, dy), 1e-4);

          // Unit normal facing incoming side of the ball
          let nx = -dy / len;
          let ny = dx / len;
          const dot = ball.vx * nx + ball.vy * ny;
          if (dot > 0) {
            nx = -nx;
            ny = -ny;
          }

          const incomingNormalSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
          const totalSpeed = Math.hypot(ball.vx, ball.vy);

          // Reflect velocity across string normal
          const vn = ball.vx * nx + ball.vy * ny;
          ball.vx = (ball.vx - (1 + config.restitution) * vn * nx) * 0.99;
          ball.vy = (ball.vy - (1 + config.restitution) * vn * ny) * 0.99;

          // Push ball slightly outside string to avoid sticking
          const hitX = str.anchorA.x + dx * hitS;
          const hitY = str.anchorA.y + dy * hitS;
          ball.x = hitX + nx * (ball.radius + 0.016);
          ball.y = hitY + ny * (ball.radius + 0.016);

          ball.bounces += 1;
          ball.lastHitStringId = str.id;
          ball.lastHitMs = nowMs;

          const intensity = Math.max(
            0.2,
            Math.min(1, (incomingNormalSpeed * 0.65 + totalSpeed * 0.35) / 2.6),
          );

          impacts.push({
            string: str,
            s: hitS,
            intensity,
            position: { x: hitX, y: hitY },
          });
          break;
        }
      }

      if (
        ball.ageSec > MAX_AGE_SEC ||
        ball.bounces > MAX_BOUNCES ||
        Math.abs(ball.x) > boundX ||
        ball.y < -boundY ||
        ball.y > boundY + 0.5
      ) {
        this.balls.splice(bIdx, 1);
      }
    }

    return impacts;
  }
}
