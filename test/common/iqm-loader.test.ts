import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { Mod, ModelScope, ModelType } from '../../source/engine/common/Mod.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { SkeletalModel } from '../../source/engine/common/model/SkeletalModel.ts';
import type { ModelLoadContext } from '../../source/engine/common/model/ModelLoadContext.ts';
import { assertNear } from '../support/assertions.ts';
import {
  IDENTITY_POSE,
  IQM_HEADER_FIELDS,
  buildIqm,
  createTwoJointSpec,
  patchHeader,
  type IqmHeaderField,
  type IqmPose,
  type IqmSpec,
} from '../support/iqmBuilder.ts';
import { createDirectoryFiles, createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';

const SQRT_HALF = Math.SQRT1_2;

/**
 * Loads a file the way a realm does.
 * @param buffer The file.
 * @param context Overrides of what the realm gives the loader.
 * @returns The model.
 */
async function load(buffer: ArrayBuffer, context: Partial<ModelLoadContext> = {}): Promise<IQMModel> {
  return await new IQMLoader(createModelLoadContext(context)).load(buffer, 'progs/test.iqm');
}

/**
 * Loads a file that must be refused, whether the loader throws or rejects.
 * @param buffer The file.
 * @param loadRenderData Whether the realm draws.
 * @returns The error the loader gave.
 */
async function loadError(buffer: ArrayBuffer, loadRenderData = false): Promise<unknown> {
  try {
    await load(buffer, { loadRenderData });
  } catch (error) {
    return error;
  }

  return null;
}

/**
 * Asserts that a file is refused as corrupted, not with some other error (a `RangeError` of a read past the end is a
 * bug of the loader, not a verdict on the file).
 * @param buffer The file.
 * @param message What the problem should say.
 */
async function assertCorrupted(buffer: ArrayBuffer, message?: RegExp): Promise<void> {
  const error = await loadError(buffer);

  assert.ok(error instanceof CorruptedResourceError, `expected CorruptedResourceError, got ${String(error)}`);

  if (message !== undefined) {
    assert.match(error.reason, message);
  }
}

/**
 * Loads the LibreQuake player fixture.
 * @param context Overrides of what the realm gives the loader.
 * @returns The model.
 */
async function loadPlayer(context: Partial<ModelLoadContext> = {}): Promise<IQMModel> {
  const file = await createDirectoryFiles(new URL('../fixtures/skeletal/', import.meta.url)).LoadFile('player.iqm');

  return await load(file!, context);
}

/**
 * Reads the numbers of a pose of one joint in one frame.
 * @param model The model.
 * @param frame The frame.
 * @param joint The joint.
 * @returns The ten numbers: translation, rotation `w, x, y, z`, scale.
 */
function poseOf(model: SkeletalModel, frame: number, joint: number): number[] {
  const start = (frame * model.jointCount + joint) * SkeletalModel.POSE_FLOATS;

  return Array.from(model.framePoses.subarray(start, start + SkeletalModel.POSE_FLOATS));
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

void describe('IQMLoader', () => {
  void describe('joints and poses', () => {
    // An asymmetric rotation: if the file's x, y, z, w were read as w, x, y, z the result would still be a valid
    // rotation, only a different one, so nothing but these exact numbers can tell.
    const length = Math.hypot(0.5, 0.1, 0.7, 0.3);
    const rotation = [0.5 / length, 0.1 / length, 0.7 / length, 0.3 / length];

    void test('reorders the stored x, y, z, w rotation to w, x, y, z', async () => {
      const spec = createTwoJointSpec({
        joints: [
          { name: 'root', parent: -1, pose: IDENTITY_POSE },
          { name: 'child', parent: 0, pose: [10, 0, 0, ...rotation, 1, 1, 1] },
        ],
        frames: [[IDENTITY_POSE, [10, 0, 0, ...rotation, 1, 1, 1]]],
        anims: [],
        bounds: [[0, 0, 0, 10, 1, 0, 10, 10]],
      });

      const model = await load(buildIqm(spec));

      assertAllNear(model.restPose.subarray(10, 20), [10, 0, 0, ...rotation, 1, 1, 1], 1e-6);
      assertAllNear(poseOf(model, 0, 1), [10, 0, 0, ...rotation, 1, 1, 1], 1e-6);
    });

    void test('decodes the quantized frames to within one step of what was written', async () => {
      const model = await load(buildIqm(createTwoJointSpec()));

      assert.deepEqual(model.jointNames, ['root', 'child']);
      assert.deepEqual(Array.from(model.jointParents), [-1, 0]);
      assertAllNear(poseOf(model, 0, 1), [10, 0, 0, 1, 0, 0, 0, 1, 1, 1], 1e-6);
      // Frame 1 turns the child by 90 degrees around Z; its z and w channels are the only ones that vary.
      assertAllNear(poseOf(model, 1, 1), [10, 0, 0, SQRT_HALF, 0, 0, SQRT_HALF, 1, 1, 1], 2e-5);
      assertAllNear(poseOf(model, 1, 0), IDENTITY_POSE, 1e-6);
    });

    void test('decodes a scale that varies over the frames', async () => {
      const grown: IqmPose = [10, 0, 0, 1, 0, 0, 0, 3, 1, 0.5];
      const spec = createTwoJointSpec({ frames: [[IDENTITY_POSE, [10, 0, 0, 1, 0, 0, 0, 1, 1, 1]], [IDENTITY_POSE, grown]] });
      const model = await load(buildIqm(spec));

      assertAllNear(poseOf(model, 1, 1), grown, 1e-4);
    });

    void test('normalizes rotations that are stored with a length other than one', async () => {
      const spec = createTwoJointSpec({ joints: [{ name: 'root', parent: -1, pose: [0, 0, 0, 2, 0, 0, 0, 1, 1, 1] }, { name: 'child', parent: 0, pose: [10, 0, 0, 0, 0, 3, 0, 1, 1, 1] }] });
      const model = await load(buildIqm(spec));

      assertAllNear(model.restPose.subarray(0, 7), [0, 0, 0, 1, 0, 0, 0], 1e-6);
      assertAllNear(model.restPose.subarray(10, 17), [10, 0, 0, 0, 0, 1, 0], 1e-6);
    });

    void test('gives a model without frames one frame, its bind pose, and bounds from its vertices', async () => {
      const spec = createTwoJointSpec({ frames: [], anims: [], bounds: null });
      const model = await load(buildIqm(spec));

      assert.equal(model.frameCount, 1);
      assert.deepEqual(Array.from(model.framePoses), Array.from(model.restPose));
      assert.deepEqual([...model.mins], [0, 0, 0]);
      assert.deepEqual([...model.maxs], [10, 1, 0]);
    });
  });

  void describe('bounds', () => {
    void test('takes the bounds of every frame, and the box and radius of the model from their union', async () => {
      const model = await load(buildIqm(createTwoJointSpec()));

      assert.equal(model.frameBounds.length, 2 * SkeletalModel.BOUNDS_FLOATS);
      assertAllNear(model.frameBounds.subarray(8, 16), [0, -2.5, 0, 9, 1, 0, 9, 9], 1e-6);
      // Frame 0 reaches x = 10 and y = 0, frame 1 reaches y = -2.5: the union has both.
      assert.deepEqual([...model.mins], [0, -2.5, 0]);
      assert.deepEqual([...model.maxs], [10, 1, 0]);
      assertNear(model.boundingradius, Math.hypot(10, 1), 1e-6);
    });

    void test('falls back to the bounds of the bind pose when a file has frames but no bounds, and says so', async () => {
      const printed: string[] = [];
      const model = await load(buildIqm(createTwoJointSpec({ bounds: null })), { con: createSilentConsole({ DPrint: (text: string) => { printed.push(text); } }) });

      assert.deepEqual([...model.maxs], [10, 1, 0]);
      assert.equal(model.frameBounds.length, 2 * SkeletalModel.BOUNDS_FLOATS);
      assert.match(printed.join(''), /no bounds/);
    });
  });

  void describe('sequences', () => {
    void test('reads the animations with their frame ranges, rates and loop flags', async () => {
      const spec = createTwoJointSpec({
        anims: [
          { name: 'first', firstFrame: 0, frameCount: 1, framerate: 0, loop: false },
          { name: 'second', firstFrame: 1, frameCount: 1, framerate: 12.5, loop: true },
        ],
      });
      const model = await load(buildIqm(spec));

      assert.deepEqual(model.sequences, [
        { name: 'first', firstFrame: 0, frameCount: 1, framerate: 0, loop: false },
        { name: 'second', firstFrame: 1, frameCount: 1, framerate: 12.5, loop: true },
      ]);
    });
  });

  void describe('mesh data', () => {
    void test('keeps the vertex arrays and names the materials when the realm draws', async () => {
      const model = await load(buildIqm(createTwoJointSpec()), { loadRenderData: true });

      assert.equal(model.type, ModelType.skeletal);
      assert.deepEqual(Array.from(model.meshData!.positions), [10, 1, 0, 0, 1, 0, 5, 0, 0]);
      assert.deepEqual(Array.from(model.meshData!.texcoords), [0, 0, 1, 0, 0, 1]);
      assert.deepEqual(Array.from(model.meshData!.blendIndexes), [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
      assert.deepEqual(Array.from(model.meshData!.triangles), [0, 1, 2]);
      assert.deepEqual(model.materials, [{ name: 'progs/body' }]);
      assert.deepEqual(model.meshes, [{ name: 'body', materialIndex: 0, firstVertex: 0, vertexCount: 3, firstTriangle: 0, triangleCount: 1 }]);
    });

    void test('lets meshes of the same material share it and gives each its own vertex range', async () => {
      const spec = createTwoJointSpec({
        positions: [10, 1, 0, 0, 1, 0, 5, 0, 0, 10, 1, 0, 0, 1, 0, 5, 0, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        texcoords: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        blendIndexes: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
        blendWeights: [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0],
        triangles: [0, 1, 2, 3, 4, 5],
        meshes: [
          { name: 'a', material: 'progs/shared', firstVertex: 0, vertexCount: 3, firstTriangle: 0, triangleCount: 1 },
          { name: 'b', material: 'progs/shared', firstVertex: 3, vertexCount: 3, firstTriangle: 1, triangleCount: 1 },
        ],
      });
      const model = await load(buildIqm(spec), { loadRenderData: true });

      assert.deepEqual(model.materials, [{ name: 'progs/shared' }]);
      assert.deepEqual(model.meshes.map((mesh) => [mesh.materialIndex, mesh.firstVertex]), [[0, 0], [0, 3]]);
    });

    void test('renormalizes blend weights, which a file may store as any floats', async () => {
      const spec = createTwoJointSpec({ blendWeights: [0.2, 0.2, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], blendWeightFormat: 'float' });
      const model = await load(buildIqm(spec), { loadRenderData: true });

      assertAllNear(model.meshData!.blendWeights.subarray(0, 4), [0.5, 0.5, 0, 0], 1e-6);
    });

    void test('reads 16-bit blend indexes of a model with more than 256 joints', async () => {
      const count = 300;
      const joints = Array.from({ length: count }, (_, index) => ({ name: `joint${index}`, parent: index - 1, pose: IDENTITY_POSE }));
      const spec = createTwoJointSpec({
        joints,
        frames: [joints.map((joint) => joint.pose)],
        blendIndexes: [299, 0, 0, 0, 0, 0, 0, 0, 258, 299, 0, 0],
        blendIndexFormat: 'ushort',
        anims: [],
        bounds: [[0, 0, 0, 10, 1, 0, 10, 10]],
      });
      const model = await load(buildIqm(spec), { loadRenderData: true });

      assert.equal(model.jointCount, count);
      assert.deepEqual(Array.from(model.meshData!.blendIndexes), [299, 0, 0, 0, 0, 0, 0, 0, 258, 299, 0, 0]);
    });
  });

  void describe('a realm that does not draw', () => {
    void test('keeps joints, poses, sequences and bounds, and drops the vertex arrays and materials', async () => {
      const model = await load(buildIqm(createTwoJointSpec()), { loadRenderData: false });

      assert.equal(model.meshData, null);
      assert.deepEqual(model.materials, []);
      assert.deepEqual(model.meshes, []);
      assert.equal(model.jointCount, 2);
      assert.equal(model.frameCount, 2);
      assert.equal(model.sequences.length, 1);
      assert.deepEqual([...model.maxs], [10, 1, 0]);
      assert.equal(model._num_verts, 3);
      assert.equal(model._num_tris, 1);
    });

    void test('still refuses a corrupted vertex array, or server and client would disagree on what loads', async () => {
      const damaged = createTwoJointSpec({ blendIndexes: [1, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0] });

      assert.ok(await loadError(buildIqm(damaged), false) instanceof CorruptedResourceError);
      assert.ok(await loadError(buildIqm(damaged), true) instanceof CorruptedResourceError);
    });
  });

  void describe('corrupted files', () => {
    const valid = buildIqm(createTwoJointSpec());

    void test('are refused with CorruptedResourceError at every truncation', async () => {
      for (let length = 0; length < valid.byteLength; length += 11) {
        await assertCorrupted(valid.slice(0, length));
      }
    });

    void test('are refused when the version is not 2 or the size in the header is wrong', async () => {
      await assertCorrupted(patchHeader(valid, 'version', 1), /version 1/);
      await assertCorrupted(patchHeader(valid, 'filesize', valid.byteLength + 1), /header says/);
    });

    void test('are refused when an offset points past the end of the file', async () => {
      const offsets: IqmHeaderField[] = ['ofs_text', 'ofs_meshes', 'ofs_vertexarrays', 'ofs_triangles', 'ofs_joints', 'ofs_poses', 'ofs_anims', 'ofs_frames', 'ofs_bounds'];

      for (const field of offsets) {
        const error = await loadError(patchHeader(valid, field, valid.byteLength + 4));

        assert.ok(error instanceof CorruptedResourceError, `${field}: ${String(error)}`);
      }
    });

    void test('are refused when a count is huge, before any memory is allocated for it', async () => {
      const counts: IqmHeaderField[] = ['num_text', 'num_meshes', 'num_vertexarrays', 'num_vertexes', 'num_triangles', 'num_joints', 'num_poses', 'num_anims', 'num_frames', 'num_framechannels'];

      for (const field of counts) {
        const error = await loadError(patchHeader(valid, field, 0xfffffff0));

        assert.ok(error instanceof CorruptedResourceError, `${field}: ${String(error)}`);
      }
    });

    void test('are refused when joints times frames would be more poses than the loader allows, though the file stays small', async () => {
      // A pose without varying channels costs no frame data, so the file's size does not bound the decoded size.
      const patched = patchHeader(patchHeader(valid, 'num_joints', 200), 'num_frames', 50000);

      await assertCorrupted(patched, /more than the loader accepts/);
    });

    void test('are refused when the channel count of the header is not what the poses add up to', async () => {
      const fields = new DataView(valid);
      const channels = fields.getUint32(16 + IQM_HEADER_FIELDS.indexOf('num_framechannels') * 4, true);

      await assertCorrupted(patchHeader(valid, 'num_framechannels', channels + 1), /frame channels/);
    });

    void test('are refused when the text table is too short for the names that point into it', async () => {
      await assertCorrupted(patchHeader(valid, 'num_text', 1), /text table/);
    });

    void test('are refused when the last string loses its terminator', async () => {
      const textBytes = new DataView(valid).getUint32(16 + IQM_HEADER_FIELDS.indexOf('num_text') * 4, true);

      await assertCorrupted(patchHeader(valid, 'num_text', textBytes - 1), /not terminated/);
    });

    void test('are refused without a vertex array the engine needs', async () => {
      await assertCorrupted(patchHeader(valid, 'num_vertexarrays', 3), /no blend indexes/);
    });

    void test('are refused without joints', async () => {
      await assertCorrupted(patchHeader(valid, 'num_joints', 0), /joints/);
    });

    const specs: [string, Partial<IqmSpec>, RegExp][] = [
      ['a joint whose parent comes after it', { joints: [{ name: 'a', parent: 1, pose: IDENTITY_POSE }, { name: 'b', parent: -1, pose: IDENTITY_POSE }] }, /parent/],
      ['a joint that is its own parent', { joints: [{ name: 'a', parent: -1, pose: IDENTITY_POSE }, { name: 'b', parent: 1, pose: IDENTITY_POSE }] }, /parent/],
      ['a parent index below -1', { joints: [{ name: 'a', parent: -2, pose: IDENTITY_POSE }, { name: 'b', parent: 0, pose: IDENTITY_POSE }] }, /parent/],
      ['a blend index past the joint count', { blendIndexes: [2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] }, /joint 2 of 2/],
      ['a triangle that leaves the vertices of its mesh', { triangles: [0, 1, 3] }, /outside the mesh/],
      ['a mesh that leaves the vertices of the model', { meshes: [{ name: 'body', material: 'm', firstVertex: 0, vertexCount: 4, firstTriangle: 0, triangleCount: 1 }] }, /leaves/],
      ['an animation past the last frame', { anims: [{ name: 'long', firstFrame: 1, frameCount: 5, framerate: 10, loop: false }] }, /leaves/],
      ['a negative frame rate', { anims: [{ name: 'back', firstFrame: 0, frameCount: 1, framerate: -1, loop: false }] }, /frame rate/],
      ['a rotation of length zero', { joints: [{ name: 'a', parent: -1, pose: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1] }, { name: 'b', parent: 0, pose: IDENTITY_POSE }] }, /normalized/],
      ['a position that is not a number', { positions: [Number.NaN, 1, 0, 0, 1, 0, 5, 0, 0] }, /not a number/],
      ['a vertex without any weight', { blendWeights: [0, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], blendWeightFormat: 'float' }, /no weight/],
    ];

    for (const [name, overrides, message] of specs) {
      void test(`are refused with ${name}`, async () => {
        await assertCorrupted(buildIqm(createTwoJointSpec(overrides)), message);
      });
    }
  });

  void describe('in the model cache', () => {
    void test('is picked by extension and magic, never for a file that only has the extension of another format', () => {
      const mod = new Mod();
      mod.Init({ ...createModelLoadContext() });
      const file = buildIqm(createTwoJointSpec());

      assert.ok(mod.modelLoaderRegistry.findLoader(file, 'progs/x.iqm') instanceof IQMLoader);
      assert.equal(mod.modelLoaderRegistry.findLoader(file, 'progs/x.mdl'), null);
      assert.equal(mod.modelLoaderRegistry.findLoader(new ArrayBuffer(2), 'progs/x.iqm'), null);
    });

    void test('shares its arrays between the scoped views of the client and the server', async () => {
      const mod = new Mod();
      mod.Init({ ...createModelLoadContext() });
      await mod.LoadModelFromBuffer('progs/test.iqm', buildIqm(createTwoJointSpec()));

      const client = mod.ResolveScopedModel('progs/test.iqm', ModelScope.client) as IQMModel;
      const server = mod.ResolveScopedModel('progs/test.iqm', ModelScope.server) as IQMModel;

      assert.notEqual(client, server);
      assert.equal(client.framePoses, server.framePoses);
      assert.equal(client.restPose, server.restPose);
    });
  });

  void describe('the LibreQuake player', () => {
    // Reference numbers come from an independent reader of the format (`iqm_format.read_iqm` of qs-tools), and the
    // bounds from the header of `player.mdl`, the model this one was made from.
    const fixtures = new URL('../fixtures/skeletal/', import.meta.url);

    void test('has the joints, frames and sequences of the rig it was exported from', async () => {
      const mod = new Mod();
      mod.Init(createModelLoadContext({ files: createDirectoryFiles(fixtures) }));
      const player = await mod.ForNameAsync('player.iqm', true, ModelScope.server) as IQMModel;

      assert.equal(player.jointCount, 25);
      assert.equal(player.frameCount, 143);
      assert.deepEqual(player.jointNames.slice(0, 2), ['parent', 'base']);
      assert.deepEqual(player.jointNames.slice(22), ['playergun', 'flash', 'playeraxe']);
      assert.deepEqual(Array.from(player.jointParents.subarray(22)), [-1, 22, -1]);
      assert.equal(player.sequences.length, 20);
      assert.deepEqual(player.sequences[0], { name: 'axrun', firstFrame: 0, frameCount: 6, framerate: 10, loop: true });
      assert.deepEqual(player.sequences[4], { name: 'axpain', firstFrame: 29, frameCount: 6, framerate: 10, loop: false });
      assert.deepEqual(player.sequences[19], { name: 'axattd', firstFrame: 137, frameCount: 6, framerate: 10, loop: false });
    });

    void test('decodes poses to what the independent reader decodes, including a scale and a rotation of w and x', async () => {
      const player = await loadPlayer();

      assertAllNear(poseOf(player, 0, 0), [-2.71884, 0, -23.99998, 0.70711, 0.70711, 0, 0, 1, 1, 1], 1e-4);
      assertAllNear(poseOf(player, 100, 9), [0, 7.08769, 0, 0.99664, -0.07802, 0.0004, 0.02499, 1, 1, 1], 1e-4);
      assertAllNear(poseOf(player, 142, 22), [-8.47108, 8.23289, 18.31784, 0.18436, 0.97523, 0.0797, -0.09272, 0.8, 0.8, 0.8], 1e-4);
      assertAllNear(poseOf(player, 60, 5), [0, 2.04209, 0, 0.95228, -0.05922, 0.08778, 0.28626, 1, 1, 1], 1e-4);
    });

    void test('has a unit rotation in every pose of every frame', async () => {
      const player = await loadPlayer();

      for (let pose = 0; pose < player.framePoses.length; pose += SkeletalModel.POSE_FLOATS) {
        assertNear(Math.hypot(...player.framePoses.subarray(pose + 3, pose + 7)), 1, 1e-5);
      }
    });

    void test('is bounded by exactly the box of player.mdl, so it needs no axis or unit conversion', async () => {
      const player = await loadPlayer();

      // `translate` of the MDL header, and `translate + 255 * scale` (the MDL stores vertices as bytes).
      assertAllNear([...player.mins], [-44.17623, -34.47351, -35.06478], 1e-3);
      assertAllNear([...player.maxs], [-44.17623 + 255 * 0.32704252, -34.47351 + 255 * 0.25418553, -35.06478 + 255 * 0.32760304], 1e-3);
      assertNear(player.boundingradius, 52.9446, 1e-3);
    });

    void test('skins its 794 vertices to joints that exist, with weights that add up to one', async () => {
      const player = await loadPlayer({ loadRenderData: true });
      const mesh = player.meshData!;

      assert.equal(mesh.positions.length, 794 * 3);
      assert.equal(mesh.triangles.length, 1060 * 3);
      assert.deepEqual(player.materials, [{ name: 'progs/player.mdl.0' }]);
      assert.ok(mesh.blendIndexes.every((index) => index < 25));
      assertAllNear(mesh.positions.subarray(300, 303), [1.11939, 6.52372, 21.97339], 1e-4);
      assertAllNear(mesh.blendIndexes.subarray(400, 404), [3, 6, 0, 0], 0);
      assertAllNear(mesh.blendWeights.subarray(400, 404), [0.50196, 0.49804, 0, 0], 1e-4);

      for (let vertex = 0; vertex < 794; vertex++) {
        const weights = mesh.blendWeights.subarray(vertex * 4, vertex * 4 + 4);

        assertNear(weights[0] + weights[1] + weights[2] + weights[3], 1, 1e-5);
      }
    });
  });
});
