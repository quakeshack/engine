import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { content, flags, solid } from '../../source/shared/Defs.ts';
import { ServerMovement } from '../../source/engine/server/physics/ServerMovement.ts';

import {
  assertNear,
  createMockEdict,
  createMockEntity,
  defaultMockRegistry,
  withMockRegistry,
} from './fixtures.mjs';

describe('ServerMovement', () => {
  describe('checkBottom', () => {
    test('returns early when all four corners are solid', () => {
      const movement = new ServerMovement();
      const moveCalls = [];
      const cornerChecks = [];
      const entity = createMockEntity({
        origin: new Vector(64, 64, 32),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          pointContents(point) {
            cornerChecks.push(point.copy());
            return content.CONTENT_SOLID;
          },
          move(...args) {
            moveCalls.push(args);
            return null;
          },
        },
      }), () => {
        assert.equal(movement.checkBottom(edict), true);
      });

      assert.equal(cornerChecks.length, 4);
      assert.equal(moveCalls.length, 0);
    });

    test('rejects support when a corner drops more than step size', () => {
      const movement = new ServerMovement();
      const moveCalls = [];
      let pointContentCalls = 0;
      const entity = createMockEntity({
        origin: new Vector(64, 64, 32),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        collision: {
          pointContents() {
            pointContentCalls += 1;
            return content.CONTENT_EMPTY;
          },
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });

            if (moveCalls.length === 1) {
              return {
                fraction: 0.5,
                endpos: new Vector(start[0], start[1], 0),
              };
            }

            return {
              fraction: 0.5,
              endpos: new Vector(start[0], start[1], -19),
            };
          },
        },
      }), () => {
        assert.equal(movement.checkBottom(edict), false);
      });

      assert.equal(pointContentCalls, 1);
      assert.equal(moveCalls.length, 2);
    });
  });

  describe('movestep', () => {
    test('preserves horizontal progress on partial ground fallback', () => {
      const movement = new ServerMovement();
      const linkCalls = [];
      const moveCalls = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        flagsValue: flags.FL_PARTIALGROUND | flags.FL_ONGROUND,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict(linkedEdict, touchTriggers) {
            linkCalls.push({ linkedEdict, touchTriggers });
          },
        },
        collision: {
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              ent: null,
            };
          },
        },
      }), () => {
        const moved = movement.movestep(edict, new Vector(4, -6, 0), true);
        assert.equal(moved, true);
      });

      assert.equal(moveCalls.length, 1);
      assert.deepEqual([...edict.entity.origin], [14, 14, 30]);
      assert.equal((edict.entity.flags & flags.FL_ONGROUND) !== 0, false);
      assert.equal((edict.entity.flags & flags.FL_PARTIALGROUND) !== 0, true);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0].linkedEdict, edict);
      assert.equal(linkCalls[0].touchTriggers, true);
    });

    test('returns false when both the raised trace and retry stay startsolid', () => {
      const movement = new ServerMovement();
      const linkCalls = [];
      const moveCalls = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        flagsValue: flags.FL_ONGROUND,
      });
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict(linkedEdict, touchTriggers) {
            linkCalls.push({ linkedEdict, touchTriggers });
          },
        },
        collision: {
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });

            return {
              allsolid: false,
              startsolid: true,
              fraction: 0.0,
              endpos: end.copy(),
              ent: null,
            };
          },
        },
      }), () => {
        assert.equal(movement.movestep(edict, new Vector(4, -6, 0), true), false);
      });

      assert.equal(moveCalls.length, 2);
      assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
      assert.equal(linkCalls.length, 0);
    });
  });

  describe('stepDirection', () => {
    test('restores origin when yaw delta stays too large', () => {
      const movement = new ServerMovement();
      const linkCalls = [];
      const entity = createMockEntity({
        origin: new Vector(10, 20, 30),
        angles: new Vector(0, 200, 0),
      });
      entity.yaw_speed = 0;
      const edict = createMockEdict(entity);

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict(linkedEdict, touchTriggers) {
            linkCalls.push({ linkedEdict, touchTriggers });
          },
        },
      }), () => {
        movement.movestep = (ent, move) => {
          ent.entity.origin = ent.entity.origin.copy().add(move);
          return true;
        };

        const stepped = movement.stepDirection(edict, 0, 8);
        assert.equal(stepped, true);
      });

      assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
      assert.equal(edict.entity.ideal_yaw, 0);
      assert.equal(edict.entity.angles[1], 200);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0].linkedEdict, edict);
      assert.equal(linkCalls[0].touchTriggers, true);
    });
  });

  describe('moveToGoal', () => {
    test('returns false when already close enough to a non-world enemy goal', () => {
      const movement = new ServerMovement();
      const actor = createMockEdict(createMockEntity({ flagsValue: flags.FL_ONGROUND }));
      const goal = createMockEdict(createMockEntity());
      const enemy = createMockEdict(createMockEntity());
      enemy.isWorld = () => false;

      actor.entity.goalentity = { edict: goal };
      actor.entity.enemy = { edict: enemy };

      movement.closeEnough = () => true;
      movement.stepDirection = () => {
        throw new Error('stepDirection should not run when already close enough');
      };
      movement.newChaseDir = () => {
        throw new Error('newChaseDir should not run when already close enough');
      };

      assert.equal(movement.moveToGoal(actor, 16), false);
    });

    test('uses the direct stepDirection to movestep chain when the ideal yaw step succeeds', () => {
      const movement = new ServerMovement();
      const linkCalls = [];
      const moveCalls = [];
      const callOrder = [];
      const actor = createMockEdict(createMockEntity({
        origin: new Vector(10, 20, 30),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        angles: new Vector(0, 90, 0),
        flagsValue: flags.FL_ONGROUND,
      }));
      actor.entity.yaw_speed = 360;
      actor.entity.ideal_yaw = 90;
      actor.entity.goalentity = { edict: createMockEdict(createMockEntity({ origin: new Vector(10, 120, 30) })) };
      actor.entity.enemy = null;

      const groundEntity = createMockEntity({ solidType: solid.SOLID_BSP });
      const groundEdict = createMockEdict(groundEntity);

      const originalStepDirection = movement.stepDirection.bind(movement);
      movement.stepDirection = (...args) => {
        callOrder.push('stepDirection');
        return originalStepDirection(...args);
      };

      const originalMovestep = movement.movestep.bind(movement);
      movement.movestep = (...args) => {
        callOrder.push('movestep');
        return originalMovestep(...args);
      };

      const originalNewChaseDir = movement.newChaseDir.bind(movement);
      movement.newChaseDir = (...args) => {
        callOrder.push('newChaseDir');
        return originalNewChaseDir(...args);
      };

      const originalRandom = Math.random;
      Math.random = () => 0.0;
      try {
        withMockRegistry(defaultMockRegistry({
          area: {
            linkEdict(linkedEdict, touchTriggers) {
              linkCalls.push({ linkedEdict, touchTriggers });
            },
          },
          collision: {
            pointContents() {
              return content.CONTENT_SOLID;
            },
            move(start, mins, maxs, end, type, passedict) {
              moveCalls.push({ start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy(), type, passedict });
              return {
                allsolid: false,
                startsolid: false,
                fraction: 0.5,
                endpos: new Vector(10, 32, 30),
                ent: groundEdict,
              };
            },
          },
        }), () => {
          assert.equal(movement.moveToGoal(actor, 12), false);
        });
      } finally {
        Math.random = originalRandom;
      }

      assert.deepEqual(callOrder, ['stepDirection', 'movestep']);
      assert.equal(moveCalls.length, 1);
      assert.deepEqual([...actor.entity.origin], [10, 32, 30]);
      assert.equal(actor.entity.ideal_yaw, 90);
      assert.equal(actor.entity.angles[1], 90);
      assert.equal(actor.entity.groundentity, groundEntity);
      assert.equal((actor.entity.flags & flags.FL_PARTIALGROUND) !== 0, false);
      assert.equal(linkCalls.length, 1);
      assert.equal(linkCalls[0].linkedEdict, actor);
      assert.equal(linkCalls[0].touchTriggers, true);
    });

    test('falls back to newChaseDir when stepDirection fails', () => {
      const movement = new ServerMovement();
      const actor = createMockEdict(createMockEntity({ flagsValue: flags.FL_ONGROUND }));
      const goal = createMockEdict(createMockEntity({ origin: new Vector(100, 50, 0) }));
      const explicitTarget = new Vector(12, 34, 56);
      const originalRandom = Math.random;
      const calls = [];

      actor.entity.goalentity = { edict: goal };
      actor.entity.enemy = null;
      actor.entity.ideal_yaw = 90;

      movement.stepDirection = (ent, yaw, dist) => {
        calls.push({ kind: 'step', ent, yaw, dist });
        return false;
      };
      movement.newChaseDir = (ent, target, dist) => {
        calls.push({ kind: 'chase', ent, target: target.copy(), dist });
      };

      Math.random = () => 0.0;
      try {
        assert.equal(movement.moveToGoal(actor, 24, explicitTarget), true);
      } finally {
        Math.random = originalRandom;
      }

      assert.equal(calls.length, 2);
      assert.equal(calls[0].kind, 'step');
      assert.equal(calls[0].yaw, 90);
      assert.equal(calls[0].dist, 24);
      assert.equal(calls[1].kind, 'chase');
      assert.deepEqual([...calls[1].target], [...explicitTarget]);
      assert.equal(calls[1].dist, 24);
    });

    test('falls through to newChaseDir and then succeeds via stepDirection plus movestep', () => {
      const movement = new ServerMovement();
      const linkCalls = [];
      const moveCalls = [];
      const stepAngles = [];
      const actor = createMockEdict(createMockEntity({
        origin: new Vector(0, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        angles: new Vector(0, 180, 0),
        flagsValue: flags.FL_ONGROUND,
      }));
      actor.entity.yaw_speed = 360;
      actor.entity.ideal_yaw = 180;
      actor.entity.goalentity = { edict: createMockEdict(createMockEntity({ origin: new Vector(100, 100, 0) })) };
      actor.entity.enemy = null;

      const groundEntity = createMockEntity({ solidType: solid.SOLID_BSP });
      const groundEdict = createMockEdict(groundEntity);

      const originalStepDirection = movement.stepDirection.bind(movement);
      movement.stepDirection = (ent, yaw, dist) => {
        stepAngles.push(yaw);
        return originalStepDirection(ent, yaw, dist);
      };

      const originalRandom = Math.random;
      Math.random = () => 0.0;
      try {
        withMockRegistry(defaultMockRegistry({
          area: {
            linkEdict(linkedEdict, touchTriggers) {
              linkCalls.push({ linkedEdict, touchTriggers });
            },
          },
          collision: {
            pointContents() {
              return content.CONTENT_SOLID;
            },
            move(start, mins, maxs, end, type, passedict) {
              moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });

              if (end[0] < 0) {
                return {
                  allsolid: true,
                  startsolid: false,
                  fraction: 0.0,
                  endpos: end.copy(),
                  ent: null,
                };
              }

              return {
                allsolid: false,
                startsolid: false,
                fraction: 0.5,
                endpos: new Vector(Math.SQRT1_2 * 12, Math.SQRT1_2 * 12, 0),
                ent: groundEdict,
              };
            },
          },
        }), () => {
          assert.equal(movement.moveToGoal(actor, 12), true);
        });
      } finally {
        Math.random = originalRandom;
      }

      assert.deepEqual(stepAngles, [180, 45]);
      assert.equal(moveCalls.length, 2);
      assertNear(actor.entity.origin[0], Math.SQRT1_2 * 12, 1e-6);
      assertNear(actor.entity.origin[1], Math.SQRT1_2 * 12, 1e-6);
      assert.equal(actor.entity.origin[2], 0);
      assert.equal(actor.entity.ideal_yaw, 45);
      assert.equal(actor.entity.angles[1], 45);
      assert.equal(actor.entity.groundentity, groundEntity);
      assert.equal(linkCalls.length, 2);
      assert.equal(linkCalls[0].linkedEdict, actor);
      assert.equal(linkCalls[1].linkedEdict, actor);
    });
  });

  describe('newChaseDir', () => {
    test('restores old yaw and marks partial ground when every direction fails', () => {
      const movement = new ServerMovement();
      const actor = createMockEdict(createMockEntity({
        origin: new Vector(0, 0, 0),
        flagsValue: flags.FL_ONGROUND,
      }));
      const attemptedDirs = [];
      const originalRandom = Math.random;

      actor.entity.ideal_yaw = 90;

      movement.stepDirection = (_actor, dir) => {
        attemptedDirs.push(dir);
        return false;
      };
      movement.checkBottom = () => false;

      let randomCall = 0;
      Math.random = () => {
        randomCall += 1;
        return 0.0;
      };
      try {
        movement.newChaseDir(actor, new Vector(100, 100, 0), 12);
      } finally {
        Math.random = originalRandom;
      }

      assert.equal(randomCall, 2);
      assert.equal(actor.entity.ideal_yaw, 90);
      assert.equal((actor.entity.flags & flags.FL_PARTIALGROUND) !== 0, true);
      assert.deepEqual(attemptedDirs, [45, 0, 90, 90, 315, 225, 180, 135, 90, 45, 0, 270]);
    });
  });

  describe('walkMove', () => {
    test('returns false when entity is not grounded, flying, or swimming', () => {
      const movement = new ServerMovement();
      const actor = createMockEdict(createMockEntity({ flagsValue: 0 }));

      movement.movestep = () => {
        throw new Error('movestep should not run when walkMove gating fails');
      };

      assert.equal(movement.walkMove(actor, 90, 16), false);
    });
  });

  describe('changeYaw', () => {
    test('wraps and clamps using the shortest turn direction', () => {
      const movement = new ServerMovement();
      const actor = createMockEdict(createMockEntity({ angles: new Vector(0, 350, 0) }));
      actor.entity.yaw_speed = 5;
      actor.entity.ideal_yaw = 10;

      assert.equal(movement.changeYaw(actor), 355);

      actor.entity.angles[1] = 10;
      actor.entity.ideal_yaw = 350;

      assert.equal(movement.changeYaw(actor), 5);
    });
  });
});
