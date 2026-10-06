import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { content, moveType } from '../../source/shared/Defs.ts';
import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import ClientEntityPhysics from '../../source/engine/client/ClientEntityPhysics.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';

import { assertNear } from '../physics/fixtures.mjs';

/**
 * A world trace result matching `CollisionTrace`'s shape.
 * @param {Vector} end where the trace ended
 * @param {{fraction?: number, normal?: Vector, allsolid?: boolean}} options hit details
 * @returns {object} a CollisionTrace-shaped mock trace
 */
function worldTrace(end, { fraction = 1.0, normal = new Vector(), allsolid = false } = {}) {
  return {
    fraction,
    allsolid,
    startsolid: allsolid,
    endpos: end.copy(),
    plane: { normal, dist: 0 },
    inopen: true,
    inwater: false,
    ent: null,
  };
}

/**
 * A world with nothing in it.
 * @returns {(start: Vector, end: Vector) => object} a traceWorldLine() mock
 */
function emptyWorld() {
  return (_start, end) => worldTrace(end);
}

/**
 * A world with a single horizontal floor at world Z = floorZ. A traced segment that would cross it
 * is clipped to the plane intersection, as a real world trace does.
 * @param {number} floorZ height of the floor
 * @returns {(start: Vector, end: Vector) => object} a traceWorldLine() mock
 */
function floorWorld(floorZ) {
  return (start, end) => {
    if (end[2] >= floorZ) {
      return worldTrace(end);
    }

    const fraction = (floorZ - start[2]) / (end[2] - start[2]);
    const point = start.copy().add(end.copy().subtract(start).multiply(fraction));

    return worldTrace(point, { fraction, normal: new Vector(0, 0, 1) });
  };
}

/**
 * Runs a callback with the registry parts the engine physics reads installed.
 * @param {{gravity?: number, paused?: boolean, worldmodel?: object|null, frametime?: number, trace: (start: Vector, end: Vector) => object}} world the world to run in
 * @param {() => void} callback
 */
function withWorld({ gravity = 800, paused = false, worldmodel = { nodes: [{ contents: content.CONTENT_EMPTY, num: 0 }] }, frametime = 0.1, trace }, callback) {
  const previous = { CL: registry.CL, Host: registry.Host };

  registry.CL = { pmove: { movevars: { gravity } }, state: { worldmodel, paused }, nolerp: { value: 0 }, collision: { traceStaticWorldLine: trace } };
  registry.Host = { frametime };
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    Object.assign(registry, previous);
    eventBus.publish('registry.frozen');
  }
}

/**
 * Creates a tossed entity with a model so `setOrigin()` can link it.
 * @param {number} movetype the move type
 * @param {Vector} origin start position
 * @param {Vector} velocity start velocity
 * @returns {ClientEdict} the entity
 */
function createTossed(movetype, origin, velocity = new Vector()) {
  const clent = new ClientEdict(-1);
  clent.model = { mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
  clent.angles.clear();
  clent.movetype = movetype;
  clent.setOrigin(origin);
  clent.velocity.set(velocity);

  return clent;
}

/**
 * Allocates a client entity whose handler records the hooks and thinks the engine calls.
 * @returns {{clientEntities: ClientEntities, clent: ClientEdict, events: Array<string|object>}} the entity and its recorded events
 */
function allocateRecording() {
  const events = [];

  class RecordingHandler extends BaseClientEdictHandler {
    impact(trace) {
      events.push({ impact: trace });
    }

    rest() {
      events.push('rest');
    }

    think() {
      events.push({ think: this.clientEdict.origin.copy() });
    }
  }

  const previous = GameModule.active;
  GameModule.active = {
    identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
    ClientGameAPI: { GetClientEdictHandler: () => RecordingHandler },
  };

  try {
    const clientEntities = new ClientEntities();
    const clent = clientEntities.allocateSimulatedEntity('test_tossed');
    clent.model = { mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
    clent.angles.clear();

    return { clientEntities, clent, events };
  } finally {
    GameModule.active = previous;
  }
}

void describe('ClientEntityPhysics.step', () => {
  void test('integrates gravity from the synced world gravity times the entity multiplier, not a hardcoded constant', () => {
    withWorld({ gravity: 400, trace: emptyWorld() }, () => {
      const clent = createTossed(moveType.MOVETYPE_TOSS, new Vector(0, 0, 100));
      clent.gravity = 0.5;

      ClientEntityPhysics.step(clent, 0.1);

      // velocity.z -= 400 * 0.5 * 0.1
      assertNear(clent.velocity[2], -20, 1e-9);
      // origin.z += (already-updated) velocity.z * frametime = 100 + (-20 * 0.1)
      assertNear(clent.origin[2], 98, 1e-9);
    });
  });

  void test('moves the entity by velocity * frametime when nothing is hit', () => {
    withWorld({ gravity: 0, trace: emptyWorld() }, () => {
      const clent = createTossed(moveType.MOVETYPE_TOSS, new Vector(0, 0, 0), new Vector(50, 0, 0));

      ClientEntityPhysics.step(clent, 0.2);

      assertNear(clent.origin[0], 10, 1e-9);
    });
  });

  void test('tumbles by avelocity * frametime, and leaves the angles alone without one', () => {
    withWorld({ gravity: 0, trace: emptyWorld() }, () => {
      const tumbling = createTossed(moveType.MOVETYPE_TOSS, new Vector());
      tumbling.avelocity.setTo(0, 90, 0);
      const still = createTossed(moveType.MOVETYPE_TOSS, new Vector());
      still.angles.setTo(10, 20, 30);

      ClientEntityPhysics.step(tumbling, 0.5); // 90 degrees/second of yaw for half a second
      ClientEntityPhysics.step(still, 0.5);

      assertNear(tumbling.angles[1], 45, 1e-6);
      assertNear(tumbling.angles[0], 0, 1e-6);
      assert.deepEqual([...still.angles], [10, 20, 30]);
    });
  });

  void describe('hitting the world', () => {
    void test('a bounce reflects velocity with overbounce 1.5 and reports the impact to the handler', () => {
      withWorld({ gravity: 0, trace: floorWorld(0) }, () => {
        const { clent, events } = allocateRecording();
        clent.movetype = moveType.MOVETYPE_BOUNCE;
        clent.setOrigin(new Vector(0, 0, 1));
        clent.velocity.setTo(0, 0, -300);

        ClientEntityPhysics.step(clent, 0.1);

        // PhysicsMath.clipVelocity(vec=(0,0,-300), normal=(0,0,1), overbounce=1.5):
        // backoff = -450; out.z = -300 + 450 = 150, still above the rest speed of 60
        assertNear(clent.velocity[2], 150, 1e-9);
        assert.equal(clent.onGround, false);
        assert.equal(events.length, 1);
        assert.deepEqual([...events[0].impact.plane.normal], [0, 0, 1]);
        assert.ok(events[0].impact.fraction < 1.0);
      });
    });

    void test('a bounce that ends up slower than the rest speed comes to rest on the floor', () => {
      withWorld({ gravity: 0, trace: floorWorld(0) }, () => {
        const { clent, events } = allocateRecording();
        clent.movetype = moveType.MOVETYPE_BOUNCE;
        clent.setOrigin(new Vector(0, 0, 1));
        clent.velocity.setTo(10, 0, -100);
        clent.avelocity.setTo(0, 300, 0);

        ClientEntityPhysics.step(clent, 0.1);

        // -100 reflects to 50 (overbounce 1.5), below PhysicsMath.BOUNCE_REST_SPEED of 60
        assert.equal(clent.onGround, true);
        assert.deepEqual([...clent.velocity], [0, 0, 0]);
        assert.deepEqual([...clent.avelocity], [0, 0, 0]);
        assert.equal(events.length, 2);
        assert.equal(typeof events[0], 'object', 'impact comes first');
        assert.equal(events[1], 'rest');
      });
    });

    void test('a toss never bounces: it slides and comes to rest on any floor-like hit', () => {
      withWorld({ gravity: 0, trace: floorWorld(0) }, () => {
        const clent = createTossed(moveType.MOVETYPE_TOSS, new Vector(0, 0, 1), new Vector(0, 0, -300));

        ClientEntityPhysics.step(clent, 0.1);

        // overbounce 1.0 absorbs the whole normal component
        assert.equal(clent.onGround, true);
        assert.deepEqual([...clent.velocity], [0, 0, 0]);
      });
    });

    void test('hitting a wall reports the impact but does not come to rest', () => {
      const wall = (start, end) => (end[0] < 10
        ? worldTrace(end)
        : worldTrace(new Vector(10, 0, 0), { fraction: 0.5, normal: new Vector(-1, 0, 0) }));

      withWorld({ gravity: 0, trace: wall }, () => {
        const { clent, events } = allocateRecording();
        clent.movetype = moveType.MOVETYPE_BOUNCE;
        clent.setOrigin(new Vector(0, 0, 0));
        clent.velocity.setTo(200, 0, 0);

        ClientEntityPhysics.step(clent, 0.1);

        assert.equal(clent.onGround, false);
        assert.equal(events.length, 1);
        // reflected off the wall: 200 - (-1 * (200 * -1 * 1.5)) = -100
        assertNear(clent.velocity[0], -100, 1e-9);
      });
    });

    void test('an entity that starts and stays inside solid is stopped and counts as at rest', () => {
      withWorld({
        gravity: 0,
        trace: (_start, end) => worldTrace(end, { fraction: 0, allsolid: true }),
      }, () => {
        const { clent, events } = allocateRecording();
        clent.movetype = moveType.MOVETYPE_BOUNCE;
        clent.setOrigin(new Vector(1, 2, 3));
        clent.velocity.setTo(0, 0, -100);

        ClientEntityPhysics.step(clent, 0.1);

        assert.equal(clent.onGround, true);
        assert.deepEqual([...clent.velocity], [0, 0, 0]);
        assert.deepEqual([...clent.origin], [1, 2, 3], 'it does not move');
        assert.deepEqual(events, ['rest']);
      });
    });
  });

  void test('recomputes the BSP leafs when the entity crosses a leaf boundary', () => {
    // Regression test for the stale-PVS footgun: stepping by writing `origin` directly instead of
    // calling setOrigin() would leave `leafs` stale and the entity would be culled wrongly.
    const frontLeaf = { contents: content.CONTENT_EMPTY, num: 10 };
    const backLeaf = { contents: content.CONTENT_EMPTY, num: 20 };
    const worldmodel = {
      nodes: [{
        contents: 0,
        plane: { normal: new Vector(1, 0, 0), dist: 0, type: 0, signbits: 0 },
        children: [frontLeaf, backLeaf],
      }],
    };

    withWorld({ gravity: 0, worldmodel, trace: emptyWorld() }, () => {
      const clent = createTossed(moveType.MOVETYPE_TOSS, new Vector(-50, 0, 0));

      assert.deepEqual(clent.leafs, [20], 'expected to start in the back leaf');

      clent.velocity.setTo(1000, 0, 0);
      ClientEntityPhysics.step(clent, 0.1); // moves x from -50 to +50, crossing the x=0 split plane

      assert.deepEqual(clent.leafs, [10], 'expected step() to have recomputed leafs for the front leaf');
    });
  });
});

void describe('ClientEntities.think (engine-driven physics)', () => {
  void test('steps a tossed entity before its handler thinks, so the handler sees the new position', () => {
    withWorld({ gravity: 0, trace: emptyWorld() }, () => {
      const { clientEntities, clent, events } = allocateRecording();
      clent.movetype = moveType.MOVETYPE_TOSS;
      clent.setOrigin(new Vector(0, 0, 0));
      clent.velocity.setTo(100, 0, 0);

      clientEntities.think();

      assertNear(clent.origin[0], 10, 1e-9);
      assertNear(events[0].think[0], 10, 1e-9);
    });
  });

  void test('does not step an entity with MOVETYPE_NONE', () => {
    withWorld({ gravity: 800, trace: emptyWorld() }, () => {
      const { clientEntities, clent } = allocateRecording();
      clent.setOrigin(new Vector(0, 0, 100));
      clent.velocity.setTo(100, 0, -100);

      clientEntities.think();

      assert.deepEqual([...clent.origin], [0, 0, 100]);
    });
  });

  void test('does not step an entity that is at rest, and does not step a freed one', () => {
    withWorld({ gravity: 800, trace: emptyWorld() }, () => {
      const { clientEntities, clent } = allocateRecording();
      clent.movetype = moveType.MOVETYPE_BOUNCE;
      clent.setOrigin(new Vector(0, 0, 100));
      clent.onGround = true;

      clientEntities.think();
      assert.deepEqual([...clent.origin], [0, 0, 100]);

      clent.onGround = false;
      clent.markFree();
      clientEntities.think();
      assert.deepEqual([...clent.origin], [0, 0, 100]);
    });
  });

  void test('does not step anything while the game is paused', () => {
    withWorld({ gravity: 800, paused: true, trace: emptyWorld() }, () => {
      const { clientEntities, clent } = allocateRecording();
      clent.movetype = moveType.MOVETYPE_BOUNCE;
      clent.setOrigin(new Vector(0, 0, 100));

      clientEntities.think();

      assert.deepEqual([...clent.origin], [0, 0, 100]);
      assert.deepEqual([...clent.velocity], [0, 0, 0]);
    });
  });

  void test('never steps an entity mirrored from the server, whatever its fields say', () => {
    withWorld({ gravity: 800, trace: emptyWorld() }, () => {
      const clientEntities = new ClientEntities();
      const mirrored = clientEntities.getEntity(3);
      mirrored.updatecount = 1;
      mirrored.movetype = moveType.MOVETYPE_BOUNCE;
      mirrored.origin.setTo(0, 0, 100);

      clientEntities.think();

      assert.deepEqual([...mirrored.origin], [0, 0, 100]);
    });
  });
});
