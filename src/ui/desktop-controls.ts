/**
 * Mouse and keyboard orbit controls for the non-headset path.
 *
 * Three.js `OrbitControls` lives in the examples folder and is perfectly fine,
 * but it is also well over a thousand lines that pull in an event-handling model
 * this project does not otherwise use. What is here covers orbit and zoom,
 * which is the whole interaction surface the desktop fallback needs: the graph
 * is recentred automatically, so there is nothing to pan toward.
 *
 * The desktop path is not a courtesy: most people who open a WebXR project have
 * no headset in front of them, and a page that shows them nothing is a page
 * they close.
 */

import type { PerspectiveCamera, Vector3 } from 'three';
import { damp } from '../core/vec3.js';

export interface OrbitState {
  /** Horizontal angle, radians. */
  azimuth: number;
  /** Vertical angle, radians, clamped away from the poles. */
  polar: number;
  distance: number;
}

const POLAR_LIMIT = 0.02;

export class OrbitControls {
  private target: OrbitState;
  private current: OrbitState;
  private dragging = false;
  private readonly detach: () => void;

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: PerspectiveCamera,
    private readonly focus: Vector3,
    initial: Partial<OrbitState> = {},
  ) {
    this.target = {
      azimuth: initial.azimuth ?? 0.6,
      polar: initial.polar ?? 1.15,
      distance: initial.distance ?? 5,
    };
    this.current = { ...this.target };

    const onPointerDown = (event: PointerEvent): void => {
      this.dragging = true;
      element.setPointerCapture(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent): void => {
      this.dragging = false;
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging) return;
      this.target.azimuth -= event.movementX * 0.005;
      this.target.polar = clamp(
        this.target.polar - event.movementY * 0.005,
        POLAR_LIMIT,
        Math.PI - POLAR_LIMIT,
      );
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      // Multiplicative zoom: one wheel notch covers the same visual step whether
      // the camera is at 2m or 40m, which additive zoom does not.
      this.target.distance = clamp(this.target.distance * Math.exp(event.deltaY * 0.0012), 0.6, 60);
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('wheel', onWheel, { passive: false });

    this.detach = () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('wheel', onWheel);
    };
  }

  /** Frame the camera on a sphere of the given radius. */
  frame(distance: number): void {
    this.target.distance = clamp(distance, 0.6, 60);
  }

  update(dt: number): void {
    this.current.azimuth = damp(this.current.azimuth, this.target.azimuth, 0.9999, dt);
    this.current.polar = damp(this.current.polar, this.target.polar, 0.9999, dt);
    this.current.distance = damp(this.current.distance, this.target.distance, 0.999, dt);

    const { azimuth, polar, distance } = this.current;
    const sinPolar = Math.sin(polar);
    this.camera.position.set(
      this.focus.x + distance * sinPolar * Math.sin(azimuth),
      this.focus.y + distance * Math.cos(polar),
      this.focus.z + distance * sinPolar * Math.cos(azimuth),
    );
    this.camera.lookAt(this.focus);
  }

  /** Normalised device coordinates for a pointer event on the canvas. */
  ndcFor(event: PointerEvent): [number, number] {
    const rect = this.element.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    ];
  }

  dispose(): void {
    this.detach();
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
