import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BrushModel, ModelType } from '../../source/engine/common/Mod.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { ClientCollisionModelSource } from '../../source/engine/client/ClientCollisionModelSource.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';

/**
 * Builds a brush model whose type is set, which is what the loaders do.
 * @returns A brush model.
 */
function createBrushModel(name: string): BrushModel {
  const model = new BrushModel(name);

  model.type = ModelType.brush;

  return model;
}

/**
 * Builds the state a source reads, with the models given.
 * @returns A client state with the world model and precache.
 */
function createState(worldmodel: BrushModel | null, models: Array<BrushModel | null>): { worldmodel: BrushModel | null; model_precache: BaseModel[] } {
  return { worldmodel, model_precache: models as unknown as BaseModel[] };
}

void describe('ClientCollisionModelSource', () => {
  void test('has no world entity, a client has none of the server', () => {
    assert.equal(new ClientCollisionModelSource(() => createState(null, [])).getWorldEntity(), null);
  });

  void test('answers with the world model and models the client loaded', () => {
    const world = createBrushModel('maps/start.bsp');
    const door = createBrushModel('*1');
    const source = new ClientCollisionModelSource(() => createState(world, [null, world, door]));

    assert.equal(source.getWorldModel(), world);
    assert.equal(source.getModelByIndex(2), door);
    assert.equal(source.getModelByIndex(0), null);
    assert.equal(source.getModelByIndex(9), null);
  });

  void test('takes the first precached model for the world while the world model is not set and that is a brush model', () => {
    const world = createBrushModel('maps/start.bsp');

    assert.equal(new ClientCollisionModelSource(() => createState(null, [null, world])).getWorldModel(), world);
  });

  void test('has no world when nothing is loaded', () => {
    assert.equal(new ClientCollisionModelSource(() => createState(null, [])).getWorldModel(), null);
  });

  void test('follows what the client state holds now, which a map change replaces', () => {
    const first = createBrushModel('maps/start.bsp');
    const second = createBrushModel('maps/e1m1.bsp');
    const state = { worldmodel: first as BrushModel | null, model_precache: [] as BaseModel[] };
    const source = new ClientCollisionModelSource(() => state);

    assert.equal(source.getWorldModel(), first);

    state.worldmodel = second;
    assert.equal(source.getWorldModel(), second);
  });

  void test('is what the page\'s collision uses, and it reads the client state', () => {
    const world = createBrushModel('maps/start.bsp');
    const previous = clientRuntimeState.worldmodel;

    clientRuntimeState.worldmodel = world;

    try {
      assert.equal(new ClientCollisionModelSource(() => clientRuntimeState).getWorldModel(), world);
    } finally {
      clientRuntimeState.worldmodel = previous;
    }
  });
});
