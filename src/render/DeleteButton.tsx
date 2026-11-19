import { useEffect, useRef } from 'react';
import {
  Color3,
  DynamicTexture,
  StandardMaterial,
  type Mesh,
} from '@babylonjs/core';
import { useScene } from 'reactylon';
import {
  computeDeleteButtonPosition,
  transientState,
  useStringStore,
} from '../strings/stringStore';
import type { HandTracker } from '../tracking/HandTracker';

interface DeleteButtonProps {
  tracker: HandTracker;
}

function drawDeleteBadge(tex: DynamicTexture, progress: number, hovering: boolean): void {
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const size = tex.getSize().width;
  const half = size / 2;
  ctx.clearRect(0, 0, size, size);

  // Outer glow disc
  ctx.beginPath();
  ctx.arc(half, half, half - 18, 0, Math.PI * 2);
  ctx.fillStyle = hovering ? 'rgba(239, 68, 68, 0.95)' : 'rgba(185, 28, 28, 0.85)';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = hovering ? '#ffffff' : 'rgba(255, 190, 190, 0.9)';
  ctx.stroke();

  // Dwell progress ring
  if (progress > 0.02) {
    ctx.beginPath();
    ctx.arc(
      half,
      half,
      half - 8,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress),
    );
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  // Crisp "X" glyph
  const arm = half * 0.34;
  ctx.beginPath();
  ctx.moveTo(half - arm, half - arm);
  ctx.lineTo(half + arm, half + arm);
  ctx.moveTo(half + arm, half - arm);
  ctx.lineTo(half - arm, half + arm);
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  tex.update();
}

export function DeleteButton({ tracker }: DeleteButtonProps) {
  const scene = useScene();
  const selectedId = useStringStore((s) => s.selectedId);
  const planeRef = useRef<Mesh | null>(null);
  const matRef = useRef<StandardMaterial | null>(null);

  useEffect(() => {
    if (!selectedId) return;

    const plane = planeRef.current;
    const mat = matRef.current;
    if (!plane || !mat) return;

    const tex = new DynamicTexture('delete-btn-tex', { width: 192, height: 192 }, scene, true);
    tex.hasAlpha = true;
    drawDeleteBadge(tex, 0, false);

    plane.metadata = { glowColor: new Color3(1, 0.22, 0.28), glowBoost: 0.7 };
    plane.isPickable = false;

    mat.disableLighting = true;
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;

    let lastQuantizedProgress = -1;
    let lastHover = false;

    const obs = scene.onBeforeRenderObservable.add(() => {
      const state = useStringStore.getState();
      const selected = state.strings.find((s) => s.id === state.selectedId);
      if (!selected) {
        plane.isVisible = false;
        return;
      }

      plane.isVisible = true;
      const pos = computeDeleteButtonPosition(
        selected,
        state.settings.deleteButtonMode,
        tracker.projection.canvasAspect,
      );
      plane.position.set(pos.x, pos.y, -0.55);

      const hover = transientState.deleteHover;
      const hovering = hover.active && hover.stringId === selected.id;
      const progress = hovering ? hover.progress : 0;

      const scale = hovering ? 1.16 + progress * 0.12 : 1.0;
      plane.scaling.set(scale, scale, 1);

      const qProg = Math.round(progress * 40);
      if (qProg !== lastQuantizedProgress || hovering !== lastHover) {
        lastQuantizedProgress = qProg;
        lastHover = hovering;
        drawDeleteBadge(tex, progress, hovering);
      }
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      tex.dispose();
    };
  }, [scene, selectedId, tracker]);

  if (!selectedId) return null;

  return (
    <plane
      ref={planeRef}
      name="delete-selected-string-btn"
      options={{ width: 0.2, height: 0.2 }}
    >
      <standardMaterial ref={matRef} name="delete-selected-string-mat" />
    </plane>
  );
}
