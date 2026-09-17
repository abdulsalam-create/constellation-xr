/**
 * Small vector helpers used inside the hot loops.
 *
 * Three.js has a perfectly good `Vector3`, but these run once per node per
 * frame inside the worker, where `Vector3` is not available and where
 * allocating a wrapper object per call would cost more than the arithmetic.
 * They take a buffer and an element index instead.
 *
 * Deliberately minimal: only the operations the application actually performs
 * live here. Anything else belongs in the code that needs it.
 */

/**
 * Clamp a vector's magnitude to `max`, in place.
 *
 * Returns true when the vector was actually clamped, which the integrator uses
 * to report how often the speed limit is binding — a persistently binding clamp
 * means the timestep is too large for the current force scale.
 */
export function clampLength(buffer: Float32Array, index: number, max: number): boolean {
  const o = index * 3;
  const x = buffer[o]!;
  const y = buffer[o + 1]!;
  const z = buffer[o + 2]!;
  const lenSq = x * x + y * y + z * z;
  if (lenSq <= max * max || lenSq === 0) return false;
  const factor = max / Math.sqrt(lenSq);
  buffer[o] = x * factor;
  buffer[o + 1] = y * factor;
  buffer[o + 2] = z * factor;
  return true;
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `rate` is the fraction of the remaining distance covered per second. Using
 * `1 - (1 - rate)^dt` rather than a bare `rate * dt` keeps camera and hand
 * smoothing identical at 60Hz, 72Hz, 90Hz and 120Hz — headsets vary, and a
 * smoothing constant tuned at one refresh rate feels wrong at another.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  const t = 1 - Math.pow(1 - rate, dt);
  return current + (target - current) * t;
}
