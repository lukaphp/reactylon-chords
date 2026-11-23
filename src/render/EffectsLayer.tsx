import { useEffect } from 'react';
import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type LinesMesh,
  type Mesh,
} from '@babylonjs/core';
import { useScene } from 'reactylon';
import type { HandTracker } from '../tracking/HandTracker';
import { transientState, useStringStore } from '../strings/stringStore';

const PARTICLE_POOL_SIZE = 72;
const TRAIL_LENGTH = 10;
const BALL_POOL_SIZE = 24;

interface ParticleSlot {
  mesh: Mesh;
  mat: StandardMaterial;
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  baseScale: number;
}

interface TrailSlot {
  line: LinesMesh;
  points: Vector3[];
  history: Array<{ x: number; y: number }>;
  glowColor: Color3;
}

interface EffectsLayerProps {
  tracker: HandTracker;
}

/**
 * High-performance pooled visual effects layer (zero per-frame allocations / zero React re-renders):
 * - Impact sparks at exact string contact point s
 * - Luminous fingertip trails (especially vivid in Stage Mode)
 * - Ball Sequencer spheres & emitter halo
 * - Expressive hand vertical modulation bar
 */
export function EffectsLayer({ tracker }: EffectsLayerProps) {
  const scene = useScene();

  useEffect(() => {
    // 1) Impact Particle Pool
    const particles: ParticleSlot[] = [];
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const mat = new StandardMaterial(`spark-mat-${i}`, scene);
      mat.disableLighting = true;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = new Color3(0.4, 1, 0.9);

      const mesh = MeshBuilder.CreateDisc(
        `spark-${i}`,
        { radius: 0.014, tessellation: 10 },
        scene,
      );
      mesh.material = mat;
      mesh.isVisible = false;
      mesh.isPickable = false;

      particles.push({
        mesh,
        mat,
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 0.45,
        baseScale: 1,
      });
    }
    let nextParticleIdx = 0;

    const spawnBurst = (
      x: number,
      y: number,
      r: number,
      g: number,
      b: number,
      intensity: number,
    ) => {
      const count = Math.round(6 + intensity * 10);
      for (let i = 0; i < count; i++) {
        const slot = particles[nextParticleIdx];
        nextParticleIdx = (nextParticleIdx + 1) % particles.length;

        const angle = Math.random() * Math.PI * 2;
        const speed = (0.35 + Math.random() * 0.95) * (0.45 + intensity * 0.85);
        slot.active = true;
        slot.x = x;
        slot.y = y;
        slot.vx = Math.cos(angle) * speed;
        slot.vy = Math.sin(angle) * speed;
        slot.life = 0;
        slot.maxLife = 0.28 + Math.random() * 0.28;
        slot.baseScale = 0.6 + intensity * 0.95;
        slot.mat.emissiveColor.set(
          Math.min(1, r * 1.15),
          Math.min(1, g * 1.15),
          Math.min(1, b * 1.15),
        );
        slot.mat.alpha = 1;
        slot.mesh.isVisible = true;
      }
    };

    // 2) Fingertip Light Trails (2 hands, index fingertip)
    const trails: TrailSlot[] = [];
    for (let h = 0; h < 2; h++) {
      const points: Vector3[] = [];
      for (let k = 0; k < TRAIL_LENGTH; k++) {
        points.push(new Vector3(0, 0, -0.7));
      }
      const line = MeshBuilder.CreateLines(
        `finger-trail-${h}`,
        { points, updatable: true },
        scene,
      );
      const glowColor =
        h === 0 ? new Color3(0.25, 0.96, 1.0) : new Color3(1.0, 0.48, 0.92);
      line.color.copyFrom(glowColor);
      line.alpha = 0.85;
      line.isVisible = false;
      line.isPickable = false;
      line.metadata = { glowColor, glowBoost: 1.35 };

      trails.push({ line, points, history: [], glowColor });
    }

    // 3) Ball Sequencer Sphere Pool + Emitter Indicator
    const ballMat = new StandardMaterial('seq-ball-mat', scene);
    ballMat.disableLighting = true;
    ballMat.emissiveColor = new Color3(0.95, 0.98, 1.0);

    const ballMeshes: Mesh[] = [];
    for (let i = 0; i < BALL_POOL_SIZE; i++) {
      const disc = MeshBuilder.CreateDisc(
        `seq-ball-${i}`,
        { radius: 0.028, tessellation: 18 },
        scene,
      );
      disc.material = ballMat;
      disc.isVisible = false;
      disc.isPickable = false;
      ballMeshes.push(disc);
    }

    const emitterMat = new StandardMaterial('seq-emitter-mat', scene);
    emitterMat.disableLighting = true;
    emitterMat.emissiveColor = new Color3(0.32, 0.95, 1.0);
    emitterMat.alpha = 0.82;

    const emitterMesh = MeshBuilder.CreateDisc(
      'seq-emitter-disc',
      { radius: 0.048, tessellation: 24 },
      scene,
    );
    emitterMesh.material = emitterMat;
    emitterMesh.isVisible = false;
    emitterMesh.isPickable = false;

    // 4) Expressive Hand Vertical Modulation Bar (left viewport edge)
    const exprTrackMat = new StandardMaterial('expr-track-mat', scene);
    exprTrackMat.disableLighting = true;
    exprTrackMat.emissiveColor = new Color3(0.25, 0.35, 0.55);
    exprTrackMat.alpha = 0.4;

    const exprFillMat = new StandardMaterial('expr-fill-mat', scene);
    exprFillMat.disableLighting = true;
    exprFillMat.emissiveColor = new Color3(0.3, 1.0, 0.85);
    exprFillMat.alpha = 0.9;

    const exprTrack = MeshBuilder.CreatePlane(
      'expr-meter-track',
      { width: 0.026, height: 1.1 },
      scene,
    );
    exprTrack.material = exprTrackMat;
    exprTrack.isVisible = false;
    exprTrack.isPickable = false;
    exprTrack.metadata = { excludeGlow: true };

    const exprFill = MeshBuilder.CreatePlane(
      'expr-meter-fill',
      { width: 0.026, height: 1.1 },
      scene,
    );
    exprFill.material = exprFillMat;
    exprFill.isVisible = false;
    exprFill.isPickable = false;

    let lastMs = performance.now();

    const obs = scene.onBeforeRenderObservable.add(() => {
      const nowMs = performance.now();
      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - lastMs) / 1000));
      lastMs = nowMs;

      const settings = useStringStore.getState().settings;

      // Consume queued impact bursts -> spawn particles
      if (transientState.pendingImpacts.length > 0) {
        if (settings.particlesEnabled) {
          for (let i = 0; i < transientState.pendingImpacts.length; i++) {
            const ev = transientState.pendingImpacts[i];
            spawnBurst(ev.x, ev.y, ev.r, ev.g, ev.b, ev.intensity);
          }
        }
        transientState.pendingImpacts.length = 0;
      }

      // Update active particles
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p.active) continue;
        p.life += dtSec;
        if (p.life >= p.maxLife) {
          p.active = false;
          p.mesh.isVisible = false;
          continue;
        }
        const progress = p.life / p.maxLife;
        p.vx *= 0.94;
        p.vy = p.vy * 0.94 - 0.55 * dtSec;
        p.x += p.vx * dtSec;
        p.y += p.vy * dtSec;

        const scale = p.baseScale * (1 - progress * 0.8);
        p.mesh.position.set(p.x, p.y, -0.35);
        p.mesh.scaling.set(scale, scale, 1);
        p.mat.alpha = 1 - progress;
      }

      // Update fingertip trails
      const hands = tracker.latestFrame.hands;
      for (let h = 0; h < trails.length; h++) {
        const trail = trails[h];
        const hand = hands.find((x) => x.id === h);
        if (!settings.fingerTrailsEnabled || !hand) {
          trail.history.length = 0;
          trail.line.isVisible = false;
          continue;
        }

        const tip = hand.fingertips[8].position;
        trail.history.unshift({ x: tip.x, y: tip.y });
        if (trail.history.length > TRAIL_LENGTH) {
          trail.history.pop();
        }

        if (trail.history.length < 2) {
          trail.line.isVisible = false;
          continue;
        }

        for (let k = 0; k < TRAIL_LENGTH; k++) {
          const sample = trail.history[Math.min(k, trail.history.length - 1)];
          trail.points[k].set(sample.x, sample.y, -0.72);
        }
        MeshBuilder.CreateLines(`finger-trail-${h}`, {
          points: trail.points,
          instance: trail.line,
        });
        trail.line.isVisible = true;
      }

      // Update Ball Sequencer spheres & emitter
      const balls = transientState.balls;
      for (let i = 0; i < ballMeshes.length; i++) {
        const b = balls[i];
        if (b) {
          ballMeshes[i].isVisible = true;
          ballMeshes[i].position.set(b.x, b.y, -0.3);
        } else {
          ballMeshes[i].isVisible = false;
        }
      }

      if (settings.ballSequencerEnabled) {
        emitterMesh.isVisible = true;
        emitterMesh.position.set(settings.ballEmitterX, settings.ballEmitterY, -0.32);
        const pulse = 1 + 0.14 * Math.sin((nowMs / 1000) * (settings.ballBpm / 60) * Math.PI * 2);
        emitterMesh.scaling.set(pulse, pulse, 1);
      } else {
        emitterMesh.isVisible = false;
      }

      // Update Expressive Hand vertical meter
      const expr = transientState.expression;
      if (settings.expressionHandEnabled && expr.value > 0.015) {
        const leftEdgeX = -tracker.projection.canvasAspect + 0.09;
        exprTrack.isVisible = true;
        exprTrack.position.set(leftEdgeX, 0, -0.6);

        const fillScaleY = Math.max(0.02, expr.value);
        exprFill.isVisible = true;
        exprFill.scaling.set(1, fillScaleY, 1);
        exprFill.position.set(leftEdgeX, -0.55 + 0.55 * fillScaleY, -0.62);
      } else {
        exprTrack.isVisible = false;
        exprFill.isVisible = false;
      }
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      for (const p of particles) {
        p.mesh.dispose();
        p.mat.dispose();
      }
      for (const t of trails) {
        t.line.dispose();
      }
      for (const b of ballMeshes) b.dispose();
      ballMat.dispose();
      emitterMesh.dispose();
      emitterMat.dispose();
      exprTrack.dispose();
      exprTrackMat.dispose();
      exprFill.dispose();
      exprFillMat.dispose();
    };
  }, [scene, tracker]);

  return null;
}
