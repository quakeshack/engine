import { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { SkeletalAnimation } from '../../source/engine/common/model/SkeletalAnimation.ts';
import type { IqmPose } from './iqmBuilder.ts';

/**
 * Builds a model from poses, the way a loader leaves it, without a file.
 * @param parents The parent of every joint.
 * @param restPose The rest pose of every joint.
 * @param frames Every frame's pose of every joint.
 * @param names The joint names, `joint0`, `joint1`, ... when left out.
 * @returns The model, with its inverse bind matrices computed.
 */
export function createModel(parents: number[], restPose: IqmPose[], frames: IqmPose[][], names: string[] = parents.map((_parent, index) => `joint${index}`)): IQMModel {
  const model = new IQMModel('progs/test.iqm');
  model.jointNames = names;
  model.jointParents = Int32Array.from(parents);
  model.restPose = Float32Array.from(restPose.flat());
  model.framePoses = Float32Array.from(frames.flat(2));
  model._num_frames = frames.length;
  model.inverseBindMatrices = SkeletalAnimation.computeInverseBindMatrices(model.restPose, model.jointParents).matrices;
  return model;
}

/**
 * A pose with a rotation about Z.
 * @param translation Where the joint sits in its parent.
 * @param degrees The turn about Z.
 * @param scale The scale along the joint's axes.
 * @returns Ten numbers: translation, rotation `w, x, y, z`, scale.
 */
export function poseOf(translation: number[], degrees = 0, scale: number[] = [1, 1, 1]): IqmPose {
  const half = degrees * Math.PI / 360.0;
  return [...translation, Math.cos(half), 0, 0, Math.sin(half), ...scale];
}

/**
 * A root and a `tag_flash` 10 units along X from it. The second frame turns the tag 90 degrees about Z, the sequence
 * `turn` plays the two frames at 10 fps.
 * @returns The model.
 */
export function createFlashModel(): IQMModel {
  const model = createModel(
    [-1, 0],
    [poseOf([0, 0, 0]), poseOf([10, 0, 0])],
    [[poseOf([0, 0, 0]), poseOf([10, 0, 0])], [poseOf([0, 0, 0]), poseOf([10, 0, 0], 90)]],
    ['root', 'tag_flash'],
  );

  model.sequences = [{ name: 'turn', firstFrame: 0, frameCount: 2, framerate: 10, loop: true }];

  return model;
}
