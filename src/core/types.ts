/**
 * Core data model.
 *
 * Everything in `src/core` is deliberately free of Three.js and of any DOM or
 * WebXR API, so the whole simulation can run in a Web Worker and be unit tested
 * in plain Node. Rendering types live in `src/render`.
 */

/** A node as it arrives from a data file. */
export interface GraphNodeInput {
  id: string;
  label?: string;
  /** Free-form grouping key. Drives colour assignment. */
  group?: string;
  /** Optional relative size hint in [0, 1]; defaults to a degree-derived value. */
  weight?: number;
}

/** An edge as it arrives from a data file. */
export interface GraphEdgeInput {
  source: string;
  target: string;
  /** Spring strength multiplier. Defaults to 1. */
  weight?: number;
}

export interface GraphInput {
  /** Optional human-readable name, shown in the HUD. */
  name?: string;
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
}

/**
 * A validated graph in the flat, index-addressed form the simulation uses.
 *
 * String ids are resolved to dense integer indices exactly once, at load time.
 * The hot loop then only ever touches typed arrays, which is what keeps the
 * layout allocation-free and transferable between threads.
 */
export interface Graph {
  name: string;
  /** Node ids, indexed by node index. */
  ids: string[];
  labels: string[];
  /** Distinct group names, in first-seen order. Index into this is the colour id. */
  groupNames: string[];
  /** Group index per node. */
  groupOf: Uint16Array;
  /** Per-node render weight in [0, 1]. */
  weights: Float32Array;
  /** Edge endpoints, flattened as [sourceA, targetA, sourceB, targetB, ...]. */
  edges: Uint32Array;
  /** Per-edge spring weight. */
  edgeWeights: Float32Array;
  /** Degree per node. */
  degrees: Uint32Array;
  nodeCount: number;
  edgeCount: number;
}

/** Tunable constants for the N-body layout. */
export interface LayoutParams {
  /**
   * Barnes-Hut opening angle. 0 degrades to an exact O(n^2) solve; the usual
   * quality/speed compromise is 0.5-0.9.
   */
  theta: number;
  /** Coulomb-like repulsion strength between every pair of nodes. */
  repulsion: number;
  /** Hooke spring constant applied along edges. */
  springStrength: number;
  /** Rest length of an edge spring, in world units. */
  springLength: number;
  /** Pull toward the origin, which keeps disconnected components in frame. */
  gravity: number;
  /** Velocity retained per step, in [0, 1). Acts as viscous damping. */
  damping: number;
  /** Fixed integration step. */
  timeStep: number;
  /** Per-step multiplier applied to alpha (the global cooling factor). */
  alphaDecay: number;
  /** Simulation is considered settled at or below this alpha. */
  alphaMin: number;
  /** Speed clamp, guarding against the singularity at r -> 0. */
  maxSpeed: number;
  /** Softening length added to r^2, also guarding r -> 0. */
  softening: number;
}

export const DEFAULT_LAYOUT_PARAMS: Readonly<LayoutParams> = Object.freeze({
  theta: 0.75,
  repulsion: 12,
  springStrength: 0.08,
  springLength: 1.2,
  gravity: 0.015,
  damping: 0.82,
  timeStep: 1,
  alphaDecay: 0.994,
  alphaMin: 0.002,
  maxSpeed: 2.5,
  softening: 0.05,
});

/** Axis-aligned bounding box. */
export interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}
