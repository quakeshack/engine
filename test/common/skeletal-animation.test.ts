import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import { SkeletalAnimation } from '../../source/engine/common/model/SkeletalAnimation.ts';
import { SkeletalModel } from '../../source/engine/common/model/SkeletalModel.ts';
import { assertNear } from '../support/assertions.ts';
import { buildIqm, createTwoJointSpec, type IqmPose } from '../support/iqmBuilder.ts';
import { createDirectoryFiles, createModelLoadContext } from '../support/modelContext.ts';

const MATRIX_FLOATS = SkeletalAnimation.MATRIX_FLOATS;
const SQRT_HALF = Math.SQRT1_2;

/**
 * Builds a model from poses, the way a loader leaves it, without a file.
 * @param parents The parent of every joint.
 * @param restPose The rest pose of every joint.
 * @param frames Every frame's pose of every joint.
 * @returns The model, with its inverse bind matrices computed.
 */
function createModel(parents: number[], restPose: IqmPose[], frames: IqmPose[][]): IQMModel {
  const model = new IQMModel('progs/test.iqm');
  model.jointNames = parents.map((_parent, index) => `joint${index}`);
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
function poseOf(translation: number[], degrees = 0, scale: number[] = [1, 1, 1]): IqmPose {
  const half = degrees * Math.PI / 360.0;
  return [...translation, Math.cos(half), 0, 0, Math.sin(half), ...scale];
}

/**
 * Poses a model and returns copies of the matrices.
 * @param model The model.
 * @param frameA First frame.
 * @param frameB Second frame.
 * @param blend Weight of the second frame.
 * @returns The joint matrices and the skinning matrices.
 */
function pose(model: SkeletalModel, frameA: number, frameB: number, blend: number): { joints: Float32Array; skinning: Float32Array } {
  const joints = new Float32Array(model.jointCount * MATRIX_FLOATS);
  const skinning = new Float32Array(model.jointCount * MATRIX_FLOATS);
  SkeletalAnimation.computePose(model, frameA, frameB, blend, joints, skinning);
  return { joints, skinning };
}

/**
 * Moves a point by a 3×4 matrix.
 * @param matrices Array of matrices.
 * @param index Which matrix.
 * @param point `x, y, z`.
 * @returns The moved point.
 */
function transformPoint(matrices: Float32Array, index: number, point: number[]): number[] {
  const start = index * MATRIX_FLOATS;
  return [0, 1, 2].map((row) => matrices[start + row * 4] * point[0] + matrices[start + row * 4 + 1] * point[1]
    + matrices[start + row * 4 + 2] * point[2] + matrices[start + row * 4 + 3]);
}

/**
 * Asserts that two lists of numbers are equal within a tolerance.
 * @param actual The numbers under test.
 * @param expected The numbers they should be.
 * @param epsilon The largest allowed difference.
 */
function assertAllNear(actual: ArrayLike<number>, expected: readonly number[], epsilon: number): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => { assertNear(actual[index], value, epsilon); });
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

void describe('SkeletalAnimation.computePose', () => {
  // The two-joint model of the loader tests: `child` sits 10 units along X from `root`; its second frame turns it
  // 90 degrees about Z. A vertex at (10, 1, 0) on `child` therefore ends up at (9, 0, 0), worked out by hand in
  // `createTwoJointSpec`.
  const twoJoints = (): IQMModel => createModel(
    [-1, 0],
    [poseOf([0, 0, 0]), poseOf([10, 0, 0])],
    [[poseOf([0, 0, 0]), poseOf([10, 0, 0])], [poseOf([0, 0, 0]), poseOf([10, 0, 0], 90)]],
  );

  void test('skins nothing in the rest pose: every skinning matrix is the identity', () => {
    const { joints, skinning } = pose(twoJoints(), 0, 0, 0);

    assertAllNear(joints.subarray(MATRIX_FLOATS), [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0], 1e-6);
    assertAllNear(skinning, [...IDENTITY_MATRIX, ...IDENTITY_MATRIX], 1e-6);
  });

  void test('moves a vertex of the turned joint to where the hand calculation puts it', () => {
    const { skinning } = pose(twoJoints(), 1, 1, 0);

    assertAllNear(transformPoint(skinning, 1, [10, 1, 0]), [9, 0, 0], 1e-5);
    assertAllNear(transformPoint(skinning, 1, [5, 0, 0]), [10, -5, 0], 1e-5);
    assertAllNear(transformPoint(skinning, 0, [5, 0, 0]), [5, 0, 0], 1e-6);
  });

  void test('interpolates the rotation halfway along the arc, not the matrix entries', () => {
    const { skinning } = pose(twoJoints(), 0, 1, 0.5);

    // The vertex (10, 1, 0) is 1 unit above the joint at (10, 0, 0). Turned 45 degrees about Z it is at
    // (10 - sin 45, cos 45), still 1 unit from the joint; a linear blend of the two matrices would pull it closer.
    const [x, y] = transformPoint(skinning, 1, [10, 1, 0]);
    assertNear(x, 10 - SQRT_HALF, 1e-5);
    assertNear(y, SQRT_HALF, 1e-5);
    assertNear(Math.hypot(x - 10, y), 1, 1e-5);
  });

  void test('takes the shortest path when a frame stores the rotation with the opposite sign', () => {
    // Joint turns from 10 to 30 degrees, and the second frame holds the same rotation as -q. The middle must
    // be 20 degrees about Z, not a rotation through the long way round.
    const second = poseOf([0, 0, 0], 30).map((value, index) => (index >= 3 && index < 7 ? -value : value));
    const model = createModel([-1], [poseOf([0, 0, 0])], [[poseOf([0, 0, 0], 10)], [second]]);

    const { joints } = pose(model, 0, 1, 0.5);

    const cosine = Math.cos(20 * Math.PI / 180);
    const sine = Math.sin(20 * Math.PI / 180);
    assertAllNear(joints, [cosine, -sine, 0, 0, sine, cosine, 0, 0, 0, 0, 1, 0], 1e-5);
  });

  void test('composes a parent chain with non-uniform scale as a matrix product', () => {
    // Parent stretches X by 2. The child sits 1 unit along the parent's X and turns 90 degrees about Z. Seen from
    // the world the child's axes are sheared by the parent's scale: its matrix is S * [R | t], which a chain of
    // translation-plus-quaternion could not hold.
    const model = createModel(
      [-1, 0],
      [poseOf([0, 0, 0], 0, [2, 1, 1]), poseOf([1, 0, 0], 90)],
      [[poseOf([0, 0, 0], 0, [2, 1, 1]), poseOf([1, 0, 0], 90)]],
    );

    const { joints } = pose(model, 0, 0, 0);

    assertAllNear(joints.subarray(MATRIX_FLOATS), [0, -2, 0, 2, 1, 0, 0, 0, 0, 0, 1, 0], 1e-6);
  });

  void test('a rest pose with non-uniform scale in a chain still skins to the identity', () => {
    // Fails if the inverse bind matrix is not the inverse of the composed bind matrix, whatever the scale does.
    const rest = [poseOf([0, 0, 0], 20, [2, 0.5, 1]), poseOf([3, 1, 0], 70, [1, 3, 2]), poseOf([0, 2, 5], 10, [1, 1, 0.25])];
    const model = createModel([-1, 0, 1], rest, [rest]);

    const { skinning } = pose(model, 0, 0, 0);

    for (let joint = 0; joint < 3; joint++) {
      assertAllNear(skinning.subarray(joint * MATRIX_FLOATS, (joint + 1) * MATRIX_FLOATS), IDENTITY_MATRIX, 1e-5);
    }
  });

  void test('fills the joint matrices when no skinning matrices are wanted', () => {
    const model = twoJoints();
    const joints = new Float32Array(2 * MATRIX_FLOATS);

    SkeletalAnimation.computePose(model, 1, 1, 0, joints, null);

    assertAllNear(transformPoint(joints, 1, [1, 0, 0]), [10, 1, 0], 1e-5);
  });

  void test('clamps frames that are off the model and a blend outside 0 to 1', () => {
    // A frame number comes off the wire; one past the last must not read the next model's memory or NaN.
    const model = twoJoints();
    const last = pose(model, 1, 1, 0);
    const first = pose(model, 0, 0, 0);

    assert.deepEqual(pose(model, 99, 99, 0).joints, last.joints);
    assert.deepEqual(pose(model, -5, -1, 0).joints, first.joints);
    assert.deepEqual(pose(model, 0, 1, 7).joints, last.joints);
    assert.deepEqual(pose(model, 0, 1, -3).joints, first.joints);
  });

  void test('a model with one frame poses that frame whatever the blend', () => {
    const model = createModel([-1], [poseOf([1, 2, 3], 40)], [[poseOf([1, 2, 3], 40)]]);

    assert.deepEqual(pose(model, 0, 3, 0.9).joints, pose(model, 0, 0, 0).joints);
  });

  void test('does not carry anything from one pose into the next', () => {
    // The scratch space is shared by all models and calls.
    const model = twoJoints();
    const other = createModel([-1], [poseOf([7, 7, 7], 33, [2, 2, 2])], [[poseOf([9, 9, 9], 77, [3, 1, 2])]]);
    const alone = pose(model, 1, 1, 0);

    pose(other, 0, 0, 0);

    assert.deepEqual(pose(model, 1, 1, 0).skinning, alone.skinning);
  });
});

void describe('SkeletalAnimation matrix helpers', () => {
  // An affine matrix with a rotation, uneven scale and a shear: nothing about it is orthonormal.
  const general = [2, 1, 0.5, 4, -1, 3, 1, -2, 0.5, 0, 2, 7];

  void test('invertMatrix3x4Into gives a matrix that undoes the original, shear and scale included', () => {
    const inverse = new Float32Array(12);

    assert.equal(SkeletalAnimation.invertMatrix3x4Into(inverse, 0, general, 0), true);

    const product = new Float32Array(12);
    SkeletalAnimation.multiplyMatrix3x4Into(product, 0, inverse, 0, general, 0);
    assertAllNear(product, IDENTITY_MATRIX, 1e-5);
  });

  void test('invertMatrix3x4Into refuses a matrix with a zero scale and leaves the output alone', () => {
    const squashed = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    const out = new Float32Array(12).fill(9);

    assert.equal(SkeletalAnimation.invertMatrix3x4Into(out, 0, squashed, 0), false);
    assert.deepEqual(Array.from(out), new Array(12).fill(9));
  });

  void test('invertMatrix3x4Into may write over its input', () => {
    const matrix = Float32Array.from(general);
    const separate = new Float32Array(12);
    SkeletalAnimation.invertMatrix3x4Into(separate, 0, general, 0);

    SkeletalAnimation.invertMatrix3x4Into(matrix, 0, matrix, 0);

    assertAllNear(matrix, Array.from(separate), 1e-6);
  });

  void test('multiplyMatrix3x4Into applies the right matrix first and carries the translation through', () => {
    // right: move +5 along X. left: turn 90 degrees about Z. Moving then turning takes (1, 0, 0) to (0, 6, 0).
    const right = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0];
    const left = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    const product = new Float32Array(12);

    SkeletalAnimation.multiplyMatrix3x4Into(product, 0, left, 0, right, 0);

    assertAllNear(transformPoint(product, 0, [1, 0, 0]), [0, 6, 0], 1e-6);
  });

  void test('multiplyMatrix3x4Into may write over either input', () => {
    const left = Float32Array.from(general);
    const right = Float32Array.from([0, -1, 0, 2, 1, 0, 0, 3, 0, 0, 1, 4]);
    const expected = new Float32Array(12);
    SkeletalAnimation.multiplyMatrix3x4Into(expected, 0, left, 0, right, 0);

    const overLeft = Float32Array.from(left);
    SkeletalAnimation.multiplyMatrix3x4Into(overLeft, 0, overLeft, 0, right, 0);
    const overRight = Float32Array.from(right);
    SkeletalAnimation.multiplyMatrix3x4Into(overRight, 0, left, 0, overRight, 0);

    assertAllNear(overLeft, Array.from(expected), 1e-6);
    assertAllNear(overRight, Array.from(expected), 1e-6);
  });
});

void describe('SkeletalAnimation.computeInverseBindMatrices', () => {
  void test('gives a zero-scale joint the identity and counts it, instead of poisoning vertices with NaN', () => {
    const rest = [poseOf([0, 0, 0]), poseOf([1, 0, 0], 0, [1, 0, 1]), poseOf([0, 5, 0])];

    const { matrices, singularJoints } = SkeletalAnimation.computeInverseBindMatrices(Float32Array.from(rest.flat()), Int32Array.from([-1, 0, 1]));

    assert.equal(singularJoints, 2, 'the squashed joint and its child, which inherits the squash');
    assert.ok(matrices.every((value) => Number.isFinite(value)));
    assertAllNear(matrices.subarray(MATRIX_FLOATS, 2 * MATRIX_FLOATS), IDENTITY_MATRIX, 0);
  });
});

void describe('SkeletalAnimation.skinMeshInto', () => {
  void test('skins positions and normals of the two-joint model to the hand-worked places', async () => {
    // Frame 1 turns `child` 90 degrees about Z. See `createTwoJointSpec`: the vertex shared half-and-half by both
    // joints ends at (7.5, -2.5, 0), the one on `child` at (9, 0, 0), the one on `root` stays.
    const model = await new IQMLoader(createModelLoadContext({ loadRenderData: true })).load(buildIqm(createTwoJointSpec()), 'progs/two.iqm');
    const { skinning } = pose(model, 1, 1, 0);
    const out = new Float32Array(3 * 8).fill(-7);

    SkeletalAnimation.skinMeshInto(model.meshData!, skinning, out, 8, 0, 5);

    assertAllNear(out.subarray(0, 3), [9, 0, 0], 1e-5);
    assertAllNear(out.subarray(8, 11), [0, 1, 0], 1e-5);
    assertAllNear(out.subarray(16, 19), [7.5, -2.5, 0], 1e-5);
    // The texture coordinates between position and normal belong to the renderer and are left alone.
    assert.deepEqual(Array.from(out.subarray(3, 5)), [-7, -7]);
    assertAllNear(out.subarray(5, 8), [0, 0, 1], 1e-6);
  });

  void test('turns a normal with its joint and keeps it unit length under scale', () => {
    // A joint turned 90 degrees about Z and stretched 3 times: the normal (1, 0, 0) must come out (0, 1, 0), not
    // (0, 3, 0), which would brighten or darken the lighting on stretched joints.
    const model = createModel([-1], [poseOf([0, 0, 0])], [[poseOf([0, 0, 0], 90, [3, 3, 3])]]);
    const meshData = {
      positions: Float32Array.from([1, 0, 0]),
      normals: Float32Array.from([1, 0, 0]),
      texcoords: new Float32Array(2),
      blendIndexes: Uint16Array.from([0, 0, 0, 0]),
      blendWeights: Float32Array.from([1, 0, 0, 0]),
      triangles: new Uint32Array(0),
    };
    const { skinning } = pose(model, 0, 0, 0);
    const out = new Float32Array(6);

    SkeletalAnimation.skinMeshInto(meshData, skinning, out, 6, 0, 3);

    assertAllNear(out.subarray(0, 3), [0, 3, 0], 1e-5);
    assertAllNear(out.subarray(3, 6), [0, 1, 0], 1e-6);
  });

  void test('gives a normal that cancels out between two joints a defined direction instead of NaN', () => {
    const model = createModel([-1, -1], [poseOf([0, 0, 0]), poseOf([0, 0, 0])], [[poseOf([0, 0, 0]), poseOf([0, 0, 0], 180)]]);
    const meshData = {
      positions: Float32Array.from([0, 0, 0]),
      normals: Float32Array.from([1, 0, 0]),
      texcoords: new Float32Array(2),
      blendIndexes: Uint16Array.from([0, 1, 0, 0]),
      blendWeights: Float32Array.from([0.5, 0.5, 0, 0]),
      triangles: new Uint32Array(0),
    };
    const { skinning } = pose(model, 0, 0, 0);
    const out = new Float32Array(6);

    SkeletalAnimation.skinMeshInto(meshData, skinning, out, 6, 0, 3);

    assert.deepEqual(Array.from(out.subarray(3, 6)), [0, 0, 1]);
  });
});

void describe('SkeletalAnimation on the LibreQuake player', () => {
  interface PoseCase {
    frameA: number;
    frameB: number;
    blend: number;
    jointMatrices: number[][];
    vertices: number[];
  }

  interface PlayerReference {
    jointCount: number;
    vertexStride: number;
    cases: PoseCase[];
  }

  const fixtures = new URL('../fixtures/skeletal/', import.meta.url);
  // Poses and skinned vertices worked out by qs-tools' IQM reader, in float64 and with the interpolation written
  // again in Python: `make-player-pose-reference.py`. Nothing of the engine took part.
  const reference = JSON.parse(readFileSync(new URL('player-pose-reference.json', fixtures), 'utf8')) as PlayerReference;
  const SKINNED_STRIDE = 6;

  /**
   * Loads the player fixture with its mesh, the way the client realm does.
   * @returns The model.
   */
  async function loadPlayer(): Promise<IQMModel> {
    const file = await createDirectoryFiles(fixtures).LoadFile('player.iqm');
    return await new IQMLoader(createModelLoadContext({ loadRenderData: true })).load(file!, 'progs/player.iqm');
  }

  /**
   * Skins the whole mesh of the player in a pose.
   * @param model The player.
   * @param frameA First frame.
   * @param frameB Second frame.
   * @param blend Weight of the second frame.
   * @returns Positions (`x, y, z`) and normals per vertex, `SKINNED_STRIDE` numbers each.
   */
  function skinPlayer(model: IQMModel, frameA: number, frameB: number, blend: number): Float32Array {
    const { skinning } = pose(model, frameA, frameB, blend);
    const out = new Float32Array(model._num_verts * SKINNED_STRIDE);
    SkeletalAnimation.skinMeshInto(model.meshData!, skinning, out, SKINNED_STRIDE, 0, 3);
    return out;
  }

  void test('every pose of the reference gives its joint matrices and skinned vertices', async () => {
    const model = await loadPlayer();
    assert.equal(model.jointCount, reference.jointCount);

    let worstJoint = 0;
    let worstVertex = 0;

    for (const { frameA, frameB, blend, jointMatrices, vertices } of reference.cases) {
      const { joints } = pose(model, frameA, frameB, blend);
      const skinned = skinPlayer(model, frameA, frameB, blend);

      for (let joint = 0; joint < model.jointCount; joint++) {
        for (let index = 0; index < MATRIX_FLOATS; index++) {
          worstJoint = Math.max(worstJoint, Math.abs(joints[joint * MATRIX_FLOATS + index] - jointMatrices[joint][index]));
        }
      }

      for (let picked = 0; picked * 3 < vertices.length; picked++) {
        const vertex = picked * reference.vertexStride;

        for (let axis = 0; axis < 3; axis++) {
          worstVertex = Math.max(worstVertex, Math.abs(skinned[vertex * SKINNED_STRIDE + axis] - vertices[picked * 3 + axis]));
        }
      }
    }

    // The reference rounds matrices to 1e-5 and vertices to 1e-4; the engine works in float32. Measured on 2026-11-15:
    // 8e-6 and 5e-5. A quaternion component order or an interpolation slip is off by whole units, not by this.
    assert.ok(worstJoint < 1e-4, `joint matrices differ by up to ${worstJoint}`);
    assert.ok(worstVertex < 5e-4, `vertices differ by up to ${worstVertex}`);
  });

  void test('the posed model stays inside the bounds the file records for that frame', async () => {
    // The bounds are the file's own claim about each whole frame (16-bit quantization allows a hair of slack), so
    // this pins the pose against data the engine did not compute.
    const model = await loadPlayer();

    for (const frame of [0, 19, 59, 99, 142]) {
      const skinned = skinPlayer(model, frame, frame, 0);
      const bounds = model.frameBounds.subarray(frame * SkeletalModel.BOUNDS_FLOATS, frame * SkeletalModel.BOUNDS_FLOATS + 6);

      for (let vertex = 0; vertex < model._num_verts; vertex += 5) {
        for (let axis = 0; axis < 3; axis++) {
          const value = skinned[vertex * SKINNED_STRIDE + axis];
          assert.ok(value >= bounds[axis] - 0.05 && value <= bounds[3 + axis] + 0.05,
            `frame ${frame} vertex ${vertex} axis ${axis}: ${value} outside ${bounds[axis]}..${bounds[3 + axis]}`);
        }
      }
    }
  });

  void test('skinned normals are unit length in every sampled pose', async () => {
    const model = await loadPlayer();

    for (const frame of [0, 59, 142]) {
      const skinned = skinPlayer(model, frame, frame, 0);

      for (let vertex = 0; vertex < model._num_verts; vertex++) {
        const offset = vertex * SKINNED_STRIDE + 3;
        assertNear(Math.hypot(skinned[offset], skinned[offset + 1], skinned[offset + 2]), 1, 1e-5);
      }
    }
  });
});

void describe('SkeletalAnimation on a loaded file', () => {
  void test('a model loaded without render data is posed the same as with it', async () => {
    // The server realm keeps joints and frames only, and tags are read from exactly that.
    const buffer = buildIqm(createTwoJointSpec());
    const withRender = await new IQMLoader(createModelLoadContext({ loadRenderData: true })).load(buffer, 'progs/a.iqm');
    const without = await new IQMLoader(createModelLoadContext({ loadRenderData: false })).load(buffer, 'progs/b.iqm');

    assert.deepEqual(pose(without, 0, 1, 0.5).joints, pose(withRender, 0, 1, 0.5).joints);
  });

  void test('the loader leaves inverse bind matrices that undo the file\'s rest pose', async () => {
    const model = await new IQMLoader(createModelLoadContext({ loadRenderData: false })).load(buildIqm(createTwoJointSpec()), 'progs/c.iqm');

    assertAllNear(model.inverseBindMatrices.subarray(MATRIX_FLOATS), [1, 0, 0, -10, 0, 1, 0, 0, 0, 0, 1, 0], 1e-6);
  });
});
