import { Quaternion } from '../../shared/Vector.ts';
import type Vector from '../../shared/Vector.ts';
import { SkeletalModel } from '../common/model/SkeletalModel.ts';
import type { ClientEdict } from './ClientEntities.ts';
import { SkeletalPoseSelection } from './renderer/models/SkeletalPoseSelection.ts';

/**
 * Where the tags of a model are in the world, for the moment an entity is drawn at.
 */
export class EntityTags {
  private constructor() {
    // Static-only helper class.
  }

  /** The tag in the model's space: origin `x, y, z`, then rotation `w, x, y, z`. */
  static readonly #local = new Float64Array(7);

  /** The entity's turn as a quaternion. */
  static readonly #entityRotation = new Float64Array(4);

  /** The tag's turn in the world. */
  static readonly #worldRotation = new Float64Array(4);

  /** The entity's turn as a matrix, to carry the tag's origin into the world. */
  static readonly #entityMatrix = new Float32Array(12);

  static readonly #noOffset = new Float32Array(3);
  static readonly #noScale = new Float32Array([1, 1, 1]);

  /**
   * Finds where a tag is in the world right now: the entity's smoothed origin and angles applied to the tag of the
   * pose the entity is drawn in (the same pose as the vertices, with the same blending), so something placed there
   * is on the weapon, the hand or the muzzle that is on the screen.
   *
   * Rotations stay quaternions all through; the angles are the one place the tag's turn becomes Euler angles, because
   * game code works in angles. They are in the convention an entity's `angles` have, so giving them to an entity turns
   * it the way the tag is turned.
   * @param entity The entity.
   * @param tagName The name of the tag, such as `tag_flash`.
   * @param outOrigin Receives the world position.
   * @param outAngles Receives pitch, yaw and roll in degrees, `null` when the angles are not wanted.
   * @returns `false` when the entity has no model, the model has no tags (alias, brush and sprite models) or no tag of that name, and the outputs are untouched.
   */
  static resolve(entity: ClientEdict, tagName: string, outOrigin: Vector, outAngles: Vector | null = null): boolean {
    const model = entity.model;

    if (!(model instanceof SkeletalModel)) {
      return false;
    }

    const tag = model.getTagIndex(tagName);

    if (tag < 0) {
      return false;
    }

    const [frameA, frameB, blend] = SkeletalPoseSelection.select(model, entity);
    const local = EntityTags.#local;

    if (!model.sampleTag(tag, frameA, frameB, blend, local)) {
      return false;
    }

    const entityRotation = EntityTags.#entityRotation;
    const matrix = EntityTags.#entityMatrix;
    const entityOrigin = entity.lerp.origin;

    Quaternion.fromModelAnglesInto(entityRotation, 0, entity.lerp.angles);
    Quaternion.toMatrix3x4Into(matrix, 0, entityRotation, 0, EntityTags.#noOffset, 0, EntityTags.#noScale, 0);

    outOrigin.setTo(
      entityOrigin[0] + matrix[0] * local[0] + matrix[1] * local[1] + matrix[2] * local[2],
      entityOrigin[1] + matrix[4] * local[0] + matrix[5] * local[1] + matrix[6] * local[2],
      entityOrigin[2] + matrix[8] * local[0] + matrix[9] * local[1] + matrix[10] * local[2],
    );

    if (outAngles !== null) {
      Quaternion.multiplyInto(EntityTags.#worldRotation, 0, entityRotation, 0, local, 3);
      Quaternion.toModelAnglesInto(outAngles, 0, EntityTags.#worldRotation, 0);
    }

    return true;
  }
}
