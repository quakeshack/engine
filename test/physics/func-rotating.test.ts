import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveType, solid } from '../../source/shared/Defs.ts';
// The game's entity modules import each other in a cycle that only resolves when its entry point is loaded first.
import '../../source/game/id1/GameAPI.ts';
import type BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import { RotatingEntity } from '../../source/game/id1/entity/props/Platforms.ts';
import { createBoundedEdict, createInertEngineApi, createInertGameApi } from '../support/entityMocks.ts';

/**
 * Create a minimal rotating-entity fixture.
 * @returns The entity, and the names of the models it precached.
 */
function createRotatingEntityFixture(): { entity: RotatingEntity; precachedModels: string[] } {
  const precachedModels: string[] = [];
  const edict = createBoundedEdict();
  const gameAPI = createInertGameApi({}, createInertEngineApi({
    PrecacheModel(modelname: string) {
      precachedModels.push(modelname);
    },
  }));

  const entity = new RotatingEntity(edict, gameAPI);
  edict.entity = entity;

  entity.model = '*rotating';

  return { entity, precachedModels };
}

void describe('RotatingEntity', () => {
  void test('starts spinning on spawn when START_ON is set', () => {
    const { entity, precachedModels } = createRotatingEntityFixture();
    entity.spawnflags = RotatingEntity.START_ON;
    entity.speed = 180;

    entity.spawn();

    assert.equal(entity.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(entity.solid, solid.SOLID_BSP);
    assert.deepEqual([...entity.avelocity], [0, 180, 0]);
    assert.equal(entity._isRotating, true);
    assert.deepEqual(precachedModels, []);
  });

  void test('maps axis flags to the engine Euler components and toggles with use', () => {
    const cases = [
      { spawnflags: RotatingEntity.X_AXIS, expected: [0, 0, 90] },
      { spawnflags: RotatingEntity.Y_AXIS, expected: [90, 0, 0] },
      { spawnflags: 0, expected: [0, 90, 0] },
      { spawnflags: RotatingEntity.REVERSE, expected: [0, -90, 0] },
    ];

    for (const { spawnflags, expected } of cases) {
      const { entity } = createRotatingEntityFixture();
      entity.spawnflags = spawnflags;
      entity.speed = 90;

      entity.spawn();

      assert.deepEqual([...entity.avelocity], [0, 0, 0]);

      // A rotating entity does not look at who used it, so it can be used by itself.
      entity.use(entity);
      assert.deepEqual([...entity.avelocity], expected);
      assert.equal(entity._isRotating, true);

      entity.use(entity);
      assert.deepEqual([...entity.avelocity], [0, 0, 0]);
      assert.equal(entity._isRotating, false);
    }
  });

  void test('inflicts configured damage on touch and stops on block when requested', () => {
    const { entity } = createRotatingEntityFixture();
    const damageCalls: unknown[][] = [];
    // Only the damage handler and the position of the touched entity are read.
    const victim = {
      _damageHandler: {
        damage(...args: unknown[]) {
          damageCalls.push(args);
        },
      },
      centerPoint: new Vector(4, 5, 6),
      origin: new Vector(1, 2, 3),
    } as unknown as BaseEntity;

    entity.spawnflags = RotatingEntity.START_ON | RotatingEntity.TOUCH_PAIN | RotatingEntity.STOP;
    entity.dmg = 5;

    entity.spawn();
    entity.touch(victim);
    entity.blocked(victim);
    entity.touch(victim);

    assert.equal(damageCalls.length, 2);
    assert.equal(damageCalls[0][2], 5);
    assert.equal(damageCalls[1][2], 5);
    assert.deepEqual([...entity.avelocity], [0, 0, 0]);
    assert.equal(entity._isRotating, false);
  });
});
