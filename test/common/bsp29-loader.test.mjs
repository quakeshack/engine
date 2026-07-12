import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Mod.ts imports BSP29Loader before BSP2Loader, establishing the evaluation
// order the two classes' `extends` relationship depends on. Importing it
// first here avoids a TDZ error from importing BSP2Loader directly.
await import('../../source/engine/common/Mod.ts');
const { BSP2Loader } = await import('../../source/engine/common/model/loaders/BSP2Loader.ts');
import { eventBus, registry } from '../../source/engine/registry.ts';
import COMClass from '../../source/engine/common/Com.ts';

/**
 * Temporarily install a mocked registry (COM/Con/isDedicatedServer) and
 * publish `registry.frozen` so module-level bindings pick up the mock, then
 * restore the previous registry afterward.
 * @param {{isDedicatedServer?: boolean, COM?: object, Con?: object}} overrides registry overrides
 * @param {() => Promise<void>} callback test body to run under the mock
 */
async function withMockedRegistry(overrides, callback) {
  const previousRegistry = {
    COM: registry.COM,
    Con: registry.Con,
    isDedicatedServer: registry.isDedicatedServer,
  };

  Object.assign(registry, overrides);
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    Object.assign(registry, previousRegistry);
    eventBus.publish('registry.frozen');
  }
}

/**
 * Read a real BSP2 fixture from data/id1/maps/ into an ArrayBuffer. All local
 * test fixtures are BSP2-format, which shares BSP29Loader's `load()` and
 * `models` lump handling via inheritance (BSP2Loader only overrides the
 * lump strides that differ between the two formats).
 * @param {string} mapName map file name, e.g. 'test_clip.bsp'
 * @returns {Promise<ArrayBuffer>} the raw file contents
 */
async function readFixtureBuffer(mapName) {
  const baseUrl = new URL('../../data/id1/maps/', import.meta.url);
  const data = await fs.readFile(new URL(mapName, baseUrl));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Overwrite the world model (model 0) bounds in the raw "models" lump with an
 * infinite bounding box, mirroring the corrupt output observed from some
 * third-party BSP2 qbsp builds (the models lump layout is identical between
 * BSP29 and BSP2).
 * @param {ArrayBuffer} buffer raw BSP file contents, mutated in place
 */
function corruptWorldModelBounds(buffer) {
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

void describe('BSP29Loader (shared load() logic, exercised via BSP2Loader fixtures)', () => {
  void describe('model bounds recovery', () => {
    void test('recomputes mins/maxs from vertex data when the models lump has infinite bounds', async () => {
      const buffer = await readFixtureBuffer('test_clip.bsp');
      corruptWorldModelBounds(buffer);

      const warnings = [];

      await withMockedRegistry({
        isDedicatedServer: true,
        Con: {
          Print() {},
          DPrint() {},
          PrintWarning(message) { warnings.push(message); },
          PrintError(...args) { console.error(...args); },
          PrintSuccess() {},
        },
        COM: {
          Parse: COMClass.Parse,
          ParseEntityLump: COMClass.ParseEntityLump,
          LoadFile() { return Promise.resolve(null); },
          LoadTextFile() { return Promise.resolve(null); },
        },
      }, async () => {
        const loader = new BSP2Loader();
        const model = await loader.load(buffer, 'maps/test_clip.bsp');

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
    });

    void test('keeps the lump-provided mins/maxs when bounds are already finite', async () => {
      const buffer = await readFixtureBuffer('test_clip.bsp');
      const warnings = [];

      await withMockedRegistry({
        isDedicatedServer: true,
        Con: {
          Print() {},
          DPrint() {},
          PrintWarning(message) { warnings.push(message); },
          PrintError(...args) { console.error(...args); },
          PrintSuccess() {},
        },
        COM: {
          Parse: COMClass.Parse,
          ParseEntityLump: COMClass.ParseEntityLump,
          LoadFile() { return Promise.resolve(null); },
          LoadTextFile() { return Promise.resolve(null); },
        },
      }, async () => {
        const loader = new BSP2Loader();
        const model = await loader.load(buffer, 'maps/test_clip.bsp');

        assert.equal(model.mins.isInfinite(), false);
        assert.equal(model.maxs.isInfinite(), false);
        assert.equal(warnings.length, 0);
      });
    });
  });
});
