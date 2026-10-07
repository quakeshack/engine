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
});
