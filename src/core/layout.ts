/**
 * The force-directed layout itself.
 *
 * Three terms act on every node each step:
 *
 *   1. Barnes-Hut repulsion between all pairs, which spreads the graph out.
 *   2. Hooke springs along edges, which pull adjacent nodes to `springLength`.
 *   3. A weak pull toward the origin, which keeps disconnected components from
 *      drifting apart forever — without it, an unconnected node feels only
 *      repulsion and leaves the scene.
 *
 * Integration is semi-implicit (symplectic) Euler with viscous damping and a
 * global cooling factor `alpha`. Semi-implicit rather than explicit Euler
 * because the latter pumps energy into a spring system and the graph visibly
 * boils; the one-line difference is that velocity is updated before position.
 *
 * The class owns its buffers and never allocates inside `step()`, so it can run
 * at frame rate inside a worker without producing GC pressure.
 */

import { Octree } from './octree.js';
import { clampLength } from './vec3.js';
import { DEFAULT_LAYOUT_PARAMS, type Graph, type LayoutParams } from './types.js';

export interface StepStats {
  /** Cooling factor after this step. */
  alpha: number;
  /** Mean speed across all nodes, a convergence signal. */
  meanSpeed: number;
  /** Largest single-node speed this step. */
  maxSpeed: number;
  /** How many nodes hit the speed clamp; persistently high means dt is too big. */
  clamped: number;
  /** Cells in the octree after the rebuild. */
  treeCells: number;
  /** True once alpha has fallen to or below `alphaMin`. */
  settled: boolean;
}

/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * `Math.random()` would make every run produce a different layout, which makes
 * regressions impossible to reproduce and screenshots impossible to compare.
 * A seeded generator means a given graph and seed always yield the same layout.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed positions on a Fibonacci sphere with a little jitter.
 *
 * Uniform random points in a cube start many nodes nearly coincident, which the
 * first repulsion step turns into a violent explosion. A spherical shell starts
 * the system close to the shape a force-directed layout converges to anyway, so
 * it settles in noticeably fewer steps.
 */
export function seedPositions(
  positions: Float32Array,
  count: number,
  radius: number,
  random: () => number,
): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const jitter = 0.92 + random() * 0.16;
    positions[i * 3] = Math.cos(theta) * r * radius * jitter;
    positions[i * 3 + 1] = y * radius * jitter;
    positions[i * 3 + 2] = Math.sin(theta) * r * radius * jitter;
  }
}

export class ForceLayout {
  readonly graph: Graph;
  readonly params: LayoutParams;

  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  private readonly forces: Float32Array;
  /** Node mass. Hubs are heavier, so they sit still and leaves orbit them. */
  private readonly masses: Float32Array;
  /** Nodes pinned by a user grab are excluded from integration. */
  private readonly pinned: Uint8Array;

  private readonly tree: Octree;
  private alphaValue = 1;
  private stepCount = 0;

  constructor(graph: Graph, params: Partial<LayoutParams> = {}, seed = 0x5eed) {
    this.graph = graph;
    this.params = { ...DEFAULT_LAYOUT_PARAMS, ...params };
    const n = graph.nodeCount;

    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.forces = new Float32Array(n * 3);
    this.masses = new Float32Array(n);
    this.pinned = new Uint8Array(n);
    this.tree = new Octree(Math.max(1024, n * 2), n);

    for (let i = 0; i < n; i++) {
      // Mass grows sub-linearly with degree: hubs anchor the layout without
      // becoming immovable, which would freeze the whole component around them.
      this.masses[i] = 1 + Math.sqrt(graph.degrees[i]!) * 0.5;
    }

    const radius = Math.max(1, Math.cbrt(n) * this.params.springLength);
    seedPositions(this.positions, n, radius, mulberry32(seed));
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get steps(): number {
    return this.stepCount;
  }

  get settled(): boolean {
    return this.alphaValue <= this.params.alphaMin;
  }

  /** Restore full alpha, e.g. after the user drags a node or edits the graph. */
  reheat(alpha = 1): void {
    this.alphaValue = Math.min(1, Math.max(this.params.alphaMin, alpha));
  }

  /** Pin a node in place; pinned nodes still repel but are not integrated. */
  pin(index: number, x: number, y: number, z: number): void {
    if (index < 0 || index >= this.graph.nodeCount) return;
    this.pinned[index] = 1;
    this.positions[index * 3] = x;
    this.positions[index * 3 + 1] = y;
    this.positions[index * 3 + 2] = z;
    this.velocities[index * 3] = 0;
    this.velocities[index * 3 + 1] = 0;
    this.velocities[index * 3 + 2] = 0;
  }

  unpin(index: number): void {
    if (index < 0 || index >= this.graph.nodeCount) return;
    this.pinned[index] = 0;
  }

  isPinned(index: number): boolean {
    return this.pinned[index] === 1;
  }

  /** Advance the simulation one step. */
  step(): StepStats {
    const { graph, params, positions, velocities, forces, masses } = this;
    const n = graph.nodeCount;
    forces.fill(0);

    this.tree.build(positions, n, masses);
    for (let i = 0; i < n; i++) {
      this.tree.accumulateRepulsion(
        i,
        positions,
        params.theta,
        params.repulsion * masses[i]!,
        params.softening,
        forces,
        i * 3,
        masses,
      );
    }

    // Springs. Force is proportional to extension beyond the rest length, so an
    // edge at rest contributes nothing rather than constantly fighting repulsion.
    const { edges, edgeWeights, edgeCount } = graph;
    for (let e = 0; e < edgeCount; e++) {
      const a = edges[e * 2]!;
      const b = edges[e * 2 + 1]!;
      const dx = positions[b * 3]! - positions[a * 3]!;
      const dy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
      const dz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const extension = dist - params.springLength;
      const f = (params.springStrength * edgeWeights[e]! * extension) / dist;
      const fx = dx * f;
      const fy = dy * f;
      const fz = dz * f;
      forces[a * 3]! += fx;
      forces[a * 3 + 1]! += fy;
      forces[a * 3 + 2]! += fz;
      forces[b * 3]! -= fx;
      forces[b * 3 + 1]! -= fy;
      forces[b * 3 + 2]! -= fz;
    }

    // Centring gravity.
    if (params.gravity !== 0) {
      for (let i = 0; i < n; i++) {
        forces[i * 3]! -= positions[i * 3]! * params.gravity;
        forces[i * 3 + 1]! -= positions[i * 3 + 1]! * params.gravity;
        forces[i * 3 + 2]! -= positions[i * 3 + 2]! * params.gravity;
      }
    }

    // Semi-implicit Euler: velocity first, then position from the new velocity.
    const dt = params.timeStep;
    const alpha = this.alphaValue;
    let speedSum = 0;
    let speedMax = 0;
    let clamped = 0;

    for (let i = 0; i < n; i++) {
      if (this.pinned[i] === 1) {
        velocities[i * 3] = 0;
        velocities[i * 3 + 1] = 0;
        velocities[i * 3 + 2] = 0;
        continue;
      }
      const invMass = 1 / masses[i]!;
      const o = i * 3;
      velocities[o] = (velocities[o]! + forces[o]! * invMass * dt * alpha) * params.damping;
      velocities[o + 1] =
        (velocities[o + 1]! + forces[o + 1]! * invMass * dt * alpha) * params.damping;
      velocities[o + 2] =
        (velocities[o + 2]! + forces[o + 2]! * invMass * dt * alpha) * params.damping;

      if (clampLength(velocities, i, params.maxSpeed)) clamped++;

      positions[o]! += velocities[o] * dt;
      positions[o + 1]! += velocities[o + 1]! * dt;
      positions[o + 2]! += velocities[o + 2]! * dt;

      const speed = Math.sqrt(
        velocities[o] * velocities[o] +
          velocities[o + 1]! * velocities[o + 1]! +
          velocities[o + 2]! * velocities[o + 2]!,
      );
      speedSum += speed;
      if (speed > speedMax) speedMax = speed;
    }

    this.alphaValue = Math.max(params.alphaMin, this.alphaValue * params.alphaDecay);
    this.stepCount++;

    return {
      alpha: this.alphaValue,
      meanSpeed: n > 0 ? speedSum / n : 0,
      maxSpeed: speedMax,
      clamped,
      treeCells: this.tree.size,
      settled: this.settled,
    };
  }

  /** Run until settled or `maxSteps` is reached. Returns the steps taken. */
  run(maxSteps = 600): number {
    let taken = 0;
    while (taken < maxSteps && !this.settled) {
      this.step();
      taken++;
    }
    return taken;
  }

  /**
   * Total potential energy of the spring system.
   *
   * Not used by the running application; it exists because it is the cleanest
   * single number for showing that the layout converges, and the test suite
   * asserts that it decreases once the initial transient has damped out.
   */
  springEnergy(): number {
    const { graph, positions, params } = this;
    let energy = 0;
    for (let e = 0; e < graph.edgeCount; e++) {
      const a = graph.edges[e * 2]!;
      const b = graph.edges[e * 2 + 1]!;
      const dx = positions[b * 3]! - positions[a * 3]!;
      const dy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
      const dz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
      const extension = Math.sqrt(dx * dx + dy * dy + dz * dz) - params.springLength;
      energy += 0.5 * params.springStrength * graph.edgeWeights[e]! * extension * extension;
    }
    return energy;
  }
}
