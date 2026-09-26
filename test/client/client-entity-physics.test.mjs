import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { ClientEntityPhysics } from '../../source/shared/ClientEntityPhysics.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

import { assertNear } from '../physics/fixtures.mjs';

/**
 * A trace result matching GameTrace's shape for a step that hits nothing.
 * @param {Vector} end the requested end point, echoed back as the trace's resting point
 * @returns {object} a GameTrace-shaped mock trace
 */
function freeFlightTrace(end) {
  return {
    solid: { all: false, start: false },
    fraction: 1.0,
    plane: { normal: new Vector(), distance: 0 },
    contents: { inOpen: true, inWater: false },
    point: end.copy(),
    entity: null,
  };
}

/**
 * A mock ClientEngineAPI that never reports a collision, so a step always moves the entity the
 * full distance it asked for. Isolates the gravity/velocity integration from collision handling.
 * @param {number} gravity value returned by engine.CL.gravity
 * @returns {{CL: {gravity: number}, Traceline: (start: Vector, end: Vector) => object}} the mock engine
 */
function createFreeFlightEngine(gravity) {
  return {
    CL: { gravity },
    Traceline(_start, end) {
      return freeFlightTrace(end);
    },
  };
}

/**
 * A mock ClientEngineAPI with a single horizontal floor plane at world Z = floorZ. A traced
 * segment that would cross it is clipped to the plane intersection, matching the fraction/plane/
 * point contract a real world trace returns, so ClientEntityPhysics.step() reacts to it exactly
 * as it would to a real floor.
 * @param {number} gravity value returned by engine.CL.gravity
 * @param {number} floorZ world-Z of the floor plane
 * @returns {{CL: {gravity: number}, Traceline: (start: Vector, end: Vector) => object}} the mock engine
 */
function createFloorEngine(gravity, floorZ) {
  return {
    CL: { gravity },
    Traceline(start, end) {
      if (end[2] >= floorZ) {
        return freeFlightTrace(end);
      }

      const fraction = (floorZ - start[2]) / (end[2] - start[2]);
      return {
        solid: { all: false, start: false },
        fraction,
        plane: { normal: new Vector(0, 0, 1), distance: floorZ },
        contents: { inOpen: true, inWater: false },
        point: start.copy().add(end.copy().subtract(start).multiply(fraction)),
        entity: null,
      };
    },
  };
}

/**
 * A worldmodel whose root node is itself a single leaf, so any entity links into it regardless
 * of position. Used by tests that call setOrigin() (via step()) but don't care about `leafs`
 * specifically, so linkEdict() succeeds instead of tripping its "worldmodel/model must be set"
 * assertions.
 * @returns {{nodes: {contents: number, num: number}[]}} a trivial single-leaf worldmodel
 */
function createTrivialWorldmodel() {
  return { nodes: [{ contents: content.CONTENT_EMPTY, num: 0 }] };
}

/**
 * A minimal model shape with the `mins`/`maxs` linkEdict() needs to compute trace bounds.
 * @returns {{mins: Vector, maxs: Vector}} a small box model fixture
 */
function createTrivialModel() {
  return { mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
}

/**
 * Runs a callback with a minimal `CL.state.worldmodel` installed so `ClientEdict.setOrigin()`/
 * `linkEdict()` can recompute `leafs` against a real (if tiny) BSP node tree.
 * @param {{nodes: unknown[]}} worldmodel worldmodel fixture with a root BSP node
 * @param {() => void} callback
 */
function withMockWorldmodelRegistry(worldmodel, callback) {
  const previousCL = registry.CL;

  registry.CL = { state: { worldmodel } };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousCL;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('ClientEntityPhysics.step', () => {
  void test('integrates gravity from engine.CL.gravity, not a hardcoded constant', () => {
    withMockWorldmodelRegistry(createTrivialWorldmodel(), () => {
      const clientEdict = new ClientEdict(-1);
      clientEdict.model = createTrivialModel();
      clientEdict.origin.setTo(0, 0, 100);
      // Half of Quake's stock 800 -- if the implementation ever hardcoded 800, this would fail.
      const engine = createFreeFlightEngine(400);
      const physics = new ClientEntityPhysics(clientEdict, engine);

      physics.step(0.1);

      // velocity.z -= gravity * frametime = 400 * 0.1
      assertNear(clientEdict.velocity[2], -40, 1e-9);
      // origin.z += (already-updated) velocity.z * frametime = 100 + (-40 * 0.1)
      assertNear(clientEdict.origin[2], 96, 1e-9);
    });
  });

  void test('moves the entity by velocity * frametime when nothing is hit', () => {
    withMockWorldmodelRegistry(createTrivialWorldmodel(), () => {
      const clientEdict = new ClientEdict(-1);
      clientEdict.model = createTrivialModel();
      clientEdict.origin.setTo(0, 0, 0);
      clientEdict.velocity.setTo(50, 0, 0);
      const engine = createFreeFlightEngine(0);
      const physics = new ClientEntityPhysics(clientEdict, engine);

      physics.step(0.2);

      assertNear(clientEdict.origin[0], 10, 1e-9);
    });
  });

  void describe('collision response', () => {
    void test('reflects velocity off a floor plane via the shared PhysicsMath.clipVelocity formula', () => {
      withMockWorldmodelRegistry(createTrivialWorldmodel(), () => {
        const clientEdict = new ClientEdict(-1);
        clientEdict.model = createTrivialModel();
        clientEdict.origin.setTo(0, 0, 1);
        clientEdict.velocity.setTo(0, 0, -100);
        const engine = createFloorEngine(0, 0); // gravity 0 isolates the bounce math from gravity
        const physics = new ClientEntityPhysics(clientEdict, engine);

        const trace = physics.step(0.1, { bounce: 1.5 });

        assert.ok(trace.fraction < 1.0, 'expected the floor to be hit before the full step completed');
        // PhysicsMath.clipVelocity(vec=(0,0,-100), normal=(0,0,1), overbounce=1.5):
        // backoff = dot(vec, normal) * 1.5 = -150; out.z = vec.z - normal.z * backoff = -100 + 150 = 50
        assertNear(clientEdict.velocity[2], 50, 1e-9);
      });
    });

    void test('comes to a full stop once the clipped velocity falls within PhysicsMath.VELOCITY_EPSILON', () => {
      withMockWorldmodelRegistry(createTrivialWorldmodel(), () => {
        const clientEdict = new ClientEdict(-1);
        clientEdict.model = createTrivialModel();
        clientEdict.origin.setTo(0, 0, 1);
        clientEdict.velocity.setTo(0, 0, -100);
        const engine = createFloorEngine(0, 0);
        const physics = new ClientEntityPhysics(clientEdict, engine);

        physics.step(0.1); // default bounce is 1.0: slides/absorbs like MOVETYPE_TOSS

        // PhysicsMath.clipVelocity(vec=(0,0,-100), normal=(0,0,1), overbounce=1.0):
        // backoff = -100; out.z = -100 - 1 * -100 = 0, landing exactly on rest
        assert.deepEqual([...clientEdict.velocity], [0, 0, 0]);
      });
    });

    void test('zeroes velocity and does not move when the trace starts and stays entirely solid', () => {
      withMockWorldmodelRegistry(null, () => {
        const clientEdict = new ClientEdict(-1);
        clientEdict.origin.setTo(0, 0, 0);
        clientEdict.velocity.setTo(0, 0, -100);
        const engine = {
          CL: { gravity: 0 },
          Traceline() {
            return {
              solid: { all: true, start: true },
              fraction: 0,
              plane: { normal: new Vector(), distance: 0 },
              contents: { inOpen: false, inWater: false },
              point: new Vector(),
              entity: null,
            };
          },
        };
        const physics = new ClientEntityPhysics(clientEdict, engine);

        physics.step(0.1);

        assert.deepEqual([...clientEdict.velocity], [0, 0, 0]);
        assert.deepEqual([...clientEdict.origin], [0, 0, 0]);
      });
    });
  });

  void describe('leaf tracking', () => {
    void test('updates ClientEdict.leafs via setOrigin() when a step crosses a BSP leaf boundary', () => {
      // Regression test for the "moving a client-only entity has a silent visibility footgun"
      // problem: a physics helper that mutated .origin directly instead of calling setOrigin()
      // would leave `leafs` stale and the entity would stop being culled correctly.
      const frontLeaf = { contents: content.CONTENT_EMPTY, num: 10 };
      const backLeaf = { contents: content.CONTENT_EMPTY, num: 20 };
      const worldmodel = {
        nodes: [{
          contents: 0,
          plane: { normal: new Vector(1, 0, 0), dist: 0, type: 0, signbits: 0 },
          children: [frontLeaf, backLeaf],
        }],
      };

      withMockWorldmodelRegistry(worldmodel, () => {
        const clientEdict = new ClientEdict(-1);
        clientEdict.model = { mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
        clientEdict.setOrigin(new Vector(-50, 0, 0));

        assert.deepEqual(clientEdict.leafs, [20], 'expected to start in the back leaf');

        clientEdict.velocity.setTo(1000, 0, 0);
        const engine = createFreeFlightEngine(0);
        const physics = new ClientEntityPhysics(clientEdict, engine);

        physics.step(0.1); // moves x from -50 to +50, crossing the x=0 split plane

        assert.deepEqual(clientEdict.leafs, [10], 'expected step() to have recomputed leafs for the front leaf');
      });
    });
  });
});
