import { describe, expect, it } from 'vitest';
import {
  DIM_FACTOR,
  SELECTION_COLOUR,
  buildPalette,
  groupColour,
  oklchToLinearSrgb,
} from '../src/core/palette.js';

describe('oklchToLinearSrgb', () => {
  it('maps zero chroma to a neutral grey', () => {
    const [r, g, b] = oklchToLinearSrgb(0.6, 0, 0);
    expect(r).toBeCloseTo(g, 4);
    expect(g).toBeCloseTo(b, 4);
  });

  it('maps lightness 0 to black and 1 to white', () => {
    expect(oklchToLinearSrgb(0, 0, 0).every((c) => c < 1e-6)).toBe(true);
    expect(oklchToLinearSrgb(1, 0, 0).every((c) => c > 0.99)).toBe(true);
  });

  it('is monotonic in lightness at fixed hue and chroma', () => {
    const dark = oklchToLinearSrgb(0.4, 0.1, 200);
    const light = oklchToLinearSrgb(0.8, 0.1, 200);
    const sum = (c: number[]): number => c[0]! + c[1]! + c[2]!;
    expect(sum(light)).toBeGreaterThan(sum(dark));
  });

  it('puts the red channel first at hue 30 and the blue channel first at hue 264', () => {
    const warm = oklchToLinearSrgb(0.65, 0.15, 30);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const cool = oklchToLinearSrgb(0.65, 0.15, 264);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it('clips out-of-gamut results into [0, 1] rather than emitting negatives', () => {
    // A chroma this high at this lightness is far outside sRGB.
    const colour = oklchToLinearSrgb(0.5, 0.9, 150);
    for (const channel of colour) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('wraps hue by 360 degrees', () => {
    const a = oklchToLinearSrgb(0.7, 0.12, 40);
    const b = oklchToLinearSrgb(0.7, 0.12, 400);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
    expect(a[2]).toBeCloseTo(b[2], 6);
  });
});

describe('groupColour', () => {
  it('is deterministic, so a dataset colours the same way every time', () => {
    expect(groupColour(7)).toEqual(groupColour(7));
  });

  it('gives adjacent group indices visibly different colours', () => {
    const a = groupColour(0);
    const b = groupColour(1);
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(distance).toBeGreaterThan(0.1);
  });

  it('never repeats a colour within the first forty groups', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(
        groupColour(i)
          .map((c) => c.toFixed(4))
          .join(','),
      );
    }
    expect(seen.size).toBe(40);
  });

  it('stays inside the sRGB cube for every group index it is asked for', () => {
    for (let i = 0; i < 200; i++) {
      for (const channel of groupColour(i)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('buildPalette', () => {
  it('packs three floats per group', () => {
    expect(buildPalette(5)).toHaveLength(15);
  });

  it('matches groupColour entry for entry', () => {
    const palette = buildPalette(4);
    for (let i = 0; i < 4; i++) {
      const [r, g, b] = groupColour(i);
      expect(palette[i * 3]).toBeCloseTo(r, 6);
      expect(palette[i * 3 + 1]).toBeCloseTo(g, 6);
      expect(palette[i * 3 + 2]).toBeCloseTo(b, 6);
    }
  });

  it('returns a one-entry palette rather than an empty buffer for zero groups', () => {
    expect(buildPalette(0)).toHaveLength(3);
  });
});

describe('selection constants', () => {
  it('uses a highlight colour inside the sRGB cube', () => {
    for (const channel of SELECTION_COLOUR) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('dims rather than hides, so context is preserved', () => {
    expect(DIM_FACTOR).toBeGreaterThan(0);
    expect(DIM_FACTOR).toBeLessThan(0.5);
  });
});
