/**
 * Room-scale locomotion: teleport plus snap turn.
 *
 * Both are implemented by moving a "player rig" group that the XR camera is a
 * child of, rather than by moving the camera. The camera's transform belongs to
 * the headset — WebXR overwrites it every frame from the real pose — so writing
 * to it does nothing useful. Offsetting the parent is the supported way to move
 * a seated or standing user through a world larger than their room.
 *
 * Comfort defaults are deliberate: teleport and snap turn are the two options
 * that do not induce vection, and they are the default rather than an accessible
 * alternative hidden behind a settings menu.
 */

import { Group, type Object3D, Quaternion, Vector3 } from 'three';
import { snapTurnIntent } from '../core/ballistics.js';

export class PlayerRig {
  readonly group = new Group();
  private snapArmed = true;
  private readonly forward = new Vector3();
  private readonly quaternion = new Quaternion();

  /** Degrees per snap-turn input. 30 is the gentler of the two conventions. */
  snapDegrees = 30;

  /** Attach the XR camera (or a camera group) to the rig. */
  attach(child: Object3D): void {
    this.group.add(child);
  }

  /**
   * Move the rig so the user's head ends up over `x, z`.
   *
   * The head's current horizontal offset within the play space is subtracted, so
   * the user arrives standing on the marker rather than with the play-space
   * origin on it. Getting this wrong is the single most common teleport bug and
   * it is invisible until someone stands in a corner of their room.
   */
  teleportTo(x: number, z: number, headWorldPosition: Vector3): void {
    const offsetX = headWorldPosition.x - this.group.position.x;
    const offsetZ = headWorldPosition.z - this.group.position.z;
    this.group.position.x = x - offsetX;
    this.group.position.z = z - offsetZ;
  }

  /**
   * Rotate the rig about the user's head, not about the play-space origin.
   *
   * Rotating about the origin translates the user sideways as well as turning
   * them, which reads as being shoved.
   */
  snapTurn(direction: -1 | 0 | 1, headWorldPosition: Vector3): void {
    if (direction === 0) return;
    const angle = (direction * this.snapDegrees * Math.PI) / 180;
    const pivotX = headWorldPosition.x;
    const pivotZ = headWorldPosition.z;

    const dx = this.group.position.x - pivotX;
    const dz = this.group.position.z - pivotZ;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.group.position.x = pivotX + dx * cos - dz * sin;
    this.group.position.z = pivotZ + dx * sin + dz * cos;

    this.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), angle);
    this.group.quaternion.premultiply(this.quaternion);
  }

  /** Feed a thumbstick x-axis; fires at most one turn per push. */
  handleTurnAxis(axis: number, headWorldPosition: Vector3): void {
    const intent = snapTurnIntent(axis, this.snapArmed);
    this.snapArmed = intent.armed;
    this.snapTurn(intent.direction, headWorldPosition);
  }

  /** World-space forward direction of the rig, projected onto the floor. */
  forwardOnFloor(out = this.forward): Vector3 {
    out.set(0, 0, -1).applyQuaternion(this.group.quaternion);
    out.y = 0;
    return out.normalize();
  }
}
