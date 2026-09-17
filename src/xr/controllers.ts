/**
 * XR input: controllers, hand tracking, and the pointer ray.
 *
 * Three.js exposes both tracked controllers and tracked hands through the same
 * `getController(i)` space, and the WebXR input profile tells them apart. Both
 * are handled here so the project works on hand-tracking-only hardware rather
 * than silently having no input at all — which is what happens if you only wire
 * up `xr-standard` gamepads.
 */

import { BufferGeometry, Float32BufferAttribute, type Group, Line, LineBasicMaterial } from 'three';
import type { WebGLRenderer } from 'three';

export type SelectPhase = 'start' | 'end';

export interface ControllerEvents {
  onSelect?: (index: number, phase: SelectPhase) => void;
  onSqueeze?: (index: number, phase: SelectPhase) => void;
}

export interface ControllerSet {
  /** Controller spaces, added to the caller's rig. */
  spaces: Group[];
  /** Gamepad handles, refreshed each frame; null for a tracked hand. */
  gamepads: (Gamepad | null)[];
  /** Call once per frame to refresh gamepad state. */
  update: (frame: XRFrame | null) => void;
  dispose: () => void;
}

function pointerRay(): Line {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
  const line = new Line(
    geometry,
    new LineBasicMaterial({ color: 0xe8c56a, transparent: true, opacity: 0.8 }),
  );
  line.name = 'pointer';
  line.scale.z = 5;
  return line;
}

export function setupControllers(
  renderer: WebGLRenderer,
  parent: Group,
  events: ControllerEvents = {},
): ControllerSet {
  const spaces: Group[] = [];
  const gamepads: (Gamepad | null)[] = [null, null];
  const listeners: Array<() => void> = [];

  for (let i = 0; i < 2; i++) {
    const space = renderer.xr.getController(i);
    space.add(pointerRay());
    parent.add(space);
    spaces.push(space);

    const onSelectStart = (): void => events.onSelect?.(i, 'start');
    const onSelectEnd = (): void => events.onSelect?.(i, 'end');
    const onSqueezeStart = (): void => events.onSqueeze?.(i, 'start');
    const onSqueezeEnd = (): void => events.onSqueeze?.(i, 'end');

    space.addEventListener('selectstart', onSelectStart);
    space.addEventListener('selectend', onSelectEnd);
    space.addEventListener('squeezestart', onSqueezeStart);
    space.addEventListener('squeezeend', onSqueezeEnd);

    listeners.push(() => {
      space.removeEventListener('selectstart', onSelectStart);
      space.removeEventListener('selectend', onSelectEnd);
      space.removeEventListener('squeezestart', onSqueezeStart);
      space.removeEventListener('squeezeend', onSqueezeEnd);
    });
  }

  const update = (frame: XRFrame | null): void => {
    const session = renderer.xr.getSession();
    if (!session || !frame) {
      gamepads[0] = null;
      gamepads[1] = null;
      return;
    }
    let i = 0;
    for (const source of session.inputSources) {
      if (i > 1) break;
      // A tracked hand has no gamepad; select/squeeze events still arrive from
      // the pinch gesture, so input degrades gracefully rather than vanishing.
      gamepads[i] = source.gamepad ?? null;
      i++;
    }
  };

  return {
    spaces,
    gamepads,
    update,
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

/**
 * Read the thumbstick x-axis used for snap turning.
 *
 * Axis 2 is the right thumbstick x in the `xr-standard` gamepad mapping; axis 0
 * is the touchpad/left stick on devices that only expose one. Falling back
 * rather than assuming one layout is what makes this work across Quest, Index
 * and WMR controllers.
 */
export function turnAxis(gamepad: Gamepad | null): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return axes[2] ?? axes[0] ?? 0;
}
