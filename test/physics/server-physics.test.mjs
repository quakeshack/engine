import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { content, flags, gameCapabilities, moveType, moveTypes, solid } from '../../source/shared/Defs.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { ServerArea } from '../../source/engine/server/physics/ServerArea.mjs';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.mjs';
import { ServerPhysics } from '../../source/engine/server/physics/ServerPhysics.mjs';
import { BlockedFlags, MAX_BUMP_COUNT } from '../../source/engine/server/physics/Defs.mjs';

import {
  assertNear,
  createBoxBrushModel,
  createBrushWorldModel,
  createMockEdict,
  createMockEntity,
  defaultMockRegistry,
  withMockRegistry,
  withMockServerPhysics,
} from './fixtures.mjs';

describe('ServerPhysics', () => {
  describe('checkVelocity', () => {
    test('clears NaNs and clamps to maxvelocity', () => {
      const serverPhysics = new ServerPhysics();
      const prints = [];
      const entity = createMockEntity({
        origin: new Vector(1, 2, 3),
        velocity: new Vector(5000, -5000, 1),
      });
      entity.origin[0] = Number.NaN;
      entity.velocity[2] = Number.NaN;
      entity.classname = 'test_entity';
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({ maxvelocity: { value: 2000 } }),
        Con: {
          Print(message) {
            prints.push(message);
          },
          DPrint() {},
        },
      }, () => {
        serverPhysics.checkVelocity(edict);
      });

      assert.deepEqual([...edict.entity.velocity], [2000, -2000, 0]);
      assert.deepEqual([...edict.entity.origin], [0, 2, 3]);
      assert.equal(prints.length, 2);
      assert.equal(prints[0], 'Got a NaN origin on test_entity\n');
      assert.equal(prints[1], 'Got a NaN velocity on test_entity\n');
    });
  });

  describe('pushEntity', () => {
    test('uses MOVE_MISSILE and preserves origin on allsolid', () => {
      const serverPhysics = new ServerPhysics();
      const linkCalls = [];
      const moveCalls = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-1, -1, -1),
        maxs: new Vector(1, 1, 1),
        movetype: moveType.MOVETYPE_FLYMISSILE,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict(linkedEdict) {
            linkCalls.push(linkedEdict);
          },
        },
        collision: {
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({
              start: start.copy(),
              mins: mins.copy(),
              maxs: maxs.copy(),
              end: end.copy(),
              type,
              passedict,
            });
            return {
              allsolid: true,
              startsolid: true,
              fraction: 0.0,
              endpos: new Vector(999, 999, 999),
              ent: null,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      }), () => {
        const trace = serverPhysics.pushEntity(edict, new Vector(5, 0, 0));

        assert.equal(trace.allsolid, true);
      });

      assert.equal(moveCalls.length, 1);
      assert.equal(moveCalls[0].type, moveTypes.MOVE_MISSILE);
      assert.equal(moveCalls[0].passedict, edict);
      assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0], edict);
    });

    test('uses MOVE_NOMONSTERS for trigger and non-solid entities', () => {
      const serverPhysics = new ServerPhysics();
      const moveCalls = [];
      const touchCalls = [];

      const touchedEntity = createMockEntity({ solidType: solid.SOLID_BBOX });
      touchedEntity.touch = (other) => {
        touchCalls.push(['target', other]);
      };
      const touchedEdict = createMockEdict(touchedEntity);

      /** @param {number} solidType solidity value to assign to the pushed test entity */
      const runCase = (solidType) => {
        const entity = createMockEntity({
          origin: new Vector(1, 2, 3),
          mins: new Vector(-1, -1, -1),
          maxs: new Vector(1, 1, 1),
          solidType,
        });
        entity.touch = (other) => {
          touchCalls.push([solidType, other]);
        };
        const edict = createMockEdict(entity);

        withMockRegistry(defaultMockRegistry({
          area: {
            linkEdict() {},
          },
          collision: {
            move(start, mins, maxs, end, type, passedict) {
              moveCalls.push({ solidType, type, passedict, end: end.copy() });
              return {
                allsolid: false,
                startsolid: false,
                fraction: 1.0,
                endpos: end.copy(),
                plane: { normal: new Vector(), dist: 0.0 },
                ent: touchedEdict,
              };
            },
          },
          server: {
            gameAPI: { time: 0 },
          },
        }), () => {
          serverPhysics.pushEntity(edict, new Vector(4, 0, 0));
        });
      };

      runCase(solid.SOLID_TRIGGER);
      runCase(solid.SOLID_NOT);

      assert.equal(moveCalls.length, 2);
      assert.equal(moveCalls[0].type, moveTypes.MOVE_NOMONSTERS);
      assert.equal(moveCalls[1].type, moveTypes.MOVE_NOMONSTERS);
      assert.equal(touchCalls.length, 3);
      assert.equal(touchCalls[0][0], solid.SOLID_TRIGGER);
      assert.equal(touchCalls[1][0], 'target');
      assert.equal(touchCalls[2][0], 'target');
    });
  });

  describe('flyMove', () => {
    test('clips against a wall and records steptrace', () => {
      const serverPhysics = new ServerPhysics();
      const moveCalls = [];
      const impacts = [];
      const blocker = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const entity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        velocity: new Vector(10, 0, 0),
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.5,
              endpos: new Vector(5, 0, 0),
              plane: { normal: new Vector(-1, 0, 0), dist: 5 },
              ent: blocker,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.impact = (e1, e2, pushVector) => {
          impacts.push({ e1, e2, pushVector: pushVector.copy() });
        };

        const result = serverPhysics.flyMove(edict, 1.0);

        assert.equal(result.blocked, BlockedFlags.WALL);
        assert.equal(result.steptrace?.ent, blocker);
      });

      assert.equal(moveCalls.length, 1);
      assert.deepEqual([...edict.entity.origin], [5, 0, 0]);
      assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
      assert.equal(impacts.length, 1);
      assert.deepEqual([...impacts[0].pushVector], [10, 0, 0]);
    });

    test('stops in a two-plane crease', () => {
      const serverPhysics = new ServerPhysics();
      let moveCallCount = 0;
      const blockerA = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const blockerB = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const entity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        velocity: new Vector(10, 10, 0),
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          move() {
            moveCallCount += 1;

            if (moveCallCount === 1) {
              return {
                allsolid: false,
                startsolid: false,
                fraction: 0.0,
                endpos: new Vector(0, 0, 0),
                plane: { normal: new Vector(-1, 0, 0), dist: 0 },
                ent: blockerA,
              };
            }

            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(0, 0, 0),
              plane: { normal: new Vector(0, -1, 0), dist: 0 },
              ent: blockerB,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.impact = () => {};

        const result = serverPhysics.flyMove(edict, 1.0);

        assert.equal(result.blocked, BlockedFlags.WALL);
        assert.equal(result.steptrace?.ent, blockerB);
      });

      assert.equal(moveCallCount, 2);
      assert.deepEqual([...edict.entity.origin], [0, 0, 0]);
      assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
    });

    test('dead-stops when clipped by three non-coplanar planes', () => {
      const serverPhysics = new ServerPhysics();
      let moveCallCount = 0;
      const blockerA = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const blockerB = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const blockerC = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const entity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        velocity: new Vector(10, 10, 10),
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          move() {
            moveCallCount += 1;

            if (moveCallCount === 1) {
              return {
                allsolid: false,
                startsolid: false,
                fraction: 0.0,
                endpos: new Vector(0, 0, 0),
                plane: { normal: new Vector(-1, 0, 0), dist: 0 },
                ent: blockerA,
              };
            }

            if (moveCallCount === 2) {
              return {
                allsolid: false,
                startsolid: false,
                fraction: 0.0,
                endpos: new Vector(0, 0, 0),
                plane: { normal: new Vector(0, -1, 0), dist: 0 },
                ent: blockerB,
              };
            }

            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(0, 0, 0),
              plane: { normal: new Vector(0, 0, -1), dist: 0 },
              ent: blockerC,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.impact = () => {};

        const result = serverPhysics.flyMove(edict, 1.0);

        assert.equal(result.blocked, 7);
        assert.equal(result.steptrace?.ent, blockerB);
      });

      assert.equal(moveCallCount, 3);
      assert.deepEqual([...edict.entity.origin], [0, 0, 0]);
      assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
    });

    test('keeps state finite when a degenerate wall normal repeats', () => {
      const serverPhysics = new ServerPhysics();
      let moveCallCount = 0;
      const impacts = [];
      const blocker = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
      const entity = createMockEntity({
        origin: new Vector(5, 6, 7),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        velocity: new Vector(3, 4, 0),
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          move() {
            moveCallCount += 1;

            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(5, 6, 7),
              plane: { normal: new Vector(0, 0, 0), dist: 0 },
              ent: blocker,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.impact = (_e1, _e2, pushVector) => {
          impacts.push(pushVector.copy());
        };

        const result = serverPhysics.flyMove(edict, 1.0);

        assert.equal(result.blocked, BlockedFlags.WALL);
        assert.equal(result.steptrace?.ent, blocker);
      });

      assert.equal(moveCallCount, MAX_BUMP_COUNT);
      assert.equal(impacts.length, MAX_BUMP_COUNT);
      assert.deepEqual([...edict.entity.origin], [5, 6, 7]);
      assert.deepEqual([...edict.entity.velocity], [3, 4, 0]);
      for (const value of edict.entity.velocity) {
        assert.equal(Number.isFinite(value), true);
      }
    });
  });

  describe('checkAllEnts', () => {
    test('skips static entities and reports invalid dynamic positions', () => {
      const serverPhysics = new ServerPhysics();
      const prints = [];
      const tested = [];

      const worldEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
      const freeEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_WALK }));
      freeEdict.isFree = () => true;
      const pushEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_PUSH }));
      const noneEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
      const noclipEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NOCLIP }));
      const walkEntity = createMockEntity({ movetype: moveType.MOVETYPE_WALK });
      const walkEdict = createMockEdict(walkEntity);
      walkEdict.num = 5;

      withMockRegistry({
        ...defaultMockRegistry({
          collision: {
            testEntityPosition(edict) {
              tested.push(edict);
              return edict === walkEdict;
            },
          },
          server: {
            num_edicts: 6,
            edicts: [worldEdict, freeEdict, pushEdict, noneEdict, noclipEdict, walkEdict],
          },
        }),
        Con: {
          Print(message) {
            prints.push(message);
          },
          DPrint() {},
        },
      }, () => {
        serverPhysics.checkAllEnts();
      });

      assert.deepEqual(tested, [walkEdict]);
      assert.deepEqual(prints, ['entity in invalid position\n']);
    });
  });

  describe('runThink', () => {
    test('returns false when the entity frees itself during think', () => {
      const serverPhysics = new ServerPhysics();
      let freed = false;
      let thinkCalls = 0;
      const entity = createMockEntity();
      entity.nextthink = 0.5;
      entity.think = () => {
        thinkCalls += 1;
        freed = true;
      };
      const edict = createMockEdict(entity);
      edict.isFree = () => freed;

      withMockRegistry(defaultMockRegistry({
        server: {
          time: 1.0,
          gameAPI: { time: 0 },
        },
      }), () => {
        const result = serverPhysics.runThink(edict);

        assert.equal(result, false);
        assert.equal(registry.SV.server.gameAPI.time, 1.0);
      });

      assert.equal(thinkCalls, 1);
      assert.equal(entity.nextthink, 0.0);
    });

    test('executes multiple thinks that become due within one frame', () => {
      const serverPhysics = new ServerPhysics();
      const thinkTimes = [];
      const entity = createMockEntity();
      entity.nextthink = 1.05;
      entity.think = () => {
        thinkTimes.push(registry.SV.server.gameAPI.time);
        entity.nextthink = thinkTimes.length === 1 ? 1.15 : 0.0;
      };
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({
          server: {
            time: 1.0,
            gameAPI: { time: 0 },
          },
        }),
        Host: { frametime: 0.2 },
      }, () => {
        const result = serverPhysics.runThink(edict);

        assert.equal(result, true);
        assert.equal(registry.SV.server.gameAPI.time, 1.15);
      });

      assert.deepEqual(thinkTimes, [1.05, 1.15]);
      assert.equal(entity.nextthink, 0.0);
    });
  });

  describe('pushMove', () => {
    test('carries a grounded rider upward without blocked()', () => {
      withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, moveCalls, testCalls, blockedCalls }) => {
        serverPhysics.pushMove(pusherEdict, 0.1);

        assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
        assert.deepEqual([...riderEdict.entity.origin], [0, 0, 42]);
        assert.equal(moveCalls.length, 1);
        assert.deepEqual([...moveCalls[0].end], [0, 0, 42]);
        assert.equal(testCalls.length, 1);
        assert.equal(testCalls[0], riderEdict);
        assert.equal(blockedCalls.length, 0);
        assert.equal(pusherEdict.entity.ltime, 0.1);
      });
    });

    test('rolls back and calls blocked() when rider remains stuck', () => {
      withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, blockedCalls }) => {
        let testCount = 0;
        registry.SV.collision.testEntityPosition = (edict) => {
          testCount += 1;
          return edict === riderEdict;
        };
        eventBus.publish('registry.frozen');

        serverPhysics.pushMove(pusherEdict, 0.1);

        assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 0]);
        assert.deepEqual([...riderEdict.entity.origin], [0, 0, 32]);
        assert.equal(testCount, 2);
        assert.equal(blockedCalls.length, 1);
        assert.equal(blockedCalls[0], riderEdict.entity);
        assert.equal(pusherEdict.entity.ltime, 0);
      });
    });

    test('restores earlier riders when a later rider blocks the push', () => {
      const linkCalls = [];
      const blockedCalls = [];

      const pusherEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-64, -64, -16),
        maxs: new Vector(64, 64, 16),
        velocity: new Vector(0, 0, 100),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      pusherEntity.blocked = (blockingEntity) => {
        blockedCalls.push(blockingEntity);
      };

      const riderAEntity = createMockEntity({
        origin: new Vector(0, 0, 32),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
        flagsValue: flags.FL_ONGROUND,
        groundentity: pusherEntity,
      });
      const riderBEntity = createMockEntity({
        origin: new Vector(24, 0, 32),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
        flagsValue: flags.FL_ONGROUND,
        groundentity: pusherEntity,
      });

      const worldEdict = createMockEdict(createMockEntity());
      const pusherEdict = createMockEdict(pusherEntity);
      const riderAEdict = createMockEdict(riderAEntity);
      riderAEdict.num = 2;
      const riderBEdict = createMockEdict(riderBEntity);
      riderBEdict.num = 3;

      withMockRegistry(defaultMockRegistry({
        maxvelocity: { value: 2000 },
        area: {
          linkEdict(edict) {
            edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
            edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
            linkCalls.push(edict);
          },
        },
        collision: {
          move(start, mins, maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
            };
          },
          testEntityPosition(edict) {
            return edict === riderBEdict;
          },
        },
        server: {
          time: 0,
          num_edicts: 4,
          edicts: [worldEdict, pusherEdict, riderAEdict, riderBEdict],
          gameAPI: { time: 0 },
        },
      }), () => {
        const serverPhysics = new ServerPhysics();
        serverPhysics.pushMove(pusherEdict, 0.1);
      });

      assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 0]);
      assert.deepEqual([...riderAEdict.entity.origin], [0, 0, 32]);
      assert.deepEqual([...riderBEdict.entity.origin], [24, 0, 32]);
      assert.equal(blockedCalls.length, 1);
      assert.equal(blockedCalls[0], riderBEdict.entity);
      assert.equal(pusherEdict.entity.ltime, 0);
      assert.ok(linkCalls.length >= 5);
    });

    test('collapses trigger bounds instead of rolling back the pusher', () => {
      const blockedCalls = [];

      const pusherEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-64, -64, -16),
        maxs: new Vector(64, 64, 16),
        velocity: new Vector(0, 0, 100),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      pusherEntity.blocked = (blockingEntity) => {
        blockedCalls.push(blockingEntity);
      };

      const triggerEntity = createMockEntity({
        origin: new Vector(0, 0, 32),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_TRIGGER,
        flagsValue: flags.FL_ONGROUND,
        groundentity: pusherEntity,
      });

      const worldEdict = createMockEdict(createMockEntity());
      const pusherEdict = createMockEdict(pusherEntity);
      const triggerEdict = createMockEdict(triggerEntity);
      triggerEdict.num = 2;

      withMockRegistry(defaultMockRegistry({
        maxvelocity: { value: 2000 },
        area: {
          linkEdict(edict) {
            edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
            edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
          },
        },
        collision: {
          move(start, mins, maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
            };
          },
          testEntityPosition(edict) {
            return edict === triggerEdict;
          },
        },
        server: {
          time: 0,
          num_edicts: 3,
          edicts: [worldEdict, pusherEdict, triggerEdict],
          gameAPI: { time: 0 },
        },
      }), () => {
        const serverPhysics = new ServerPhysics();
        serverPhysics.pushMove(pusherEdict, 0.1);
      });

      assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
      assert.deepEqual([...triggerEdict.entity.origin], [0, 0, 42]);
      assert.deepEqual([...triggerEdict.entity.mins], [0, 0, -8]);
      assert.deepEqual([...triggerEdict.entity.maxs], [0, 0, -8]);
      assert.equal(blockedCalls.length, 0);
      assert.equal(pusherEdict.entity.ltime, 0.1);
    });

    test('rotates grounded riders around the pusher yaw axis', () => {
      withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, moveCalls, testCalls, blockedCalls }) => {
        pusherEdict.entity.velocity.clear();
        pusherEdict.entity.avelocity = new Vector(0, 900, 0);
        riderEdict.entity.origin = new Vector(32, 0, 32);
        riderEdict.entity.angles = new Vector(0, 0, 0);
        riderEdict.entity.absmin = riderEdict.entity.origin.copy().add(riderEdict.entity.mins);
        riderEdict.entity.absmax = riderEdict.entity.origin.copy().add(riderEdict.entity.maxs);

        const rotatedOffset = new Vector(0, 0, 1).rotatePointAroundVector(new Vector(32, 0, 32), 90);
        const expectedOrigin = rotatedOffset;

        serverPhysics.pushMove(pusherEdict, 0.1);

        assert.equal(moveCalls.length, 1);
        assertNear(moveCalls[0].end[0], expectedOrigin[0], 1e-9);
        assertNear(moveCalls[0].end[1], expectedOrigin[1], 1e-9);
        assertNear(moveCalls[0].end[2], expectedOrigin[2], 1e-9);
        assertNear(riderEdict.entity.origin[0], expectedOrigin[0], 1e-9);
        assertNear(riderEdict.entity.origin[1], expectedOrigin[1], 1e-9);
        assertNear(riderEdict.entity.origin[2], expectedOrigin[2], 1e-9);
        assert.deepEqual([...riderEdict.entity.angles], [0, 90, 0]);
        assert.deepEqual([...pusherEdict.entity.angles], [0, 90, 0]);
        assert.equal(testCalls.length, 1);
        assert.equal(testCalls[0], riderEdict);
        assert.equal(blockedCalls.length, 0);
      });
    });

    test('ignores rider overlap that only collides with the current pusher after the move', () => {
      const testCalls = [];
      const blockedCalls = [];

      const worldEdict = createMockEdict(createMockEntity());
      worldEdict.num = 0;

      const pusherEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-64, -64, -16),
        maxs: new Vector(64, 64, 16),
        velocity: new Vector(0, 0, 100),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      pusherEntity.blocked = (blockingEntity) => {
        blockedCalls.push(blockingEntity);
      };
      const pusherEdict = createMockEdict(pusherEntity);
      pusherEdict.num = 1;

      const riderEntity = createMockEntity({
        origin: new Vector(0, 0, 40),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
        flagsValue: flags.FL_ONGROUND,
        groundentity: pusherEntity,
      });
      const riderEdict = createMockEdict(riderEntity);
      riderEdict.num = 2;

      let testPositionCall = 0;

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict() {},
        },
        collision: {
          testEntityPosition(edict) {
            testCalls.push({ edict, pusherSolid: pusherEntity.solid });

            if (edict !== riderEdict) {
              return false;
            }

            testPositionCall += 1;

            if (testPositionCall === 1) {
              return true;
            }

            return false;
          },
          move(start, mins, maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
            };
          },
        },
        server: {
          num_edicts: 3,
          edicts: [worldEdict, pusherEdict, riderEdict],
          gameAPI: { time: 0 },
        },
      }), () => {
        const serverPhysics = new ServerPhysics();
        serverPhysics.pushMove(pusherEdict, 0.1);
      });

      assert.equal(blockedCalls.length, 0);
      assert.equal(testCalls.length, 2);
      assert.equal(testCalls[0].edict, riderEdict);
      assert.equal(testCalls[0].pusherSolid, solid.SOLID_BSP);
      assert.equal(testCalls[1].edict, riderEdict);
      assert.equal(testCalls[1].pusherSolid, solid.SOLID_NOT);
      assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
      assert.deepEqual([...riderEdict.entity.origin], [0, 0, 50]);
    });

    test('keeps non-rider overlaps with the current pusher blocking the move', () => {
      const testCalls = [];
      const blockedCalls = [];

      const worldEdict = createMockEdict(createMockEntity());
      worldEdict.num = 0;

      const pusherEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-64, -64, -16),
        maxs: new Vector(64, 64, 16),
        velocity: new Vector(0, 0, 100),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      pusherEntity.blocked = (blockingEntity) => {
        blockedCalls.push(blockingEntity);
      };
      const pusherEdict = createMockEdict(pusherEntity);
      pusherEdict.num = 1;

      const blockerEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_BBOX,
      });
      const blockerEdict = createMockEdict(blockerEntity);
      blockerEdict.num = 2;

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict() {},
        },
        collision: {
          testEntityPosition(edict) {
            testCalls.push({ edict, pusherSolid: pusherEntity.solid });
            return edict === blockerEdict;
          },
          move(start, mins, maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
            };
          },
        },
        server: {
          num_edicts: 3,
          edicts: [worldEdict, pusherEdict, blockerEdict],
          gameAPI: { time: 0 },
        },
      }), () => {
        const serverPhysics = new ServerPhysics();
        serverPhysics.pushMove(pusherEdict, 0.1);
      });

      assert.equal(testCalls.length, 2);
      assert.equal(testCalls[0].edict, blockerEdict);
      assert.equal(testCalls[0].pusherSolid, solid.SOLID_BSP);
      assert.equal(testCalls[1].edict, blockerEdict);
      assert.equal(testCalls[1].pusherSolid, solid.SOLID_BSP);
      assert.equal(blockedCalls.length, 1);
      assert.equal(blockedCalls[0], blockerEdict.entity);
      assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 0]);
      assert.deepEqual([...blockerEdict.entity.origin], [0, 0, 0]);
    });

    test('combines translation with non-yaw rotation when carrying riders', () => {
      const transformPointToLocal = (point, origin, basis) => {
        const delta = point.copy().subtract(origin);
        const forward = new Vector(basis[0], basis[1], basis[2]);
        const right = new Vector(basis[3], basis[4], basis[5]);
        const up = new Vector(basis[6], basis[7], basis[8]);

        return new Vector(
          delta.dot(forward),
          delta.dot(right),
          delta.dot(up),
        );
      };

      const transformPointToWorld = (point, origin, basis) => {
        const forward = new Vector(basis[0], basis[1], basis[2]);
        const right = new Vector(basis[3], basis[4], basis[5]);
        const up = new Vector(basis[6], basis[7], basis[8]);

        return origin.copy()
          .add(forward.multiply(point[0]))
          .add(right.multiply(point[1]))
          .add(up.multiply(point[2]));
      };

      withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, moveCalls, testCalls, blockedCalls }) => {
        pusherEdict.entity.velocity = new Vector(10, 0, 0);
        pusherEdict.entity.avelocity = new Vector(900, 0, 0);

        const initialOrigin = pusherEdict.entity.origin.copy();
        const initialAngles = pusherEdict.entity.angles.copy();
        const riderStart = new Vector(32, 0, 32);
        const localOffset = initialAngles.isOrigin()
          ? riderStart.copy().subtract(initialOrigin)
          : transformPointToLocal(riderStart, initialOrigin, initialAngles.toRotationMatrix());
        const expectedPusherOrigin = initialOrigin.copy().add(new Vector(1, 0, 0));
        const expectedPusherAngles = initialAngles.copy().add(new Vector(90, 0, 0));
        const expectedOrigin = transformPointToWorld(localOffset, expectedPusherOrigin, expectedPusherAngles.toRotationMatrix());

        riderEdict.entity.origin = riderStart;
        riderEdict.entity.angles = new Vector(0, 0, 0);
        riderEdict.entity.absmin = riderEdict.entity.origin.copy().add(riderEdict.entity.mins);
        riderEdict.entity.absmax = riderEdict.entity.origin.copy().add(riderEdict.entity.maxs);

        serverPhysics.pushMove(pusherEdict, 0.1);

        assert.equal(moveCalls.length, 1);
        assertNear(moveCalls[0].end[0], expectedOrigin[0], 1e-9);
        assertNear(moveCalls[0].end[1], expectedOrigin[1], 1e-9);
        assertNear(moveCalls[0].end[2], expectedOrigin[2], 1e-9);
        assertNear(riderEdict.entity.origin[0], expectedOrigin[0], 1e-9);
        assertNear(riderEdict.entity.origin[1], expectedOrigin[1], 1e-9);
        assertNear(riderEdict.entity.origin[2], expectedOrigin[2], 1e-9);
        assert.deepEqual([...riderEdict.entity.angles], [90, 0, 0]);
        assert.deepEqual([...pusherEdict.entity.origin], [1, 0, 0]);
        assert.deepEqual([...pusherEdict.entity.angles], [90, 0, 0]);
        assert.equal(testCalls.length, 1);
        assert.equal(testCalls[0], riderEdict);
        assert.equal(blockedCalls.length, 0);
      });
    });

    test('does not call blocked() for a rider resting within sub-epsilon top contact on a BSP pusher', () => {
      const blockedCalls = [];
      const pusherModel = createBoxBrushModel({ halfExtents: [64, 64, 16], name: '*plat' });
      const worldModel = createBrushWorldModel({ center: [4096, 0, 0], halfExtents: [16, 16, 16] });
      const modelSource = {
        getModelByIndex(index) {
          return index === 1 ? pusherModel : null;
        },
        getWorldEntity() {
          return null;
        },
        getWorldModel() {
          return worldModel;
        },
      };
      const area = new ServerArea(modelSource);
      area.initBoxHull();
      const collision = new ServerCollision(modelSource);
      const serverPhysics = new ServerPhysics();

      const worldEdict = createMockEdict(createMockEntity({
        movetype: moveType.MOVETYPE_NONE,
        solidType: solid.SOLID_BSP,
      }));
      worldEdict.num = 0;

      const pusherEntity = createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-64, -64, -16),
        maxs: new Vector(64, 64, 16),
        velocity: new Vector(0, 0, 100),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      pusherEntity.modelindex = 1;
      pusherEntity.blocked = (blockingEntity) => {
        blockedCalls.push(blockingEntity);
      };
      const pusherEdict = createMockEdict(pusherEntity);
      pusherEdict.num = 1;

      const riderEntity = createMockEntity({
        origin: new Vector(0, 0, 39.99),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
        flagsValue: flags.FL_ONGROUND,
        groundentity: pusherEntity,
      });
      riderEntity.classname = 'player';
      const riderEdict = createMockEdict(riderEntity);
      riderEdict.num = 2;

      withMockRegistry(defaultMockRegistry({
        maxvelocity: { value: 2000 },
        area,
        collision,
        physics: serverPhysics,
        server: {
          time: 0,
          num_edicts: 3,
          edicts: [worldEdict, pusherEdict, riderEdict],
          worldmodel: worldModel,
          navigation: { relinkEdict() {} },
          gameCapabilities: [gameCapabilities.CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK],
          gameAPI: { time: 0 },
        },
      }), () => {
        const touches = [pusherEdict, riderEdict];
        area.tree = {
          insert() {
            return { remove() {} };
          },
          queryAABB() {
            return touches;
          },
        };

        area.linkEdict(pusherEdict);
        area.linkEdict(riderEdict);
        serverPhysics.pushMove(pusherEdict, 0.1);

        assert.equal(collision.testEntityPosition(riderEdict), false);
      });

      assert.equal(blockedCalls.length, 0);
      assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
      assertNear(riderEdict.entity.origin[2], 49.99, 1e-4);
    });
  });

  describe('physicsPusher', () => {
    test('limits movement to nextthink and then runs think', () => {
      const serverPhysics = new ServerPhysics();
      const moveTimes = [];
      let observedGameTime = -1;
      let thinkCalls = 0;
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      entity.ltime = 1.0;
      entity.nextthink = 1.05;
      entity.think = () => {
        thinkCalls += 1;
      };
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        server: {
          time: 7.0,
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.pushMove = (pusher, movetime) => {
          moveTimes.push(movetime);
          pusher.entity.ltime += movetime;
        };

        serverPhysics.physicsPusher(edict);

        observedGameTime = registry.SV.server.gameAPI.time;
      });

      assert.equal(moveTimes.length, 1);
      assertNear(moveTimes[0], 0.05, 1e-9);
      assert.equal(entity.ltime, 1.05);
      assert.equal(entity.nextthink, 0.0);
      assert.equal(thinkCalls, 1);
      assert.equal(observedGameTime, 7.0);
    });

    test('keeps think deferred when nextthink is beyond this frame', () => {
      const serverPhysics = new ServerPhysics();
      const moveTimes = [];
      let observedGameTime = -1;
      let thinkCalls = 0;
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      entity.ltime = 1.0;
      entity.nextthink = 1.3;
      entity.think = () => {
        thinkCalls += 1;
      };
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        server: {
          time: 8.0,
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.pushMove = (pusher, movetime) => {
          moveTimes.push(movetime);
          pusher.entity.ltime += movetime;
        };

        serverPhysics.physicsPusher(edict);

        observedGameTime = registry.SV.server.gameAPI.time;
      });

      assert.equal(moveTimes.length, 1);
      assertNear(moveTimes[0], 0.1, 1e-9);
      assertNear(entity.ltime, 1.1, 1e-9);
      assert.equal(entity.nextthink, 1.3);
      assert.equal(thinkCalls, 0);
      assert.equal(observedGameTime, 0);
    });

    test('moves pushers for a full frame when no think is scheduled', () => {
      const serverPhysics = new ServerPhysics();
      const moveTimes = [];
      let thinkCalls = 0;
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
        avelocity: new Vector(0, 100, 0),
      });
      entity.ltime = 1.0;
      entity.nextthink = 0.0;
      entity.think = () => {
        thinkCalls += 1;
      };
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        Host: { frametime: 0.1 },
        server: {
          time: 9.0,
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.pushMove = (pusher, movetime) => {
          moveTimes.push(movetime);
          pusher.entity.ltime += movetime;
          pusher.entity.angles = pusher.entity.angles.add(pusher.entity.avelocity.copy().multiply(movetime));
        };

        serverPhysics.physicsPusher(edict);
      });

      assert.equal(moveTimes.length, 1);
      assertNear(moveTimes[0], 0.1, 1e-9);
      assertNear(entity.ltime, 1.1, 1e-9);
      assert.deepEqual([...entity.angles], [0, 10, 0]);
      assert.equal(entity.nextthink, 0.0);
      assert.equal(thinkCalls, 0);
    });
  });

  describe('checkStuck', () => {
    test('restores oldorigin when the saved position is clear', () => {
      const serverPhysics = new ServerPhysics();
      const prints = [];
      const linkCalls = [];
      let testCallCount = 0;
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      entity.oldorigin = new Vector(1, 2, 3);
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({
          area: {
            linkEdict(linkedEdict, touchTriggers) {
              linkCalls.push({ linkedEdict, touchTriggers });
            },
          },
          collision: {
            testEntityPosition() {
              testCallCount += 1;
              return testCallCount === 1;
            },
          },
        }),
        Con: {
          Print() {},
          DPrint(message) {
            prints.push(message);
          },
        },
      }, () => {
        serverPhysics.checkStuck(edict);
      });

      assert.equal(testCallCount, 2);
      assert.deepEqual([...edict.entity.origin], [1, 2, 3]);
      assert.deepEqual(prints, ['Unstuck.\n']);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0].linkedEdict, edict);
      assert.equal(linkCalls[0].touchTriggers, true);
    });

    // checkStuck tries: 1 (current pos) + 1 (oldorigin) + 18 z-levels * 3 x * 3 y = 164
    test('reports failure after exhausting all nudges', () => {
      const serverPhysics = new ServerPhysics();
      const prints = [];
      const linkCalls = [];
      let testCallCount = 0;
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      entity.oldorigin = new Vector(1, 2, 3);
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({
          area: {
            linkEdict(linkedEdict, touchTriggers) {
              linkCalls.push({ linkedEdict, touchTriggers });
            },
          },
          collision: {
            testEntityPosition() {
              testCallCount += 1;
              return true;
            },
          },
        }),
        Con: {
          Print() {},
          DPrint(message) {
            prints.push(message);
          },
        },
      }, () => {
        serverPhysics.checkStuck(edict);
      });

      assert.equal(testCallCount, 164);
      assert.deepEqual(prints, ['player is stuck.\n']);
      assert.equal(linkCalls.length, 0);
      assert.deepEqual([...edict.entity.oldorigin], [1, 2, 3]);
    });
  });

  describe('checkWater', () => {
    test('leaves entities dry when feet probe is not water', () => {
      const serverPhysics = new ServerPhysics();
      const probes = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      entity.view_ofs = new Vector(0, 0, 22);
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          pointContents(point) {
            probes.push(point.copy());
            return content.CONTENT_EMPTY;
          },
        },
      }), () => {
        assert.equal(serverPhysics.checkWater(edict), false);
      });

      assert.equal(entity.waterlevel, 0);
      assert.equal(entity.watertype, content.CONTENT_EMPTY);
      assert.equal(probes.length, 1);
      assert.deepEqual([...probes[0]], [10, 20, 7]);
    });

    test('distinguishes feet waist and head submersion', () => {
      const serverPhysics = new ServerPhysics();
      const feetEntity = createMockEntity({
        origin: new Vector(0, 0, 40),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      feetEntity.view_ofs = new Vector(0, 0, 22);
      const waistEntity = createMockEntity({
        origin: new Vector(0, 0, 40),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      waistEntity.view_ofs = new Vector(0, 0, 22);
      const headEntity = createMockEntity({
        origin: new Vector(0, 0, 40),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      headEntity.view_ofs = new Vector(0, 0, 22);

      const runCase = (entity, contents) => {
        let probeIndex = 0;

        withMockRegistry(defaultMockRegistry({
          collision: {
            pointContents() {
              const result = contents[probeIndex];
              probeIndex += 1;
              return result;
            },
          },
        }), () => {
          serverPhysics.checkWater(createMockEdict(entity));
        });
      };

      runCase(feetEntity, [content.CONTENT_WATER, content.CONTENT_EMPTY]);
      runCase(waistEntity, [content.CONTENT_WATER, content.CONTENT_WATER, content.CONTENT_EMPTY]);
      const headResult = (() => {
        let result;

        withMockRegistry(defaultMockRegistry({
          collision: {
            pointContents() {
              return content.CONTENT_WATER;
            },
          },
        }), () => {
          result = serverPhysics.checkWater(createMockEdict(headEntity));
        });

        return result;
      })();

      assert.equal(feetEntity.waterlevel, 1);
      assert.equal(feetEntity.watertype, content.CONTENT_WATER);
      assert.equal(waistEntity.waterlevel, 2);
      assert.equal(waistEntity.watertype, content.CONTENT_WATER);
      assert.equal(headEntity.waterlevel, 3);
      assert.equal(headEntity.watertype, content.CONTENT_WATER);
      assert.equal(headResult, true);
    });
  });

  describe('checkWaterTransition', () => {
    test('plays a splash and marks waist-deep water when entering from air', () => {
      const serverPhysics = new ServerPhysics();
      const startSoundCalls = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
      });
      entity.watertype = content.CONTENT_EMPTY;
      entity.waterlevel = 0;
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          pointContents() {
            return content.CONTENT_WATER;
          },
        },
        messages: {
          startSound(...args) {
            startSoundCalls.push(args);
          },
        },
      }), () => {
        serverPhysics.checkWaterTransition(edict);
      });

      assert.equal(startSoundCalls.length, 1);
      assert.equal(startSoundCalls[0][0], edict);
      assert.equal(startSoundCalls[0][2], 'misc/h2ohit1.wav');
      assert.equal(entity.watertype, content.CONTENT_WATER);
      assert.equal(entity.waterlevel, 2);
    });

    test('plays a splash and clears watertype when leaving water', () => {
      const serverPhysics = new ServerPhysics();
      const startSoundCalls = [];
      const entity = createMockEntity({
        origin: new Vector(5, 6, 7),
      });
      entity.watertype = content.CONTENT_WATER;
      entity.waterlevel = 2;
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          pointContents() {
            return content.CONTENT_EMPTY;
          },
        },
        messages: {
          startSound(...args) {
            startSoundCalls.push(args);
          },
        },
      }), () => {
        serverPhysics.checkWaterTransition(edict);
      });

      assert.equal(startSoundCalls.length, 1);
      assert.equal(startSoundCalls[0][0], edict);
      assert.equal(startSoundCalls[0][2], 'misc/h2ohit1.wav');
      assert.equal(entity.watertype, content.CONTENT_EMPTY);
      assert.equal(entity.waterlevel, content.CONTENT_EMPTY);
    });
  });

  describe('wallFriction', () => {
    test('damps tangential speed when the player is steering into a wall', () => {
      const serverPhysics = new ServerPhysics();
      const entity = createMockEntity({
        velocity: new Vector(10, 4, 3),
        angles: new Vector(),
      });
      entity.v_angle = new Vector();
      const edict = createMockEdict(entity);

      serverPhysics.wallFriction(edict, {
        plane: { normal: new Vector(-1, 0, 0) },
      });

      assert.deepEqual([...entity.velocity], [0, 2, 3]);
    });
  });

  describe('addGravity / addBuoyancy', () => {
    test('accumulate using entity gravity and frametime', () => {
      const serverPhysics = new ServerPhysics();
      const entity = createMockEntity({
        velocity: new Vector(0, 0, 10),
      });
      entity.gravity = 0.5;
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({ gravity: { value: 800 } }),
        Host: { frametime: 0.25 },
      }, () => {
        serverPhysics.addGravity(edict);
        serverPhysics.addBuoyancy(edict);
      });

      assert.deepEqual([...entity.velocity], [0, 0, -88]);
    });
  });

  describe('clipVelocity', () => {
    test('zeroes tiny residuals after clipping against an angled plane', () => {
      const serverPhysics = new ServerPhysics();
      const out = new Vector();

      serverPhysics.clipVelocity(
        new Vector(1, -1, 0.05),
        new Vector(0, 1, 0),
        out,
        1.0,
      );

      assertNear(out[0], 1.0, 1e-9);
      assert.equal(out[1], 0.0);
      assert.equal(out[2], 0.0);
    });
  });

  describe('physicsToss', () => {
    test('keeps a bounce entity moving after a hard floor impact', () => {
      const serverPhysics = new ServerPhysics();
      const entity = createMockEntity({
        origin: new Vector(0, 0, 64),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
        velocity: new Vector(0, 0, -200),
        avelocity: new Vector(0, 0, 90),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_BOUNCE,
        solidType: solid.SOLID_BBOX,
      });
      entity.gravity = 1.0;
      entity.nextthink = 0.0;
      entity.watertype = content.CONTENT_EMPTY;
      entity.waterlevel = 0;
      const floorEntity = createMockEntity({ solidType: solid.SOLID_BSP });
      const floorEdict = createMockEdict(floorEntity);
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        gravity: { value: 800 },
        maxvelocity: { value: 2000 },
        area: {
          linkEdict() {},
        },
        collision: {
          move(_start, _mins, _maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.5,
              endpos: end.copy(),
              ent: floorEdict,
              plane: { normal: new Vector(0, 0, 1), dist: 0.0 },
            };
          },
          pointContents() {
            return content.CONTENT_EMPTY;
          },
        },
        messages: {
          startSound() {},
        },
        server: {
          time: 0,
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.physicsToss(edict);
      });

      assert.equal((entity.flags & flags.FL_ONGROUND) !== 0, false);
      assert.equal(entity.groundentity, null);
      assert.deepEqual([...entity.velocity], [0, 0, 140]);
      assert.deepEqual([...entity.avelocity], [0, 0, 90]);
      assert.deepEqual([...entity.angles], [0, 0, 9]);
    });

    test('settles non-bounce tosses on walkable ground', () => {
      const serverPhysics = new ServerPhysics();
      const entity = createMockEntity({
        origin: new Vector(0, 0, 64),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
        velocity: new Vector(0, 0, -20),
        avelocity: new Vector(0, 10, 0),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_TOSS,
        solidType: solid.SOLID_BBOX,
      });
      entity.gravity = 1.0;
      entity.nextthink = 0.0;
      entity.watertype = content.CONTENT_EMPTY;
      entity.waterlevel = 0;
      const floorEntity = createMockEntity({ solidType: solid.SOLID_BSP });
      const floorEdict = createMockEdict(floorEntity);
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        gravity: { value: 800 },
        maxvelocity: { value: 2000 },
        area: {
          linkEdict() {},
        },
        collision: {
          move(_start, _mins, _maxs, end) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.5,
              endpos: end.copy(),
              ent: floorEdict,
              plane: { normal: new Vector(0, 0, 1), dist: 0.0 },
            };
          },
          pointContents() {
            return content.CONTENT_EMPTY;
          },
        },
        messages: {
          startSound() {},
        },
        server: {
          time: 0,
          gameAPI: { time: 0 },
        },
      }), () => {
        serverPhysics.physicsToss(edict);
      });

      assert.equal((entity.flags & flags.FL_ONGROUND) !== 0, true);
      assert.equal(entity.groundentity, floorEntity);
      assert.deepEqual([...entity.velocity], [0, 0, 0]);
      assert.deepEqual([...entity.avelocity], [0, 0, 0]);
      assert.deepEqual([...entity.angles], [0, 1, 0]);
    });
  });

  describe('physicsStep', () => {
    test('applies airborne step movement, links, and plays the landing sound', () => {
      const serverPhysics = new ServerPhysics();
      const soundCalls = [];
      const linkCalls = [];
      const sequence = [];
      const entity = createMockEntity({
        origin: new Vector(0, 0, 64),
        velocity: new Vector(0, 0, -100),
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);

      withMockRegistry({
        ...defaultMockRegistry({
          gravity: { value: 800 },
          area: {
            linkEdict(linkedEdict, touchTriggers) {
              linkCalls.push({ linkedEdict, touchTriggers });
            },
          },
          messages: {
            startSound(...args) {
              soundCalls.push(args);
            },
          },
        }),
        Host: { frametime: 0.1 },
      }, () => {
        serverPhysics.addGravity = () => {
          sequence.push('gravity');
        };
        serverPhysics.checkVelocity = () => {
          sequence.push('checkVelocity');
        };
        serverPhysics.flyMove = () => {
          sequence.push('flyMove');
          entity.flags |= flags.FL_ONGROUND;
          return { blocked: 0, steptrace: null };
        };
        serverPhysics.runThink = () => {
          sequence.push('runThink');
          return true;
        };
        serverPhysics.checkWaterTransition = () => {
          sequence.push('checkWaterTransition');
        };

        serverPhysics.physicsStep(edict);
      });

      assert.deepEqual(sequence, ['gravity', 'checkVelocity', 'flyMove', 'runThink', 'checkWaterTransition']);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0].linkedEdict, edict);
      assert.equal(linkCalls[0].touchTriggers, true);
      assert.equal(soundCalls.length, 1);
      assert.equal(soundCalls[0][2], 'demon/dland2.wav');
    });

    test('still runs think and water transition while already grounded', () => {
      const serverPhysics = new ServerPhysics();
      const sequence = [];
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_BBOX,
        flagsValue: flags.FL_ONGROUND,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict() {
            sequence.push('linkEdict');
          },
        },
        messages: {
          startSound() {
            sequence.push('startSound');
          },
        },
      }), () => {
        serverPhysics.addGravity = () => {
          sequence.push('gravity');
        };
        serverPhysics.checkVelocity = () => {
          sequence.push('checkVelocity');
        };
        serverPhysics.flyMove = () => {
          sequence.push('flyMove');
          return { blocked: 0, steptrace: null };
        };
        serverPhysics.runThink = () => {
          sequence.push('runThink');
          return true;
        };
        serverPhysics.checkWaterTransition = () => {
          sequence.push('checkWaterTransition');
        };

        serverPhysics.physicsStep(edict);
      });

      assert.deepEqual(sequence, ['runThink', 'checkWaterTransition']);
    });
  });

  describe('physics', () => {
    test('applies gravity and toss movement for one frame', () => {
      const linkCalls = [];
      const moveCalls = [];
      let startFrameCount = 0;
      const worldEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
      const tossEntity = createMockEntity({
        origin: new Vector(0, 0, 100),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
        velocity: new Vector(10, 0, 0),
        avelocity: new Vector(),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_TOSS,
        solidType: solid.SOLID_BBOX,
      });
      tossEntity.nextthink = 0;
      tossEntity.gravity = 1.0;
      tossEntity.watertype = 0;
      tossEntity.waterlevel = 0;
      tossEntity.view_ofs = new Vector(0, 0, 22);
      tossEntity.oldorigin = tossEntity.origin.copy();
      const tossEdict = createMockEdict(tossEntity);
      tossEdict.num = 1;

      withMockRegistry(defaultMockRegistry({
        gravity: { value: 800 },
        maxvelocity: { value: 2000 },
        area: {
          linkEdict(edict) {
            edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
            edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
            linkCalls.push(edict);
          },
        },
        collision: {
          move(start, mins, maxs, end) {
            moveCalls.push({ start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
              plane: { normal: new Vector(), dist: 0.0 },
            };
          },
          pointContents() {
            return content.CONTENT_EMPTY;
          },
        },
        messages: {
          startSound() {},
        },
        clientPhysics: {
          physicsClient() {},
        },
        server: {
          time: 0,
          num_edicts: 2,
          edicts: [worldEdict, tossEdict],
          gameAPI: {
            time: 0,
            force_retouch: 0,
            startFrame() {
              startFrameCount += 1;
            },
          },
        },
      }), () => {
        const serverPhysics = new ServerPhysics();
        serverPhysics.physics();

        assert.equal(startFrameCount, 1);
        assert.equal(moveCalls.length, 1);
        assert.deepEqual([...moveCalls[0].end], [1, 0, 92]);
        assert.deepEqual([...tossEntity.origin], [1, 0, 92]);
        assert.deepEqual([...tossEntity.velocity], [10, 0, -80]);
        assert.equal(linkCalls.length, 1);
      });
    });
  });
});
