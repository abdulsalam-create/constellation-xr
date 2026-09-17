/// <reference lib="webworker" />
/**
 * The layout worker.
 *
 * The simulation runs here rather than on the main thread for one reason: a
 * frame that misses the headset's deadline is not a dropped frame, it is a
 * reprojected one, and reprojection artefacts are what make people take the
 * headset off. Keeping the N-body solve off the render thread means a heavy
 * graph slows the layout down without ever stalling the compositor.
 *
 * Positions cross the boundary as a transferred `Float32Array`. Transfer rather
 * than structured-clone copy: the buffer is handed over with no copy at all, and
 * the main thread hands it straight back on the next request, so the pair of
 * threads pass a single allocation back and forth for the lifetime of the page.
 */

import { ForceLayout } from '../core/layout.js';
import { loadGraph } from '../core/graph.js';
import type { FrameMessage, WorkerRequest, WorkerResponse } from './protocol.js';

/** Simulation steps per posted frame. Several steps per message keeps the
 *  message rate sane while still converging quickly. */
const STEPS_PER_TICK = 2;
/** Once settled, keep ticking slowly so a later reheat is picked up promptly. */
const IDLE_INTERVAL_MS = 250;

let layout: ForceLayout | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Buffer handed back by the main thread, ready to be filled again.
 *
 * Transferring a buffer detaches it here, so without a return trip every tick
 * would have to allocate a fresh one — 60KB per tick at 5,000 nodes, forever,
 * which is exactly the per-frame garbage this design exists to avoid.
 */
let spare: Float32Array | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer) {
    self.postMessage(message, { transfer });
  } else {
    self.postMessage(message);
  }
}

function tick(): void {
  if (!layout) return;

  const started = performance.now();
  let meanSpeed = 0;
  if (!layout.settled) {
    for (let i = 0; i < STEPS_PER_TICK; i++) meanSpeed = layout.step().meanSpeed;
  }
  const simMs = performance.now() - started;

  // The snapshot is a copy, because the layout keeps mutating its own buffer
  // between ticks. It reuses the buffer the main thread returned on the last
  // frame, so after the first two ticks this loop allocates nothing.
  const snapshot =
    spare !== null && spare.length === layout.positions.length
      ? spare
      : new Float32Array(layout.positions.length);
  snapshot.set(layout.positions);
  spare = null;

  const frame: FrameMessage = {
    type: 'frame',
    positions: snapshot,
    alpha: layout.alpha,
    meanSpeed,
    settled: layout.settled,
    steps: layout.steps,
    simMs,
  };
  post(frame, [snapshot.buffer]);

  timer = setTimeout(tick, layout.settled ? IDLE_INTERVAL_MS : 0);
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'start': {
        const graph = loadGraph(message.graph);
        layout = new ForceLayout(graph, message.params ?? {}, message.seed ?? 0x5eed);
        post({
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
        });
        if (timer !== null) clearTimeout(timer);
        tick();
        break;
      }
      case 'pin':
        layout?.pin(message.index, message.x, message.y, message.z);
        layout?.reheat(0.35);
        break;
      case 'unpin':
        layout?.unpin(message.index);
        layout?.reheat(0.35);
        break;
      case 'reheat':
        layout?.reheat();
        break;
      case 'recycle':
        // The main thread is done with a previous frame's buffer and has
        // transferred it back; hold it for the next tick.
        spare = message.positions;
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
