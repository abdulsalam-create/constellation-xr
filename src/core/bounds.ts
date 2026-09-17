/**
 * Bounding-volume helpers used to frame the graph for the camera.
 */

import type { Bounds } from './types.js';

export function emptyBounds(): Bounds {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

export function isEmpty(bounds: Bounds): boolean {
  return bounds.minX > bounds.maxX;
}

/** Axis-aligned bounds of `count` interleaved xyz positions. */
export function computeBounds(positions: Float32Array, count: number): Bounds {
  const bounds = emptyBounds();
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  return bounds;
}

export function centre(bounds: Bounds): [number, number, number] {
  if (isEmpty(bounds)) return [0, 0, 0];
  return [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ];
}

/** Radius of the sphere circumscribing the box. */
export function boundingRadius(bounds: Bounds): number {
  if (isEmpty(bounds)) return 0;
  const dx = (bounds.maxX - bounds.minX) / 2;
  const dy = (bounds.maxY - bounds.minY) / 2;
  const dz = (bounds.maxZ - bounds.minZ) / 2;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Distance at which a sphere of `radius` exactly fills a camera with vertical
 * field of view `fovDegrees` and the given aspect ratio.
 *
 * Both fields of view are considered and the larger distance wins. On a wide
 * viewport the horizontal field is the wider angle, so the *vertical* term is
 * the binding one and the sphere would otherwise be clipped top and bottom; on
 * a tall, narrow viewport the roles swap. Taking the maximum covers both
 * without a special case.
 */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  if (radius <= 0) return 1;
  const vFov = (fovDegrees * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 1e-3));
  return Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2));
}

/**
 * Uniform scale that brings a graph of the given radius into a comfortable
 * room-scale volume.
 *
 * In VR a graph you cannot reach across is exhausting and one you cannot see
 * past your own hands is useless, so the world is rescaled rather than the
 * camera moved: `targetRadius` metres is roughly arm's length plus a step.
 */
export function roomScaleFactor(radius: number, targetRadius = 1.6): number {
  if (radius <= 1e-6) return 1;
  return targetRadius / radius;
}
