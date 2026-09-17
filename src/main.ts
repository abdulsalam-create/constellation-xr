/**
 * Application entry point: wires the worker, the renderer, the XR session and
 * the desktop fallback together.
 *
 * The render loop is driven by `renderer.setAnimationLoop`, not
 * `requestAnimationFrame`. Inside an immersive session the two are different
 * clocks: `setAnimationLoop` is driven by the headset's compositor via
 * `XRSession.requestAnimationFrame`, which is the only one that stays in step
 * with the display's refresh and the predicted pose.
 */

import { Vector3 } from 'three';
import { buildAdjacency, compileGraph } from './core/graph.js';
import { boundingRadius, computeBounds, fitDistance, roomScaleFactor } from './core/bounds.js';
import { pickCone, pickSphere } from './core/pick.js';
import { DEFAULT_ARC_OPTIONS, computeArc } from './core/ballistics.js';
import { createScene } from './render/scene.js';
import { GraphRenderer } from './render/graph-renderer.js';
import { PlayerRig } from './xr/locomotion.js';
import { setupControllers, turnAxis } from './xr/controllers.js';
import { FpsMeter, Hud } from './ui/hud.js';
import { OrbitControls } from './ui/desktop-controls.js';
import { enableDrop, fetchGraph } from './data/loader.js';
import type { GraphInput } from './core/types.js';
import type { ReadyMessage, WorkerResponse } from './worker/protocol.js';

const SAMPLE_URL = `${import.meta.env.BASE_URL}data/ecosystem.json`;
/** Half-angle of the controller aim-assist cone. */
const AIM_CONE = (4 * Math.PI) / 180;

/**
 * Where the graph's local origin sits in the room, in metres.
 *
 * Roughly chest height on a standing adult, so the graph is centred on the user
 * rather than around their ankles. The render transform uses it and the picking
 * path inverts it, so it must be one constant rather than a repeated literal.
 */
const GRAPH_ORIGIN = new Vector3(0, 1.4, 0);

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#viewport');
  const overlay = requireElement<HTMLElement>('#overlay');
  const enterButton = requireElement<HTMLButtonElement>('#enter-xr');
  const reheatButton = requireElement<HTMLButtonElement>('#reheat');

  const hud = new Hud(overlay);
  const { renderer, scene, camera, dispose: disposeScene } = createScene(canvas);

  const rig = new PlayerRig();
  rig.attach(camera);
  scene.add(rig.group);

  const focus = GRAPH_ORIGIN.clone();
  const orbit = new OrbitControls(canvas, camera, focus);

  let worker: Worker | null = null;
  let graphRenderer: GraphRenderer | null = null;
  let ready: ReadyMessage | null = null;
  let adjacency: { offsets: Uint32Array; neighbours: Uint32Array } | null = null;
  let positions: Float32Array | null = null;
  let worldScale = 1;
  let simMs = 0;
  let alpha = 1;
  let settled = false;
  let selected = -1;
  let grabbed = -1;
  /** Which controller index is holding the grabbed node, or -1. */
  let grabbedBy = -1;
  let grabDistance = 1;

  const fps = new FpsMeter();
  const arcScratch = new Float32Array(DEFAULT_ARC_OPTIONS.samples * 3);
  const headWorld = new Vector3();
  const rayOrigin = new Vector3();
  const rayDirection = new Vector3();

  function startGraph(input: GraphInput, label: string): void {
    worker?.terminate();
    if (graphRenderer) {
      // Detach from the parent it was actually added to, and before disposing.
      // Removing from a different parent is a silent no-op, which would leave a
      // still-rendered object holding freed GPU buffers.
      scene.remove(graphRenderer.asObject3D());
      graphRenderer.dispose();
    }
    // The previous buffer is sized for the previous node count, so reading it
    // against the new count yields undefined — which becomes NaN in the instance
    // matrices and in the bounds. It must not survive the swap.
    positions = null;

    // The graph is compiled on the main thread as well as in the worker: the
    // renderer needs the topology immediately, and compiling twice is cheaper
    // than another round trip before the first frame can be drawn.
    const graph = compileGraph(input);
    adjacency = buildAdjacency(graph);
    graphRenderer = new GraphRenderer(graph);
    scene.add(graphRenderer.asObject3D());
    selected = -1;
    grabbed = -1;
    hud.setSelection(null, 0, '');
    hud.setStatus(`${label} — settling`);

    worker = new Worker(new URL('./worker/layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
      const message = event.data;
      if (message.type === 'ready') {
        ready = message;
        return;
      }
      if (message.type === 'error') {
        hud.setStatus(`Layout error: ${message.message}`);
        return;
      }
      // Hand the previous buffer back so the worker can refill it instead of
      // allocating. Safe to transfer: nothing reads `positions` between this
      // assignment and the next render-loop pass.
      const spent = positions;
      positions = message.positions;
      if (spent !== null && worker) {
        worker.postMessage({ type: 'recycle', positions: spent }, [spent.buffer]);
      }
      simMs = message.simMs;
      alpha = message.alpha;
      settled = message.settled;
    };
    worker.postMessage({ type: 'start', graph: input });
    ready = {
      type: 'ready',
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      edges: graph.edges,
      groupOf: graph.groupOf,
      weights: graph.weights,
      degrees: graph.degrees,
      labels: graph.labels,
      ids: graph.ids,
      groupNames: graph.groupNames,
      name: graph.name,
    };
  }

  function neighbourMask(index: number): Uint8Array | null {
    if (!adjacency || !ready || index < 0) return null;
    const mask = new Uint8Array(ready.nodeCount);
    const end = adjacency.offsets[index + 1]!;
    for (let k = adjacency.offsets[index]!; k < end; k++) {
      mask[adjacency.neighbours[k]!] = 1;
    }
    return mask;
  }

  function select(index: number): void {
    if (!graphRenderer || !ready) return;
    selected = index;
    graphRenderer.select(index, neighbourMask(index));
    if (index < 0) {
      hud.setSelection(null, 0, '');
      return;
    }
    hud.setSelection(
      ready.labels[index] ?? ready.ids[index] ?? `#${index}`,
      ready.degrees[index] ?? 0,
      ready.groupNames[ready.groupOf[index] ?? 0] ?? 'default',
    );
  }

  /**
   * Pointer ray for a controller space, in **world** space.
   *
   * The graph's position buffer is in graph-local space, so anything testing a
   * ray against it must convert first — see {@link toGraphLocal}.
   */
  function controllerRay(space: { matrixWorld: { elements: ArrayLike<number> } }): void {
    const m = space.matrixWorld.elements;
    rayOrigin.set(m[12]!, m[13]!, m[14]);
    // -Z column of the world matrix is the pointer's forward direction.
    rayDirection.set(-m[8]!, -m[9]!, -m[10]!).normalize();
  }

  /**
   * Convert the current ray from world space into the graph's local space.
   *
   * The renderer root is uniformly scaled by `worldScale` and lifted to
   * `GRAPH_ORIGIN`, so a world-space ray has to be un-lifted and un-scaled
   * before it can be intersected against the layout's raw position buffer.
   * Because the scale is *uniform*, the direction survives unchanged — which is
   * the reason it is kept uniform rather than fitted per axis.
   *
   * Distances a pick returns are therefore in local units; multiply by
   * `worldScale` to get metres.
   */
  function toGraphLocal(): void {
    rayOrigin.sub(GRAPH_ORIGIN).divideScalar(worldScale);
    rayDirection.normalize();
  }

  const controllers = setupControllers(renderer, rig.group, {
    onSelect: (index, phase) => {
      if (!positions || !ready || !graphRenderer) return;
      const space = controllers.spaces[index];
      if (!space) return;
      controllerRay(space);
      if (phase === 'start') {
        // Picking tests against the layout's own buffer, which is in
        // graph-local space, so the world-space ray is converted first.
        toGraphLocal();
        const hit = pickCone(
          positions,
          ready.nodeCount,
          [rayOrigin.x, rayOrigin.y, rayOrigin.z],
          [rayDirection.x, rayDirection.y, rayDirection.z],
          AIM_CONE,
          40 / worldScale,
        );
        select(hit.index);
        return;
      }
      // Release: if the teleport arc found a floor, go there. The arc is
      // ballistics in the real room, so it stays in world space.
      const arc = computeArc(
        [rayOrigin.x, rayOrigin.y, rayOrigin.z],
        [rayDirection.x, rayDirection.y, rayDirection.z],
        {},
        arcScratch,
      );
      if (arc.landing && selected < 0) {
        camera.getWorldPosition(headWorld);
        rig.teleportTo(arc.landing[0], arc.landing[2], headWorld);
      }
    },
    onSqueeze: (index, phase) => {
      if (!positions || !ready || !worker) return;
      const space = controllers.spaces[index];
      if (!space) return;
      if (phase === 'end') {
        // Only the hand that grabbed the node may release it.
        if (grabbed >= 0 && grabbedBy === index) {
          worker.postMessage({ type: 'unpin', index: grabbed });
          grabbed = -1;
          grabbedBy = -1;
        }
        return;
      }
      controllerRay(space);
      toGraphLocal();
      const hit = pickSphere(
        positions,
        graphRenderer!.radii,
        ready.nodeCount,
        [rayOrigin.x, rayOrigin.y, rayOrigin.z],
        [rayDirection.x, rayDirection.y, rayDirection.z],
        40 / worldScale,
      );
      if (hit.index >= 0) {
        grabbed = hit.index;
        grabbedBy = index;
        // In local units, because the pick itself ran in local space.
        grabDistance = hit.distance;
        select(hit.index);
      }
    },
  });

  // Desktop picking on click.
  canvas.addEventListener('pointerdown', (event) => {
    if (renderer.xr.isPresenting || !positions || !ready || !graphRenderer) return;
    const [ndcX, ndcY] = orbit.ndcFor(event);
    const target = new Vector3(ndcX, ndcY, 0.5).unproject(camera);
    camera.getWorldPosition(rayOrigin);
    rayDirection.copy(target).sub(rayOrigin).normalize();
    toGraphLocal();
    const hit = pickSphere(
      positions,
      graphRenderer.radii,
      ready.nodeCount,
      [rayOrigin.x, rayOrigin.y, rayOrigin.z],
      [rayDirection.x, rayDirection.y, rayDirection.z],
    );
    select(hit.index);
  });

  reheatButton.addEventListener('click', () => worker?.postMessage({ type: 'reheat' }));

  const disableDrop = enableDrop(
    document.body,
    (graph, name) => startGraph(graph, name),
    (message) => hud.setStatus(`Could not load file: ${message}`),
  );

  // XR availability. `isSessionSupported` is the only correct check: the
  // presence of `navigator.xr` says the API exists, not that a device is there.
  if (navigator.xr) {
    const supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    enterButton.disabled = !supported;
    enterButton.textContent = supported ? 'Enter VR' : 'No VR device detected';
    if (supported) {
      enterButton.addEventListener('click', () => {
        void navigator
          .xr!.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
          })
          .then((session) => renderer.xr.setSession(session))
          .catch((error: unknown) => {
            hud.setStatus(`Could not enter VR: ${(error as Error).message}`);
          });
      });
    }
  } else {
    enterButton.disabled = true;
    enterButton.textContent = 'WebXR unavailable in this browser';
  }

  try {
    startGraph(await fetchGraph(SAMPLE_URL), 'Sample ecosystem');
  } catch (error) {
    hud.setStatus(`Could not load the sample dataset: ${(error as Error).message}`);
  }

  // Release everything on navigation. Not strictly required — the browser
  // reclaims a closed tab either way — but leaving a GL context and two event
  // listeners attached on a bfcache-restored page is a real leak, and the
  // teardown paths only stay correct if something actually calls them.
  window.addEventListener('pagehide', () => {
    renderer.setAnimationLoop(null);
    worker?.terminate();
    controllers.dispose();
    orbit.dispose();
    disableDrop();
    graphRenderer?.dispose();
    disposeScene();
  });

  let lastTime = performance.now();
  let framedOnce = false;

  renderer.setAnimationLoop((now, frame) => {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;

    controllers.update(frame ?? null);

    if (positions && ready && graphRenderer) {
      graphRenderer.update(positions);

      // Rescale and recentre once the layout has taken shape, so the graph is
      // reachable in VR and framed on desktop without the user doing anything.
      const bounds = computeBounds(positions, ready.nodeCount);
      const radius = boundingRadius(bounds);
      if (!framedOnce && radius > 0) {
        worldScale = roomScaleFactor(radius);
        graphRenderer.asObject3D().scale.setScalar(worldScale);
        graphRenderer.asObject3D().position.copy(GRAPH_ORIGIN);
        orbit.frame(fitDistance(radius * worldScale, 65, window.innerWidth / window.innerHeight));
        framedOnce = true;
      }

      if (grabbed >= 0) {
        // The hand that grabbed it, not whichever controller is listed first.
        const space = controllers.spaces[grabbedBy];
        if (space) {
          controllerRay(space);
          toGraphLocal();
          // `grabDistance` is already in local units, so the held point is
          // simply that far along the local-space ray — no further conversion.
          worker?.postMessage({
            type: 'pin',
            index: grabbed,
            x: rayOrigin.x + rayDirection.x * grabDistance,
            y: rayOrigin.y + rayDirection.y * grabDistance,
            z: rayOrigin.z + rayDirection.z * grabDistance,
          });
        }
      }
    }

    if (renderer.xr.isPresenting) {
      camera.getWorldPosition(headWorld);
      rig.handleTurnAxis(
        turnAxis(controllers.gamepads[1] ?? controllers.gamepads[0] ?? null),
        headWorld,
      );
    } else {
      orbit.update(dt);
    }

    if (ready) {
      hud.setStats({
        nodes: ready.nodeCount,
        edges: ready.edgeCount,
        fps: fps.sample(now),
        simMs,
        alpha,
        settled,
      });
      if (settled) hud.setStatus(`${ready.name} — settled`);
    }

    renderer.render(scene, camera);
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  const overlay = document.querySelector('[data-hud-status]');
  if (overlay) overlay.textContent = `Startup failed: ${(error as Error).message}`;
});
