import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { entityClasses } from '../../source/game/id1/GameAPI.mjs';

const TrainEntity = entityClasses.find((entityClass) => entityClass.classname === 'func_train');

assert.ok(TrainEntity, 'func_train must be registered in GameAPI');

/**
 * @returns {{entity: InstanceType<TrainEntity>, gameAPI: {engine: object, time: number}}} train test fixture
 */
function createTrainEntityFixture() {
  const modelMins = new Vector(-16, -16, -16);
  const modelMaxs = new Vector(16, 16, 16);
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
    PrecacheModel() {},
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

  const entity = new TrainEntity(edict, gameAPI);
  edict.entity = entity;

  return { entity, gameAPI };
}

describe('TrainEntity', () => {
  test('uses attack_finished for blocked damage cooldown without mutating nextthink', () => {
    const { entity, gameAPI } = createTrainEntityFixture();
    const damageCalls = [];
    const victim = {
      _damageHandler: {
        damage(...args) {
          damageCalls.push(args);
        },
      },
      origin: new Vector(10, 20, 30),
    };

    entity.dmg = 90;
    entity.nextthink = 3.25;
    entity.attack_finished = 0.0;

    entity.blocked(victim);
    entity.blocked(victim);

    assert.equal(damageCalls.length, 1);
    assert.equal(damageCalls[0][2], 90);
    assert.equal(entity.attack_finished, 0.5);
    assert.equal(entity.nextthink, 3.25);

    gameAPI.time = 0.49;
    entity.blocked(victim);
    assert.equal(damageCalls.length, 1);
    assert.equal(entity.attack_finished, 0.5);
    assert.equal(entity.nextthink, 3.25);

    gameAPI.time = 0.5;
    entity.blocked(victim);
    assert.equal(damageCalls.length, 2);
    assert.equal(entity.attack_finished, 1.0);
    assert.equal(entity.nextthink, 3.25);
  });
});
