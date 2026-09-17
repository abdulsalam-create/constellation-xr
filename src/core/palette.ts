/**
 * Colour assignment for node groups.
 *
 * Categorical colours are generated rather than taken from a fixed list so that
 * a graph with forty groups does not silently start reusing colours. Hues are
 * spaced by the golden angle, which keeps successive groups far apart on the
 * wheel, and lightness alternates so that adjacent hues stay distinguishable
 * even for viewers with reduced colour discrimination.
 *
 * The palette is defined in OKLCH-like terms (perceptual lightness and chroma)
 * and converted to sRGB, so no two groups differ mainly in a channel the eye is
 * insensitive to. In a headset this matters more than on a monitor: the low
 * persistence displays used in VR wash out low-contrast colour differences.
 */

const GOLDEN_ANGLE_DEG = 137.508;

/** Linear-light sRGB triple in [0, 1]. */
export type Rgb = [number, number, number];

/**
 * Convert OKLCH to linear sRGB.
 *
 * Reference: Bjorn Ottosson, "A perceptual color space for image processing"
 * (2020). Values outside the sRGB gamut are clipped per channel.
 */
export function oklchToLinearSrgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);

  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Deterministic colour for group `index`.
 *
 * Deterministic matters: the same dataset must colour the same way every time
 * it is opened, or a user comparing two sessions is comparing noise.
 */
export function groupColour(index: number): Rgb {
  const hue = (index * GOLDEN_ANGLE_DEG) % 360;
  // Alternate lightness bands so neighbouring hues differ on two axes, not one.
  const band = index % 3;
  const lightness = band === 0 ? 0.74 : band === 1 ? 0.63 : 0.83;
  const chroma = band === 2 ? 0.1 : 0.14;
  return oklchToLinearSrgb(lightness, chroma, hue);
}

/** Pack a palette for `count` groups into a flat rgb buffer. */
export function buildPalette(count: number): Float32Array {
  const out = new Float32Array(Math.max(1, count) * 3);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = groupColour(i);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** Highlight colour used for the selected node and its incident edges. */
export const SELECTION_COLOUR: Rgb = oklchToLinearSrgb(0.86, 0.17, 95);

/** Dimming factor applied to everything outside the selected neighbourhood. */
export const DIM_FACTOR = 0.22;
