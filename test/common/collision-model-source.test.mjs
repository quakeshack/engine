import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import CollisionModelSource, { createRegistryCollisionModelSource } from '../../source/engine/common/CollisionModelSource.ts';
import { createBoxBrushModel, defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

void describe('CollisionModelSource', () => {
  void test('uses injected server accessors before client fallbacks', () => {
    const source = new CollisionModelSource();
    const worldEntity = { num: 0 };
    const worldModel = createBoxBrushModel({ name: 'server-world', halfExtents: [16, 16, 16] });
    const clientWorldModel = createBoxBrushModel({ name: 'client-world', halfExtents: [24, 24, 24] });
    const serverModel = { name: 'server-model' };
    const clientModel = { name: 'client-model' };

    source.configureServer({
      getWorldEntity: () => worldEntity,
      getWorldModel: () => worldModel,
      getModels: () => [null, serverModel],
    });
    source.configureClient({
      getWorldModel: () => clientWorldModel,
      getModels: () => [null, clientModel],
    });

    assert.equal(source.getWorldEntity(), worldEntity);
    assert.equal(source.getWorldModel(), worldModel);
    assert.equal(source.getModelByIndex(1), serverModel);
  });

  void test('falls back to client world model and client precache when server world is unavailable', () => {
    const clientWorldModel = createBoxBrushModel({ name: 'client-world', halfExtents: [32, 32, 32] });
    const clientModel = { name: 'client-model' };

    void withMockRegistry(defaultMockRegistry({
      server: {
        edicts: [],
        worldmodel: null,
        models: null,
      },
    }, {
      state: {
        worldmodel: clientWorldModel,
        model_precache: [null, clientModel],
      },
    }), () => {
      const source = createRegistryCollisionModelSource();

      assert.equal(source.getWorldEntity(), null);
      assert.equal(source.getWorldModel(), clientWorldModel);
      assert.equal(source.getModelByIndex(1), clientModel);
    });
  });

  void test('falls back to client precache slot 1 when the client world model is missing', () => {
    const clientWorldFromPrecache = createBoxBrushModel({ name: 'client-precache-world', halfExtents: [48, 48, 48] });

    void withMockRegistry(defaultMockRegistry({
      server: {
        edicts: [],
        worldmodel: null,
        models: null,
      },
    }, {
      state: {
        worldmodel: null,
        model_precache: [null, clientWorldFromPrecache],
      },
    }), () => {
      const source = createRegistryCollisionModelSource();

      assert.equal(source.getWorldModel(), clientWorldFromPrecache);
      assert.equal(source.getModelByIndex(1), clientWorldFromPrecache);
    });
  });
});
