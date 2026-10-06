import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { content, solid } from '../../source/shared/Defs.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import ClientCollision from '../../source/engine/client/ClientCollision.ts';
import CollisionModelSource from '../../source/engine/common/CollisionModelSource.ts';

import { assertNear, createBrushWorldModel, createLegacyWorldModel } from '../physics/fixtures.mjs';

/**
 * Creates a client collision whose model source only knows the given client world.
 * @param {import('../../source/engine/common/model/BSP.ts').BrushModel | null} worldModel the client's world model
 * @returns {ClientCollision} the collision under test
 */
function createClientCollision(worldModel) {
  const modelSource = new CollisionModelSource();

  modelSource.configureClient({ getWorldModel: () => worldModel });

  return new ClientCollision(modelSource);
}

// A wall of 16 units thickness, centered 64 units along +x of the origin: it occupies x in [56, 72].
const WALL = { axis: 0, center: [64, 0, 0], halfExtents: [8, 8, 8] };

void describe('ClientCollision', () => {
  void describe('without a world', () => {
    void test('reports empty space at every point', () => {
      const collision = createClientCollision(null);

      assert.equal(collision.pointContents(new Vector(1, 2, 3)), content.CONTENT_EMPTY);
    });

    void test('lets a trace go the whole way', () => {
      const collision = createClientCollision(null);
      const end = new Vector(100, 0, 0);
      const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), end);

      assert.equal(trace.fraction, 1.0);
      assert.deepEqual([...trace.endpos], [100, 0, 0]);
      assert.equal(trace.ent, null);
    });
  });

  void describe('with a world that only has legacy clipnode hulls', () => {
    // A room spanning -100 to 100 on every axis, solid everywhere outside of it.
    const room = () => createLegacyWorldModel(new Vector(-100, -100, -100), new Vector(100, 100, 100));

    void test('samples contents through the hull', () => {
      const collision = createClientCollision(room());

      assert.equal(collision.pointContents(new Vector(0, 0, 0)), content.CONTENT_EMPTY);
      assert.equal(collision.pointContents(new Vector(150, 0, 0)), content.CONTENT_SOLID);
    });

    void test('traces a line through the hull and stops at the room wall', () => {
      const collision = createClientCollision(room());
      const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(200, 0, 0));

      assert.ok(trace.fraction < 1.0);
      assertNear(trace.endpos[0], 100, 0.5);
    });
  });

  void describe('pointContents', () => {
    void test('is solid inside brush geometry and empty outside of it', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));

      assert.equal(collision.pointContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
      assert.equal(collision.pointContents(new Vector(0, 0, 0)), content.CONTENT_EMPTY);
    });
  });

  void describe('traceStaticWorldLine', () => {
    void test('stops in front of a wall and reports its plane', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));
      const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(200, 0, 0));

      assert.equal(trace.allsolid, false);
      assertNear(trace.fraction, 56 / 200, 0.01);
      assertNear(trace.endpos[0], 56, 0.1);
      assert.deepEqual([...trace.plane.normal], [-1, 0, 0]);
      assert.equal(trace.ent, null, 'the client only knows the static world, there is no entity to hit');
    });

    void test('goes through open space without hitting anything', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));
      const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(0, 100, 0));

      assert.equal(trace.fraction, 1.0);
      assert.equal(trace.startsolid, false);
    });

    void test('reports a start inside solid as blocked', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));
      const trace = collision.traceStaticWorldLine(new Vector(64, 0, 0), new Vector(64, 50, 0));

      assert.equal(trace.startsolid, true);
    });

    void test('treats a zero-length trace as a position test', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));
      const inside = collision.traceStaticWorldLine(new Vector(64, 0, 0), new Vector(64, 0, 0));
      const outside = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(0, 0, 0));

      assert.equal(inside.allsolid, true);
      assert.equal(outside.allsolid, false);
      assert.equal(outside.fraction, 1.0);
    });

    void test('traceWorldLine is the same query', () => {
      const collision = createClientCollision(createBrushWorldModel(WALL));
      const start = new Vector(0, 0, 0);
      const end = new Vector(200, 0, 0);

      assert.equal(collision.traceWorldLine(start, end).fraction, collision.traceStaticWorldLine(start, end).fraction);
    });
  });

  void describe('clipMoveToEntity', () => {
    /**
     * @param {Vector} origin where the entity is
     * @returns {import('../../source/engine/client/ClientCollision.ts').ClientCollisionTarget} a box entity in the form the narrow phase takes
     */
    function createTarget(origin) {
      const entity = new ClientEdict(2);

      entity.origin.set(origin);
      entity.mins.setTo(-16, -16, -24);
      entity.maxs.setTo(16, 16, 32);
      entity.solid = solid.SOLID_BBOX;

      return { entity, num: 2, equals(other) { return this === other; } };
    }

    void test('stops a trace at a box entity without needing a server', () => {
      const collision = createClientCollision(null);
      const trace = collision.clipMoveToEntity(createTarget(new Vector(64, 0, 0)), new Vector(0, 0, 0), Vector.origin, Vector.origin, new Vector(128, 0, 0));

      // The box starts 16 units before its origin, so 48 of 128 units; a trace stops a hair before the surface.
      assertNear(trace.fraction, (64 - 16) / 128, 0.005);
      assert.ok(trace.fraction < (64 - 16) / 128);
    });

    void test('lets a trace pass an entity that is out of the way', () => {
      const collision = createClientCollision(null);
      const trace = collision.clipMoveToEntity(createTarget(new Vector(64, 200, 0)), new Vector(0, 0, 0), Vector.origin, Vector.origin, new Vector(128, 0, 0));

      assert.equal(trace.fraction, 1.0);
    });

    void test('can be asked again, the stand-in server is reused', () => {
      const collision = createClientCollision(null);
      const target = createTarget(new Vector(64, 0, 0));
      const first = collision.clipMoveToEntity(target, new Vector(0, 0, 0), Vector.origin, Vector.origin, new Vector(128, 0, 0));
      const second = collision.clipMoveToEntity(target, new Vector(0, 0, 0), Vector.origin, Vector.origin, new Vector(128, 0, 0));

      assert.equal(second.fraction, first.fraction);
    });
  });
});
