import { Quaternion } from '../../shared/Vector.ts';

/**
 * How many numbers a transform takes: origin `x, y, z`, then rotation `w, x, y, z` (the layout tags have, see
 * `BaseModel.sampleTag`).
 */
export const TRANSFORM_SIZE = 7;

/** The deepest chain of attachments the engine follows: a flash on a weapon on a hand on a player is four. */
export const MAX_ATTACHMENT_DEPTH = 8;

const NO_SCALE = new Float64Array([1, 1, 1]);
const NO_OFFSET = new Float64Array(3);

/**
 * The one place the transform of an attached entity is composed, for the server (where a child stays when its parent
 * is freed) and the client (where it is drawn). Rotations are quaternions all the way: the entity's own `angles`
 * become one with `Quaternion.fromModelAnglesInto`, the convention every model renderer uses, and only game code ever
 * sees angles again.
 */
export class AttachmentTransform {
  private constructor() {
    // Static-only helper class.
  }

  /** The tag and the child's offset combined, in the parent's space. */
  static readonly #local = new Float64Array(TRANSFORM_SIZE);

  /** The parent's rotation as a matrix, to carry the combined origin into the world. */
  static readonly #parentMatrix = new Float64Array(12);

  /** The tag's rotation as a matrix, to carry the child's offset into the parent's space. */
  static readonly #tagMatrix = new Float64Array(12);

  static readonly #world = new Float64Array(TRANSFORM_SIZE);

  /**
   * Composes `parent × tag × child`, the way DarkPlaces' `setattachment` does: the child's own origin and rotation
   * are its transform in the tag's space, so a game moves a holstered gun by changing the child's `origin` and
   * `angles` and needs no tag of its own for it.
   * @param out Receives the child's world transform. May be the same array as `parent`.
   * @param parent The parent's world transform, the pose its entity is drawn at.
   * @param tag The tag in the parent's model space as `BaseModel.sampleTag` writes it, `null` to attach to the parent's origin.
   * @param childOrigin The child's own origin, an offset in tag space.
   * @param childRotation The child's own rotation (`w, x, y, z`), at index 0.
   */
  static composeInto(out: Float64Array, parent: ArrayLike<number>, tag: ArrayLike<number> | null, childOrigin: ArrayLike<number>, childRotation: ArrayLike<number>): void {
    const local = AttachmentTransform.#local;

    if (tag === null) {
      local[0] = childOrigin[0];
      local[1] = childOrigin[1];
      local[2] = childOrigin[2];
      local[3] = childRotation[0];
      local[4] = childRotation[1];
      local[5] = childRotation[2];
      local[6] = childRotation[3];
    } else {
      const tagMatrix = AttachmentTransform.#tagMatrix;
      Quaternion.toMatrix3x4Into(tagMatrix, 0, tag, 3, NO_OFFSET, 0, NO_SCALE, 0);

      local[0] = tag[0] + tagMatrix[0] * childOrigin[0] + tagMatrix[1] * childOrigin[1] + tagMatrix[2] * childOrigin[2];
      local[1] = tag[1] + tagMatrix[4] * childOrigin[0] + tagMatrix[5] * childOrigin[1] + tagMatrix[6] * childOrigin[2];
      local[2] = tag[2] + tagMatrix[8] * childOrigin[0] + tagMatrix[9] * childOrigin[1] + tagMatrix[10] * childOrigin[2];
      Quaternion.multiplyInto(local, 3, tag, 3, childRotation, 0);
    }

    const parentMatrix = AttachmentTransform.#parentMatrix;
    const world = AttachmentTransform.#world;

    Quaternion.toMatrix3x4Into(parentMatrix, 0, parent, 3, NO_OFFSET, 0, NO_SCALE, 0);

    world[0] = parent[0] + parentMatrix[0] * local[0] + parentMatrix[1] * local[1] + parentMatrix[2] * local[2];
    world[1] = parent[1] + parentMatrix[4] * local[0] + parentMatrix[5] * local[1] + parentMatrix[6] * local[2];
    world[2] = parent[2] + parentMatrix[8] * local[0] + parentMatrix[9] * local[1] + parentMatrix[10] * local[2];
    Quaternion.multiplyInto(world, 3, parent, 3, local, 3);

    out.set(world);
  }

  /**
   * Writes an entity's own origin and angles as a transform, the angles in the model convention.
   * @param out Receives the transform.
   * @param origin The entity's origin.
   * @param angles The entity's pitch, yaw and roll in degrees.
   */
  static fromOriginAnglesInto(out: Float64Array, origin: ArrayLike<number>, angles: ArrayLike<number>): void {
    out[0] = origin[0];
    out[1] = origin[1];
    out[2] = origin[2];
    Quaternion.fromModelAnglesInto(out, 3, angles);
  }
}
