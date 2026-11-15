import { effect } from '../../../../shared/Defs.ts';
import { SkeletalAnimation } from '../../../common/model/SkeletalAnimation.ts';
import type { SkeletalModel } from '../../../common/model/SkeletalModel.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import rendererCvars from '../resources/RendererCvars.ts';

/**
 * Which pose of a skeletal model an entity is in right now. The renderer skins the mesh for it and `GetEntityTag` puts
 * a tag where it is, both from this one answer, so a weapon on a tag is on the hand that is drawn.
 */
export class SkeletalPoseSelection {
  private constructor() {
    // Static-only helper class.
  }

  /** The frames a sequence selects, written by `SkeletalAnimation.samplePlayback`. */
  static readonly #sequencePose: [number, number, number] = [0, 0, 0];

  /**
   * Picks the two frames to blend and the weight of the second. An entity that selects a sequence the model has plays
   * it from its `animtime`, blending a frame into the next while interpolation is on. Any other follows its `frame`
   * the way alias models do: the interpolated frame, or the plain one while interpolation is off or a muzzle flash
   * makes the pose jump.
   * @param model The skeletal model.
   * @param entity The entity.
   * @returns Frame A, frame B and the blend. A sequence's result is a scratch array, valid until the next call.
   */
  static select(model: SkeletalModel, entity: ClientEdict): [number, number, number] {
    const interpolate = Boolean(rendererCvars.interpolation.value);

    if (entity.sequence >= 0) {
      const elapsed = clientRuntimeState.clientMessages.renderTime - entity.animtime;

      if (SkeletalAnimation.samplePlayback(model, entity.sequence, elapsed, entity.framerate, interpolate, SkeletalPoseSelection.#sequencePose)) {
        return SkeletalPoseSelection.#sequencePose;
      }
    }

    if (interpolate && (entity.effects & effect.EF_MUZZLEFLASH) === 0) {
      return entity.lerp.frame;
    }

    return [entity.frame, entity.frame, 0];
  }
}
