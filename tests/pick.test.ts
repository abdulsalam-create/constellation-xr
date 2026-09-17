import { describe, expect, it } from 'vitest';
import { closestPointOnRay, pickCone, pickSphere } from '../src/core/pick.js';

const X: readonly [number, number, number] = [1, 0, 0];
const ORIGIN: readonly [number, number, number] = [0, 0, 0];

describe('pickSphere', () => {
  it('hits a sphere directly ahead', () => {
    const positions = Float32Array.from([5, 0, 0]);
    const hit = pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X);
    expect(hit.index).toBe(0);
    expect(hit.distance).toBeCloseTo(4, 5);
  });

  it('misses a sphere off the ray', () => {
    const positions = Float32Array.from([5, 3, 0]);
    const hit = pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X);
    expect(hit.index).toBe(-1);
    expect(hit.distance).toBe(Infinity);
  });

  it('misses a sphere behind the origin', () => {
    const positions = Float32Array.from([-5, 0, 0]);
    expect(pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X).index).toBe(-1);
  });

  it('returns the nearest of two spheres on the same ray', () => {
    const positions = Float32Array.from([10, 0, 0, 3, 0, 0]);
    const hit = pickSphere(positions, Float32Array.from([1]), 2, ORIGIN, X);
    expect(hit.index).toBe(1);
    expect(hit.distance).toBeCloseTo(2, 5);
  });

  it('honours per-node radii', () => {
    const positions = Float32Array.from([5, 1.5, 0]);
    expect(pickSphere(positions, Float32Array.from([2]), 1, ORIGIN, X).index).toBe(0);
    expect(pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X).index).toBe(-1);
  });

  it('uses the far root when the origin is inside the sphere', () => {
    const positions = Float32Array.from([0, 0, 0]);
    const hit = pickSphere(positions, Float32Array.from([2]), 1, ORIGIN, X);
    expect(hit.index).toBe(0);
    expect(hit.distance).toBeCloseTo(2, 5);
  });

  it('is tangent-stable: a grazing ray still registers', () => {
    const positions = Float32Array.from([5, 1, 0]);
    expect(pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X).index).toBe(0);
  });

  it('respects maxDistance', () => {
    const positions = Float32Array.from([50, 0, 0]);
    expect(pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X, 10).index).toBe(-1);
    expect(pickSphere(positions, Float32Array.from([1]), 1, ORIGIN, X, 100).index).toBe(0);
  });

  it('returns a miss for an empty node set', () => {
    expect(pickSphere(new Float32Array(0), Float32Array.from([1]), 0, ORIGIN, X).index).toBe(-1);
  });

  it('works along an arbitrary normalised direction', () => {
    const d: readonly [number, number, number] = [0, 0, -1];
    const positions = Float32Array.from([0, 0, -4]);
    const hit = pickSphere(positions, Float32Array.from([0.5]), 1, ORIGIN, d);
    expect(hit.index).toBe(0);
    expect(hit.distance).toBeCloseTo(3.5, 5);
  });
});

describe('pickCone', () => {
  it('selects a node inside the cone that a strict ray would miss', () => {
    const positions = Float32Array.from([10, 0.5, 0]);
    expect(pickSphere(positions, Float32Array.from([0.05]), 1, ORIGIN, X).index).toBe(-1);
    expect(pickCone(positions, 1, ORIGIN, X, (6 * Math.PI) / 180).index).toBe(0);
  });

  it('rejects a node outside the cone', () => {
    const positions = Float32Array.from([10, 10, 0]);
    expect(pickCone(positions, 1, ORIGIN, X, (6 * Math.PI) / 180).index).toBe(-1);
  });

  it('prefers the smaller angular offset over the nearer node', () => {
    const positions = Float32Array.from([2, 0.2, 0, 8, 0, 0]);
    expect(pickCone(positions, 2, ORIGIN, X, (20 * Math.PI) / 180).index).toBe(1);
  });

  it('breaks an exact angular tie by proximity', () => {
    const positions = Float32Array.from([9, 0, 0, 3, 0, 0]);
    const hit = pickCone(positions, 2, ORIGIN, X, (10 * Math.PI) / 180);
    expect(hit.index).toBe(1);
    expect(hit.distance).toBeCloseTo(3, 5);
  });

  it('selects equally well at near and far range, unlike a distance threshold', () => {
    const angle = (4 * Math.PI) / 180;
    const offset = Math.tan(angle) * 0.5;
    expect(pickCone(Float32Array.from([2, offset * 2, 0]), 1, ORIGIN, X, angle).index).toBe(0);
    expect(pickCone(Float32Array.from([20, offset * 20, 0]), 1, ORIGIN, X, angle).index).toBe(0);
  });

  it('ignores a node coincident with the ray origin', () => {
    expect(pickCone(Float32Array.from([0, 0, 0]), 1, ORIGIN, X, 1).index).toBe(-1);
  });

  it('respects maxDistance', () => {
    expect(pickCone(Float32Array.from([30, 0, 0]), 1, ORIGIN, X, 0.2, 10).index).toBe(-1);
  });

  it('returns a miss for an empty node set', () => {
    expect(pickCone(new Float32Array(0), 0, ORIGIN, X, 0.2).index).toBe(-1);
  });
});

describe('closestPointOnRay', () => {
  it('projects a point onto the ray', () => {
    const result = closestPointOnRay(ORIGIN, X, [4, 3, 0]);
    expect(result.t).toBeCloseTo(4, 5);
    expect(result.x).toBeCloseTo(4, 5);
    expect(result.y).toBeCloseTo(0, 5);
  });

  it('clamps behind the origin to t = 0', () => {
    const result = closestPointOnRay(ORIGIN, X, [-4, 3, 0]);
    expect(result.t).toBe(0);
    expect(result.x).toBe(0);
  });

  it('accounts for a non-zero ray origin', () => {
    const result = closestPointOnRay([1, 1, 1], X, [5, 1, 1]);
    expect(result.t).toBeCloseTo(4, 5);
    expect(result.x).toBeCloseTo(5, 5);
    expect(result.z).toBeCloseTo(1, 5);
  });
});
