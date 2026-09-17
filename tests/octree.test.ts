import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, Octree, bruteForceRepulsion, LEAF_CAPACITY } from '../src/core/octree.js';
import { mulberry32 } from '../src/core/layout.js';

/** Random cloud of `n` bodies in a cube of the given half-extent. */
function cloud(n: number, extent = 10, seed = 1): Float32Array {
  const random = mulberry32(seed);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    positions[i] = (random() * 2 - 1) * extent;
  }
  return positions;
}

function maxRelativeError(a: Float32Array, b: Float32Array, count: number): number {
  let worst = 0;
  for (let i = 0; i < count; i++) {
    const ax = a[i * 3]!;
    const ay = a[i * 3 + 1]!;
    const az = a[i * 3 + 2]!;
    const bx = b[i * 3]!;
    const by = b[i * 3 + 1]!;
    const bz = b[i * 3 + 2]!;
    const magnitude = Math.hypot(bx, by, bz);
    if (magnitude < 1e-9) continue;
    const error = Math.hypot(ax - bx, ay - by, az - bz) / magnitude;
    if (error > worst) worst = error;
  }
  return worst;
}

describe('Octree construction', () => {
  it('handles an empty body set without allocating a root', () => {
    const tree = new Octree();
    tree.build(new Float32Array(0), 0);
    expect(tree.size).toBe(0);
  });

  it('keeps a single body in the root leaf', () => {
    const tree = new Octree();
    tree.build(Float32Array.from([1, 2, 3]), 1);
    expect(tree.size).toBe(1);
    const com = tree.centreOfMass(0);
    expect(com.mass).toBe(1);
    expect(com.x).toBeCloseTo(1, 6);
    expect(com.y).toBeCloseTo(2, 6);
    expect(com.z).toBeCloseTo(3, 6);
  });

  it('does not subdivide at or below the leaf capacity', () => {
    const positions = cloud(LEAF_CAPACITY, 5, 7);
    const tree = new Octree();
    tree.build(positions, LEAF_CAPACITY);
    expect(tree.size).toBe(1);
  });

  it('subdivides once the leaf capacity is exceeded', () => {
    const positions = cloud(LEAF_CAPACITY + 1, 5, 9);
    const tree = new Octree();
    tree.build(positions, LEAF_CAPACITY + 1);
    expect(tree.size).toBeGreaterThan(1);
  });

  it('computes the root centre of mass exactly', () => {
    const n = 250;
    const positions = cloud(n, 8, 3);
    const tree = new Octree();
    tree.build(positions, n);

    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += positions[i * 3]!;
      sy += positions[i * 3 + 1]!;
      sz += positions[i * 3 + 2]!;
    }
    const com = tree.centreOfMass(0);
    expect(com.mass).toBeCloseTo(n, 5);
    expect(com.x).toBeCloseTo(sx / n, 3);
    expect(com.y).toBeCloseTo(sy / n, 3);
    expect(com.z).toBeCloseTo(sz / n, 3);
  });

  it('honours per-body masses in the root centre of mass', () => {
    const positions = Float32Array.from([-1, 0, 0, 1, 0, 0]);
    const masses = Float32Array.from([3, 1]);
    const tree = new Octree();
    tree.build(positions, 2, masses);
    const com = tree.centreOfMass(0);
    expect(com.mass).toBeCloseTo(4, 6);
    // Weighted mean: (3*-1 + 1*1) / 4 = -0.5
    expect(com.x).toBeCloseTo(-0.5, 6);
  });

  it('encloses every body within the root cell, on all three axes', () => {
    const n = 400;
    const positions = cloud(n, 13, 11);
    const tree = new Octree();
    tree.build(positions, n);

    // Cube read from the tree, not recomputed from the input: asserting against
    // a re-derived centre would make the test circular, which is exactly the
    // failure mode worth avoiding here.
    const half = tree.halfWidth(0);
    const centre = tree.cellCentre(0);
    expect(half).toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      expect(Math.abs(positions[i * 3]! - centre.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(positions[i * 3 + 1]! - centre.y)).toBeLessThanOrEqual(half);
      expect(Math.abs(positions[i * 3 + 2]! - centre.z)).toBeLessThanOrEqual(half);
    }
  });

  it('makes the root cube only as large as the widest axis span', () => {
    const n = 300;
    const positions = cloud(n, 9, 43);
    const tree = new Octree();
    tree.build(positions, n);

    let widest = 0;
    for (let axis = 0; axis < 3; axis++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = positions[i * 3 + axis]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      widest = Math.max(widest, hi - lo);
    }
    const width = tree.halfWidth(0) * 2;
    // Big enough to contain everything, and no more than a hair larger. A cube
    // materially wider than the data would make the s/d opening criterion fire
    // against the wrong scale, silently degrading accuracy.
    expect(width).toBeGreaterThanOrEqual(widest);
    expect(width).toBeLessThanOrEqual(widest * 1.001);
  });

  it('gives the root a cube, not the tight bounding box', () => {
    // Deliberately anisotropic: 20 wide in x, 2 in y, 0.2 in z.
    const positions = Float32Array.from([-10, -1, -0.1, 10, 1, 0.1]);
    const tree = new Octree();
    tree.build(positions, 2);
    // Half-width must follow the *largest* extent, so a single cell width is
    // well defined for the opening criterion.
    expect(tree.halfWidth(0)).toBeGreaterThanOrEqual(10);
    expect(tree.halfWidth(0)).toBeLessThan(10.1);
  });

  it('halves the cell width at each level of descent', () => {
    const positions = cloud(LEAF_CAPACITY * 8, 5, 21);
    const tree = new Octree();
    tree.build(positions, LEAF_CAPACITY * 8);
    // Cell 1 is the first child allocated, so it is exactly one level down.
    expect(tree.halfWidth(1)).toBeCloseTo(tree.halfWidth(0) / 2, 6);
  });

  it('terminates on fully coincident bodies rather than recursing forever', () => {
    const n = 64;
    const positions = new Float32Array(n * 3); // every body at the origin
    const tree = new Octree();
    expect(() => tree.build(positions, n)).not.toThrow();
    // The depth bound must stop subdivision; without it this recurses forever,
    // and an unbounded pool would be the symptom.
    expect(tree.size).toBeLessThan(MAX_DEPTH * 8 + 8);
    expect(tree.centreOfMass(0).mass).toBe(n);
  });

  it('terminates on collinear bodies that share two coordinates', () => {
    const n = 200;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) positions[i * 3] = i * 1e-4;
    const tree = new Octree();
    expect(() => tree.build(positions, n)).not.toThrow();
    expect(tree.centreOfMass(0).mass).toBe(n);
  });

  it('grows its cell pool beyond the initial capacity', () => {
    const n = 3000;
    const positions = cloud(n, 20, 5);
    const tree = new Octree(8, n); // deliberately tiny initial pool
    tree.build(positions, n);
    expect(tree.size).toBeGreaterThan(8);
  });

  it('is reusable across builds without leaking state', () => {
    const tree = new Octree();
    tree.build(cloud(500, 10, 2), 500);
    const first = tree.centreOfMass(0).mass;
    tree.build(cloud(120, 10, 4), 120);
    const second = tree.centreOfMass(0).mass;
    expect(first).toBeCloseTo(500, 4);
    expect(second).toBeCloseTo(120, 4);
  });

  it('rejects non-finite coordinates instead of producing a corrupt tree', () => {
    const positions = Float32Array.from([0, 0, 0, Number.NaN, 0, 0]);
    expect(() => new Octree().build(positions, 2)).toThrow(RangeError);
  });
});

describe('Barnes-Hut force approximation', () => {
  const strength = 10;
  const softening = 0.05;

  it('is exact when theta is zero', () => {
    const n = 300;
    const positions = cloud(n, 10, 13);

    const approx = new Float32Array(n * 3);
    const tree = new Octree(1024, n);
    tree.build(positions, n);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(i, positions, 0, strength, softening, approx, i * 3);
    }

    const exact = new Float32Array(n * 3);
    bruteForceRepulsion(positions, n, strength, softening, exact);

    // theta = 0 never opens a cell, so the traversal reaches every leaf and the
    // only difference from the reference is float summation order.
    expect(maxRelativeError(approx, exact, n)).toBeLessThan(1e-4);
  });

  // Tolerances are set just above the measured error, not an order of magnitude
  // above it: a loose bound would let a real accuracy regression through, which
  // is the only thing this test exists to catch.
  it.each([
    [0.3, 0.004],
    [0.5, 0.03],
    [0.75, 0.15],
  ])('stays within tolerance at theta=%s', (theta, tolerance) => {
    const n = 600;
    const positions = cloud(n, 12, 17);

    const approx = new Float32Array(n * 3);
    const tree = new Octree(1024, n);
    tree.build(positions, n);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(i, positions, theta, strength, softening, approx, i * 3);
    }

    const exact = new Float32Array(n * 3);
    bruteForceRepulsion(positions, n, strength, softening, exact);

    expect(maxRelativeError(approx, exact, n)).toBeLessThan(tolerance);
  });

  it('gets monotonically more accurate as theta decreases', () => {
    const n = 400;
    const positions = cloud(n, 12, 23);
    const exact = new Float32Array(n * 3);
    bruteForceRepulsion(positions, n, strength, softening, exact);

    const errors = [0.9, 0.6, 0.3, 0.1].map((theta) => {
      const approx = new Float32Array(n * 3);
      const tree = new Octree(1024, n);
      tree.build(positions, n);
      for (let i = 0; i < n; i++) {
        tree.accumulateRepulsion(i, positions, theta, strength, softening, approx, i * 3);
      }
      return maxRelativeError(approx, exact, n);
    });

    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!).toBeLessThanOrEqual(errors[i - 1]! + 1e-9);
    }
  });

  it('repels two bodies along the axis separating them', () => {
    const positions = Float32Array.from([-1, 0, 0, 1, 0, 0]);
    const out = new Float32Array(6);
    const tree = new Octree();
    tree.build(positions, 2);
    tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
    tree.accumulateRepulsion(1, positions, 0.5, strength, softening, out, 3);

    expect(out[0]!).toBeLessThan(0); // body 0 pushed further negative
    expect(out[3]!).toBeGreaterThan(0); // body 1 pushed further positive
    expect(out[1]!).toBeCloseTo(0, 6);
    expect(out[2]!).toBeCloseTo(0, 6);
    // Equal and opposite.
    expect(out[0]! + out[3]!).toBeCloseTo(0, 5);
  });

  it('falls off as the inverse square of distance', () => {
    const near = Float32Array.from([0, 0, 0, 1, 0, 0]);
    const far = Float32Array.from([0, 0, 0, 2, 0, 0]);

    const measure = (positions: Float32Array): number => {
      const out = new Float32Array(6);
      const tree = new Octree();
      tree.build(positions, 2);
      tree.accumulateRepulsion(0, positions, 0.5, strength, 0, out, 0);
      return Math.abs(out[0]!);
    };

    // Doubling the distance must quarter the force.
    expect(measure(near) / measure(far)).toBeCloseTo(4, 1);
  });

  it('matches the exact solve under NON-UNIFORM masses at theta = 0', () => {
    // The configuration the layout actually runs: hubs are heavier than leaves.
    // Before the masses were threaded into the leaf branch, this diverged from
    // the oracle by over 1700% at the default theta while every uniform-mass
    // test still passed.
    const n = 400;
    const positions = cloud(n, 10, 29);
    const masses = new Float32Array(n);
    const random = mulberry32(31);
    for (let i = 0; i < n; i++) masses[i] = 1 + random() * 6;

    const approx = new Float32Array(n * 3);
    const tree = new Octree(1024, n);
    tree.build(positions, n, masses);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(
        i,
        positions,
        0,
        strength * masses[i]!,
        softening,
        approx,
        i * 3,
        masses,
      );
    }

    const exact = new Float32Array(n * 3);
    bruteForceRepulsion(positions, n, strength, softening, exact, masses);

    expect(maxRelativeError(approx, exact, n)).toBeLessThan(1e-4);
  });

  it('stays close to the exact solve under non-uniform masses at the default theta', () => {
    const n = 400;
    const positions = cloud(n, 10, 29);
    const masses = new Float32Array(n);
    const random = mulberry32(31);
    for (let i = 0; i < n; i++) masses[i] = 1 + random() * 6;

    const approx = new Float32Array(n * 3);
    const tree = new Octree(1024, n);
    tree.build(positions, n, masses);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(
        i,
        positions,
        0.75,
        strength * masses[i]!,
        softening,
        approx,
        i * 3,
        masses,
      );
    }
    const exact = new Float32Array(n * 3);
    bruteForceRepulsion(positions, n, strength, softening, exact, masses);
    expect(maxRelativeError(approx, exact, n)).toBeLessThan(0.2);
  });

  it('conserves momentum under non-uniform masses', () => {
    // The pairwise force must be symmetric, or every interaction leaks a little
    // momentum and the whole graph slowly translates out of the scene.
    const n = 200;
    const positions = cloud(n, 8, 37);
    const masses = new Float32Array(n);
    const random = mulberry32(41);
    for (let i = 0; i < n; i++) masses[i] = 1 + random() * 6;

    const forces = new Float32Array(n * 3);
    const tree = new Octree(1024, n);
    tree.build(positions, n, masses);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(
        i,
        positions,
        0,
        strength * masses[i]!,
        softening,
        forces,
        i * 3,
        masses,
      );
    }

    let netX = 0;
    let netY = 0;
    let netZ = 0;
    let magnitude = 0;
    for (let i = 0; i < n; i++) {
      netX += forces[i * 3]!;
      netY += forces[i * 3 + 1]!;
      netZ += forces[i * 3 + 2]!;
      magnitude += Math.hypot(forces[i * 3]!, forces[i * 3 + 1]!, forces[i * 3 + 2]!);
    }
    // Net force must vanish to rounding error, relative to the total magnitude.
    expect(Math.hypot(netX, netY, netZ) / magnitude).toBeLessThan(1e-6);
  });

  it('does not let a body repel itself', () => {
    const positions = Float32Array.from([3, 3, 3]);
    const out = new Float32Array(3);
    const tree = new Octree();
    tree.build(positions, 1);
    tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('produces finite forces for coincident bodies thanks to softening', () => {
    const n = 8;
    const positions = new Float32Array(n * 3);
    const out = new Float32Array(n * 3);
    const tree = new Octree();
    tree.build(positions, n);
    for (let i = 0; i < n; i++) {
      tree.accumulateRepulsion(i, positions, 0.5, strength, softening, out, i * 3);
    }
    for (let i = 0; i < n * 3; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
    }
  });

  it('produces a non-zero force for a coincident pair, so they can separate', () => {
    // Softening alone keeps the magnitude finite but leaves the direction at
    // (0,0,0), which welds coincident nodes together permanently.
    const positions = new Float32Array([1, 1, 1, 1, 1, 1]);
    const out = new Float32Array(6);
    const tree = new Octree();
    tree.build(positions, 2);
    tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
    expect(Math.hypot(out[0]!, out[1]!, out[2]!)).toBeGreaterThan(0);
  });

  it('gives coincident bodies opposing forces, not the same one', () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 0]);
    const out = new Float32Array(6);
    const tree = new Octree();
    tree.build(positions, 2);
    tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
    tree.accumulateRepulsion(1, positions, 0.5, strength, softening, out, 3);
    // Equal and opposite. The substitute separation is antisymmetric in the
    // index pair, so momentum is conserved and the graph does not drift.
    expect(out[0]! + out[3]!).toBeCloseTo(0, 6);
    expect(out[1]! + out[4]!).toBeCloseTo(0, 6);
    expect(out[2]! + out[5]!).toBeCloseTo(0, 6);
  });

  it('jitters deterministically, so layouts stay reproducible', () => {
    const run = (): number[] => {
      const positions = new Float32Array([2, 2, 2, 2, 2, 2]);
      const out = new Float32Array(6);
      const tree = new Octree();
      tree.build(positions, 2);
      tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
      return Array.from(out);
    };
    expect(run()).toEqual(run());
  });

  it('names the offending body when a coordinate is non-finite', () => {
    const positions = Float32Array.from([0, 0, 0, 0, Number.POSITIVE_INFINITY, 0]);
    expect(() => new Octree().build(positions, 2)).toThrow(/body 1/);
  });

  it('accumulates into the caller buffer rather than overwriting it', () => {
    const positions = Float32Array.from([-1, 0, 0, 1, 0, 0]);
    const out = new Float32Array([100, 200, 300, 0, 0, 0]);
    const tree = new Octree();
    tree.build(positions, 2);
    tree.accumulateRepulsion(0, positions, 0.5, strength, softening, out, 0);
    expect(out[0]!).toBeLessThan(100);
    expect(out[1]!).toBeCloseTo(200, 5);
    expect(out[2]!).toBeCloseTo(300, 5);
  });
});
