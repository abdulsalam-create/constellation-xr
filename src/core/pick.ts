/**
 * Ray casting against the node cloud.
 *
 * Three.js ships a `Raycaster` that understands `InstancedMesh`, but it walks
 * every instance and builds a result object per hit. Nodes here are spheres of
 * known radius stored in a flat buffer, so an analytic ray-sphere test over that
 * buffer is both faster and — more usefully — a pure function that can be tested
 * without a WebGL context.
 *
 * Both routines are also used for the "aim assist" that makes controller
 * pointing bearable: a strict ray misses a 2cm sphere at three metres far more
 * often than a user expects.
 */

export interface PickResult {
  /** Node index, or -1 when nothing was hit. */
  index: number;
  /** Ray parameter at the hit, in the ray's units. Infinity on a miss. */
  distance: number;
}

const MISS: PickResult = Object.freeze({ index: -1, distance: Infinity });

/**
 * Nearest sphere intersected by a ray.
 *
 * Solves |o + td - c|^2 = r^2 for the smaller positive root. `direction` must be
 * normalised. `radii` is per node; pass a single-element array to use one radius
 * for every node.
 */
export function pickSphere(
  positions: Float32Array,
  radii: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  maxDistance = Infinity,
): PickResult {
  let bestIndex = -1;
  let bestT = maxDistance;
  const uniformRadius = radii.length === 1 ? radii[0]! : null;

  for (let i = 0; i < count; i++) {
    const cx = positions[i * 3]! - origin[0];
    const cy = positions[i * 3 + 1]! - origin[1];
    const cz = positions[i * 3 + 2]! - origin[2];

    // Projection of the centre onto the ray.
    const tca = cx * direction[0] + cy * direction[1] + cz * direction[2];
    const r = uniformRadius ?? radii[i]!;
    // Behind the origin by more than the radius: cannot be hit.
    if (tca < -r) continue;

    const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
    const r2 = r * r;
    if (d2 > r2) continue;

    const thc = Math.sqrt(r2 - d2);
    // Near root; if the origin is inside the sphere, use the far root.
    const t = tca - thc >= 0 ? tca - thc : tca + thc;
    if (t < 0 || t >= bestT) continue;

    bestT = t;
    bestIndex = i;
  }

  return bestIndex === -1 ? MISS : { index: bestIndex, distance: bestT };
}

/**
 * Forgiving pick: selects the node with the smallest angular offset from the
 * ray, within a cone of half-angle `coneRadians`.
 *
 * Scoring by angle rather than by distance-to-ray is deliberate. A distance
 * threshold makes far-away nodes progressively harder to select, because the
 * same angular wobble of the hand sweeps a larger arc the further out it goes.
 * Angular scoring makes selection feel the same at arm's length and across the
 * room, which is what people actually expect from a laser pointer.
 *
 * Ties are broken by proximity, so a near node always wins over a far one
 * directly behind it.
 */
export function pickCone(
  positions: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  coneRadians: number,
  maxDistance = Infinity,
): PickResult {
  const cosCone = Math.cos(coneRadians);
  let bestIndex = -1;
  let bestScore = cosCone;
  let bestDistance = Infinity;

  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3]! - origin[0];
    const dy = positions[i * 3 + 1]! - origin[1];
    const dz = positions[i * 3 + 2]! - origin[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq === 0 || distSq > maxDistance * maxDistance) continue;

    const dist = Math.sqrt(distSq);
    const cosAngle = (dx * direction[0] + dy * direction[1] + dz * direction[2]) / dist;
    if (cosAngle < cosCone) continue;

    if (cosAngle > bestScore || (cosAngle === bestScore && dist < bestDistance)) {
      bestScore = cosAngle;
      bestDistance = dist;
      bestIndex = i;
    }
  }

  return bestIndex === -1 ? MISS : { index: bestIndex, distance: bestDistance };
}

/**
 * Point on a ray nearest to a world-space point, clamped to t >= 0.
 *
 * Used when dragging a node: the node tracks the closest point on the pointer
 * ray at the grab distance, which is what makes a grabbed node feel attached to
 * the controller rather than to the cursor.
 */
export function closestPointOnRay(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  point: readonly [number, number, number],
): { t: number; x: number; y: number; z: number } {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const t = Math.max(0, dx * direction[0] + dy * direction[1] + dz * direction[2]);
  return {
    t,
    x: origin[0] + direction[0] * t,
    y: origin[1] + direction[1] * t,
    z: origin[2] + direction[2] * t,
  };
}
