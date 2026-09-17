/**
 * Scene, renderer and lighting setup.
 *
 * The renderer is configured for XR from the start rather than reconfigured on
 * session entry: `xr.enabled` and the reference-space type have to be set before
 * a session is requested, and a foveation setting applied mid-session causes a
 * visible hitch.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

export interface SceneBundle {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Detaches the resize listener and releases GPU resources. */
  dispose: () => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    // `powerPreference` is a hint, but on standalone headsets it is the
    // difference between the efficiency and performance cluster being used.
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  // 'local-floor' puts the origin at the physical floor, which is what makes a
  // teleport target land at the user's feet rather than at their head height.
  renderer.xr.setReferenceSpaceType('local-floor');
  // Fixed foveation trades peripheral resolution for fill rate; 1 is aggressive
  // but for a scene of small bright nodes on a dark ground it is imperceptible.
  renderer.xr.setFoveation(1);

  const scene = new Scene();
  scene.background = new Color(0x080b14);
  // Fog gives depth ordering at a glance, which stereo alone does not provide
  // for a cloud of identical spheres.
  scene.fog = new Fog(0x080b14, 6, 26);

  const camera = new PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.position.set(0, 1.6, 4.5);

  scene.add(new AmbientLight(0x6f7fa8, 1.15));
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 6, 4);
  scene.add(key);
  const rim = new DirectionalLight(0x4f7cff, 0.7);
  rim.position.set(-4, -2, -5);
  scene.add(rim);

  const grid = new GridHelper(24, 24, 0x1d2740, 0x131a2b);
  grid.position.y = 0;
  scene.add(grid);

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    camera,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    },
  };
}
