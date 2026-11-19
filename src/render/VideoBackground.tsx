import { useEffect, useRef } from 'react';
import {
  Color3,
  StandardMaterial,
  Texture,
  Vector3,
  VideoTexture,
  type Mesh,
} from '@babylonjs/core';
import { useScene } from 'reactylon';
import type { HandTracker } from '../tracking/HandTracker';

interface VideoBackgroundProps {
  video: HTMLVideoElement | null;
  tracker: HandTracker;
}

export function VideoBackground({ video, tracker }: VideoBackgroundProps) {
  const scene = useScene();
  const planeRef = useRef<Mesh | null>(null);
  const matRef = useRef<StandardMaterial | null>(null);

  useEffect(() => {
    const plane = planeRef.current;
    const mat = matRef.current;
    if (!plane || !mat) return;

    plane.metadata = { excludeGlow: true };
    plane.isPickable = false;

    mat.disableLighting = true;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.05, 0.06, 0.1);
    mat.backFaceCulling = false;

    let videoTex: VideoTexture | null = null;
    if (video) {
      videoTex = new VideoTexture(
        'webcam-video-tex',
        video,
        scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE,
        { autoPlay: true, loop: false, autoUpdateTexture: true },
      );
      // Mirror horizontally to match natural user perspective and mirrored landmark X.
      videoTex.uScale = -1;
      videoTex.uOffset = 1;
      videoTex.level = 0.82;

      mat.emissiveTexture = videoTex;
      mat.emissiveColor = Color3.Black();
    }

    const obs = scene.onBeforeRenderObservable.add(() => {
      const { planeWidth, planeHeight } = tracker.projection;
      plane.scaling.x = planeWidth;
      plane.scaling.y = planeHeight;
    });

    return () => {
      scene.onBeforeRenderObservable.remove(obs);
      if (videoTex) {
        mat.emissiveTexture = null;
        videoTex.dispose();
      }
    };
  }, [scene, video, tracker]);

  return (
    <plane
      ref={planeRef}
      name="webcam-background-plane"
      options={{ width: 1, height: 1 }}
      position={new Vector3(0, 0, 5)}
    >
      <standardMaterial ref={matRef} name="webcam-background-mat" />
    </plane>
  );
}
