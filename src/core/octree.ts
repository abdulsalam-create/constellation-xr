/**
 * Barnes-Hut octree for the N-body repulsion term.
 *
 * The naive all-pairs repulsion in a force-directed layout is O(n^2): at 5,000
 * nodes that is 25 million interactions per step, far past the ~11ms budget a
 * 90Hz headset allows. Barnes-Hut reduces it to O(n log n) by approximating a
 * distant cluster with its centre of mass — a cell of width `s` seen from
 * distance `d` collapses to a single interaction whenever `s / d < theta`.
 *
 * Implementation notes:
 *
 * - The tree is a struct-of-arrays over a growable pool. No per-cell objects are
 *   allocated, so rebuilding every step produces no garbage after warm-up. That
 *   matters more than raw throughput here: a GC pause is a dropped frame, and a
 *   dropped frame in a headset is nausea.
 * - Bodies live in per-leaf singly-linked lists threaded through `nextBody`.
 * - Centres of mass are computed in a single reverse sweep over the cell pool.
 *   Children are always allocated after their parent, so iterating the pool
 *   backwards visits every cell before its parent — a topological order for free,
 *   with no recursion and no second tree walk.
 * - Coincident bodies are the classic failure mode: subdividing two points at the
 *   same coordinate never separates them and would recurse forever. `MAX_DEPTH`
 *   bounds it, and at maximum depth a leaf simply keeps an unbounded bucket.
 *
 * Reference: Barnes, J. & Hut, P. (1986). "A hierarchical O(N log N)
 * force-calculation algorithm." Nature 324, 446-449.
 */

/** Bodies a leaf holds before it subdivides. */
export const LEAF_CAPACITY = 4;

/** Depth bound, which also bounds the damage done by coincident points. */
export const MAX_DEPTH = 24;

const EMPTY = -1;

/**
 * Separation below which two bodies are treated as coincident.
 *
 * Softening keeps the force finite at r = 0, but it does nothing about the
 * *direction*: the displacement vector between two bodies at the same point is
 * (0, 0, 0), so the force is zero and they stay welded together forever. Every
 * serious force-layout implementation perturbs this case (d3-force calls it
 * "jiggle"); without it, any dataset whose seeding puts two nodes on the same
 * coordinate renders them as one node permanently.
 */
const COINCIDENT_EPSILON_SQ = 1e-12;

/**
 * Deterministic displacement standing in for a coincident pair's separation.
 *
 * Two properties matter here, and both are load-bearing:
 *
 * - **Deterministic.** Derived from the body indices rather than from
 *   `Math.random()`, so a given graph and seed lay out identically every run.
 *   Any direction will do, so reproducibility costs nothing.
 * - **Antisymmetric.** `jiggle(i, j)` must be exactly `-jiggle(j, i)`, or the
 *   pair pushes itself one way and Newton's third law is broken. Momentum then
 *   leaks out of every coincident pair and the whole graph slowly drifts off
 *   into space — a baffling bug to chase from the symptom. The hash is computed
 *   from the *unordered* pair and the sign comes from the ordering, which makes
 *   the antisymmetry exact rather than approximate.
 */
function jiggle(i: number, j: number, out: [number, number, number]): void {
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  let h = (Math.imul(lo + 1, 0x9e3779b1) ^ Math.imul(hi + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;

  // Uniform point on a sphere: z uniform in [-1, 1], azimuth uniform in [0, 2pi).
  const azimuth = ((h & 0x3ff) / 0x3ff) * Math.PI * 2;
  const z = (((h >>> 10) & 0x3ff) / 0x3ff) * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const scale = (i < j ? 1 : -1) * COINCIDENT_OFFSET;

  out[0] = Math.cos(azimuth) * r * scale;
  out[1] = Math.sin(azimuth) * r * scale;
  out[2] = z * scale;
}

/** Magnitude of the substitute separation. Small enough to be invisible. */
const COINCIDENT_OFFSET = 1e-4;

export class Octree {
  private children: Int32Array;
  /** Bit k set when child k exists. Makes the leaf test O(1). */
  private childMask: Uint8Array;
  private parent: Int32Array;
  private mass: Float64Array;
  /** Mass-weighted position sums; divided by mass on read. */
  private comX: Float64Array;
  private comY: Float64Array;
  private comZ: Float64Array;
  private cx: Float64Array;
  private cy: Float64Array;
  private cz: Float64Array;
  private half: Float64Array;
  private firstBody: Int32Array;
  private bodyCount: Int32Array;
  private depth: Uint8Array;

  /** Body linked-list successor, indexed by body. */
  private nextBody: Int32Array;

  private cellCount = 0;
  private capacity: number;

  /** Traversal stack, reused across force queries so queries never allocate. */
  private stack: Int32Array;
  /** Scratch displacement for the coincident-pair case; see {@link jiggle}. */
  private readonly jitter: [number, number, number] = [0, 0, 0];

  constructor(initialCapacity = 1024, maxBodies = 1024) {
    this.capacity = Math.max(8, initialCapacity);
    const c = this.capacity;
    this.children = new Int32Array(c * 8);
    this.childMask = new Uint8Array(c);
    this.parent = new Int32Array(c);
    this.mass = new Float64Array(c);
    this.comX = new Float64Array(c);
    this.comY = new Float64Array(c);
    this.comZ = new Float64Array(c);
    this.cx = new Float64Array(c);
    this.cy = new Float64Array(c);
    this.cz = new Float64Array(c);
    this.half = new Float64Array(c);
    this.firstBody = new Int32Array(c);
    this.bodyCount = new Int32Array(c);
    this.depth = new Uint8Array(c);
    this.nextBody = new Int32Array(Math.max(1, maxBodies));
    this.stack = new Int32Array(1024);
  }

  /** Cells currently in use. Exposed for tests and the performance HUD. */
  get size(): number {
    return this.cellCount;
  }

  /**
   * Rebuild over `count` bodies whose positions are interleaved xyz in
   * `positions`. `masses` may be omitted, in which case every body has mass 1.
   *
   * The root is a cube enclosing every body. A cube rather than the tight AABB
   * is what makes the `s / d < theta` test meaningful: `s` has to be one
   * well-defined cell width, not three different extents.
   */
  build(positions: Float32Array, count: number, masses?: Float32Array | null): void {
    this.cellCount = 0;
    if (this.nextBody.length < count) this.nextBody = new Int32Array(count);
    if (count <= 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]!;
      const y = positions[i * 3 + 1]!;
      const z = positions[i * 3 + 2]!;
      // Checked explicitly rather than by inspecting the extrema afterwards:
      // every comparison against NaN is false, so a single NaN slips through the
      // min/max pass untouched and only surfaces later as a silently corrupt
      // tree. Catching it here turns a mystery into a message.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new RangeError(
          `Octree.build: body ${i} has a non-finite coordinate (${x}, ${y}, ${z})`,
        );
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
    // A hair of slack keeps bodies lying exactly on the boundary inside the root.
    const half = (extent / 2) * 1.0001;
    this.allocCell(EMPTY, (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, half, 0);

    for (let i = 0; i < count; i++) {
      this.place(i, positions);
    }
    this.summarise(positions, masses ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                            */
  /* ---------------------------------------------------------------------- */

  private grow(): void {
    const next = this.capacity * 2;
    this.children = growI32(this.children, next * 8);
    const mask = new Uint8Array(next);
    mask.set(this.childMask);
    this.childMask = mask;
    this.parent = growI32(this.parent, next);
    this.mass = growF64(this.mass, next);
    this.comX = growF64(this.comX, next);
    this.comY = growF64(this.comY, next);
    this.comZ = growF64(this.comZ, next);
    this.cx = growF64(this.cx, next);
    this.cy = growF64(this.cy, next);
    this.cz = growF64(this.cz, next);
    this.half = growF64(this.half, next);
    this.firstBody = growI32(this.firstBody, next);
    this.bodyCount = growI32(this.bodyCount, next);
    const depth = new Uint8Array(next);
    depth.set(this.depth);
    this.depth = depth;
    this.capacity = next;
  }

  private allocCell(
    parent: number,
    cx: number,
    cy: number,
    cz: number,
    half: number,
    depth: number,
  ): number {
    if (this.cellCount >= this.capacity) this.grow();
    const c = this.cellCount++;
    const base = c * 8;
    for (let k = 0; k < 8; k++) this.children[base + k] = EMPTY;
    this.childMask[c] = 0;
    this.parent[c] = parent;
    this.mass[c] = 0;
    this.comX[c] = 0;
    this.comY[c] = 0;
    this.comZ[c] = 0;
    this.cx[c] = cx;
    this.cy[c] = cy;
    this.cz[c] = cz;
    this.half[c] = half;
    this.firstBody[c] = EMPTY;
    this.bodyCount[c] = 0;
    this.depth[c] = depth;
    return c;
  }

  private octantOf(cell: number, x: number, y: number, z: number): number {
    return (
      (x >= this.cx[cell]! ? 1 : 0) | (y >= this.cy[cell]! ? 2 : 0) | (z >= this.cz[cell]! ? 4 : 0)
    );
  }

  private childFor(cell: number, octant: number): number {
    const existing = this.children[cell * 8 + octant]!;
    if (existing !== EMPTY) return existing;
    const half = this.half[cell]! / 2;
    const child = this.allocCell(
      cell,
      this.cx[cell]! + (octant & 1 ? half : -half),
      this.cy[cell]! + (octant & 2 ? half : -half),
      this.cz[cell]! + (octant & 4 ? half : -half),
      half,
      this.depth[cell]! + 1,
    );
    this.children[cell * 8 + octant] = child;
    this.childMask[cell]! |= 1 << octant;
    return child;
  }

  private attach(cell: number, body: number): void {
    this.nextBody[body] = this.firstBody[cell]!;
    this.firstBody[cell] = body;
    this.bodyCount[cell]! += 1;
  }

  /** Insert one body, subdividing full leaves on the way down. */
  private place(body: number, positions: Float32Array): void {
    const x = positions[body * 3]!;
    const y = positions[body * 3 + 1]!;
    const z = positions[body * 3 + 2]!;

    let cell = 0;
    for (;;) {
      if (this.childMask[cell] === 0) {
        if (this.bodyCount[cell]! < LEAF_CAPACITY || this.depth[cell]! >= MAX_DEPTH) {
          this.attach(cell, body);
          return;
        }
        // Full leaf below the depth bound: push its residents down one level.
        // A child may end up over capacity if the residents are collinear; that
        // is fine, the next insertion into that child subdivides it in turn, and
        // depth strictly increases so the process terminates.
        let resident = this.firstBody[cell]!;
        this.firstBody[cell] = EMPTY;
        this.bodyCount[cell] = 0;
        while (resident !== EMPTY) {
          const nextResident = this.nextBody[resident]!;
          const child = this.childFor(
            cell,
            this.octantOf(
              cell,
              positions[resident * 3]!,
              positions[resident * 3 + 1]!,
              positions[resident * 3 + 2]!,
            ),
          );
          this.attach(child, resident);
          resident = nextResident;
        }
      }
      cell = this.childFor(cell, this.octantOf(cell, x, y, z));
    }
  }

  /**
   * Compute mass and centre of mass for every cell in one reverse sweep.
   *
   * Children always have a higher pool index than their parent, so walking the
   * pool from the end visits every cell before the cell it rolls up into.
   */
  private summarise(positions: Float32Array, masses: Float32Array | null): void {
    for (let cell = this.cellCount - 1; cell >= 0; cell--) {
      if (this.childMask[cell] === 0) {
        for (let b = this.firstBody[cell]!; b !== EMPTY; b = this.nextBody[b]!) {
          const m = masses ? masses[b]! : 1;
          this.mass[cell]! += m;
          this.comX[cell]! += positions[b * 3]! * m;
          this.comY[cell]! += positions[b * 3 + 1]! * m;
          this.comZ[cell]! += positions[b * 3 + 2]! * m;
        }
      }
      const p = this.parent[cell]!;
      if (p !== EMPTY) {
        this.mass[p]! += this.mass[cell]!;
        this.comX[p]! += this.comX[cell]!;
        this.comY[p]! += this.comY[cell]!;
        this.comZ[p]! += this.comZ[cell]!;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Force query                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Accumulate the repulsive force on `body` into `out` (three floats starting
   * at `outOffset`), using the `s / d < theta` opening criterion.
   *
   * The force law is Coulomb-like, `F = k * m / (r^2 + eps^2)`, with the
   * softening term `eps` removing the singularity at r -> 0 that would otherwise
   * fling coincident nodes to infinity on the first step.
   *
   * With `theta = 0` no cell ever satisfies the criterion, so the traversal
   * descends to every leaf and the result is exact. That identity is what the
   * unit tests use to check the approximation against
   * {@link bruteForceRepulsion}.
   */
  accumulateRepulsion(
    body: number,
    positions: Float32Array,
    theta: number,
    strength: number,
    softening: number,
    out: Float32Array,
    outOffset: number,
    masses?: Float32Array | null,
  ): void {
    if (this.cellCount === 0) return;
    const x = positions[body * 3]!;
    const y = positions[body * 3 + 1]!;
    const z = positions[body * 3 + 2]!;
    const eps2 = softening * softening;
    const thetaSq = theta * theta;

    let fx = 0;
    let fy = 0;
    let fz = 0;

    let sp = 0;
    this.stack[sp++] = 0;

    while (sp > 0) {
      const cell = this.stack[--sp]!;
      const m = this.mass[cell]!;
      if (m === 0) continue;

      if (this.childMask[cell] !== 0) {
        const dx = x - this.comX[cell]! / m;
        const dy = y - this.comY[cell]! / m;
        const dz = z - this.comZ[cell]! / m;
        const distSq = dx * dx + dy * dy + dz * dz;
        const width = this.half[cell]! * 2;

        // s/d < theta  <=>  s^2 < theta^2 * d^2, which avoids the square root.
        if (width * width < thetaSq * distSq) {
          const invDist = 1 / Math.sqrt(distSq + eps2);
          const f = strength * m * invDist * invDist;
          fx += dx * invDist * f;
          fy += dy * invDist * f;
          fz += dz * invDist * f;
          continue;
        }
        if (sp + 8 > this.stack.length) this.growStack();
        const base = cell * 8;
        const mask = this.childMask[cell]!;
        for (let k = 0; k < 8; k++) {
          if (mask & (1 << k)) this.stack[sp++] = this.children[base + k]!;
        }
        continue;
      }

      // Leaf: exact pairwise interaction with each resident body.
      for (let j = this.firstBody[cell]!; j !== EMPTY; j = this.nextBody[j]!) {
        if (j === body) continue;
        let dx = x - positions[j * 3]!;
        let dy = y - positions[j * 3 + 1]!;
        let dz = z - positions[j * 3 + 2]!;
        let distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < COINCIDENT_EPSILON_SQ) {
          jiggle(body, j, this.jitter);
          dx = this.jitter[0];
          dy = this.jitter[1];
          dz = this.jitter[2];
          distSq = dx * dx + dy * dy + dz * dz;
        }
        // The other body's mass must appear here, because the multipole branch
        // above uses the cell's *total* mass. Omitting it makes a nearby body
        // repel as if it had mass 1 while a distant cluster repels in
        // proportion to its summed mass, so the force jumps discontinuously
        // across the theta threshold, the approximation stops converging to the
        // exact solve, and the pair interaction stops being symmetric — which
        // leaks momentum and drifts the whole graph off into space.
        const otherMass = masses ? masses[j]! : 1;
        const invDist = 1 / Math.sqrt(distSq + eps2);
        const f = strength * otherMass * invDist * invDist;
        fx += dx * invDist * f;
        fy += dy * invDist * f;
        fz += dz * invDist * f;
      }
    }

    out[outOffset]! += fx;
    out[outOffset + 1]! += fy;
    out[outOffset + 2]! += fz;
  }

  private growStack(): void {
    const next = new Int32Array(this.stack.length * 2);
    next.set(this.stack);
    this.stack = next;
  }

  /** Centre of mass of a cell. Exposed for tests and debug visualisation. */
  centreOfMass(cell: number): { x: number; y: number; z: number; mass: number } {
    const m = this.mass[cell]!;
    if (m === 0) return { x: 0, y: 0, z: 0, mass: 0 };
    return {
      x: this.comX[cell]! / m,
      y: this.comY[cell]! / m,
      z: this.comZ[cell]! / m,
      mass: m,
    };
  }

  /** Half-width of a cell. Exposed for tests and debug visualisation. */
  halfWidth(cell: number): number {
    return this.half[cell]!;
  }

  /**
   * Geometric centre of a cell — distinct from its centre of *mass*.
   *
   * Exposed so tests can assert the enclosing-cube invariant against the tree's
   * own geometry rather than against a value recomputed from the input, which
   * would make the assertion circular.
   */
  cellCentre(cell: number): { x: number; y: number; z: number } {
    return { x: this.cx[cell]!, y: this.cy[cell]!, z: this.cz[cell]! };
  }
}

function growF64(source: Float64Array, length: number): Float64Array {
  const next = new Float64Array(length);
  next.set(source);
  return next;
}

function growI32(source: Int32Array, length: number): Int32Array {
  const next = new Int32Array(length);
  next.set(source);
  return next;
}

/**
 * Exact O(n^2) reference implementation of the same force law.
 *
 * `masses` must be supplied whenever the tree was built with masses, or the two
 * are not modelling the same physics and the comparison is meaningless. The
 * self-mass factor is applied here rather than folded into `strength` by the
 * caller, so a single call reproduces exactly what {@link ForceLayout} computes.
 *
 * Kept beside the approximation rather than in the test folder on purpose: it is
 * the oracle Barnes-Hut is validated against, and keeping the two in one file
 * makes it obvious when one drifts from the other.
 */
export function bruteForceRepulsion(
  positions: Float32Array,
  count: number,
  strength: number,
  softening: number,
  out: Float32Array,
  masses?: Float32Array | null,
): void {
  const eps2 = softening * softening;
  const scratch: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    let fx = 0;
    let fy = 0;
    let fz = 0;
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      let dx = x - positions[j * 3]!;
      let dy = y - positions[j * 3 + 1]!;
      let dz = z - positions[j * 3 + 2]!;
      let distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < COINCIDENT_EPSILON_SQ) {
        jiggle(i, j, scratch);
        dx = scratch[0];
        dy = scratch[1];
        dz = scratch[2];
        distSq = dx * dx + dy * dy + dz * dz;
      }
      const invDist = 1 / Math.sqrt(distSq + eps2);
      const f = strength * (masses ? masses[j]! : 1) * invDist * invDist;
      fx += dx * invDist * f;
      fy += dy * invDist * f;
      fz += dz * invDist * f;
    }
    const selfMass = masses ? masses[i]! : 1;
    fx *= selfMass;
    fy *= selfMass;
    fz *= selfMass;
    out[i * 3]! += fx;
    out[i * 3 + 1]! += fy;
    out[i * 3 + 2]! += fz;
  }
}
