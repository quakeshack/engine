import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import type Server from '../../source/engine/server/Server.ts';
import type { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import { SkeletalAnimation } from '../../source/engine/common/model/SkeletalAnimation.ts';
import { Quaternion } from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { buildIqm, createTwoJointSpec } from '../support/iqmBuilder.ts';
import { createDirectoryFiles, createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';
import { createModel, poseOf } from '../support/skeletalModels.ts';

const SQRT_HALF = Math.SQRT1_2;
const NO_SCALE = [1, 1, 1];

/**
 * @param model The model.
 * @param tag The tag's name.
 * @param frameA First frame.
 * @param frameB Second frame.
 * @param blend Weight of the second frame.
 * @returns The 7 numbers of the tag (origin, then rotation `w, x, y, z`), `null` when the model has no such tag.
 */
function sample(model: BaseModel, tag: string, frameA: number, frameB = frameA, blend = 0): number[] | null {
  const out = new Array<number>(7).fill(Number.NaN);

  return model.sampleTag(model.getTagIndex(tag), frameA, frameB, blend, out) ? out : null;
}

/**
 * @param rotation `w, x, y, z`.
 * @returns The three axes of the rotation as columns of a row-major 3×3 matrix.
 */
function axesOf(rotation: ArrayLike<number>): number[] {
  const matrix = new Float32Array(12);

  Quaternion.toMatrix3x4Into(matrix, 0, rotation, 0, [0, 0, 0], 0, [1, 1, 1], 0);

  return [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
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

void describe('tags of a skeletal model', () => {
  // root, arm 10 units along X from it (turns 90 degrees about Z in the second frame), hand 5 units along the arm
  // and scaled to half: a bone that carries scale, like the gun bone of the LibreQuake player.
  const arm = (degrees: number, scale = NO_SCALE) => poseOf([10, 0, 0], degrees, scale);
  const hand = poseOf([5, 0, 0], 0, [0.5, 0.5, 0.5]);
  const createArmModel = (armScale = NO_SCALE): IQMModel => createModel(
    [-1, 0, 1],
    [poseOf([0, 0, 0]), arm(0, armScale), hand],
    [[poseOf([0, 0, 0]), arm(0, armScale), hand], [poseOf([0, 0, 0]), arm(90, armScale), hand]],
    ['root', 'arm', 'hand'],
  );

  void describe('getTagIndex', () => {
    void test('finds a joint by its name', () => {
      const model = createArmModel();

      assert.equal(model.getTagIndex('root'), 0);
      assert.equal(model.getTagIndex('hand'), 2);
    });

    void test('is -1 for a name the model does not have and for an empty name', () => {
      const model = createArmModel();

      assert.equal(model.getTagIndex('tag_flash'), -1);
      assert.equal(model.getTagIndex(''), -1);
    });

    void test('is -1 for a model that has no tags at all, the default of every other format', () => {
      assert.equal(new BaseModel('progs/x.mdl').getTagIndex('tag_flash'), -1);
    });
  });

  void describe('sampleTag', () => {
    void test('puts a tag where the chain of its joints puts it, in the rest frame', () => {
      const tag = sample(createArmModel(), 'hand', 0)!;

      assertAllNear(tag.slice(0, 3), [15, 0, 0], 1e-6);
      assertAllNear(tag.slice(3), [1, 0, 0, 0], 1e-6);
    });

    void test('turns the tag with the parents that turn: 90 degrees about Z moves the hand and rotates it', () => {
      const tag = sample(createArmModel(), 'hand', 1)!;

      // the arm sits at (10, 0, 0) and turns, so the hand 5 units along it is at (10, 5, 0)
      assertAllNear(tag.slice(0, 3), [10, 5, 0], 1e-5);
      assertAllNear(tag.slice(3), [SQRT_HALF, 0, 0, SQRT_HALF], 1e-5);
    });

    void test('interpolates the way the vertices do: halfway is 45 degrees', () => {
      const tag = sample(createArmModel(), 'hand', 0, 1, 0.5)!;

      assertAllNear(tag.slice(0, 3), [10 + 5 * SQRT_HALF, 5 * SQRT_HALF, 0], 1e-5);
      assertAllNear(tag.slice(3), [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)], 1e-5);
    });

    void test('is rigid: the scale of the bone does not leave the tag stretched', () => {
      const tag = sample(createArmModel(), 'hand', 0)!;
      const axes = axesOf(tag.slice(3));

      // unit length axes at right angles, whatever the 0.5 on the hand did to its matrix
      assertNear(Math.hypot(axes[0], axes[3], axes[6]), 1, 1e-6);
      assertNear(Math.hypot(axes[1], axes[4], axes[7]), 1, 1e-6);
      assertNear(axes[0] * axes[1] + axes[3] * axes[4] + axes[6] * axes[7], 0, 1e-6);
      assertNear(Math.hypot(...tag.slice(3)), 1, 1e-6);
    });

    void test('keeps the turn of a joint whose parent is stretched along one axis, the shear dropped', () => {
      // A parent stretched 2 times along X with a child turned 45 degrees: the child's matrix is S * R, whose columns
      // are not at right angles any more. The first axis is the child's own X axis as the stretch bends it, which
      // points at atan2(sin 45, 2 cos 45) = 26.565 degrees; the rest is made orthonormal around it.
      const model = createModel(
        [-1, 0],
        [poseOf([0, 0, 0], 0, [2, 1, 1]), poseOf([0, 0, 0], 45)],
        [[poseOf([0, 0, 0], 0, [2, 1, 1]), poseOf([0, 0, 0], 45)]],
        ['parent', 'child'],
      );

      const tag = sample(model, 'child', 0)!;
      const axes = axesOf(tag.slice(3));
      const expectedAngle = Math.atan2(SQRT_HALF, 2 * SQRT_HALF);

      assertNear(axes[0], Math.cos(expectedAngle), 1e-5);
      assertNear(axes[3], Math.sin(expectedAngle), 1e-5);
      assertNear(Math.hypot(...tag.slice(3)), 1, 1e-6);
      assertNear(axes[0] * axes[1] + axes[3] * axes[4] + axes[6] * axes[7], 0, 1e-5);
    });

    void test('a bone scaled to nothing gives the identity instead of NaN', () => {
      const model = createModel([-1], [poseOf([3, 4, 5], 0, [0, 0, 0])], [[poseOf([3, 4, 5], 0, [0, 0, 0])]], ['flat']);

      const tag = sample(model, 'flat', 0)!;

      assertAllNear(tag, [3, 4, 5, 1, 0, 0, 0], 1e-6);
    });

    void test('says no for an index that is no tag and leaves the result alone', () => {
      const model = createArmModel();
      const out = [7, 7, 7, 7, 7, 7, 7];

      for (const index of [-1, 3, 99, 1.5, Number.NaN]) {
        assert.equal(model.sampleTag(index, 0, 0, 0, out), false);
      }

      assert.deepEqual(out, [7, 7, 7, 7, 7, 7, 7]);
    });

    void test('clamps frames and blend like the vertices, which come off the wire', () => {
      const model = createArmModel();

      assert.deepEqual(sample(model, 'hand', 99), sample(model, 'hand', 1));
      assert.deepEqual(sample(model, 'hand', -4), sample(model, 'hand', 0));
      assert.deepEqual(sample(model, 'hand', 0, 1, 9), sample(model, 'hand', 1));
    });

    void test('does not carry anything from one call into the next', () => {
      const model = createArmModel();
      const first = sample(model, 'hand', 1);

      sample(model, 'arm', 0, 1, 0.3);
      sample(createArmModel([3, 3, 3]), 'hand', 0);

      assert.deepEqual(sample(model, 'hand', 1), first);
    });
  });

  void describe('the realms and the vertices', () => {
    void test('a server, which loads a model without its mesh, answers the same as a client', async () => {
      const buffer = buildIqm(createTwoJointSpec());
      const client = await new IQMLoader(createModelLoadContext({ loadRenderData: true })).load(buffer, 'progs/a.iqm');
      const server = await new IQMLoader(createModelLoadContext({ loadRenderData: false })).load(buffer, 'progs/b.iqm');

      assert.equal(server.meshData, null);
      assert.equal(server.getTagIndex('child'), 1);
      // frame 1 turns `child` 90 degrees about Z, 10 units along X from `root`
      assertAllNear(sample(server, 'child', 1)!, [10, 0, 0, SQRT_HALF, 0, 0, SQRT_HALF], 1e-5);
      assert.deepEqual(sample(server, 'child', 0, 1, 0.5), sample(client, 'child', 0, 1, 0.5));
    });
  });

  void describe('on the LibreQuake player', () => {
    interface PoseCase {
      frameA: number;
      frameB: number;
      blend: number;
      jointMatrices: number[][];
    }

    const fixtures = new URL('../fixtures/skeletal/', import.meta.url);
    // Joint matrices worked out in float64 by qs-tools' reader (`make-player-pose-reference.py`), nothing of the engine.
    const reference = JSON.parse(readFileSync(new URL('player-pose-reference.json', fixtures), 'utf8')) as { cases: PoseCase[] };

    /**
     * @returns The player, loaded the way a server loads it.
     */
    async function loadPlayer(): Promise<IQMModel> {
      const file = await createDirectoryFiles(fixtures).LoadFile('player.iqm');

      return await new IQMLoader(createModelLoadContext({ loadRenderData: false })).load(file!, 'progs/player.iqm');
    }

    void test('every tag is where the reference puts its joint, and turned the way the reference turns it', async () => {
      const player = await loadPlayer();
      let compared = 0;

      for (const { frameA, frameB, blend, jointMatrices } of reference.cases) {
        for (let joint = 0; joint < player.jointCount; joint++) {
          const matrix = jointMatrices[joint];
          const tag = new Array<number>(7).fill(Number.NaN);

          assert.equal(player.sampleTag(joint, frameA, frameB, blend, tag), true);
          assertAllNear(tag.slice(0, 3), [matrix[3], matrix[7], matrix[11]], 1e-3);

          // Where the reference's axes are at right angles (a bone with a uniform scale), the tag's axes are those
          // axes at unit length. A bone with a shear has no such axes to compare, and the tag only has to be rigid.
          const columns = [[matrix[0], matrix[4], matrix[8]], [matrix[1], matrix[5], matrix[9]], [matrix[2], matrix[6], matrix[10]]];
          const lengths = columns.map((column) => Math.hypot(...column));
          const unit = columns.map((column, index) => column.map((value) => value / lengths[index]));
          const dots = [0, 1, 2].map((index) => unit[index][0] * unit[(index + 1) % 3][0] + unit[index][1] * unit[(index + 1) % 3][1] + unit[index][2] * unit[(index + 1) % 3][2]);

          if (dots.every((dot) => Math.abs(dot) < 1e-3)) {
            const axes = axesOf(tag.slice(3));

            for (let column = 0; column < 3; column++) {
              assertAllNear([axes[column], axes[3 + column], axes[6 + column]], unit[column], 2e-3);
            }

            compared++;
          }
        }
      }

      assert.ok(compared > reference.cases.length * 20, `only ${compared} tags had axes to compare`);
    });

    void test('a gun bone that the rig scales to 0.8 gives a tag of unit axes', async () => {
      const player = await loadPlayer();
      const gun = player.getTagIndex('playergun');
      const [{ jointMatrices }] = reference.cases;
      const matrix = jointMatrices[gun];

      // the plan's survey: playergun has a world scale of 0.8 in every sampled frame
      assertNear(Math.hypot(matrix[0], matrix[4], matrix[8]), 0.8, 0.02);

      const tag = sample(player, 'playergun', reference.cases[0].frameA)!;
      const axes = axesOf(tag.slice(3));

      assertNear(Math.hypot(axes[0], axes[3], axes[6]), 1, 1e-5);
      assertNear(Math.hypot(...tag.slice(3)), 1, 1e-5);
    });

    void test('lies where the joint matrices of the pose put it, at a fraction between two frames', async () => {
      // The tag and the vertices have to move together or a weapon drifts off the hand: both come from the same
      // interpolation, so they agree to the last bit the float32 composition keeps.
      const player = await loadPlayer();
      const joints = new Float32Array(player.jointCount * SkeletalAnimation.MATRIX_FLOATS);

      SkeletalAnimation.computePose(player, 19, 20, 0.35, joints, null);

      for (let joint = 0; joint < player.jointCount; joint++) {
        const tag = new Array<number>(7).fill(Number.NaN);

        player.sampleTag(joint, 19, 20, 0.35, tag);

        assertAllNear(tag.slice(0, 3), [joints[joint * 12 + 3], joints[joint * 12 + 7], joints[joint * 12 + 11]], 1e-5);
      }
    });

    void test('names the equipment bones of the rig, which Phase 7 renames to tags', async () => {
      const player = await loadPlayer();

      assert.ok(player.getTagIndex('playergun') >= 0);
      assert.ok(player.getTagIndex('flash') >= 0);
      assert.ok(player.getTagIndex('playeraxe') >= 0);
      assert.equal(player.getTagIndex('tag_flash'), -1);
    });
  });
});

void describe('ServerEngineAPI.GetTagIndex', () => {
  /**
   * @returns The API of a server whose map has loaded the player (without its mesh, as a server loads it) and a model with no tags.
   */
  async function createServerApi(): Promise<ServerEngineAPI> {
    const mod = new Mod();

    mod.Init({ files: createDirectoryFiles(new URL('../fixtures/skeletal/', import.meta.url)), con: createSilentConsole(), loadRenderData: false });
    await mod.ForNameAsync('player.iqm', true, ModelScope.server);
    mod.known['progs/plain.mdl'] = new BaseModel('progs/plain.mdl');
    mod.serverKnown['progs/plain.mdl'] = mod.known['progs/plain.mdl'];

    const server = { modelPrecache: ['', 'player.iqm', 'progs/plain.mdl'], modelPrecacheFlags: [], models: [] };

    return new ServerEngineAPI({ server, mod } as unknown as Server, () => ({ registered: true, hipnotic: false, rogue: false }));
  }

  void test('finds the joints of a skeletal model, the same on the server as the client sees them', async () => {
    const api = await createServerApi();

    assert.equal(api.GetTagIndex('player.iqm', 'playergun'), 22);
    assert.equal(api.GetTagIndex('player.iqm', 'flash'), 23);
  });

  void test('is -1 for a name the model does not have, and for a model that has no tags', async () => {
    const api = await createServerApi();

    assert.equal(api.GetTagIndex('player.iqm', 'tag_weapon'), -1);
    assert.equal(api.GetTagIndex('progs/plain.mdl', 'tag_weapon'), -1);
  });

  void test('fails for a model that was not precached', async () => {
    const api = await createServerApi();

    assert.throws(() => api.GetTagIndex('progs/missing.iqm', 'tag_weapon'), /not precached/);
  });
});

