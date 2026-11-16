import { Quaternion } from '../../../shared/Vector.ts';
import type Vector from '../../../shared/Vector.ts';

/**
 * Rotations that a game puts on the joints of one entity on top of the animation: a spine that bends with where a player looks,
 * a head that turns to a target. A rotation is in model space and about the joint's own origin, so it turns the joint, and with it
 * everything below it in the hierarchy (the weapon on a hand tag, the vertices skinned to it), and leaves the joint's place alone.
 * `SkeletalAnimation.computePose` and `sampleJointInto` apply them.
 *
 * One object belongs to one entity and one model (it is sized by the model's joint count). It is flat, nothing is allocated
 * to change it, and `version` changes whenever a rotation does, so a cache of poses can tell.
 */
export class JointAdjustments {
  /** The rotation of each joint as `w, x, y, z`; the identity where `isSet` is 0. */
  readonly rotations: Float32Array;

  /** 1 for a joint that has a rotation. */
  readonly isSet: Uint8Array;

  /** The number of joints that have a rotation. */
  count = 0;

  /** Counts every change to a rotation, so that a pose made earlier can be told from one made now. */
  version = 0;

  readonly #rotation = new Float64Array(4);

  /**
   * @param jointCount The number of joints of the model these are for.
   */
  constructor(jointCount: number) {
    this.rotations = new Float32Array(jointCount * 4);
    this.isSet = new Uint8Array(jointCount);
    this.clear();
  }

  /**
   * @returns The number of joints these are for.
   */
  get jointCount(): number {
    return this.isSet.length;
  }

  /**
   * Turns a joint. The angles are in the convention of an entity's `angles` (pitch, yaw, roll in degrees; a positive pitch lifts
   * what points along the model's X axis), applied in model space.
   * @param joint The joint's index.
   * @param angles The rotation. All zero removes it.
   */
  setAngles(joint: number, angles: Vector): void {
    console.assert(Number.isInteger(joint) && joint >= 0 && joint < this.jointCount, 'JointAdjustments.setAngles: joint out of range');

    if (angles[0] === 0 && angles[1] === 0 && angles[2] === 0) {
      this.#unset(joint);
      return;
    }

    const rotation = this.#rotation;
    Quaternion.fromModelAnglesInto(rotation, 0, angles);

    const offset = joint * 4;
    const rotations = this.rotations;

    if (this.isSet[joint] === 1
      && rotations[offset] === Math.fround(rotation[0]) && rotations[offset + 1] === Math.fround(rotation[1])
      && rotations[offset + 2] === Math.fround(rotation[2]) && rotations[offset + 3] === Math.fround(rotation[3])) {
      return;
    }

    rotations[offset] = rotation[0];
    rotations[offset + 1] = rotation[1];
    rotations[offset + 2] = rotation[2];
    rotations[offset + 3] = rotation[3];

    if (this.isSet[joint] === 0) {
      this.isSet[joint] = 1;
      this.count++;
    }

    this.version++;
  }

  /**
   * Removes all rotations.
   */
  clear(): void {
    if (this.count > 0) {
      this.version++;
    }

    this.rotations.fill(0);
    this.isSet.fill(0);
    this.count = 0;

    for (let joint = 0; joint < this.jointCount; joint++) {
      this.rotations[joint * 4] = 1;
    }
  }

  #unset(joint: number): void {
    if (this.isSet[joint] === 0) {
      return;
    }

    const offset = joint * 4;
    this.rotations[offset] = 1;
    this.rotations[offset + 1] = 0;
    this.rotations[offset + 2] = 0;
    this.rotations[offset + 3] = 0;
    this.isSet[joint] = 0;
    this.count--;
    this.version++;
  }
}
