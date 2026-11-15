import { Quaternion } from '../../shared/Vector.ts';
import { AttachmentTransform, MAX_ATTACHMENT_DEPTH, TRANSFORM_SIZE } from '../common/AttachmentTransform.ts';
import { SkeletalModel } from '../common/model/SkeletalModel.ts';
import type { ClientEdict } from './ClientEntities.ts';
import { SkeletalPoseSelection } from './renderer/models/SkeletalPoseSelection.ts';

/**
 * Finds where an entity is in the world when it may be attached to another (`ClientEdict.attachmentParent`): its
 * parent's transform, itself resolved the same way, times the parent's tag in the pose the parent is drawn in, times
 * the entity's own origin and angles as an offset in tag space. The pose comes from `SkeletalPoseSelection`, which also
 * skins the parent's vertices, so a child is on the hand or the barrel that is on the screen, with the same blend.
 * Rotations stay quaternions all the way (`AttachmentTransform`).
 */
export class EntityAttachments {
  private constructor() {
    // Static-only helper class.
  }

  static readonly #parentTransforms = Array.from({ length: MAX_ATTACHMENT_DEPTH + 1 }, () => new Float64Array(TRANSFORM_SIZE));
  static readonly #tag = new Float64Array(TRANSFORM_SIZE);
  static readonly #childRotation = new Float64Array(4);

  /**
   * Resolves an entity for the frame that is being drawn: what `lerp.origin` and `lerp.rotationMatrix` answer for an
   * attached entity, and what `GetEntityTag` builds on. A free-standing entity has nothing to resolve.
   * @param entity The entity.
   * @returns `true` when the entity is attached and sits in the world now. `false` when it stands free, or cannot be
   * placed (its parent is gone or has no model, or the chain is deeper than `MAX_ATTACHMENT_DEPTH` or loops), and then
   * it is not drawn.
   */
  static resolve(entity: ClientEdict): boolean {
    if (entity.attachmentParent === null) {
      entity.attachmentResolved = false;
      return false;
    }

    const transform = entity.attachmentTransform;

    entity.attachmentResolved = EntityAttachments.transformInto(entity, transform);

    if (entity.attachmentResolved) {
      entity.attachmentOrigin.setTo(transform[0], transform[1], transform[2]);
    }

    return entity.attachmentResolved;
  }

  /**
   * Where an entity is in the world, attached or not.
   * @param entity The entity.
   * @param out Receives origin `x, y, z` and rotation `w, x, y, z`. Left alone when the entity cannot be placed.
   * @param depth How many parents deep this call is, which ends a chain that loops.
   * @returns `false` when a parent in the chain is free or has no model, or the chain is too deep.
   */
  static transformInto(entity: ClientEdict, out: Float64Array, depth = 0): boolean {
    const parent = entity.attachmentParent;
    const origin = entity.lerp.localOrigin;
    const childRotation = EntityAttachments.#childRotation;

    if (parent === null) {
      AttachmentTransform.fromOriginAnglesInto(out, origin, entity.lerp.angles);
      return true;
    }

    if (depth >= MAX_ATTACHMENT_DEPTH || parent.free || parent.model === null) {
      return false;
    }

    const parentTransform = EntityAttachments.#parentTransforms[depth];

    if (!EntityAttachments.transformInto(parent, parentTransform, depth + 1)) {
      return false;
    }

    const tag = EntityAttachments.#sampleTag(entity, parent);

    // the recursion above used the scratch rotation for its own child, so it is written only now
    Quaternion.fromModelAnglesInto(childRotation, 0, entity.lerp.angles);
    AttachmentTransform.composeInto(out, parentTransform, tag, origin, childRotation);
    return true;
  }

  /**
   * The tag of the parent that the entity follows, in the pose the parent is drawn in.
   * @returns The tag as origin and rotation, `null` to attach to the parent's origin: no tag was asked for, or the
   * parent's model has none of that name (a model without tags, or one the parent changed to).
   */
  static #sampleTag(entity: ClientEdict, parent: ClientEdict): Float64Array | null {
    const model = parent.model;

    if (!(model instanceof SkeletalModel)) {
      return null;
    }

    const tagIndex = entity.attachmentTagName !== null ? model.getTagIndex(entity.attachmentTagName) : entity.attachmentTag;

    if (tagIndex < 0) {
      return null;
    }

    const [frameA, frameB, blend] = SkeletalPoseSelection.select(model, parent);
    const tag = EntityAttachments.#tag;

    return model.sampleTag(tagIndex, frameA, frameB, blend, tag) ? tag : null;
  }
}
