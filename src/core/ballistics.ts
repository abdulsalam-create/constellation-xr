/**
 * Parabolic teleport arc.
 *
 * Teleport locomotion is the accessibility floor for room-scale VR: smooth
 * locomotion induces motion sickness in a substantial minority of users, and a
 * project that only offers it is unusable for them. The arc is a plain ballistic
 * trajectory under constant gravity, which gives the user a readable preview of
 * where they will land and a natural way to control range by pitching the
 * controller.
 *
 * Everything here is pure maths on plain tuples so the landing logic can be
 * tested without a headset, a renderer, or a DOM.
 */

export type Vec3 = readonly [number, number, number];

export interface ArcOptions {
  /** Initial speed along `direction`, in metres per second. */
  speed: number;
  /** Downward acceleration, metres per second squared. Earth gravity by default. */
  gravity: number;
  /** Height of the floor plane in world space. */
  floorY: number;
  /** Sample count along the arc, used for the rendered ribbon. */
  samples: number;
  /** Hard cap on horizontal range, in metres. */
  maxRange: number;
}

export const DEFAULT_ARC_OPTIONS: Readonly<ArcOptions> = Object.freeze({
  speed: 7,
  gravity: 9.81,
  floorY: 0,
  samples: 24,
  maxRange: 12,
});

export interface ArcResult {
  /** Flattened xyz samples from the origin to the landing point. */
  points: Float32Array;
  /** Number of valid samples written into `points`. */
  pointCount: number;
  /** Landing position, or null when the arc never reaches the floor. */
  landing: [number, number, number] | null;
  /** True when the landing point was clamped by `maxRange`. */
  clamped: boolean;
}

/**
 * Time at which a projectile launched from `originY` with vertical velocity
 * `vy` crosses `floorY`, or null when it never does.
 *
 * Solves `0.5*g*t^2 - vy*t - (originY - floorY) = 0` for the positive root. The
 * degenerate `g == 0` case is handled separately rather than dividing by zero:
 * with no gravity the path is a straight line, which only reaches the floor when
 * aimed downwards.
 */
export function timeToFloor(
  originY: number,
  vy: number,
  gravity: number,
  floorY: number,
): number | null {
  const height = originY - floorY;
  if (gravity === 0) {
    // Straight line: it crosses the plane iff it is moving toward it.
    if (vy === 0) return height === 0 ? 0 : null;
    const t = -height / vy;
    return t >= 0 ? t : null;
  }
  // t = (vy + sqrt(vy^2 + 2*g*h)) / g
  const discriminant = vy * vy + 2 * gravity * height;
  if (discriminant < 0) return null;
  const t = (vy + Math.sqrt(discriminant)) / gravity;
  return t >= 0 ? t : null;
}

/**
 * Sample a teleport arc from `origin` along `direction`.
 *
 * `direction` must be normalised. The returned `points` buffer is reused when
 * one is supplied, so the per-frame arc update allocates nothing.
 */
export function computeArc(
  origin: Vec3,
  direction: Vec3,
  options: Partial<ArcOptions> = {},
  scratch?: Float32Array,
): ArcResult {
  const opts = { ...DEFAULT_ARC_OPTIONS, ...options };
  const samples = Math.max(2, Math.floor(opts.samples));
  const points = scratch && scratch.length >= samples * 3 ? scratch : new Float32Array(samples * 3);

  const vx = direction[0] * opts.speed;
  const vy = direction[1] * opts.speed;
  const vz = direction[2] * opts.speed;

  const tFloor = timeToFloor(origin[1], vy, opts.gravity, opts.floorY);
  // No floor hit: draw a fixed-length probe so the user still sees an arc.
  const tEnd = tFloor ?? opts.maxRange / Math.max(opts.speed, 1e-6);

  let clamped = false;
  let tLimit = tEnd;

  // Clamp by horizontal range rather than by time, so the cap feels the same
  // whether the user is aiming flat and far or steeply and short.
  const horizontalSpeed = Math.hypot(vx, vz);
  if (horizontalSpeed > 1e-6) {
    const tRange = opts.maxRange / horizontalSpeed;
    if (tRange < tLimit) {
      tLimit = tRange;
      clamped = true;
    }
  }

  for (let i = 0; i < samples; i++) {
    const t = (tLimit * i) / (samples - 1);
    points[i * 3] = origin[0] + vx * t;
    points[i * 3 + 1] = origin[1] + vy * t - 0.5 * opts.gravity * t * t;
    points[i * 3 + 2] = origin[2] + vz * t;
  }

  // A clamped arc still has a landing point — it is just short of where the
  // un-clamped parabola would have hit. Returning null here would silently
  // disable teleporting for any flat, long aim, which is the common case, and
  // the user would see the arc drawn with no explanation for why nothing
  // happened. `maxRange` is a cap on distance, not a refusal to move.
  const reachesFloor = tFloor !== null;
  const landing: [number, number, number] | null = reachesFloor
    ? [points[(samples - 1) * 3]!, points[(samples - 1) * 3 + 1]!, points[(samples - 1) * 3 + 2]!]
    : null;
  // Snap the y to the floor plane only when the arc actually got there; when
  // clamped it stops mid-flight, and reporting the true height lets the caller
  // drop the marker straight down if it wants to.
  if (landing && !clamped) landing[1] = opts.floorY;

  return { points, pointCount: samples, landing, clamped };
}

/**
 * Map a thumbstick axis to a discrete snap-turn intent with hysteresis.
 *
 * A single threshold makes a stick resting near it emit a stream of turns as it
 * jitters. Requiring the stick to fall back below `releaseThreshold` before the
 * next turn can fire is the standard fix, and it is worth testing: the bug only
 * shows up with a worn controller, which is exactly when nobody is looking.
 */
export function snapTurnIntent(
  axis: number,
  armed: boolean,
  fireThreshold = 0.7,
  releaseThreshold = 0.35,
): { direction: -1 | 0 | 1; armed: boolean } {
  const magnitude = Math.abs(axis);
  if (armed && magnitude >= fireThreshold) {
    return { direction: axis > 0 ? 1 : -1, armed: false };
  }
  if (!armed && magnitude <= releaseThreshold) {
    return { direction: 0, armed: true };
  }
  return { direction: 0, armed };
}
