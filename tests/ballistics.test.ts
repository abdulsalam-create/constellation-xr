import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARC_OPTIONS,
  computeArc,
  snapTurnIntent,
  timeToFloor,
} from '../src/core/ballistics.js';

describe('timeToFloor', () => {
  it('returns the free-fall time for a projectile dropped from rest', () => {
    // h = 0.5*g*t^2  =>  t = sqrt(2h/g) = sqrt(2*4.905/9.81) = 1
    expect(timeToFloor(4.905, 0, 9.81, 0)).toBeCloseTo(1, 4);
  });

  it('includes the rise time when launched upwards', () => {
    // Up for one second, back down for one second.
    expect(timeToFloor(0, 9.81, 9.81, 0)).toBeCloseTo(2, 4);
  });

  it('returns zero when already on the floor with no upward velocity', () => {
    expect(timeToFloor(0, 0, 9.81, 0)).toBeCloseTo(0, 6);
  });

  it('accounts for a raised floor plane', () => {
    expect(timeToFloor(5, 0, 9.81, 5)).toBeCloseTo(0, 6);
    expect(timeToFloor(9.905, 0, 9.81, 5)).toBeCloseTo(1, 4);
  });

  it('never reaches a floor below when fired upward with no gravity', () => {
    expect(timeToFloor(1, 1, 0, 0)).toBeNull();
  });

  it('reaches the floor in a straight line when gravity is zero and aim is downward', () => {
    expect(timeToFloor(2, -1, 0, 0)).toBeCloseTo(2, 6);
  });

  it('returns null for a zero-gravity ray fired level from below the floor', () => {
    expect(timeToFloor(-1, 0, 0, 0)).toBeNull();
  });

  it('finds the crossing for a zero-gravity ray fired upward from below the floor', () => {
    // Height is -2 and the ray climbs at 1 m/s, so it reaches the plane at
    // t = 2. Treating every upward zero-gravity ray as a miss loses this.
    expect(timeToFloor(-2, 1, 0, 0)).toBeCloseTo(2, 6);
  });

  it('returns null for a zero-gravity ray aimed away from the floor', () => {
    expect(timeToFloor(3, 1, 0, 0)).toBeNull();
  });
});

describe('computeArc', () => {
  const flat: readonly [number, number, number] = [1, 0, 0];

  it('starts exactly at the origin', () => {
    const arc = computeArc([1, 1.6, 2], flat);
    expect(arc.points[0]).toBeCloseTo(1, 5);
    expect(arc.points[1]).toBeCloseTo(1.6, 5);
    expect(arc.points[2]).toBeCloseTo(2, 5);
  });

  it('writes the requested number of samples', () => {
    const arc = computeArc([0, 2, 0], flat, { samples: 16 });
    expect(arc.pointCount).toBe(16);
    expect(arc.points.length).toBeGreaterThanOrEqual(48);
  });

  it('enforces a minimum of two samples', () => {
    expect(computeArc([0, 2, 0], flat, { samples: 1 }).pointCount).toBe(2);
  });

  it('lands on the floor plane', () => {
    const arc = computeArc([0, 1.6, 0], flat, { maxRange: 100 });
    expect(arc.landing).not.toBeNull();
    expect(arc.landing![1]).toBe(0);
    expect(arc.clamped).toBe(false);
  });

  it('respects a raised floor plane', () => {
    const arc = computeArc([0, 3, 0], flat, { floorY: 1, maxRange: 100 });
    expect(arc.landing![1]).toBe(1);
  });

  it('descends monotonically in y when fired horizontally', () => {
    const arc = computeArc([0, 2, 0], flat, { maxRange: 100, samples: 20 });
    for (let i = 1; i < arc.pointCount; i++) {
      expect(arc.points[i * 3 + 1]!).toBeLessThanOrEqual(arc.points[(i - 1) * 3 + 1]! + 1e-5);
    }
  });

  it('rises then falls when fired upward', () => {
    const up: readonly [number, number, number] = [0.6, 0.8, 0];
    const arc = computeArc([0, 1, 0], up, { maxRange: 100, samples: 40 });
    const heights = Array.from({ length: arc.pointCount }, (_, i) => arc.points[i * 3 + 1]!);
    const peak = Math.max(...heights);
    expect(peak).toBeGreaterThan(1);
    expect(heights[heights.length - 1]!).toBeLessThan(peak);
  });

  it('clamps the horizontal range and reports it', () => {
    const arc = computeArc([0, 20, 0], flat, { maxRange: 3 });
    expect(arc.clamped).toBe(true);
    expect(arc.points[(arc.pointCount - 1) * 3]!).toBeLessThanOrEqual(3 + 1e-4);
  });

  it('still reports a landing point when the range is clamped', () => {
    // A clamped arc is short, not cancelled. Returning null here would
    // silently disable teleporting for any flat, long aim -- the common case --
    // and the user would see the arc drawn with nothing happening.
    const arc = computeArc([0, 20, 0], flat, { maxRange: 3 });
    expect(arc.landing).not.toBeNull();
    expect(arc.landing![0]).toBeLessThanOrEqual(3 + 1e-4);
    // Clamped mid-flight, so it is above the floor rather than snapped onto it.
    expect(arc.landing![1]).toBeGreaterThan(0);
  });

  it('snaps the landing y onto the floor only when the arc actually reaches it', () => {
    const reached = computeArc([0, 1.6, 0], flat, { maxRange: 100 });
    expect(reached.clamped).toBe(false);
    expect(reached.landing![1]).toBe(0);
  });

  it('reports no landing point when the arc never comes down', () => {
    const arc = computeArc([0, 1, 0], [0, 1, 0], { gravity: 0, maxRange: 5 });
    expect(arc.landing).toBeNull();
  });

  it('draws a probe rather than nothing when the arc never reaches the floor', () => {
    const up: readonly [number, number, number] = [0, 1, 0];
    const arc = computeArc([0, 1, 0], up, { gravity: 0, maxRange: 5 });
    expect(arc.landing).toBeNull();
    expect(arc.pointCount).toBeGreaterThan(1);
    expect(Array.from(arc.points.subarray(0, arc.pointCount * 3)).every(Number.isFinite)).toBe(
      true,
    );
  });

  it('reuses a supplied scratch buffer so per-frame updates do not allocate', () => {
    const scratch = new Float32Array(DEFAULT_ARC_OPTIONS.samples * 3);
    expect(computeArc([0, 1.6, 0], flat, {}, scratch).points).toBe(scratch);
  });

  it('allocates when the supplied scratch buffer is too small', () => {
    const scratch = new Float32Array(3);
    expect(computeArc([0, 1.6, 0], flat, { samples: 10 }, scratch).points).not.toBe(scratch);
  });

  it('travels further at higher launch speed', () => {
    const slow = computeArc([0, 1.6, 0], flat, { speed: 4, maxRange: 100 });
    const fast = computeArc([0, 1.6, 0], flat, { speed: 9, maxRange: 100 });
    expect(fast.landing![0]).toBeGreaterThan(slow.landing![0]);
  });

  it('produces only finite samples', () => {
    const arc = computeArc([0, 1.6, 0], [0.577, 0.577, 0.577], { maxRange: 50 });
    expect(Array.from(arc.points.subarray(0, arc.pointCount * 3)).every(Number.isFinite)).toBe(
      true,
    );
  });
});

describe('snapTurnIntent', () => {
  it('fires once when the stick crosses the threshold', () => {
    const first = snapTurnIntent(0.9, true);
    expect(first.direction).toBe(1);
    expect(first.armed).toBe(false);
  });

  it('does not fire again while the stick is still held', () => {
    const held = snapTurnIntent(0.95, false);
    expect(held.direction).toBe(0);
    expect(held.armed).toBe(false);
  });

  it('re-arms only once the stick falls below the release threshold', () => {
    expect(snapTurnIntent(0.5, false).armed).toBe(false);
    expect(snapTurnIntent(0.2, false).armed).toBe(true);
  });

  it('turns the other way for a negative axis', () => {
    expect(snapTurnIntent(-0.8, true).direction).toBe(-1);
  });

  it('ignores stick noise below the fire threshold', () => {
    expect(snapTurnIntent(0.3, true).direction).toBe(0);
    expect(snapTurnIntent(0.3, true).armed).toBe(true);
  });

  it('does not chatter across a full push-and-release cycle', () => {
    let armed = true;
    let fires = 0;
    // A worn stick hovering around the threshold, then released.
    for (const axis of [0.68, 0.72, 0.69, 0.74, 0.71, 0.4, 0.3, 0.1]) {
      const result = snapTurnIntent(axis, armed);
      armed = result.armed;
      if (result.direction !== 0) fires++;
    }
    expect(fires).toBe(1);
  });
});
