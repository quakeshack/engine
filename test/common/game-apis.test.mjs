import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveTypes, solid } from '../../source/shared/Defs.ts';
import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { ED, ServerEdict } from '../../source/engine/server/Edict.ts';
import { ServerArea } from '../../source/engine/server/physics/ServerArea.ts';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.ts';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { defaultMockEngine, withMockEngine, mockedSV, mockedCollisionModelSource } from '../physics/fixtures.mjs';

const engineApi = createClientEngineApi();

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

const serverEngineAPI = mockedSV().engineAPI;

void describe('ClientEngineAPI.Traceline', () => {
  void test('keeps the default client trace static-world only', () => {
    let clipMoveCalls = 0;

    void withMockEngine(defaultMockEngine({
      collision: {
        clipMoveToEntity() {
          clipMoveCalls += 1;
          return CollisionTrace.empty(Vector.origin);
        },
      },
    }, {
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
      },
      state: {
        clientEntities: {
          *getEntities() {
          },
        },
      },
    }), () => {
      const trace = engineApi.Traceline(new Vector(), new Vector(128, 0, 0));

      assert.equal(trace.fraction, 1.0);
      assert.equal(trace.entity, null);
      assert.equal(clipMoveCalls, 0);
    });
  });

  void test('can trace current client entities on demand', () => {
    const collision = new ServerCollision(mockedSV(), mockedCollisionModelSource());
    const area = new ServerArea(mockedSV(), mockedCollisionModelSource());
    area.initBoxHull();

    const target = createClientTraceEntity(
      2,
      new Vector(64, 0, 0),
      new Vector(-16, -16, -24),
      new Vector(16, 16, 32),
    );

    void withMockEngine(defaultMockEngine({
      area,
    }, {
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
        clipMoveToEntity: collision.clipMoveToEntity.bind(collision),
      },
      state: {
        clientEntities: {
          *getEntities() {
            yield target;
          },
        },
      },
    }), () => {
      const trace = engineApi.Traceline(
        new Vector(0, 0, 0),
        new Vector(128, 0, 0),
        { includeEntities: true },
      );

      assert.ok(trace.fraction < 1.0);
      assert.equal(trace.entity, target);
    });
  });

  void test('supports skipping and filtering client trace candidates', () => {
    const collision = new ServerCollision(mockedSV(), mockedCollisionModelSource());
    const area = new ServerArea(mockedSV(), mockedCollisionModelSource());
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

    void withMockEngine(defaultMockEngine({
      area,
    }, {
      collision: {
        traceWorldLine(_start, end) {
          return CollisionTrace.empty(end);
        },
        clipMoveToEntity: collision.clipMoveToEntity.bind(collision),
      },
      state: {
        clientEntities: {
          *getEntities() {
            yield skipped;
            yield filtered;
          },
        },
      },
    }), () => {
      const trace = engineApi.Traceline(
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

    void withMockEngine(defaultMockEngine({
      collision,
    }), () => {
      const trace = serverEngineAPI.Traceline(
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
    const worldEdict = new ServerEdict(0, mockedSV());
    const ownerEdict = new ServerEdict(1, mockedSV());
    const spawnedEdict = new ServerEdict(2, mockedSV());
    const ownerEntity = { classname: 'player' };
    let capturedInitialData = null;

    ownerEdict.entity = ownerEntity;

    void withMockEngine(defaultMockEngine({
      ed: new ED(mockedSV()),
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
      const result = serverEngineAPI.SpawnEntity('test_entity', { owner: ownerEdict });

      assert.equal(result, spawnedEdict);
    });

    assert.equal(capturedInitialData.owner, ownerEntity);
  });
});

void describe('ServerEngineAPI.Navigate', () => {
  void test('passes through a missing synchronous path as null', () => {
    void withMockEngine(defaultMockEngine({
      server: {
        navigation: {
          findPath() {
            return null;
          },
        },
      },
    }), () => {
      const path = serverEngineAPI.Navigate(new Vector(1, 2, 3), new Vector(4, 5, 6));

      assert.equal(path, null);
    });
  });

  void test('passes through a missing asynchronous path as null', async () => {
    await withMockEngine(defaultMockEngine({
      server: {
        navigation: {
          findPathAsync() {
            return Promise.resolve(null);
          },
        },
      },
    }), async () => {
      const path = await serverEngineAPI.NavigateAsync(new Vector(1, 2, 3), new Vector(4, 5, 6));

      assert.equal(path, null);
    });
  });
});

void describe('ClientEngineAPI.SpawnClientEntity', () => {
  /**
   * @param {() => void} callback runs with a real ClientEntities as `CL.state.clientEntities`
   */
  function withClientEntities(callback) {
    const clientEntities = new ClientEntities();
    const previousModule = GameModule.active;

    GameModule.active = {
      identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
      ClientGameAPI: { GetClientEdictHandler: () => null },
    };

    try {
      void withMockEngine(defaultMockEngine({}, { state: { clientEntities } }), () => {
        callback(clientEntities);
      });
    } finally {
      GameModule.active = previousModule;
    }
  }

  void test('spawns a persistent client-only entity by default', () => {
    withClientEntities((clientEntities) => {
      const entity = engineApi.SpawnClientEntity('test_debris');

      assert.equal(entity.classname, 'test_debris');
      assert.equal(entity.persistent, true);
      assert.equal(entity.isClientOwned(), true);
      assert.deepEqual([...clientEntities.getEntities()], [entity]);
    });
  });

  void test('spawns a non-persistent entity on request', () => {
    withClientEntities(() => {
      const entity = engineApi.SpawnClientEntity('test_decoration', { persistent: false });

      assert.equal(entity.persistent, false);
    });
  });
});

void describe('ClientEngineAPI.DetermineStaticWorldContents', () => {
  void test('asks the static world collision of the client for the contents at the point', () => {
    const queried = [];

    void withMockEngine(defaultMockEngine({}, {
      collision: {
        pointContents(point) {
          queried.push([...point]);
          return -3;
        },
      },
    }), () => {
      assert.equal(engineApi.DetermineStaticWorldContents(new Vector(1, 2, 3)), -3);
      assert.deepEqual(queried, [[1, 2, 3]]);
    });
  });
});

void describe('ClientEngineAPI.IsInPVS', () => {
  void test('asks the client entities whether the entity is in the PVS of the current view', () => {
    const entity = new ClientEdict(-1);
    const asked = [];

    void withMockEngine(defaultMockEngine({}, {
      state: {
        clientEntities: {
          isPotentiallyVisible(candidate) {
            asked.push(candidate);
            return false;
          },
        },
      },
    }), () => {
      assert.equal(engineApi.IsInPVS(entity), false);
      assert.deepEqual(asked, [entity]);
    });
  });
});
