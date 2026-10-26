import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { BrushModel } from '../../source/engine/common/Mod.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { clientCollision } from '../../source/engine/client/ClientPhysics.ts';
import Server from '../../source/engine/server/Server.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import { createDeterminismWorld } from '../support/pmoveDeterminism.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';
import { ServerCollisionModelSource } from '../../source/engine/server/physics/ServerCollisionModelSource.ts';

/**
 * Builds a server with the state the model source reads.
 * @returns A server with no map.
 */
function createServerState(): { server: { edicts: ServerEdict[]; worldmodel: BrushModel | null; models: Array<BaseModel | null | Promise<BaseModel | null>> } } {
  return { server: { edicts: [], worldmodel: null, models: [] } };
}

void describe('ServerCollisionModelSource', () => {
  void test('knows nothing before a map is loaded', () => {
    const source = new ServerCollisionModelSource(createServerState());

    assert.equal(source.getWorldEntity(), null);
    assert.equal(source.getWorldModel(), null);
    assert.equal(source.getModelByIndex(1), null);
  });

  void test('answers with the world entity, world model and models of the server', () => {
    const sv = createServerState();
    const source = new ServerCollisionModelSource(sv);
    const worldEntity = { num: 0 } as unknown as ServerEdict;
    const world = new BrushModel('maps/start.bsp');
    const door = new BrushModel('*1');

    sv.server.edicts = [worldEntity];
    sv.server.worldmodel = world;
    sv.server.models = [null, world, door];

    assert.equal(source.getWorldEntity(), worldEntity);
    assert.equal(source.getWorldModel(), world);
    assert.equal(source.getModelByIndex(1), world);
    assert.equal(source.getModelByIndex(2), door);
    assert.equal(source.getModelByIndex(3), null, 'an index past the precache is no model');
  });

  void test('treats a model that is still loading as no model', () => {
    const sv = createServerState();
    const source = new ServerCollisionModelSource(sv);

    sv.server.models = [null, Promise.resolve(new BrushModel('*1'))];

    assert.equal(source.getModelByIndex(1), null);
  });

  void test('follows a map change, which replaces what the server holds', () => {
    const sv = createServerState();
    const source = new ServerCollisionModelSource(sv);
    const first = new BrushModel('maps/start.bsp');
    const second = new BrushModel('maps/e1m1.bsp');

    sv.server.worldmodel = first;
    assert.equal(source.getWorldModel(), first);

    sv.server = { edicts: [], worldmodel: second, models: [null, second] };
    assert.equal(source.getWorldModel(), second);
    assert.equal(source.getModelByIndex(1), second);
  });
});

void describe('a Server and the client in one thread', () => {
  /**
   * Builds a server over silent stand-ins.
   * @returns A server that has not spawned a map.
   */
  function createServer(): Server {
    const silent = (): void => {};
    const dependencies: ServerDependencies = {
      con: { Print: silent, DPrint: silent, PrintWarning: silent, PrintError: silent, PrintSuccess: silent, StartCapturing: silent, StopCapturing: () => '' },
      sys: { Print: silent, FloatTime: () => 0 },
      net: {} as ServerDependencies['net'],
      mod: {} as ServerDependencies['mod'],
      view: { CalcRoll: () => 0 },
      files: { LoadFile: () => Promise.resolve(null), WriteGeneratedFile: () => Promise.resolve(true) },
      engineVersion: () => 'test',
      gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }),
      dedicated: true,
    };

    return new Server(dependencies);
  }

  // The in-thread server used to share one model source with the client, which fell back to the client's world and
  // models whenever the server had none (a map still loading, a model slot not filled yet).
  void test('the server does not see the world the client loaded', () => {
    const sv = createServer();
    const inTheFloor = new Vector(0, 0, -8);
    const previous = clientRuntimeState.worldmodel;

    clientRuntimeState.worldmodel = createDeterminismWorld();

    try {
      assert.equal(clientCollision.pointContents(inTheFloor), content.CONTENT_SOLID, 'the client sees its own world');
      assert.equal(sv.collision.staticWorldContents(inTheFloor), content.CONTENT_EMPTY, 'the server has no world yet');
      assert.equal(sv.collision.traceStaticWorldLine(new Vector(0, 0, 24), new Vector(0, 0, -100)).fraction, 1.0);
    } finally {
      clientRuntimeState.worldmodel = previous;
    }
  });
});
