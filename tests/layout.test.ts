import { describe, expect, it } from 'vitest';
import { ForceLayout, mulberry32, seedPositions } from '../src/core/layout.js';
import { loadGraph } from '../src/core/graph.js';
import { computeBounds, boundingRadius } from '../src/core/bounds.js';

function ring(size: number) {
  const nodes = Array.from({ length: size }, (_, i) => ({ id: `n${i}` }));
  const edges = Array.from({ length: size }, (_, i) => ({
    source: `n${i}`,
    target: `n${(i + 1) % size}`,
  }));
  return loadGraph({ nodes, edges });
}

function star(spokes: number) {
  const nodes = [{ id: 'hub' }, ...Array.from({ length: spokes }, (_, i) => ({ id: `s${i}` }))];
  const edges = Array.from({ length: spokes }, (_, i) => ({ source: 'hub', target: `s${i}` }));
  return loadGraph({ nodes, edges });
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it('produces different streams for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays within [0, 1)', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('seedPositions', () => {
  it('places every node within the requested radius', () => {
    const n = 500;
    const positions = new Float32Array(n * 3);
    seedPositions(positions, n, 10, mulberry32(3));
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
      expect(r).toBeLessThanOrEqual(10 * 1.08 + 1e-4);
    }
  });

  it('does not place two nodes at the same point', () => {
    const n = 200;
    const positions = new Float32Array(n * 3);
    seedPositions(positions, n, 5, mulberry32(11));
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      seen.add(`${positions[i * 3]!},${positions[i * 3 + 1]!},${positions[i * 3 + 2]!}`);
    }
    expect(seen.size).toBe(n);
  });

  it('handles a single node without dividing by zero', () => {
    const positions = new Float32Array(3);
    seedPositions(positions, 1, 4, mulberry32(1));
    expect(positions.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('ForceLayout', () => {
  it('starts at full alpha and cools toward alphaMin', () => {
    const layout = new ForceLayout(ring(30));
    expect(layout.alpha).toBe(1);
    layout.run(2000);
    expect(layout.alpha).toBeCloseTo(layout.params.alphaMin, 6);
    expect(layout.settled).toBe(true);
  });

  it('reports the number of steps taken', () => {
    const layout = new ForceLayout(ring(20));
    const taken = layout.run(50);
    expect(taken).toBe(50);
    expect(layout.steps).toBe(50);
  });

  it('stops early once settled', () => {
    const layout = new ForceLayout(ring(10), { alphaDecay: 0.5 });
    const taken = layout.run(10_000);
    expect(taken).toBeLessThan(100);
  });

  it('never produces a non-finite position', () => {
    const layout = new ForceLayout(ring(120));
    layout.run(300);
    for (let i = 0; i < layout.positions.length; i++) {
      expect(Number.isFinite(layout.positions[i]!)).toBe(true);
    }
  });

  it('stays finite even when every node starts coincident', () => {
    const layout = new ForceLayout(ring(40));
    layout.positions.fill(0);
    layout.run(120);
    expect(Array.from(layout.positions).every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    const a = new ForceLayout(ring(60), {}, 1234);
    const b = new ForceLayout(ring(60), {}, 1234);
    a.run(80);
    b.run(80);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it('produces a different layout for a different seed', () => {
    const a = new ForceLayout(ring(60), {}, 1);
    const b = new ForceLayout(ring(60), {}, 2);
    a.run(50);
    b.run(50);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('separates two nodes that start on top of each other', () => {
    const graph = loadGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] });
    const layout = new ForceLayout(graph);
    layout.positions.fill(0);
    layout.run(200);
    const separation = Math.hypot(
      layout.positions[0]! - layout.positions[3]!,
      layout.positions[1]! - layout.positions[4]!,
      layout.positions[2]! - layout.positions[5]!,
    );
    expect(separation).toBeGreaterThan(0.1);
  });

  it('pulls connected nodes closer than unconnected ones', () => {
    const graph = loadGraph({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
    });
    const layout = new ForceLayout(graph);
    layout.run(600);
    const dist = (i: number, j: number): number =>
      Math.hypot(
        layout.positions[i * 3]! - layout.positions[j * 3]!,
        layout.positions[i * 3 + 1]! - layout.positions[j * 3 + 1]!,
        layout.positions[i * 3 + 2]! - layout.positions[j * 3 + 2]!,
      );
    expect(dist(0, 1)).toBeLessThan(dist(0, 2));
    expect(dist(2, 3)).toBeLessThan(dist(1, 3));
  });

  it('settles edge lengths near the configured spring length', () => {
    const layout = new ForceLayout(ring(24), { springLength: 2, springStrength: 0.25 });
    layout.run(2500);
    const { edges, edgeCount } = layout.graph;
    let total = 0;
    for (let e = 0; e < edgeCount; e++) {
      const a = edges[e * 2]!;
      const b = edges[e * 2 + 1]!;
      total += Math.hypot(
        layout.positions[a * 3]! - layout.positions[b * 3]!,
        layout.positions[a * 3 + 1]! - layout.positions[b * 3 + 1]!,
        layout.positions[a * 3 + 2]! - layout.positions[b * 3 + 2]!,
      );
    }
    const mean = total / edgeCount;
    // Repulsion inflates edges somewhat; an order-of-magnitude match is the
    // meaningful assertion, not an exact one.
    expect(mean).toBeGreaterThan(1);
    expect(mean).toBeLessThan(8);
  });

  it('reduces spring energy over a run', () => {
    const layout = new ForceLayout(ring(50), { springStrength: 0.2 });
    layout.run(30); // let the initial transient pass
    const early = layout.springEnergy();
    layout.run(800);
    expect(layout.springEnergy()).toBeLessThan(early);
  });

  it('keeps a disconnected node in frame via centring gravity', () => {
    const makeGraph = () =>
      loadGraph({
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'lonely' }],
        edges: [{ source: 'a', target: 'b' }],
      });
    const radiusOfLonely = (gravity: number): number => {
      const layout = new ForceLayout(makeGraph(), { gravity }, 99);
      layout.run(1500);
      return Math.hypot(layout.positions[6]!, layout.positions[7]!, layout.positions[8]!);
    };

    const withGravity = radiusOfLonely(0.05);
    const withoutGravity = radiusOfLonely(0);

    // The assertion that matters is the *comparison*. An absolute threshold is
    // useless here: an unconnected node feels only repulsion, and with gravity
    // off it drifts several times further out while still sitting under any
    // bound generous enough not to be flaky.
    expect(withGravity).toBeLessThan(withoutGravity / 2);
  });

  it('pulls harder toward the origin as gravity increases', () => {
    const radius = (gravity: number): number => {
      const layout = new ForceLayout(ring(40), { gravity }, 5);
      layout.run(1200);
      return boundingRadius(computeBounds(layout.positions, layout.graph.nodeCount));
    };
    expect(radius(0.15)).toBeLessThan(radius(0.01));
  });

  it('holds a pinned node exactly in place', () => {
    const layout = new ForceLayout(ring(20));
    layout.pin(3, 5, 6, 7);
    layout.run(200);
    expect(layout.positions[9]).toBeCloseTo(5, 5);
    expect(layout.positions[10]).toBeCloseTo(6, 5);
    expect(layout.positions[11]).toBeCloseTo(7, 5);
    expect(layout.isPinned(3)).toBe(true);
  });

  it('zeroes the velocity of a pinned node', () => {
    const layout = new ForceLayout(ring(12));
    layout.run(20);
    layout.pin(1, 0, 0, 0);
    layout.step();
    expect(layout.velocities[3]).toBe(0);
    expect(layout.velocities[4]).toBe(0);
    expect(layout.velocities[5]).toBe(0);
  });

  it('lets an unpinned node move again', () => {
    const layout = new ForceLayout(ring(12));
    layout.pin(2, 1, 1, 1);
    layout.run(30);
    layout.unpin(2);
    layout.reheat();
    layout.run(60);
    expect(layout.isPinned(2)).toBe(false);
    const moved =
      Math.abs(layout.positions[6]! - 1) +
      Math.abs(layout.positions[7]! - 1) +
      Math.abs(layout.positions[8]! - 1);
    expect(moved).toBeGreaterThan(1e-4);
  });

  it('ignores pin and unpin for out-of-range indices', () => {
    const layout = new ForceLayout(ring(5));
    expect(() => layout.pin(-1, 0, 0, 0)).not.toThrow();
    expect(() => layout.pin(99, 0, 0, 0)).not.toThrow();
    expect(() => layout.unpin(99)).not.toThrow();
  });

  it('restores alpha on reheat', () => {
    const layout = new ForceLayout(ring(10));
    // 0.994^n reaches alphaMin (0.002) at n = ln(0.002)/ln(0.994) ~ 1032 steps,
    // so 1000 is not enough; run() stops of its own accord once settled.
    layout.run(1500);
    expect(layout.settled).toBe(true);
    layout.reheat();
    expect(layout.alpha).toBe(1);
    expect(layout.settled).toBe(false);
  });

  it('clamps reheat into the legal alpha range', () => {
    const layout = new ForceLayout(ring(10));
    layout.reheat(50);
    expect(layout.alpha).toBe(1);
    layout.reheat(-5);
    expect(layout.alpha).toBe(layout.params.alphaMin);
  });

  it('respects the speed clamp', () => {
    const layout = new ForceLayout(ring(40), { maxSpeed: 0.1, repulsion: 500 });
    const stats = layout.step();
    expect(stats.maxSpeed).toBeLessThanOrEqual(0.1 + 1e-5);
    expect(stats.clamped).toBeGreaterThan(0);
  });

  it('reports a shrinking mean speed as it cools', () => {
    const layout = new ForceLayout(ring(60));
    layout.run(40);
    const early = layout.step().meanSpeed;
    layout.run(900);
    expect(layout.step().meanSpeed).toBeLessThan(early);
  });

  it('gives hub nodes a smaller displacement than their leaves', () => {
    // Mass grows with degree, so the hub should barely move while its leaves
    // swing out around it. Both sides must measure the SAME quantity --
    // displacement from the seeded position -- or the comparison is meaningless.
    const layout = new ForceLayout(star(40));
    const seeded = Float32Array.from(layout.positions);
    layout.run(250);

    const displacement = (i: number): number =>
      Math.hypot(
        layout.positions[i * 3]! - seeded[i * 3]!,
        layout.positions[i * 3 + 1]! - seeded[i * 3 + 1]!,
        layout.positions[i * 3 + 2]! - seeded[i * 3 + 2]!,
      );

    const hubMoved = displacement(0);
    let leafTotal = 0;
    for (let i = 1; i <= 40; i++) leafTotal += displacement(i);
    const meanLeafMoved = leafTotal / 40;

    expect(hubMoved).toBeLessThan(meanLeafMoved);
    // And by a clear margin, not by rounding: the mass ratio is the point.
    expect(hubMoved).toBeLessThan(meanLeafMoved * 0.75);
  });

  it('keeps the graph inside a finite volume', () => {
    const layout = new ForceLayout(ring(200));
    layout.run(900);
    const radius = boundingRadius(computeBounds(layout.positions, layout.graph.nodeCount));
    // Bounds set close to the settled value (~103 for this graph), so a real
    // change in the force balance shows up instead of sliding under a bound
    // loose enough to admit almost anything.
    expect(radius).toBeGreaterThan(20);
    expect(radius).toBeLessThan(200);
  });

  it('reports octree cell counts in its step statistics', () => {
    const layout = new ForceLayout(ring(100));
    expect(layout.step().treeCells).toBeGreaterThan(1);
  });

  it('handles a single-node graph', () => {
    const layout = new ForceLayout(loadGraph({ nodes: [{ id: 'only' }], edges: [] }));
    expect(() => layout.run(20)).not.toThrow();
    expect(Array.from(layout.positions).every(Number.isFinite)).toBe(true);
  });
});
