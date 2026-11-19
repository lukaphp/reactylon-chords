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
import { FINGERTIP_INDICES, HAND_CONNECTIONS } from '../tracking/types';
import { transientState, useStringStore } from '../strings/stringStore';

interface HandOverlayProps {
  tracker: HandTracker;
}

interface HandVisualRig {
  bones: LinesMesh;
  bonePoints: Vector3[][];
  joints: Mesh[];
  pinchCursor: Mesh;
  pinchMat: StandardMaterial;
  tipMat: StandardMaterial;
  jointMat: StandardMaterial;
}

/**
 * Debug hand skeleton overlay (2 hands x 21 joints + 21 bone segments + pinch ring),
 * updated imperatively inside Babylon's render loop with zero React re-renders.
 */
export function HandOverlay({ tracker }: HandOverlayProps) {
  const scene = useScene();
  const visible = useStringStore((s) => s.settings.showHandOverlay);

  useEffect(() => {
    const rigs: HandVisualRig[] = [];

    for (let h = 0; h < 2; h++) {
      const bonePoints: Vector3[][] = HAND_CONNECTIONS.map(() => [
        new Vector3(0, 0, -0.8),
        new Vector3(0, 0, -0.8),
      ]);

      const bones = MeshBuilder.CreateLineSystem(
        `hand-bones-${h}`,
        { lines: bonePoints, updatable: true },
        scene,
      );
      bones.color = h === 0 ? new Color3(0.35, 0.92, 1) : new Color3(0.95, 0.55, 1);
      bones.alpha = 0.65;
      bones.isVisible = false;
      bones.isPickable = false;
      bones.metadata = { excludeGlow: true };

      const jointMat = new StandardMaterial(`hand-joint-mat-${h}`, scene);
      jointMat.disableLighting = true;
      jointMat.emissiveColor = new Color3(0.8, 0.95, 1);
      jointMat.alpha = 0.72;

      const tipMat = new StandardMaterial(`hand-tip-mat-${h}`, scene);
      tipMat.disableLighting = true;
      tipMat.emissiveColor = h === 0 ? new Color3(0.25, 1, 0.88) : new Color3(1, 0.5, 0.9);
      tipMat.alpha = 0.95;

      const joints: Mesh[] = [];
      const tipSet = new Set<number>(FINGERTIP_INDICES);

      for (let j = 0; j < 21; j++) {
        const isTip = tipSet.has(j);
        const disc = MeshBuilder.CreateDisc(
          `hand-${h}-joint-${j}`,
          { radius: isTip ? 0.022 : 0.011, tessellation: 14 },
          scene,
        );
        disc.material = isTip ? tipMat : jointMat;
        disc.isVisible = false;
        disc.isPickable = false;
        disc.metadata = { excludeGlow: !isTip };
        joints.push(disc);
      }

      const pinchMat = new StandardMaterial(`hand-pinch-mat-${h}`, scene);
      pinchMat.disableLighting = true;
      pinchMat.emissiveColor = new Color3(1, 0.92, 0.3);
      pinchMat.alpha = 0.9;

      const pinchCursor = MeshBuilder.CreateDisc(
        `hand-pinch-cursor-${h}`,
        { radius: 0.032, tessellation: 20 },
        scene,
      );
      pinchCursor.material = pinchMat;
      pinchCursor.isVisible = false;
      pinchCursor.isPickable = false;

      rigs.push({
        bones,
        bonePoints,
        joints,
        pinchCursor,
        pinchMat,
        tipMat,
        jointMat,
      });
    }

    const obs = scene.onBeforeRenderObservable.add(() => {
      const showSkeleton = useStringStore.getState().settings.showHandOverlay;
      const hands = tracker.latestFrame.hands;

      for (let r = 0; r < rigs.length; r++) {
        const rig = rigs[r];
        const hand = hands[r];

        if (!hand) {
          rig.bones.isVisible = false;
          rig.pinchCursor.isVisible = false;
          for (const j of rig.joints) j.isVisible = false;
          continue;
        }

        const pinching = Boolean(transientState.activeHandPinch[hand.id]);

        // Always show a subtle fingertip / pinch cursor even when full skeleton debug is toggled off
        if (showSkeleton) {
          for (let c = 0; c < HAND_CONNECTIONS.length; c++) {
            const [aIdx, bIdx] = HAND_CONNECTIONS[c];
            const pa = hand.landmarks[aIdx];
            const pb = hand.landmarks[bIdx];
            rig.bonePoints[c][0].set(pa.x, pa.y, -0.78);
            rig.bonePoints[c][1].set(pb.x, pb.y, -0.78);
          }
          MeshBuilder.CreateLineSystem(`hand-bones-${r}`, {
            lines: rig.bonePoints,
            instance: rig.bones,
          });
          rig.bones.isVisible = true;

          for (let j = 0; j < 21; j++) {
            const p = hand.landmarks[j];
            rig.joints[j].position.set(p.x, p.y, -0.82);
            rig.joints[j].isVisible = true;
          }
        } else {
          rig.bones.isVisible = false;
          // Show only active fingertip cursor(s) cleanly when debug overlay is hidden
          const allTips = useStringStore.getState().settings.allFingertips;
          for (let j = 0; j < 21; j++) {
            const showTip = allTips ? (FINGERTIP_INDICES as readonly number[]).includes(j) : j === 8;
            if (showTip) {
              const p = hand.landmarks[j];
              rig.joints[j].position.set(p.x, p.y, -0.82);
              rig.joints[j].isVisible = true;
            } else {
              rig.joints[j].isVisible = false;
            }
          }
        }

        // Pinch feedback dot
        rig.pinchCursor.isVisible = pinching;
        if (pinching) {
          rig.pinchCursor.position.set(hand.pinchMidpoint.x, hand.pinchMidpoint.y, -0.85);
        }
      }
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      for (const rig of rigs) {
        rig.bones.dispose();
        for (const j of rig.joints) j.dispose();
        rig.pinchCursor.dispose();
        rig.pinchMat.dispose();
        rig.tipMat.dispose();
        rig.jointMat.dispose();
      }
    };
  }, [scene, tracker, visible]);

  return null;
}
