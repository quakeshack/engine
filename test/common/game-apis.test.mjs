import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveTypes, solid } from '../../source/shared/Defs.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { ClientEngineAPI, ServerEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { ServerEdict } from '../../source/engine/server/Edict.ts';
import { ServerArea } from '../../source/engine/server/physics/ServerArea.ts';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.ts';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

/**
 * @param {number} num entity number
 * @param {Vector} origin entity origin
 * @param {Vector} mins entity minimum bounds
 * @param {Vector} maxs entity maximum bounds
 * @returns {ClientEdict} configured client entity fixture
 */
function createClientTraceEntity(num, origin, mins, maxs) {
  const entity = new ClientEdict(num);
  entity.origin.set(origin);
  entity.mins.set(mins);
  entity.maxs.set(maxs);
  entity.solid = solid.SOLID_BBOX;
  entity.modelindex = 0;
  entity.model = {
    mins: mins.copy(),
    maxs: maxs.copy(),
  };
  return entity;
}

void describe('ClientEngineAPI.Traceline', () => {
  void test('keeps the default client trace static-world only', () => {
    let clipMoveCalls = 0;

    void withMockRegistry(defaultMockRegistry({
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
        clipMoveToEntity() {
          clipMoveCalls += 1;
          return CollisionTrace.empty(Vector.origin);
        },
      },
    }, {
      state: {
        clientEntities: {
          *getEntities() {
          },
        },
      },
    }), () => {
      const trace = ClientEngineAPI.Traceline(new Vector(), new Vector(128, 0, 0));

      assert.equal(trace.fraction, 1.0);
      assert.equal(trace.entity, null);
      assert.equal(clipMoveCalls, 0);
    });
  });

  void test('can trace current client entities on demand', () => {
    const collision = new ServerCollision();
    const area = new ServerArea();
    area.initBoxHull();

    const target = createClientTraceEntity(
      2,
      new Vector(64, 0, 0),
      new Vector(-16, -16, -24),
      new Vector(16, 16, 32),
    );

    void withMockRegistry(defaultMockRegistry({
      area,
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
        clipMoveToEntity: collision.clipMoveToEntity.bind(collision),
      },
    }, {
      state: {
        clientEntities: {
          *getEntities() {
            yield target;
          },
        },
      },
    }), () => {
      const trace = ClientEngineAPI.Traceline(
        new Vector(0, 0, 0),
        new Vector(128, 0, 0),
        { includeEntities: true },
      );

      assert.ok(trace.fraction < 1.0);
      assert.equal(trace.entity, target);
    });
  });

  void test('supports skipping and filtering client trace candidates', () => {
    const collision = new ServerCollision();
    const area = new ServerArea();
    area.initBoxHull();

    const skipped = createClientTraceEntity(
      1,
      new Vector(48, 0, 0),
      new Vector(-16, -16, -24),
      new Vector(16, 16, 32),
    );
    const filtered = createClientTraceEntity(
      2,
      new Vector(80, 0, 0),
      new Vector(-16, -16, -24),
      new Vector(16, 16, 32),
    );

    void withMockRegistry(defaultMockRegistry({
      area,
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
        clipMoveToEntity: collision.clipMoveToEntity.bind(collision),
      },
    }, {
      state: {
        clientEntities: {
          *getEntities() {
            yield skipped;
            yield filtered;
          },
        },
      },
    }), () => {
      const trace = ClientEngineAPI.Traceline(
        new Vector(0, 0, 0),
        new Vector(128, 0, 0),
        {
          includeEntities: true,
          passEntityId: 1,
          filter: (entity) => entity.num === 2,
        },
      );

      assert.ok(trace.fraction < 1.0);
      assert.equal(trace.entity, filtered);
    });
  });
});

void describe('ServerEngineAPI.Traceline', () => {
  void test('calls collision.move with the collision instance bound as this', () => {
    const collision = {
      calls: [],
      move(start, mins, maxs, end, type, passedict) {
        this.calls.push({ start, mins, maxs, end, type, passedict });
        return CollisionTrace.empty(end);
      },
    };

    void withMockRegistry(defaultMockRegistry({
      collision,
    }), () => {
      const trace = ServerEngineAPI.Traceline(
        new Vector(1, 2, 3),
        new Vector(4, 5, 6),
        true,
        null,
      );

      assert.equal(trace.fraction, 1.0);
    });

    assert.equal(collision.calls.length, 1);
    assert.equal(collision.calls[0].type, moveTypes.MOVE_NOMONSTERS);
    assert.deepEqual([...collision.calls[0].start], [1, 2, 3]);
    assert.deepEqual([...collision.calls[0].end], [4, 5, 6]);
  });
});

void describe('ServerEngineAPI.SpawnEntity', () => {
  void test('unwraps edict-backed initial entity references before prepareEntity', () => {
    const worldEdict = new ServerEdict(0);
    const ownerEdict = new ServerEdict(1);
    const spawnedEdict = new ServerEdict(2);
    const ownerEntity = { classname: 'player' };
    let capturedInitialData = null;

    ownerEdict.entity = ownerEntity;

    void withMockRegistry(defaultMockRegistry({
      area: {
        unlinkEdict() {},
      },
      svs: {
        maxclients: 1,
      },
      server: {
        time: 0,
        num_edicts: 2,
        edicts: [worldEdict, ownerEdict, spawnedEdict],
        gameAPI: {
          prepareEntity(_edict, _classname, initialData) {
            capturedInitialData = initialData;
            return true;
          },
          spawnPreparedEntity() {
            return true;
          },
        },
      },
    }), () => {
      const result = ServerEngineAPI.SpawnEntity('test_entity', { owner: ownerEdict });

      assert.equal(result, spawnedEdict);
    });

    assert.equal(capturedInitialData.owner, ownerEntity);
  });
});

void describe('ServerEngineAPI.Navigate', () => {
  void test('passes through a missing synchronous path as null', () => {
    void withMockRegistry(defaultMockRegistry({
      server: {
        navigation: {
          findPath() {
            return null;
          },
        },
      },
    }), () => {
      const path = ServerEngineAPI.Navigate(new Vector(1, 2, 3), new Vector(4, 5, 6));

      assert.equal(path, null);
    });
  });

  void test('passes through a missing asynchronous path as null', async () => {
    await withMockRegistry(defaultMockRegistry({
      server: {
        navigation: {
          findPathAsync() {
            return Promise.resolve(null);
          },
        },
      },
    }), async () => {
      const path = await ServerEngineAPI.NavigateAsync(new Vector(1, 2, 3), new Vector(4, 5, 6));

      assert.equal(path, null);
    });
  });
});
