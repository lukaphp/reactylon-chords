import { useEffect, useRef } from 'react';
import {
  Camera,
  Color3,
  Color4,
  DynamicTexture,
  GlowLayer,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type FreeCamera,
  type LinesMesh,
  type Mesh,
} from '@babylonjs/core';
import { Engine } from 'reactylon/web';
import { Scene, useEngine, useScene } from 'reactylon';
import { HandTracker } from '../tracking/HandTracker';
import { FINGERTIP_INDICES } from '../tracking/types';
import { PinchDetector, type PinchState } from '../gestures/pinch';
import { StringCreator } from '../gestures/stringCreator';
import { AnchorDragController } from '../gestures/anchorDrag';
import { LongPressController } from '../gestures/longPress';
import {
  hitTestHandles,
  mapSpeedToIntensity,
  testFingerStringCollision,
} from '../strings/collision';
import { transientState, useStringStore } from '../strings/stringStore';
import { audioEngine } from '../audio/audioEngine';
import { VideoBackground } from './VideoBackground';
import { StringMesh } from './StringMesh';
import { DeleteButton } from './DeleteButton';
import { HandOverlay } from './HandOverlay';

const PLUCK_COOLDOWN_MS = 100;
const PLUCK_TOUCH_RADIUS = 0.048;

interface AirSceneProps {
  tracker: HandTracker;
  video: HTMLVideoElement | null;
}

/**
 * Configures the orthographic camera, Neon GlowLayer, and runs the single per-frame
 * Babylon render-loop controller for gestures, collisions, audio plucking, and vibration.
 */
function SceneController({ tracker }: { tracker: HandTracker }) {
  const scene = useScene();
  const engine = useEngine();
  const cameraRef = useRef<FreeCamera | null>(null);

  // Sync camera & GlowLayer
  useEffect(() => {
    scene.clearColor = new Color4(0.03, 0.04, 0.08, 1);

    const glowLayer = new GlowLayer('neon-glow', scene, {
      mainTextureSamples: 4,
      blurKernelSize: 48,
    });
    glowLayer.intensity = 0.85;
    glowLayer.customEmissiveColorSelector = (mesh, _subMesh, _material, result) => {
      if (mesh.metadata?.excludeGlow) {
        result.set(0, 0, 0, 0);
        return;
      }
      if (mesh.metadata?.glowColor) {
        const c = mesh.metadata.glowColor as Color3;
        const boost = (mesh.metadata.glowBoost as number | undefined) ?? 1;
        result.set(c.r * boost, c.g * boost, c.b * boost, 1);
        return;
      }
      const mat = mesh.material as StandardMaterial | null;
      if (mat && 'emissiveColor' in mat && mat.emissiveColor) {
        result.set(mat.emissiveColor.r, mat.emissiveColor.g, mat.emissiveColor.b, 1);
        return;
      }
      result.set(0, 0, 0, 0);
    };

    const syncOrthoCamera = () => {
      const cam = cameraRef.current ?? (scene.activeCamera as FreeCamera | null);
      if (!cam) return;

      const w = engine.getRenderWidth() || window.innerWidth || 1280;
      const h = engine.getRenderHeight() || window.innerHeight || 720;
      tracker.updateCanvasSize(w, h);

      const aspect = tracker.projection.canvasAspect;
      cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
      cam.orthoTop = 1;
      cam.orthoBottom = -1;
      cam.orthoLeft = -aspect;
      cam.orthoRight = aspect;
      cam.setTarget(Vector3.Zero());
    };

    syncOrthoCamera();
    const handleResize = () => {
      engine.resize();
      syncOrthoCamera();
    };
    window.addEventListener('resize', handleResize);

    const projObs = scene.onBeforeRenderObservable.add(() => {
      const cam = cameraRef.current;
      if (!cam) return;
      const w = engine.getRenderWidth();
      const h = engine.getRenderHeight();
      if (
        w > 0 &&
        h > 0 &&
        (w !== tracker.projection.canvasWidth ||
          h !== tracker.projection.canvasHeight ||
          (tracker.getVideoElement()?.videoWidth &&
            tracker.getVideoElement()!.videoWidth !== tracker.projection.videoWidth))
      ) {
        syncOrthoCamera();
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      scene.onBeforeRenderObservable.remove(projObs);
      glowLayer.dispose();
    };
  }, [scene, engine, tracker]);

  // Main non-reactive interaction & physics render loop
  useEffect(() => {
    const pinchDetector = new PinchDetector();
    const stringCreator = new StringCreator();
    const anchorDrag = new AnchorDragController();
    const longPress = new LongPressController();

    // Tracks which (handId, fingerIdx, stringId) pairs are currently inside the touch envelope
    // so pluck only fires on the rising edge (entry / crossing), never repeatedly during dwell.
    const touchingStrings = new Set<string>();
    const activeHandIds = new Set<number>();
    let lastFrameMs = performance.now();

    const obs = scene.onBeforeRenderObservable.add(() => {
      const nowMs = performance.now();
      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      const store = useStringStore.getState();
      const { strings, selectedId, settings } = store;

      // 1) Advance string vibration timers
      for (let i = 0; i < strings.length; i++) {
        const vib = strings[i].vibration;
        if (vib.amplitude > 0) {
          vib.elapsed += dtSec;
        }
      }

      const frame = tracker.latestFrame;
      const presentHandIds = new Set<number>();
      const pinchesByHand = new Map<number, PinchState>();

      for (const hand of frame.hands) {
        presentHandIds.add(hand.id);
        const pinch = pinchDetector.update(hand);
        pinchesByHand.set(hand.id, pinch);
        transientState.activeHandPinch[hand.id] = pinch.isPinching;
      }

      // Clean up hands that disappeared from tracking (safe release!)
      for (const prevId of activeHandIds) {
        if (!presentHandIds.has(prevId)) {
          pinchDetector.resetHand(prevId);
          anchorDrag.end(prevId); // Anchor stays safely where it was
          longPress.clearHand(prevId);
          transientState.activeHandPinch[prevId] = false;

          for (const key of Array.from(touchingStrings)) {
            if (key.startsWith(`${prevId}:`)) {
              touchingStrings.delete(key);
            }
          }
        }
      }
      activeHandIds.clear();
      for (const id of presentHandIds) activeHandIds.add(id);

      let bestLongPressRing = {
        active: false,
        stringId: null as string | null,
        progress: 0,
        position: { x: 0, y: 0 },
      };
      let bestDeleteHover = {
        active: false,
        stringId: null as string | null,
        progress: 0,
      };
      let hoveredHandle = {
        stringId: null as string | null,
        end: null as 'A' | 'B' | null,
        grabbed: false,
      };

      const selectedString = selectedId
        ? strings.find((s) => s.id === selectedId) ?? null
        : null;

      let anyAnchorDragging = false;
      for (const hand of frame.hands) {
        if (anchorDrag.isActive(hand.id)) {
          anyAnchorDragging = true;
          break;
        }
      }

      // 2) Two-hand common-point string creation:
      //    Touch both hands together & pinch both -> pull apart -> release to place cleanly!
      const creation = stringCreator.update(
        frame.hands,
        pinchesByHand,
        settings.tuning,
        nowMs,
        anyAnchorDragging,
      );

      if (creation.commit) {
        const created = store.addString(
          creation.commit.anchorA,
          creation.commit.anchorB,
        );
        audioEngine.pluck(created.freq, 0.36);
        store.triggerVibrationInPlace(created.id, 0.42, nowMs);
        touchingStrings.clear();
      }

      if (creation.active && creation.session) {
        if (selectedId) {
          store.selectString(null);
        }
        if (creation.noteChanged && settings.previewSoundOnDrag) {
          audioEngine.pluck(creation.session.freq, 0.22);
        }
        for (const hand of frame.hands) {
          longPress.clearHand(hand.id);
        }
        touchingStrings.clear();
      }

      // 3) Per-hand playing, long-press selection, delete X, and intentional anchor editing
      if (!creation.suppressPlay) {
        const editableStrings = settings.editRequiresSelection
          ? selectedString
            ? [selectedString]
            : []
          : strings;

        for (const hand of frame.hands) {
          const pinch = pinchesByHand.get(hand.id)!;
          const indexTip = hand.fingertips[8];
          const handleHitRadius = Math.max(0.115, hand.handScale * 0.44);

          // --- Priority 0: Delete "X" button check (when a string is selected) ---
          if (selectedString && !anchorDrag.isActive(hand.id)) {
            const delRes = longPress.checkDeleteButton(
              hand.id,
              indexTip.position,
              pinch.point,
              pinch.justStarted,
              selectedString,
              settings.deleteButtonMode,
              tracker.projection.canvasAspect,
              nowMs,
            );

            if (delRes.confirmedDeleteId) {
              store.removeString(delRes.confirmedDeleteId);
              longPress.clearHand(hand.id);
              continue;
            }

            if (delRes.hovering) {
              if (!bestDeleteHover.active || delRes.progress > bestDeleteHover.progress) {
                bestDeleteHover = {
                  active: true,
                  stringId: selectedString.id,
                  progress: delRes.progress,
                };
              }
              continue;
            }
          }

          // --- Priority 1: Active Anchor Drag ---
          if (anchorDrag.isActive(hand.id)) {
            const session = anchorDrag.getSession(hand.id)!;
            const targetString = store.strings.find((s) => s.id === session.stringId);

            if (!targetString || !pinch.isPinching) {
              anchorDrag.end(hand.id);
              if (selectedId === session.stringId) {
                longPress.notifySelected(nowMs);
              }
            } else {
              if (selectedId === session.stringId) {
                longPress.notifySelected(nowMs);
              }
              const fixedAnchor =
                session.end === 'A' ? targetString.anchorB : targetString.anchorA;
              const clamped = anchorDrag.clampPosition(pinch.point, fixedAnchor);
              const res = store.updateStringAnchorsInPlace(
                session.stringId,
                session.end,
                clamped,
              );
              hoveredHandle = {
                stringId: session.stringId,
                end: session.end,
                grabbed: true,
              };

              if (res?.noteChanged && settings.previewSoundOnDrag) {
                audioEngine.pluck(res.freq, 0.32);
                store.triggerVibrationInPlace(session.stringId, 0.35, nowMs);
              }
            }
            continue;
          }

          // --- Priority 2: Intentional Anchor Grab (only on editable/selected strings) ---
          const nearEditableHandle = hitTestHandles(
            pinch.point,
            editableStrings,
            handleHitRadius,
          );
          if (nearEditableHandle && !hoveredHandle.grabbed) {
            hoveredHandle = {
              stringId: nearEditableHandle.stringId,
              end: nearEditableHandle.end,
              grabbed: false,
            };
          }

          if (pinch.justStarted && nearEditableHandle) {
            longPress.clearHand(hand.id);
            anchorDrag.start(
              hand.id,
              nearEditableHandle.stringId,
              nearEditableHandle.end,
            );
            hoveredHandle = {
              stringId: nearEditableHandle.stringId,
              end: nearEditableHandle.end,
              grabbed: true,
            };
            continue;
          }

          // --- Priority 3: Long press dwell on string body (index fingertip) ---
          // Suppress dwell while two hands are approaching each other to create a new string
          const dwellDisabled =
            Boolean(nearEditableHandle) ||
            pinch.isPinching ||
            creation.readyHint.visible;

          const lp = longPress.updateStringDwell(
            hand.id,
            indexTip.position,
            strings,
            selectedId,
            nowMs,
            dwellDisabled,
          );
          if (lp.newlySelectedId) {
            store.selectString(lp.newlySelectedId);
          }
          if (lp.ring.active && lp.ring.progress >= bestLongPressRing.progress) {
            bestLongPressRing = lp.ring;
          }

          // --- Priority 4: Clean single-hand (or open-hand) plucking ---
          // Skip plucking if the user is pinching with 2 hands approaching to create
          if (creation.readyHint.visible && pinch.isPinching) continue;

          const activeTips = settings.allFingertips ? FINGERTIP_INDICES : ([8] as const);

          for (const tipIdx of activeTips) {
            const tip = hand.fingertips[tipIdx];
            if (!tip) continue;

            for (let i = 0; i < strings.length; i++) {
              const str = strings[i];
              if (anchorDrag.isStringBeingDragged(str.id)) continue;

              const contactKey = `${hand.id}:${tipIdx}:${str.id}`;
              const col = testFingerStringCollision(
                tip.prevPosition,
                tip.position,
                str.anchorA,
                str.anchorB,
                PLUCK_TOUCH_RADIUS,
              );

              if (col.hit) {
                const alreadyTouching = touchingStrings.has(contactKey);
                touchingStrings.add(contactKey);

                const cooldownReady =
                  nowMs - str.vibration.lastPluckMs >= PLUCK_COOLDOWN_MS;
                if ((!alreadyTouching || col.crossed) && cooldownReady) {
                  const intensity = mapSpeedToIntensity(
                    tip.normalizedSpeed,
                    settings.minIntensity,
                    settings.intensityCurve,
                  );

                  if (selectedId && selectedId !== str.id) {
                    store.selectString(null);
                  }

                  audioEngine.pluck(str.freq, intensity);
                  store.triggerVibrationInPlace(str.id, intensity, nowMs);
                }
              } else {
                touchingStrings.delete(contactKey);
              }
            }
          }
        }
      }

      // 4) Auto-deselect timeout (~4 s, paused while hovering delete X or dragging an anchor)
      const keepSelectionAlive = bestDeleteHover.active || hoveredHandle.grabbed;
      if (longPress.isSelectionExpired(selectedId, nowMs, keepSelectionAlive)) {
        store.selectString(null);
      }

      // 5) Publish non-reactive transient visuals for preview / ready halo / rings / handle hover
      if (creation.active && creation.session) {
        transientState.creationPreview.active = true;
        transientState.creationPreview.anchorA.x = creation.session.anchorA.x;
        transientState.creationPreview.anchorA.y = creation.session.anchorA.y;
        transientState.creationPreview.anchorB.x = creation.session.anchorB.x;
        transientState.creationPreview.anchorB.y = creation.session.anchorB.y;
        transientState.creationPreview.note = creation.session.note;
        transientState.creationPreview.freq = creation.session.freq;
        transientState.creationPreview.isValid = creation.session.isValid;
      } else {
        transientState.creationPreview.active = false;
      }

      transientState.twoHandReady.visible = creation.readyHint.visible;
      transientState.twoHandReady.position.x = creation.readyHint.position.x;
      transientState.twoHandReady.position.y = creation.readyHint.position.y;
      transientState.twoHandReady.pinchingCount = creation.readyHint.pinchingCount;

      transientState.longPress.active = bestLongPressRing.active;
      transientState.longPress.stringId = bestLongPressRing.stringId;
      transientState.longPress.progress = bestLongPressRing.progress;
      transientState.longPress.position.x = bestLongPressRing.position.x;
      transientState.longPress.position.y = bestLongPressRing.position.y;

      transientState.deleteHover.active = bestDeleteHover.active;
      transientState.deleteHover.stringId = bestDeleteHover.stringId;
      transientState.deleteHover.progress = bestDeleteHover.progress;

      transientState.hoveredHandle.stringId = hoveredHandle.stringId;
      transientState.hoveredHandle.end = hoveredHandle.end;
      transientState.hoveredHandle.grabbed = hoveredHandle.grabbed;
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
    };
  }, [scene, tracker]);

  return (
    <>
      <freeCamera
        ref={cameraRef}
        name="ortho-camera"
        position={new Vector3(0, 0, -10)}
      />
      <hemisphericLight
        name="ambient-light"
        direction={new Vector3(0, 1, -1)}
        intensity={1}
      />
    </>
  );
}

/**
 * Renders the two-hand common-point magnetic halo, real-time string creation preview
 * (line + two anchors + live note pill), and the circular long-press dwell progress ring.
 */
function TransientFeedbackMeshes() {
  const scene = useScene();

  useEffect(() => {
    // 1) Two-hand common-point magnetic halo
    const readyTex = new DynamicTexture(
      'two-hand-ready-tex',
      { width: 160, height: 160 },
      scene,
      true,
    );
    readyTex.hasAlpha = true;

    const readyMat = new StandardMaterial('two-hand-ready-mat', scene);
    readyMat.disableLighting = true;
    readyMat.diffuseTexture = readyTex;
    readyMat.emissiveTexture = readyTex;
    readyMat.opacityTexture = readyTex;
    readyMat.useAlphaFromDiffuseTexture = true;

    const readyPlane = MeshBuilder.CreatePlane(
      'two-hand-ready-plane',
      { width: 0.24, height: 0.24 },
      scene,
    );
    readyPlane.material = readyMat;
    readyPlane.isVisible = false;
    readyPlane.isPickable = false;
    readyPlane.metadata = { excludeGlow: true };

    const drawReadyHalo = (pinchCount: number) => {
      const ctx = readyTex.getContext() as unknown as CanvasRenderingContext2D;
      const size = readyTex.getSize().width;
      const half = size / 2;
      ctx.clearRect(0, 0, size, size);

      // Outer dashed ring showing the two hands are in the common-point zone
      ctx.save();
      ctx.beginPath();
      ctx.arc(half, half, half - 18, 0, Math.PI * 2);
      ctx.setLineDash(pinchCount >= 1 ? [] : [14, 10]);
      ctx.lineWidth = pinchCount >= 1 ? 8 : 6;
      ctx.strokeStyle =
        pinchCount >= 1 ? 'rgba(94, 252, 232, 0.95)' : 'rgba(148, 224, 255, 0.72)';
      ctx.stroke();
      ctx.restore();

      // Inner core dot
      ctx.beginPath();
      ctx.arc(half, half, pinchCount >= 1 ? 16 : 10, 0, Math.PI * 2);
      ctx.fillStyle =
        pinchCount >= 1 ? 'rgba(255, 232, 106, 0.95)' : 'rgba(94, 252, 232, 0.75)';
      ctx.fill();

      readyTex.update();
    };
    drawReadyHalo(0);

    // 2) Creation preview line + anchors + note label
    const previewPts = [new Vector3(0, 0, -0.1), new Vector3(0, 0, -0.1)];
    const previewLine: LinesMesh = MeshBuilder.CreateLines(
      'creation-preview-line',
      { points: previewPts, updatable: true },
      scene,
    );
    previewLine.isVisible = false;
    previewLine.isPickable = false;
    const previewGlow = new Color3(0.4, 1, 0.85);
    previewLine.metadata = { glowColor: previewGlow, glowBoost: 1.3 };

    const anchorMat = new StandardMaterial('preview-anchor-mat', scene);
    anchorMat.disableLighting = true;
    anchorMat.emissiveColor = new Color3(0.5, 1, 0.9);

    const anchorA: Mesh = MeshBuilder.CreateDisc(
      'preview-anchor-a',
      { radius: 0.04, tessellation: 20 },
      scene,
    );
    anchorA.material = anchorMat;
    anchorA.isVisible = false;
    anchorA.isPickable = false;

    const anchorB: Mesh = MeshBuilder.CreateDisc(
      'preview-anchor-b',
      { radius: 0.04, tessellation: 20 },
      scene,
    );
    anchorB.material = anchorMat;
    anchorB.isVisible = false;
    anchorB.isPickable = false;

    const previewNoteTex = new DynamicTexture(
      'preview-note-tex',
      { width: 240, height: 96 },
      scene,
      true,
    );
    previewNoteTex.hasAlpha = true;

    const previewNoteMat = new StandardMaterial('preview-note-mat', scene);
    previewNoteMat.disableLighting = true;
    previewNoteMat.diffuseTexture = previewNoteTex;
    previewNoteMat.emissiveTexture = previewNoteTex;
    previewNoteMat.opacityTexture = previewNoteTex;
    previewNoteMat.useAlphaFromDiffuseTexture = true;

    const previewNotePlane = MeshBuilder.CreatePlane(
      'preview-note-plane',
      { width: 0.23, height: 0.092 },
      scene,
    );
    previewNotePlane.material = previewNoteMat;
    previewNotePlane.isVisible = false;
    previewNotePlane.isPickable = false;
    previewNotePlane.metadata = { excludeGlow: true };

    // 3) Long-press circular progress ring
    const ringTex = new DynamicTexture(
      'long-press-ring-tex',
      { width: 160, height: 160 },
      scene,
      true,
    );
    ringTex.hasAlpha = true;

    const ringMat = new StandardMaterial('long-press-ring-mat', scene);
    ringMat.disableLighting = true;
    ringMat.diffuseTexture = ringTex;
    ringMat.emissiveTexture = ringTex;
    ringMat.opacityTexture = ringTex;
    ringMat.useAlphaFromDiffuseTexture = true;

    const ringPlane = MeshBuilder.CreatePlane(
      'long-press-ring-plane',
      { width: 0.22, height: 0.22 },
      scene,
    );
    ringPlane.material = ringMat;
    ringPlane.isVisible = false;
    ringPlane.isPickable = false;
    ringPlane.metadata = { excludeGlow: true };

    let lastPreviewKey = '';
    let lastRingStep = -1;
    let lastReadyPinchCount = -1;

    const obs = scene.onBeforeRenderObservable.add(() => {
      // Two-hand ready common-point halo
      const ready = transientState.twoHandReady;
      if (ready.visible) {
        readyPlane.isVisible = true;
        readyPlane.position.set(ready.position.x, ready.position.y, -0.45);
        const pulse = 1 + 0.08 * Math.sin(performance.now() * 0.01);
        readyPlane.scaling.set(pulse, pulse, 1);

        if (ready.pinchingCount !== lastReadyPinchCount) {
          lastReadyPinchCount = ready.pinchingCount;
          drawReadyHalo(ready.pinchingCount);
        }
      } else {
        readyPlane.isVisible = false;
      }

      // Creation preview update
      const p = transientState.creationPreview;
      if (p.active) {
        previewPts[0].set(p.anchorA.x, p.anchorA.y, -0.1);
        previewPts[1].set(p.anchorB.x, p.anchorB.y, -0.1);
        MeshBuilder.CreateLines('creation-preview-line', {
          points: previewPts,
          instance: previewLine,
        });

        const col = p.isValid
          ? new Color3(0.38, 1.0, 0.85)
          : new Color3(1.0, 0.65, 0.35);
        previewGlow.copyFrom(col);
        previewLine.color.copyFrom(col);
        anchorMat.emissiveColor = col;

        previewLine.isVisible = true;
        anchorA.position.set(p.anchorA.x, p.anchorA.y, -0.16);
        anchorB.position.set(p.anchorB.x, p.anchorB.y, -0.16);
        anchorA.isVisible = true;
        anchorB.isVisible = true;

        const midX = (p.anchorA.x + p.anchorB.x) * 0.5;
        const midY = (p.anchorA.y + p.anchorB.y) * 0.5 + 0.095;
        previewNotePlane.position.set(midX, midY, -0.28);
        previewNotePlane.isVisible = true;

        const key = `${p.note}:${p.isValid}`;
        if (key !== lastPreviewKey) {
          lastPreviewKey = key;
          const ctx = previewNoteTex.getContext() as unknown as CanvasRenderingContext2D;
          const w = previewNoteTex.getSize().width;
          const h = previewNoteTex.getSize().height;
          ctx.clearRect(0, 0, w, h);
          ctx.beginPath();
          ctx.roundRect(12, 12, w - 24, h - 24, 34);
          ctx.fillStyle = p.isValid
            ? 'rgba(10, 24, 32, 0.88)'
            : 'rgba(38, 22, 12, 0.88)';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = p.isValid ? '#5efce8' : '#ffb469';
          ctx.stroke();
          ctx.font = '700 38px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(p.isValid ? p.note : 'Allarga…', w / 2, h / 2 + 2);
          previewNoteTex.update();
        }
      } else {
        previewLine.isVisible = false;
        anchorA.isVisible = false;
        anchorB.isVisible = false;
        previewNotePlane.isVisible = false;
      }

      // Long-press progress ring update
      const lp = transientState.longPress;
      if (lp.active) {
        ringPlane.isVisible = true;
        ringPlane.position.set(lp.position.x, lp.position.y, -0.5);
        const step = Math.round(lp.progress * 50);
        if (step !== lastRingStep) {
          lastRingStep = step;
          const ctx = ringTex.getContext() as unknown as CanvasRenderingContext2D;
          const size = ringTex.getSize().width;
          const half = size / 2;
          ctx.clearRect(0, 0, size, size);

          ctx.beginPath();
          ctx.arc(half, half, half - 14, 0, Math.PI * 2);
          ctx.lineWidth = 10;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(
            half,
            half,
            half - 14,
            -Math.PI / 2,
            -Math.PI / 2 + Math.PI * 2 * Math.min(1, lp.progress),
          );
          ctx.lineWidth = 12;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#ffe26a';
          ctx.stroke();

          ringTex.update();
        }
      } else {
        ringPlane.isVisible = false;
      }
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      readyPlane.dispose();
      readyMat.dispose();
      readyTex.dispose();
      previewLine.dispose();
      anchorA.dispose();
      anchorB.dispose();
      anchorMat.dispose();
      previewNotePlane.dispose();
      previewNoteMat.dispose();
      previewNoteTex.dispose();
      ringPlane.dispose();
      ringMat.dispose();
      ringTex.dispose();
    };
  }, [scene]);

  return null;
}

function StringListLayer() {
  // React re-renders ONLY when the strings list itself changes (add / delete / selection / tuning).
  const strings = useStringStore((s) => s.strings);

  return (
    <>
      {strings.map((str) => (
        <StringMesh key={str.id} stringData={str} />
      ))}
    </>
  );
}

export function AirScene({ tracker, video }: AirSceneProps) {
  return (
    <Engine
      forceWebGL
      canvasId="air-strings-canvas"
      engineOptions={{
        antialias: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }}
    >
      <Scene>
        <SceneController tracker={tracker} />
        <VideoBackground video={video} tracker={tracker} />
        <StringListLayer />
        <TransientFeedbackMeshes />
        <DeleteButton tracker={tracker} />
        <HandOverlay tracker={tracker} />
      </Scene>
    </Engine>
  );
}
