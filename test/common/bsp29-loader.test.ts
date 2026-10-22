import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Mod.ts imports BSP29Loader before BSP2Loader, establishing the evaluation
// order the two classes' `extends` relationship depends on. Importing it
// first here avoids a TDZ error from importing BSP2Loader directly.
import '../../source/engine/common/Mod.ts';
import { BSP2Loader } from '../../source/engine/common/model/loaders/BSP2Loader.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';
import { createRandom } from '../support/pmoveDeterminism.ts';
import Vector from '../../source/shared/Vector.ts';

/**
 * Read a real BSP2 fixture from data/id1/maps/ into an ArrayBuffer. All local
 * test fixtures are BSP2-format, which shares BSP29Loader's `load()` and
 * `models` lump handling via inheritance (BSP2Loader only overrides the
 * lump strides that differ between the two formats).
 * @param mapName Map file name, e.g. 'test_clip.bsp'.
 * @returns The raw file contents.
 */
async function readFixtureBuffer(mapName: string): Promise<ArrayBuffer> {
  const baseUrl = new URL('../../data/id1/maps/', import.meta.url);
  const data = await fs.readFile(new URL(mapName, baseUrl));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Overwrite the world model (model 0) bounds in the raw "models" lump with an
 * infinite bounding box, mirroring the corrupt output observed from some
 * third-party BSP2 qbsp builds (the models lump layout is identical between
 * BSP29 and BSP2).
 * @param buffer Raw BSP file contents, mutated in place.
 */
function corruptWorldModelBounds(buffer: ArrayBuffer): void {
  const modelsLumpIndex = 14;
  const view = new DataView(buffer);
  const fileofs = view.getUint32((modelsLumpIndex << 3) + 4, true);

  view.setFloat32(fileofs, -Infinity, true);
  view.setFloat32(fileofs + 4, -Infinity, true);
  view.setFloat32(fileofs + 8, -Infinity, true);
  view.setFloat32(fileofs + 12, Infinity, true);
  view.setFloat32(fileofs + 16, Infinity, true);
  view.setFloat32(fileofs + 20, Infinity, true);
}

/**
 * Builds a loader that records the warnings it prints.
 * @param warnings Where the warnings are collected.
 * @returns A BSP2 loader, which shares BSP29Loader's `load()`.
 */
function createWarningLoader(warnings: string[]): BSP2Loader {
  return new BSP2Loader(createModelLoadContext({ con: createSilentConsole({ PrintWarning(message: string) { warnings.push(message); } }) }));
}

void describe('BSP29Loader (shared load() logic, exercised via BSP2Loader fixtures)', () => {
  void describe('model bounds recovery', () => {
    void test('recomputes mins/maxs from vertex data when the models lump has infinite bounds', async () => {
      const buffer = await readFixtureBuffer('test_clip.bsp');
      corruptWorldModelBounds(buffer);

      const warnings: string[] = [];
      const model = await createWarningLoader(warnings).load(buffer, 'maps/test_clip.bsp') as BrushModel;

      assert.equal(model.mins.isInfinite(), false);
      assert.equal(model.maxs.isInfinite(), false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /invalid model bounds/);

      let expectedMinX = Infinity;
      let expectedMinY = Infinity;
      let expectedMinZ = Infinity;
      let expectedMaxX = -Infinity;
      let expectedMaxY = -Infinity;
      let expectedMaxZ = -Infinity;

      for (const vert of model.vertexes) {
        expectedMinX = Math.min(expectedMinX, vert[0]);
        expectedMinY = Math.min(expectedMinY, vert[1]);
        expectedMinZ = Math.min(expectedMinZ, vert[2]);
        expectedMaxX = Math.max(expectedMaxX, vert[0]);
        expectedMaxY = Math.max(expectedMaxY, vert[1]);
        expectedMaxZ = Math.max(expectedMaxZ, vert[2]);
      }

      assert.deepEqual([...model.mins], [expectedMinX, expectedMinY, expectedMinZ]);
      assert.deepEqual([...model.maxs], [expectedMaxX, expectedMaxY, expectedMaxZ]);
    });

    void test('keeps the lump-provided mins/maxs when bounds are already finite', async () => {
      const buffer = await readFixtureBuffer('test_clip.bsp');
      const warnings: string[] = [];
      const model = await createWarningLoader(warnings).load(buffer, 'maps/test_clip.bsp') as BrushModel;

      assert.equal(model.mins.isInfinite(), false);
      assert.equal(model.maxs.isInfinite(), false);
      assert.equal(warnings.length, 0);
    });
  });

  void describe('collision hulls', () => {
    /**
     *
     */
    /**
     * Loads the clip test map.
     * @returns The model.
     */
    async function loadClipMap(): Promise<BrushModel> {
      const buffer = await readFixtureBuffer('test_clip.bsp');

      return await createWarningLoader([]).load(buffer, 'maps/test_clip.bsp') as BrushModel;
    }

    void test('the plane table holds the planes of the plane lump, in order', async () => {
      const model = await loadClipMap();

      assert.ok(model.planeTable.count > 0);
      assert.ok(model.planes.length >= model.planeTable.count);

      for (let index = 0; index < model.planeTable.count; index++) {
        const plane = model.planes[index];

        assert.deepEqual([...model.planeTable.normals.subarray(index * 3, index * 3 + 3)], [...plane.normal], `plane ${index}`);
        assert.equal(model.planeTable.dists[index], plane.dist, `plane ${index}`);
        assert.equal(model.planeTable.types[index], plane.type, `plane ${index}`);
        assert.equal(model.planeTable.signbits[index], plane.signbits, `plane ${index}`);
      }
    });

    void test('the standing and large hulls share the plane table and the clip tree of the model', async () => {
      const model = await loadClipMap();

      assert.equal(model.hulls.length, 3);

      for (const hull of [model.hulls[1], model.hulls[2]]) {
        assert.equal(hull.planes, model.planeTable);
        assert.equal(hull.tree, model.clipTree);
        assert.equal(hull.lastClipNode, model.clipTree.count - 1);
      }

      assert.deepEqual([...model.hulls[1].clipMins], [-16, -16, -24]);
      assert.deepEqual([...model.hulls[1].clipMaxs], [16, 16, 32]);
      assert.deepEqual([...model.hulls[2].clipMins], [-32, -32, -24]);
      assert.deepEqual([...model.hulls[2].clipMaxs], [32, 32, 64]);
    });

    void test('the point hull is the node tree of the model, with the contents of the leafs for children', async () => {
      const model = await loadClipMap();
      const hull = model.hulls[0];

      assert.equal(hull.planes, model.planeTable);
      assert.equal(hull.tree.count, model.nodeTable.count);

      for (let index = 0; index < model.nodeTable.count; index++) {
        assert.equal(hull.tree.planeNums[index], model.nodeTable.planeNums[index]);

        for (let side = 0; side < 2; side++) {
          const child = model.nodeTable.children[index * 2 + side];
          const expected = child >= 0 ? child : model.leafTable.contents[~child];

          assert.equal(hull.tree.children[index * 2 + side], expected, `node ${index}, side ${side}`);
        }
      }
    });

    void test('the point hull and the node tree say the same about every point', async () => {
      const model = await loadClipMap();
      const random = createRandom(0x5eed);

      for (let sample = 0; sample < 2000; sample++) {
        const point = new Vector(
          model.mins[0] + random() * (model.maxs[0] - model.mins[0]),
          model.mins[1] + random() * (model.maxs[1] - model.mins[1]),
          model.mins[2] + random() * (model.maxs[2] - model.mins[2]),
        );

        assert.equal(model.hulls[0].pointContents(point), model.leafTable.contents[model.getLeafIndexForPoint(point)], `point ${[...point]}`);
      }
    });

    void test('the hulls of the world are limited to their own subtree', async () => {
      const model = await loadClipMap();

      for (const hull of model.hulls) {
        assert.ok(hull.allowedClipNodes !== null);
        assert.equal(hull.allowedClipNodes[hull.firstClipNode], 1);
      }
    });

    void test('the hulls of an inline model share the data of the world and only start at nodes of their own', async () => {
      const buffer = await readFixtureBuffer('test_trans_1.bsp');
      const model = await createWarningLoader([]).load(buffer, 'maps/test_trans_1.bsp') as BrushModel;

      assert.ok(model.submodels.length > 0);

      for (const submodel of model.submodels) {
        assert.equal(submodel.hulls.length, 3);
        assert.equal(submodel.planeTable, model.planeTable);
        assert.equal(submodel.clipTree, model.clipTree);
        assert.equal(submodel.hulls[0].tree, model.hulls[0].tree);
        assert.equal(submodel.hulls[1].tree, model.clipTree);
        assert.equal(submodel.hulls[2].planes, model.planeTable);

        // a model without a hull of a size has no root for it, and then no mask
        for (const hull of submodel.hulls) {
          if (hull.allowedClipNodes !== null) {
            assert.equal(hull.allowedClipNodes[hull.firstClipNode], 1);
          }
        }
      }

      assert.ok(model.submodels.some((submodel) => submodel.hulls.some((hull) => hull.allowedClipNodes !== null)));
    });
  });
});
