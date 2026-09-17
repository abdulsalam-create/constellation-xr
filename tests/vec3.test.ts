import { describe, expect, it } from 'vitest';
import { clampLength, damp } from '../src/core/vec3.js';

/** Magnitude of the vector at `index`, for assertions only. */
function magnitude(buffer: Float32Array, index: number): number {
  const o = index * 3;
  return Math.hypot(buffer[o]!, buffer[o + 1]!, buffer[o + 2]!);
}

describe('clampLength', () => {
  it('leaves a short vector alone and reports no clamp', () => {
    const buffer = Float32Array.from([1, 0, 0]);
    expect(clampLength(buffer, 0, 5)).toBe(false);
    expect(Array.from(buffer)).toEqual([1, 0, 0]);
  });

  it('shortens a long vector to exactly the maximum', () => {
    const buffer = Float32Array.from([30, 40, 0]);
    expect(clampLength(buffer, 0, 5)).toBe(true);
    expect(magnitude(buffer, 0)).toBeCloseTo(5, 5);
  });

  it('preserves direction while clamping', () => {
    const buffer = Float32Array.from([30, 40, 0]);
    clampLength(buffer, 0, 5);
    expect(buffer[0]! / buffer[1]!).toBeCloseTo(30 / 40, 5);
  });

  it('operates on the requested element only', () => {
    const buffer = Float32Array.from([30, 40, 0, 30, 40, 0]);
    clampLength(buffer, 1, 5);
    expect(magnitude(buffer, 0)).toBeCloseTo(50, 5);
    expect(magnitude(buffer, 1)).toBeCloseTo(5, 5);
  });

  it('reports no clamp for the zero vector instead of dividing by zero', () => {
    const buffer = new Float32Array(3);
    expect(clampLength(buffer, 0, 5)).toBe(false);
    expect(Array.from(buffer).every(Number.isFinite)).toBe(true);
  });

  it('treats a vector exactly at the limit as unclamped', () => {
    expect(clampLength(Float32Array.from([5, 0, 0]), 0, 5)).toBe(false);
  });

  it('handles a negative-component vector', () => {
    const buffer = Float32Array.from([-30, -40, 0]);
    expect(clampLength(buffer, 0, 5)).toBe(true);
    expect(buffer[0]).toBeLessThan(0);
    expect(magnitude(buffer, 0)).toBeCloseTo(5, 5);
  });
});

describe('damp', () => {
  it('moves toward the target without overshooting', () => {
    const next = damp(0, 10, 0.5, 1);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
  });

  it('does not move at all over zero elapsed time', () => {
    expect(damp(3, 10, 0.9, 0)).toBeCloseTo(3, 6);
  });

  it('is frame-rate independent: two half-steps equal one full step', () => {
    // The property the whole function exists for. A bare `rate * dt` fails this.
    const once = damp(0, 1, 0.8, 0.2);
    const twice = damp(damp(0, 1, 0.8, 0.1), 1, 0.8, 0.1);
    expect(twice).toBeCloseTo(once, 6);
  });

  it('holds across four refresh rates a headset might run at', () => {
    const target = 1;
    const reference = damp(0, target, 0.9, 1);
    for (const hz of [60, 72, 90, 120]) {
      let value = 0;
      for (let i = 0; i < hz; i++) value = damp(value, target, 0.9, 1 / hz);
      expect(value).toBeCloseTo(reference, 5);
    }
  });

  it('converges to the target over a long interval', () => {
    expect(damp(0, 10, 0.9, 20)).toBeCloseTo(10, 6);
  });

  it('is a no-op when already at the target', () => {
    expect(damp(5, 5, 0.5, 1)).toBeCloseTo(5, 6);
  });
});
