import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { content } from '../../source/shared/Defs.mjs';
import { PM_TYPE, PMF, Pmove, PmovePlayer, Trace } from '../../source/engine/common/Pmove.mjs';
import { UserCmd } from '../../source/engine/network/Protocol.mjs';

import {
  assertNear,
  createBrushWorldModel,
  createLegacyWorldModel,
  createPmoveBoxEntity,
} from './fixtures.mjs';

/**
 * Build a trace fixture with the requested observable fields.
 * @param {{ endpos: Vector, fraction?: number, normal?: Vector, dist?: number, ent?: number|null, allsolid?: boolean, startsolid?: boolean }} options trace options
 * @returns {Trace} trace fixture
 */
function createTrace({
  endpos,
  fraction = 1.0,
  normal = new Vector(),
  dist = 0.0,
  ent = null,
  allsolid = false,
  startsolid = false,
}) {
  const trace = new Trace();
  trace.endpos.set(endpos);
  trace.fraction = fraction;
  trace.allsolid = allsolid;
  trace.startsolid = startsolid;
  trace.ent = ent;
  trace.plane.normal.set(normal);
  trace.plane.dist = dist;
  return trace;
}

describe('PmovePlayer', () => {
  test('DEBUG is disabled before Pmove.Init()', () => {
    assert.equal(PmovePlayer.DEBUG, false);
  });

  test('move integrates one grounded movement frame against a world model', () => {
    const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, -40], halfExtents: [512, 512, 16] });
    const pmove = new Pmove();
    const player = pmove.newPlayerMove();

    pmove.setWorldmodel(worldModel);

    player.origin.setTo(0, 0, 0);
    player.velocity.clear();
    player.angles.clear();
    player.cmd = new UserCmd();
    player.cmd.msec = 100;
    player.cmd.forwardmove = 200;

    player.move();

    assert.equal((player.pmFlags & PMF.ON_GROUND) !== 0, true);
    assert.equal(player.onground, 0);
    assert.ok(player.origin[0] > 0.5);
    assertNear(player.origin[2], 0, 0.125);
    assert.ok(player.velocity[0] > 0);
  });

  test('move uses noclip-style spectator movement without collision traces', () => {
    const pmove = new Pmove();
    const player = pmove.newPlayerMove();

    pmove.clipPlayerMove = () => {
      throw new Error('spectator movement should not use collision traces');
    };
    pmove.isValidPlayerPosition = () => true;

    player.spectator = true;
    player.origin.clear();
    player.velocity.clear();
    player.angles.clear();
    player.cmd = new UserCmd();
    player.cmd.msec = 100;
    player.cmd.forwardmove = 600;
    player.cmd.upmove = 50;

    player.move();

    assert.equal(player.pmType, PM_TYPE.SPECTATOR);
    assert.equal(player.onground, null);
    assert.equal(player.viewheight, 22);
    assertNear(player.origin[0], 49.875, 0.001);
    assertNear(player.origin[1], 0.0);
    assertNear(player.origin[2], 4.125, 0.001);
    assertNear(player.velocity[0], 498.25, 0.001);
    assertNear(player.velocity[1], 0.0);
    assertNear(player.velocity[2], 41.5, 0.001);
  });

  describe('_checkDuck', () => {
    test('enters ducked state on grounded crouch input and stands when space is clear', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      player.origin.clear();
      player.cmd = new UserCmd();
      player.pmFlags = PMF.ON_GROUND;
      player.cmd.upmove = -1;

      player._checkDuck();

      assert.equal((player.pmFlags & PMF.DUCKED) !== 0, true);
      assert.equal(player.viewheight, -2);

      player.cmd.upmove = 0;
      pmove.isValidPlayerPosition = () => true;

      player._checkDuck();

      assert.equal((player.pmFlags & PMF.DUCKED) !== 0, false);
      assert.equal(player.viewheight, 22);
    });
  });

  describe('_checkSpecialMovement', () => {
    test('starts a waterjump when water waist depth meets a solid lip with empty space above', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      player.origin.clear();
      player.velocity.clear();
      player.angles.clear();
      player.waterlevel = 2;
      player.cmd = new UserCmd();
      player._clampAngles();

      pmove.clipPlayerMove = (start, end) => {
        void start;
        return createTrace({ endpos: end.copy() });
      };

      /** @type {number[][]} */
      const probes = [];
      pmove.staticWorldContents = (point) => {
        probes.push([...point]);
        if (point[2] === 8) {
          return content.CONTENT_SOLID;
        }
        if (point[2] === 32) {
          return content.CONTENT_EMPTY;
        }
        return content.CONTENT_WATER;
      };

      player._checkSpecialMovement();

      assert.deepEqual(probes, [[24, 0, 8], [24, 0, 32]]);
      assert.deepEqual([...player.velocity], [50, 0, 310]);
      assert.equal((player.pmFlags & PMF.TIME_WATERJUMP) !== 0, true);
      assert.equal(player.pmTime, 255);
    });
  });

  describe('waterjump movement', () => {
    test('applies gravity and clears waterjump once the upward boost turns downward', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let stepSlideCalls = 0;

      pmove.isValidPlayerPosition = () => true;
      pmove.clipPlayerMove = (start, end) => {
        void start;
        return createTrace({ endpos: end.copy(), normal: new Vector(0, 0, 1) });
      };
      pmove.staticWorldContents = () => content.CONTENT_EMPTY;

      player.origin.clear();
      player.velocity.setTo(0, 0, 10);
      player.angles.clear();
      player.pmFlags = PMF.TIME_WATERJUMP;
      player.pmTime = 255;
      player.cmd = new UserCmd();
      player.cmd.msec = 100;
      player._stepSlideMove = () => {
        stepSlideCalls += 1;
      };

      player.move();

      assert.equal(stepSlideCalls, 1);
      assert.equal((player.pmFlags & PMF.TIME_WATERJUMP) !== 0, false);
      assert.equal(player.pmTime, 0);
      assertNear(player.velocity[2], -70.0);
    });
  });

  describe('_stepSlideMove', () => {
    test('keeps the stepped path when it travels farther horizontally', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let slideCalls = 0;
      let traceCalls = 0;

      player.origin.clear();
      player.velocity.setTo(30, 0, 0);
      player.onground = 0;
      player._slideMove = () => {
        slideCalls += 1;
        if (slideCalls === 1) {
          player.origin.setTo(4, 0, 0);
          player.velocity.setTo(10, 0, 0);
          return;
        }

        player.origin.setTo(8, 0, 4);
        player.velocity.setTo(20, 0, 3);
      };

      pmove.clipPlayerMove = () => {
        traceCalls += 1;

        if (traceCalls === 1) {
          return createTrace({
            endpos: new Vector(4, 0, -18),
            normal: new Vector(0, 0, 1),
          });
        }

        if (traceCalls === 2) {
          return createTrace({
            endpos: new Vector(0, 0, 9),
            fraction: 0.5,
            normal: new Vector(0, 0, 1),
            ent: 3,
          });
        }

        return createTrace({
          endpos: new Vector(8, 0, 0),
          normal: new Vector(0, 0, 1),
          ent: 4,
        });
      };

      player._stepSlideMove();

      assert.equal(slideCalls, 2);
      assert.equal(traceCalls, 3);
      assert.deepEqual([...player.origin], [8, 0, 0]);
      assert.deepEqual([...player.velocity], [20, 0, 0]);
      assert.deepEqual(player.touchindices, [3, 4]);
    });
  });
});

describe('Pmove', () => {
  describe('clipPlayerMove', () => {
    test('keeps startsolid end positions in world space', () => {
      const pmove = new Pmove();

      pmove.addEntity(createPmoveBoxEntity({
        origin: new Vector(),
        mins: new Vector(-32, -32, -32),
        maxs: new Vector(32, 32, 32),
      }));

      const start = new Vector();
      const end = new Vector(128, 0, 0);
      const trace = pmove.clipPlayerMove(start, end);

      assert.equal(trace.startsolid, true);
      assert.equal(trace.fraction, 0.0);
      assert.deepEqual([...trace.endpos], [...start]);
    });

    test('reports hull hits in world coordinates', () => {
      const pmove = new Pmove();

      pmove.addEntity(createPmoveBoxEntity({
        origin: new Vector(64, 0, 0),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
      }));

      const trace = pmove.clipPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));

      assert.equal(trace.startsolid, false);
      assert.ok(trace.fraction < 1.0);
      assertNear(trace.endpos[0], 31.96875, 0.001);
      assertNear(trace.endpos[1], 0);
      assertNear(trace.endpos[2], 0);
    });
  });

  test('server-style smoke setup mirrors TestServerside assertions', () => {
    const worldModel = createLegacyWorldModel(
      new Vector(-256, -256, -128),
      new Vector(256, 256, 128),
    );
    const pmove = new Pmove();
    const entity = createPmoveBoxEntity({
      origin: new Vector(128, 0, 0),
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      num: 1,
    });

    pmove.setWorldmodel(worldModel);

    assert.equal(pmove.physents[0].constructor.name, 'PhysEnt');
    assert.equal(pmove.physents[0].hulls.length, worldModel.hulls.length);

    pmove.addEntity(entity);

    assert.equal(pmove.physents.length, 2);
    assert.equal(pmove.physents[1].origin.equals(entity.origin), true);
    assert.equal(pmove.physents[1].edictId, 1);

    const playerOrigin = new Vector(0, 0, 0);
    assert.equal(pmove.isValidPlayerPosition(playerOrigin), true);

    const playerMoveTraceIntoSpace = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 999999));
    assert.equal(playerMoveTraceIntoSpace instanceof Trace, true);
    assert.equal(playerMoveTraceIntoSpace.ent, 0);
    assert.ok(playerMoveTraceIntoSpace.fraction < 1.0);

    const playerMoveTraceHigher = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 64.0));
    assert.equal(playerMoveTraceHigher instanceof Trace, true);
    assert.equal(playerMoveTraceHigher.ent, null);
    assert.equal(playerMoveTraceHigher.fraction, 1.0);
  });

  test('traceStaticWorldPlayerMove traces world only and ignores dynamic physents', () => {
    const worldModel = createLegacyWorldModel(
      new Vector(-256, -256, -128),
      new Vector(256, 256, 128),
    );
    const pmove = new Pmove();

    pmove.setWorldmodel(worldModel);
    pmove.addEntity(createPmoveBoxEntity({
      origin: new Vector(64, 0, 0),
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      num: 1,
    }));

    const staticWorldTrace = pmove.traceStaticWorldPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));
    const aggregateTrace = pmove.clipPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));

    assert.equal(staticWorldTrace.fraction, 1.0);
    assert.deepEqual([...staticWorldTrace.endpos], [100, 0, 0]);
    assert.ok(aggregateTrace.fraction < 1.0);
    assertNear(aggregateTrace.endpos[0], 31.96875, 0.001);
  });

  test('brush-list world path supports server-style vertical smoke checks', () => {
    const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, 144], halfExtents: [512, 512, 16] });
    const pmove = new Pmove();
    const entity = createPmoveBoxEntity({
      origin: new Vector(128, 0, 0),
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      num: 1,
    });

    pmove.setWorldmodel(worldModel);
    pmove.addEntity(entity);

    const playerOrigin = new Vector(0, 0, 0);
    assert.equal(pmove.physents[0].usesBrushTracing, true);
    assert.equal(pmove.isValidPlayerPosition(playerOrigin), true);

    const playerMoveTraceIntoSpace = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 999999));
    assert.equal(playerMoveTraceIntoSpace instanceof Trace, true);
    assert.equal(playerMoveTraceIntoSpace.ent, 0);
    assert.ok(playerMoveTraceIntoSpace.fraction < 1.0);

    const playerMoveTraceHigher = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 64.0));
    assert.equal(playerMoveTraceHigher instanceof Trace, true);
    assert.equal(playerMoveTraceHigher.ent, null);
    assert.equal(playerMoveTraceHigher.fraction, 1.0);
  });

  describe('staticWorldContents', () => {
    test('uses brush-backed world solids before leaf contents', () => {
      const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
      const pmove = new Pmove();

      worldModel.leafs[0].contents = content.CONTENT_WATER;

      pmove.setWorldmodel(worldModel);

      assert.equal(pmove.staticWorldContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
      assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
    });

    test('normalizes brush-backed current leaves to water', () => {
      const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
      const pmove = new Pmove();

      worldModel.leafs[0].contents = content.CONTENT_CURRENT_UP;

      pmove.setWorldmodel(worldModel);

      assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
    });
  });

  describe('crouching movement', () => {
    test('uses duckspeed as the movement cap while ducked on the ground', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      const recordedWishspeeds = [];

      player.origin.clear();
      player.velocity.clear();
      player.angles.clear();
      player.onground = 0;
      player.pmFlags = PMF.ON_GROUND | PMF.DUCKED;
      player.cmd = new UserCmd();
      player.cmd.forwardmove = 400;
      player._clampAngles();
      player._accelerate = (_wishdir, wishspeed) => {
        recordedWishspeeds.push(wishspeed);
      };
      player._stepSlideMove = () => {};

      player._airMove();

      assert.deepEqual(recordedWishspeeds, [pmove.movevars.duckspeed]);
      assert.equal(player.velocity[2], 0);
    });
  });
});
