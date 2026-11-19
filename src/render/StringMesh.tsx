import { useEffect, useRef } from 'react';
import {
  Color3,
  DynamicTexture,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type LinesMesh,
  type Mesh,
} from '@babylonjs/core';
import { useScene } from 'reactylon';
import { transientState, useStringStore, type AirString } from '../strings/stringStore';

const STRING_SEGMENTS = 32;
const HANDLE_BASE_RADIUS = 0.036;

interface StringMeshProps {
  stringData: AirString;
}

/**
 * Maps normalized pitch (0 low -> 1 high) to a vivid neon palette (warm violet/cyan -> electric mint/gold).
 */
export function pitchToNeonColor(normalizedPitch: number): Color3 {
  const t = Math.max(0, Math.min(1, normalizedPitch));
  // Smooth HSL-inspired interpolation: deep indigo/magenta (low) -> electric cyan (mid) -> warm amber (high)
  if (t < 0.5) {
    const k = t * 2;
    return new Color3(
      0.85 * (1 - k) + 0.15 * k,
      0.28 * (1 - k) + 0.92 * k,
      1.0,
    );
  }
  const k = (t - 0.5) * 2;
  return new Color3(
    0.15 * (1 - k) + 1.0 * k,
    0.92 * (1 - k) + 0.82 * k,
    1.0 * (1 - k) + 0.35 * k,
  );
}

function drawNoteBadge(
  tex: DynamicTexture,
  note: string,
  selected: boolean,
  accentHex: string,
): void {
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const w = tex.getSize().width;
  const h = tex.getSize().height;
  ctx.clearRect(0, 0, w, h);

  // Pill background
  const padX = 14;
  const padY = 12;
  const radius = (h - padY * 2) / 2;
  ctx.beginPath();
  ctx.roundRect(padX, padY, w - padX * 2, h - padY * 2, radius);
  ctx.fillStyle = selected ? 'rgba(255, 226, 120, 0.92)' : 'rgba(10, 14, 24, 0.78)';
  ctx.fill();
  ctx.lineWidth = selected ? 4 : 2.5;
  ctx.strokeStyle = selected ? '#ffffff' : accentHex;
  ctx.stroke();

  // Note label text
  ctx.font = '700 44px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = selected ? '#111622' : '#f4f8ff';
  ctx.fillText(note, w / 2, h / 2 + 2);

  tex.update();
}

export function StringMesh({ stringData }: StringMeshProps) {
  const scene = useScene();

  const handleARef = useRef<Mesh | null>(null);
  const handleBRef = useRef<Mesh | null>(null);
  const ringARef = useRef<Mesh | null>(null);
  const ringBRef = useRef<Mesh | null>(null);
  const handleAMatRef = useRef<StandardMaterial | null>(null);
  const handleBMatRef = useRef<StandardMaterial | null>(null);
  const ringAMatRef = useRef<StandardMaterial | null>(null);
  const ringBMatRef = useRef<StandardMaterial | null>(null);
  const labelPlaneRef = useRef<Mesh | null>(null);
  const labelMatRef = useRef<StandardMaterial | null>(null);

  // Keep latest reactive prop accessible inside Babylon render loop without re-subscribing
  const dataRef = useRef<AirString>(stringData);
  dataRef.current = stringData;

  useEffect(() => {
    const id = stringData.id;

    // Pre-allocate 33 vertices for zero-GC per-frame updates
    const points: Vector3[] = [];
    for (let i = 0; i <= STRING_SEGMENTS; i++) {
      points.push(new Vector3(0, 0, 0));
    }

    const linesMesh: LinesMesh = MeshBuilder.CreateLines(
      `string-line-${id}`,
      { points, updatable: true },
      scene,
    );
    linesMesh.isPickable = false;

    // Secondary offset line gives extra visual thickness & richer neon core in WebGL
    const corePoints: Vector3[] = [];
    for (let i = 0; i <= STRING_SEGMENTS; i++) {
      corePoints.push(new Vector3(0, 0, -0.02));
    }
    const coreLines: LinesMesh = MeshBuilder.CreateLines(
      `string-core-${id}`,
      { points: corePoints, updatable: true },
      scene,
    );
    coreLines.isPickable = false;

    const glowColor = new Color3(0.4, 0.9, 1);
    linesMesh.metadata = { glowColor, glowBoost: 1.1 };
    coreLines.metadata = { glowColor, glowBoost: 1.5 };

    // DynamicTexture for crisp floating note badge
    const labelTex = new DynamicTexture(
      `string-note-tex-${id}`,
      { width: 220, height: 96 },
      scene,
      true,
    );
    labelTex.hasAlpha = true;

    const labelPlane = labelPlaneRef.current;
    const labelMat = labelMatRef.current;
    if (labelPlane && labelMat) {
      labelPlane.metadata = { excludeGlow: true };
      labelPlane.isPickable = false;
      labelMat.disableLighting = true;
      labelMat.diffuseTexture = labelTex;
      labelMat.emissiveTexture = labelTex;
      labelMat.opacityTexture = labelTex;
      labelMat.useAlphaFromDiffuseTexture = true;
      labelMat.backFaceCulling = false;
    }

    for (const mat of [
      handleAMatRef.current,
      handleBMatRef.current,
      ringAMatRef.current,
      ringBMatRef.current,
    ]) {
      if (mat) {
        mat.disableLighting = true;
        mat.diffuseColor = Color3.Black();
        mat.specularColor = Color3.Black();
      }
    }

    let lastRenderedNote = '';
    let lastRenderedSelected: boolean | null = null;
    const selectedColor = new Color3(1.0, 0.9, 0.35);
    const whiteColor = new Color3(1, 1, 1);

    const obs = scene.onBeforeRenderObservable.add(() => {
      const s = dataRef.current;
      const a = s.anchorA;
      const b = s.anchorB;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(Math.hypot(dx, dy), 1e-4);

      // Unit normal orthogonal to the string
      const nx = -dy / len;
      const ny = dx / len;

      // Standing-wave vibration: y(s, t) = A · sin(π·s) · sin(ω·t) · e^(−d·t)
      const vib = s.vibration;
      let env = 0;
      let wave = 0;
      if (vib.amplitude > 0.0005) {
        const decayFactor = Math.exp(-vib.decay * vib.elapsed);
        env = vib.amplitude * decayFactor;
        if (env < 0.0004) {
          vib.amplitude = 0;
          env = 0;
        } else {
          wave = Math.sin(vib.omega * vib.elapsed);
        }
      }

      // Update all 33 points in-place
      for (let i = 0; i <= STRING_SEGMENTS; i++) {
        const u = i / STRING_SEGMENTS;
        const disp = env * Math.sin(Math.PI * u) * wave;
        const px = a.x + dx * u + nx * disp;
        const py = a.y + dy * u + ny * disp;
        points[i].set(px, py, 0);
        // Slightly offset core along normal by 0.004 to thicken the laser strand
        corePoints[i].set(px + nx * 0.004, py + ny * 0.004, -0.02);
      }

      MeshBuilder.CreateLines(`string-line-${id}`, { points, instance: linesMesh });
      MeshBuilder.CreateLines(`string-core-${id}`, { points: corePoints, instance: coreLines });

      // Color & glow flash on pluck / selection
      const baseColor = s.selected ? selectedColor : pitchToNeonColor(s.normalizedPitch);
      const flash =
        vib.amplitude > 0
          ? Math.min(1, Math.exp(-vib.decay * 1.4 * vib.elapsed) * vib.intensity)
          : 0;

      Color3.LerpToRef(baseColor, whiteColor, flash * 0.68, glowColor);
      linesMesh.color.copyFrom(glowColor);
      coreLines.color.copyFrom(glowColor);

      const boost = s.selected ? 1.65 : 1.05 + flash * 1.1;
      linesMesh.metadata.glowBoost = boost;
      coreLines.metadata.glowBoost = boost * 1.25;

      // Position & highlight anchor handles
      // Handles stay compact & subtle while locked for playing, and expand when selected/editable
      const editable = !useStringStore.getState().settings.editRequiresSelection || s.selected;
      const hovered = transientState.hoveredHandle;
      const aHot = editable && hovered.stringId === id && hovered.end === 'A';
      const bHot = editable && hovered.stringId === id && hovered.end === 'B';
      const baseHandleScale = s.selected ? 1.28 : editable ? 1.0 : 0.68;

      if (handleARef.current && ringARef.current) {
        handleARef.current.position.set(a.x, a.y, -0.15);
        ringARef.current.position.set(a.x, a.y, -0.14);
        const scaleA = aHot ? (hovered.grabbed ? 1.6 : 1.38) : baseHandleScale;
        handleARef.current.scaling.set(scaleA, scaleA, 1);
        ringARef.current.scaling.set(scaleA * 1.55, scaleA * 1.55, 1);
        ringARef.current.isVisible = editable;
      }

      if (handleBRef.current && ringBRef.current) {
        handleBRef.current.position.set(b.x, b.y, -0.15);
        ringBRef.current.position.set(b.x, b.y, -0.14);
        const scaleB = bHot ? (hovered.grabbed ? 1.6 : 1.38) : baseHandleScale;
        handleBRef.current.scaling.set(scaleB, scaleB, 1);
        ringBRef.current.scaling.set(scaleB * 1.55, scaleB * 1.55, 1);
        ringBRef.current.isVisible = editable;
      }

      if (handleAMatRef.current) {
        handleAMatRef.current.emissiveColor = aHot ? whiteColor : glowColor;
      }
      if (handleBMatRef.current) {
        handleBMatRef.current.emissiveColor = bHot ? whiteColor : glowColor;
      }
      if (ringAMatRef.current) {
        ringAMatRef.current.emissiveColor = baseColor;
        ringAMatRef.current.alpha = aHot ? 0.7 : 0.28;
      }
      if (ringBMatRef.current) {
        ringBMatRef.current.emissiveColor = baseColor;
        ringBMatRef.current.alpha = bHot ? 0.7 : 0.28;
      }

      // Position note badge above the midpoint (always upright)
      if (labelPlaneRef.current) {
        const midX = (a.x + b.x) * 0.5;
        const midY = (a.y + b.y) * 0.5;
        // Offset slightly above the string along normal pointing upward
        const upNx = ny >= 0 ? nx : -nx;
        const upNy = ny >= 0 ? ny : -ny;
        const labelOffset = 0.085 + env * 0.4;
        labelPlaneRef.current.position.set(
          midX + upNx * labelOffset,
          midY + upNy * labelOffset,
          -0.25,
        );
      }

      // Redraw note DynamicTexture only when the note or selection state actually changes
      if (s.note !== lastRenderedNote || s.selected !== lastRenderedSelected) {
        lastRenderedNote = s.note;
        lastRenderedSelected = s.selected;
        drawNoteBadge(labelTex, s.note, s.selected, baseColor.toHexString());
      }
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      linesMesh.dispose();
      coreLines.dispose();
      labelTex.dispose();
    };
  }, [scene, stringData.id]);

  return (
    <>
      <disc
        ref={ringARef}
        name={`handle-ring-a-${stringData.id}`}
        options={{ radius: HANDLE_BASE_RADIUS, tessellation: 24 }}
      >
        <standardMaterial ref={ringAMatRef} name={`handle-ring-a-mat-${stringData.id}`} />
      </disc>
      <disc
        ref={handleARef}
        name={`handle-a-${stringData.id}`}
        options={{ radius: HANDLE_BASE_RADIUS, tessellation: 24 }}
      >
        <standardMaterial ref={handleAMatRef} name={`handle-a-mat-${stringData.id}`} />
      </disc>

      <disc
        ref={ringBRef}
        name={`handle-ring-b-${stringData.id}`}
        options={{ radius: HANDLE_BASE_RADIUS, tessellation: 24 }}
      >
        <standardMaterial ref={ringBMatRef} name={`handle-ring-b-mat-${stringData.id}`} />
      </disc>
      <disc
        ref={handleBRef}
        name={`handle-b-${stringData.id}`}
        options={{ radius: HANDLE_BASE_RADIUS, tessellation: 24 }}
      >
        <standardMaterial ref={handleBMatRef} name={`handle-b-mat-${stringData.id}`} />
      </disc>

      <plane
        ref={labelPlaneRef}
        name={`note-label-${stringData.id}`}
        options={{ width: 0.21, height: 0.092 }}
      >
        <standardMaterial ref={labelMatRef} name={`note-label-mat-${stringData.id}`} />
      </plane>
    </>
  );
}
