import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector, { Quaternion } from '../../source/shared/Vector.ts';
import { JointAdjustments } from '../../source/engine/common/model/JointAdjustments.ts';
import { SkeletalAnimation } from '../../source/engine/common/model/SkeletalAnimation.ts';
import type { SkeletalModel } from '../../source/engine/common/model/SkeletalModel.ts';
import { assertNear } from '../support/assertions.ts';
import { createFlashModel, createModel, poseOf } from '../support/skeletalModels.ts';

const MATRIX_FLOATS = SkeletalAnimation.MATRIX_FLOATS;

/**
 * A root at the origin, a `mid` 10 units along X from it and a `tip` 10 units along X from `mid`: an arm laid out along +X.
 * @returns The model, in its rest pose.
 */
function createArm(): SkeletalModel {
  const rest = [poseOf([0, 0, 0]), poseOf([10, 0, 0]), poseOf([10, 0, 0])];

  return createModel([-1, 0, 1], rest, [rest], ['root', 'mid', 'tip']);
}

/**
 * @param model The model.
 * @param adjustments What to turn.
 * @param frameA First frame.
 * @param frameB Second frame.
 * @param blend Weight of the second frame.
 * @returns The joint matrices and the skinning matrices of the pose.
 */
function pose(model: SkeletalModel, adjustments: JointAdjustments | null, frameA = 0, frameB = 0, blend = 0) {
  const joints = new Float32Array(model.jointCount * MATRIX_FLOATS);
  const skinning = new Float32Array(model.jointCount * MATRIX_FLOATS);
  SkeletalAnimation.computePose(model, frameA, frameB, blend, joints, skinning, adjustments);

  return { joints, skinning };
}

/**
 * @param matrices Array of 3×4 matrices.
 * @param joint Which one.
 * @returns Where the joint is: the translation of its matrix.
 */
function originOf(matrices: Float32Array, joint: number): number[] {
  const start = joint * MATRIX_FLOATS;

  return [matrices[start + 3]!, matrices[start + 7]!, matrices[start + 11]!];
}

/**
 * @param matrices Array of 3×4 matrices.
 * @param joint Which one.
 * @param point `x, y, z`.
 * @returns The point moved by the joint's matrix.
 */
function transformPoint(matrices: Float32Array, joint: number, point: number[]): number[] {
  const start = joint * MATRIX_FLOATS;

  return [0, 1, 2].map((row) => matrices[start + row * 4]! * point[0]! + matrices[start + row * 4 + 1]! * point[1]!
    + matrices[start + row * 4 + 2]! * point[2]! + matrices[start + row * 4 + 3]!);
}

/**
 * @param actual The numbers under test.
 * @param expected What they should be.
 */
function assertPointNear(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((value, index) => { assertNear(actual[index]!, value, 1e-4); });
}

void describe('JointAdjustments', () => {
  void test('a new set holds nothing and every rotation is the identity', () => {
    const adjustments = new JointAdjustments(3);

    assert.equal(adjustments.count, 0);
    assert.deepEqual([...adjustments.isSet], [0, 0, 0]);
    assert.deepEqual([...adjustments.rotations], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  void test('setting a joint counts it once, and its version changes only when a rotation does', () => {
    const adjustments = new JointAdjustments(3);
    const first = adjustments.version;

    adjustments.setAngles(1, new Vector(10, 0, 0));
    const afterSet = adjustments.version;
    adjustments.setAngles(1, new Vector(10, 0, 0));
    const afterSame = adjustments.version;
    adjustments.setAngles(1, new Vector(20, 0, 0));

    assert.equal(adjustments.count, 1);
    assert.notEqual(afterSet, first);
    assert.equal(afterSame, afterSet, 'the same angles again is no change');
    assert.notEqual(adjustments.version, afterSame);
  });

  void test('angles of zero take the rotation away again', () => {
    const adjustments = new JointAdjustments(2);
    adjustments.setAngles(0, new Vector(0, 30, 0));
    const version = adjustments.version;

    adjustments.setAngles(0, new Vector(0, 0, 0));

    assert.equal(adjustments.count, 0);
    assert.equal(adjustments.isSet[0], 0);
    assert.deepEqual([...adjustments.rotations.subarray(0, 4)], [1, 0, 0, 0]);
    assert.notEqual(adjustments.version, version);

    const removed = adjustments.version;
    adjustments.setAngles(0, new Vector(0, 0, 0));
    assert.equal(adjustments.version, removed, 'nothing to take away is no change');
  });

  void test('clear removes everything, and counts as a change only if there was something', () => {
    const adjustments = new JointAdjustments(2);
    adjustments.clear();
    assert.equal(adjustments.version, 0);

    adjustments.setAngles(0, new Vector(10, 0, 0));
    adjustments.setAngles(1, new Vector(0, 10, 0));
    const version = adjustments.version;
    adjustments.clear();

    assert.equal(adjustments.count, 0);
    assert.deepEqual([...adjustments.isSet], [0, 0]);
    assert.deepEqual([...adjustments.rotations], [1, 0, 0, 0, 1, 0, 0, 0]);
    assert.notEqual(adjustments.version, version);
  });
});

void describe('SkeletalAnimation with joint adjustments', () => {
  void test('without adjustments, or with none set, the pose is the animation', () => {
    const model = createArm();
    const plain = pose(model, null);
    const empty = pose(model, new JointAdjustments(3));

    assert.deepEqual([...empty.joints], [...plain.joints]);
    assert.deepEqual([...empty.skinning], [...plain.skinning]);
  });

  void test('a positive pitch on the root lifts everything below it, about the root\'s own origin', () => {
    const model = createArm();
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(0, new Vector(30, 0, 0));
    const angle = Math.PI / 6;

    const { joints } = pose(model, adjustments);

    assertPointNear(originOf(joints, 0), [0, 0, 0]);
    assertPointNear(originOf(joints, 1), [10 * Math.cos(angle), 0, 10 * Math.sin(angle)]);
    assertPointNear(originOf(joints, 2), [20 * Math.cos(angle), 0, 20 * Math.sin(angle)]);
  });

  void test('a joint in the middle turns about its own origin: it stays, what hangs below it moves', () => {
    const model = createArm();
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(1, new Vector(90, 0, 0));

    const { joints } = pose(model, adjustments);

    assertPointNear(originOf(joints, 0), [0, 0, 0]);
    assertPointNear(originOf(joints, 1), [10, 0, 0]);
    assertPointNear(originOf(joints, 2), [10, 0, 10]);
  });

  void test('yaw and roll turn the way the entity angles do: the same rotation as `Quaternion.fromModelAnglesInto` makes', () => {
    // A joint's own turn is checked against the rotation matrix that the shared quaternion code writes, with all three angles at once, so
    // that no element of the matrix can be wrong without a point moving the wrong way.
    const model = createArm();
    const angles = new Vector(20, 35, 50);
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(0, angles);
    const quaternion = new Float64Array(4);
    Quaternion.fromModelAnglesInto(quaternion, 0, angles);
    const expected = new Float32Array(MATRIX_FLOATS);
    Quaternion.toMatrix3x4Into(expected, 0, quaternion, 0, [0, 0, 0], 0, [1, 1, 1], 0);

    const { joints } = pose(model, adjustments);

    for (const [joint, rest] of [[1, [10, 0, 0]], [2, [20, 0, 0]]] as const) {
      const moved = [0, 1, 2].map((row) => expected[row * 4]! * rest[0] + expected[row * 4 + 1]! * rest[1] + expected[row * 4 + 2]! * rest[2]);
      assertPointNear(originOf(joints, joint), moved);
    }

    // and the axes of the joint are turned by it: the matrix of the root is the rotation itself
    for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      assertNear(joints[index]!, expected[index]!, 1e-5);
    }
  });

  void test('yaw turns +X towards +Y, the way an entity\'s yaw does', () => {
    const model = createArm();
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(0, new Vector(0, 90, 0));

    const { joints } = pose(model, adjustments);

    assertPointNear(originOf(joints, 2), [0, 20, 0]);
  });

  void test('adjustments of a joint and of one below it add up', () => {
    const model = createArm();
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(0, new Vector(30, 0, 0));
    adjustments.setAngles(1, new Vector(30, 0, 0));
    const thirty = Math.PI / 6;
    const sixty = Math.PI / 3;

    const { joints } = pose(model, adjustments);

    assertPointNear(originOf(joints, 1), [10 * Math.cos(thirty), 0, 10 * Math.sin(thirty)]);
    assertPointNear(originOf(joints, 2), [10 * Math.cos(thirty) + 10 * Math.cos(sixty), 0, 10 * Math.sin(thirty) + 10 * Math.sin(sixty)]);
  });

  void test('the adjustment is in model space, not in the joint\'s own axes: a joint that the animation turned is turned the same way', () => {
    // `mid` is turned 90 degrees about Z by its pose, so its own X axis points along +Y; a pitch of 90 in model space
    // still lifts along +Z, not along the joint's turned axes.
    const rest = [poseOf([0, 0, 0]), poseOf([10, 0, 0], 90), poseOf([10, 0, 0])];
    const model = createModel([-1, 0, 1], rest, [rest], ['root', 'mid', 'tip']);
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(0, new Vector(90, 0, 0));

    const { joints } = pose(model, adjustments);

    assertPointNear(originOf(joints, 1), [0, 0, 10]);
    // `tip` hangs 10 units along the turned X axis of `mid`, which is +Y; the root's pitch lifts `mid`, and `tip` with it.
    assertPointNear(originOf(joints, 2), [0, 10, 10]);
  });

  void test('vertices skinned to a turned joint turn with it, and a vertex on its origin does not move', () => {
    const model = createArm();
    const adjustments = new JointAdjustments(3);
    adjustments.setAngles(1, new Vector(90, 0, 0));

    const { skinning } = pose(model, adjustments);

    assertPointNear(transformPoint(skinning, 1, [10, 0, 0]), [10, 0, 0]);
    assertPointNear(transformPoint(skinning, 1, [11, 0, 0]), [10, 0, 1]);
    assertPointNear(transformPoint(skinning, 0, [11, 0, 0]), [11, 0, 0]); // joint 0 is not adjusted
  });

  void test('a tag is where the vertices are: sampleTag agrees with the pose at a fraction between two frames', () => {
    const model = createFlashModel();
    const adjustments = new JointAdjustments(2);
    adjustments.setAngles(0, new Vector(25, 0, 0));
    const { joints } = pose(model, adjustments, 0, 1, 0.5);
    const tag = new Float64Array(7);

    assert.ok(model.sampleTag(1, 0, 1, 0.5, tag, adjustments));

    assertPointNear([tag[0]!, tag[1]!, tag[2]!], originOf(joints, 1));
    const matrix = new Float32Array(MATRIX_FLOATS);
    Quaternion.toMatrix3x4Into(matrix, 0, tag, 3, [0, 0, 0], 0, [1, 1, 1], 0);
    for (const row of [0, 1, 2]) {
      for (const column of [0, 1, 2]) {
        assertNear(matrix[row * 4 + column]!, joints[MATRIX_FLOATS + row * 4 + column]!, 1e-4);
      }
    }
  });

  void test('without adjustments sampleTag is what it was', () => {
    const model = createFlashModel();
    const withNone = new Float64Array(7);
    const without = new Float64Array(7);

    model.sampleTag(1, 0, 1, 0.5, withNone, null);
    model.sampleTag(1, 0, 1, 0.5, without);

    assert.deepEqual([...withNone], [...without]);
  });
});
