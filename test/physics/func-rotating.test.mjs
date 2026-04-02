import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveType, solid } from '../../source/shared/Defs.ts';
import { entityClasses } from '../../source/game/id1/GameAPI.mjs';

const RotatingEntity = entityClasses.find((entityClass) => entityClass.classname === 'func_rotating');

assert.ok(RotatingEntity, 'func_rotating must be registered in GameAPI');

/**
 *
 */
function createRotatingEntityFixture() {
  const modelMins = new Vector(-16, -16, -16);
  const modelMaxs = new Vector(16, 16, 16);
  const precachedModels = [];
  const edict = {
    num: 1,
    entity: null,
    setOrigin(origin) {
      const entity = this.entity;
      entity.origin.set(origin);
      entity.absmin = origin.copy().add(entity.mins);
      entity.absmax = origin.copy().add(entity.maxs);
    },
    setModel(modelname) {
      const entity = this.entity;
      entity.model = modelname;
      entity.modelindex = modelname ? 1 : 0;
      entity.mins.set(modelMins);
      entity.maxs.set(modelMaxs);
      entity.size = modelMaxs.copy().subtract(modelMins);
      entity.absmin = entity.origin.copy().add(entity.mins);
      entity.absmax = entity.origin.copy().add(entity.maxs);
    },
    setMinMaxSize(mins, maxs) {
      const entity = this.entity;
      entity.mins.set(mins);
      entity.maxs.set(maxs);
      entity.size = maxs.copy().subtract(mins);
      entity.absmin = entity.origin.copy().add(entity.mins);
      entity.absmax = entity.origin.copy().add(entity.maxs);
    },
    equals(other) {
      return this === other;
    },
    freeEdict() {},
    walkMove() {
      return false;
    },
    changeYaw() {
      return 0;
    },
    dropToFloor() {
      return true;
    },
    isOnTheFloor() {
      return false;
    },
    makeStatic() {},
    aim() {
      return new Vector();
    },
    getNextBestClient() {
      return null;
    },
  };

  const engine = {
    IsLoading() {
      return false;
    },
    PrecacheModel(modelname) {
      precachedModels.push(modelname);
    },
    PrecacheSound() {},
    StartSound() {},
    SpawnAmbientSound() {},
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    ParseQC() {
      return null;
    },
    Traceline() {
      return null;
    },
    SetAreaPortalState() {},
    GetCvar() {
      return { value: 0 };
    },
  };

  const gameAPI = {
    engine,
    time: 0,
  };

  const entity = new RotatingEntity(edict, gameAPI);
  edict.entity = entity;

  entity.model = '*rotating';

  return { entity, precachedModels };
}

describe('RotatingEntity', () => {
  test('starts spinning on spawn when START_ON is set', () => {
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

  test('maps axis flags to the engine Euler components and toggles with use', () => {
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

      entity.use(null);
      assert.deepEqual([...entity.avelocity], expected);
      assert.equal(entity._isRotating, true);

      entity.use(null);
      assert.deepEqual([...entity.avelocity], [0, 0, 0]);
      assert.equal(entity._isRotating, false);
    }
  });

  test('inflicts configured damage on touch and stops on block when requested', () => {
    const { entity } = createRotatingEntityFixture();
    const damageCalls = [];
    const victim = {
      _damageHandler: {
        damage(...args) {
          damageCalls.push(args);
        },
      },
      centerPoint: new Vector(4, 5, 6),
      origin: new Vector(1, 2, 3),
    };

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
