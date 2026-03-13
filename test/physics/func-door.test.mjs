import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { worldType } from '../../source/game/id1/Defs.mjs';
import { entityClasses } from '../../source/game/id1/GameAPI.mjs';

const DoorEntity = entityClasses.find((entityClass) => entityClass.classname === 'func_door');

assert.ok(DoorEntity, 'func_door must be registered in GameAPI');

/**
 * @returns {{entity: InstanceType<DoorEntity>, gameAPI: {engine: object, time: number, worldspawn: {worldtype: number}}}} door test fixture
 */
function createDoorEntityFixture() {
  const edict = {
    num: 1,
    entity: null,
    equals(other) {
      return this === other;
    },
    freeEdict() {},
    setOrigin() {},
    setModel() {},
    setMinMaxSize() {},
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
      return null;
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
    SpawnEntity() {
      return { entity: null };
    },
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
    worldspawn: {
      worldtype: worldType.MEDIEVAL,
    },
  };

  const entity = new DoorEntity(edict, gameAPI);
  edict.entity = entity;
  entity.noise1 = 'doors/drclos4.wav';
  entity.noise2 = 'doors/doormv1.wav';
  entity.wait = 3.0;

  return { entity, gameAPI };
}

describe('DoorEntity', () => {
  test('resets the scheduled go-down think when reopening a door that is already at the top', () => {
    const { entity } = createDoorEntityFixture();
    const activator = { centerPoint: null };

    entity.ltime = 10.0;
    entity._doorHitTop();

    assert.equal(entity._scheduledThinks.length, 1);
    assert.equal(entity._scheduledThinks[0].identifier, 'door-go-down');
    assert.equal(entity._scheduledThinks[0].nextThink, 13.0);
    assert.equal(entity.nextthink, 13.0);

    entity.ltime = 11.5;
    entity._doorGoUp(activator);

    assert.equal(entity._scheduledThinks.length, 1);
    assert.equal(entity._scheduledThinks[0].identifier, 'door-go-down');
    assert.equal(entity._scheduledThinks[0].nextThink, 14.5);
    assert.equal(entity.nextthink, 14.5);
  });
});
