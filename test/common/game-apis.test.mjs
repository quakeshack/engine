import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { solid } from '../../source/shared/Defs.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.mjs';
import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.mjs';
import { ServerArea } from '../../source/engine/server/physics/ServerArea.mjs';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.mjs';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.mjs';
import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

/**
 *
 * @param num
 * @param origin
 * @param mins
 * @param maxs
 */
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

describe('ClientEngineAPI.Traceline', () => {
  test('keeps the default client trace static-world only', () => {
    let clipMoveCalls = 0;

    withMockRegistry(defaultMockRegistry({
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

  test('can trace current client entities on demand', () => {
    const collision = new ServerCollision();
    const area = new ServerArea();
    area.initBoxHull();

    const target = createClientTraceEntity(
      2,
      new Vector(64, 0, 0),
      new Vector(-16, -16, -24),
      new Vector(16, 16, 32),
    );

    withMockRegistry(defaultMockRegistry({
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

  test('supports skipping and filtering client trace candidates', () => {
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

    withMockRegistry(defaultMockRegistry({
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
