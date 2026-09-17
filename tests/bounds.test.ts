import { describe, expect, it } from 'vitest';
import {
  boundingRadius,
  centre,
  computeBounds,
  emptyBounds,
  fitDistance,
  isEmpty,
  roomScaleFactor,
} from '../src/core/bounds.js';

describe('computeBounds', () => {
  it('returns an empty box for zero points', () => {
    const bounds = computeBounds(new Float32Array(0), 0);
    expect(isEmpty(bounds)).toBe(true);
  });

  it('collapses to a point for a single position', () => {
    const bounds = computeBounds(Float32Array.from([2, 3, 4]), 1);
    expect(bounds.minX).toBe(2);
    expect(bounds.maxX).toBe(2);
    expect(boundingRadius(bounds)).toBe(0);
  });

  it('spans every axis independently', () => {
    const positions = Float32Array.from([-1, 0, 5, 3, -7, 2]);
    const bounds = computeBounds(positions, 2);
    expect(bounds.minX).toBe(-1);
    expect(bounds.maxX).toBe(3);
    expect(bounds.minY).toBe(-7);
    expect(bounds.maxY).toBe(0);
    expect(bounds.minZ).toBe(2);
    expect(bounds.maxZ).toBe(5);
  });

  it('ignores positions past the supplied count', () => {
    const positions = Float32Array.from([0, 0, 0, 100, 100, 100]);
    const bounds = computeBounds(positions, 1);
    expect(bounds.maxX).toBe(0);
  });
});

describe('centre', () => {
  it('returns the midpoint of the box', () => {
    const bounds = computeBounds(Float32Array.from([-2, -4, -6, 2, 4, 6]), 2);
    expect(centre(bounds)).toEqual([0, 0, 0]);
  });

  it('returns the origin for an empty box rather than NaN', () => {
    expect(centre(emptyBounds())).toEqual([0, 0, 0]);
  });
});

describe('boundingRadius', () => {
  it('is the half-diagonal of the box', () => {
    const bounds = computeBounds(Float32Array.from([-1, -1, -1, 1, 1, 1]), 2);
    expect(boundingRadius(bounds)).toBeCloseTo(Math.sqrt(3), 6);
  });

  it('is zero for an empty box', () => {
    expect(boundingRadius(emptyBounds())).toBe(0);
  });
});

describe('fitDistance', () => {
  it('grows linearly with the radius', () => {
    const near = fitDistance(1, 60, 1);
    const far = fitDistance(2, 60, 1);
    expect(far / near).toBeCloseTo(2, 6);
  });

  it('shrinks as the field of view widens', () => {
    expect(fitDistance(1, 90, 1)).toBeLessThan(fitDistance(1, 45, 1));
  });

  it('matches the closed form on a square viewport', () => {
    // At aspect 1 the horizontal and vertical fields agree, so the distance is
    // exactly r / sin(fov/2).
    const fov = 60;
    const expected = 1 / Math.sin((fov * Math.PI) / 360);
    expect(fitDistance(1, fov, 1)).toBeCloseTo(expected, 6);
  });

  it('backs off further on a narrow viewport, where height binds', () => {
    // Aspect below 1 means a tall, narrow window: the vertical field is the
    // tighter constraint, so the distance must not fall below the square case.
    expect(fitDistance(1, 60, 0.5)).toBeGreaterThanOrEqual(fitDistance(1, 60, 1) - 1e-9);
  });

  it('returns a safe default for a degenerate radius', () => {
    expect(fitDistance(0, 60, 1)).toBe(1);
    expect(fitDistance(-5, 60, 1)).toBe(1);
  });

  it('never returns a non-finite distance for a degenerate aspect', () => {
    expect(Number.isFinite(fitDistance(1, 60, 0))).toBe(true);
  });
});

describe('roomScaleFactor', () => {
  it('scales a large graph down to arm reach', () => {
    expect(roomScaleFactor(160, 1.6)).toBeCloseTo(0.01, 6);
  });

  it('scales a tiny graph up', () => {
    expect(roomScaleFactor(0.16, 1.6)).toBeCloseTo(10, 6);
  });

  it('is the identity when the graph already matches the target', () => {
    expect(roomScaleFactor(1.6, 1.6)).toBeCloseTo(1, 6);
  });

  it('returns 1 for a degenerate radius rather than dividing by zero', () => {
    expect(roomScaleFactor(0)).toBe(1);
    expect(Number.isFinite(roomScaleFactor(1e-12))).toBe(true);
  });
});
