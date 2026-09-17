/** Messages exchanged with the layout worker. */
import type { GraphInput, LayoutParams } from '../core/types.js';

export interface StartMessage {
  type: 'start';
  graph: GraphInput;
  params?: Partial<LayoutParams>;
  seed?: number;
}

export interface PinMessage {
  type: 'pin';
  index: number;
  x: number;
  y: number;
  z: number;
}

export interface UnpinMessage {
  type: 'unpin';
  index: number;
}

export interface ReheatMessage {
  type: 'reheat';
}

/**
 * Returns a spent positions buffer to the worker so it can be refilled.
 *
 * This is the other half of the zero-copy handoff: the worker transfers a
 * buffer out, the main thread reads it and transfers the previous one back, and
 * the pair of threads reuse two allocations for the lifetime of the page.
 */
export interface RecycleMessage {
  type: 'recycle';
  positions: Float32Array;
}

export type WorkerRequest =
  StartMessage | PinMessage | UnpinMessage | ReheatMessage | RecycleMessage;

export interface ReadyMessage {
  type: 'ready';
  nodeCount: number;
  edgeCount: number;
  /** Edge endpoints, transferred once — topology never changes after load. */
  edges: Uint32Array;
  groupOf: Uint16Array;
  weights: Float32Array;
  degrees: Uint32Array;
  labels: string[];
  ids: string[];
  groupNames: string[];
  name: string;
}

export interface FrameMessage {
  type: 'frame';
  /** Interleaved xyz, transferred out each tick and returned via {@link RecycleMessage}. */
  positions: Float32Array;
  alpha: number;
  /** Mean node speed on the last step. A convergence signal for the HUD. */
  meanSpeed: number;
  settled: boolean;
  steps: number;
  /** Milliseconds spent in the simulation for this batch of steps. */
  simMs: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerResponse = ReadyMessage | FrameMessage | ErrorMessage;
