import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { entityClasses } from '../../source/game/id1/GameAPI.ts';

const PlatformEntity = entityClasses.find((entityClass) => entityClass.classname === 'func_plat');

assert.ok(PlatformEntity, 'func_plat must be registered in GameAPI');

/**
 * @returns {{entity: InstanceType<PlatformEntity>, gameAPI: {engine: object, time: number}}} plat test fixture
 */
function createPlatformEntityFixture() {
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
  };

  const entity = new PlatformEntity(edict, gameAPI);
  edict.entity = entity;
  entity.noise = 'plats/plat1.wav';
  entity.noise1 = 'plats/plat2.wav';

  return { entity, gameAPI };
}

void describe('PlatformEntity', () => {
  void test('extends the scheduled go-down think instead of leaving a stale queue entry', () => {
    const { entity } = createPlatformEntityFixture();

    entity.ltime = 5.0;
    entity._hitTop();

    assert.equal(entity._scheduledThinks.length, 1);
    assert.equal(entity._scheduledThinks[0].identifier, 'plat-go-down');
    assert.equal(entity._scheduledThinks[0].nextThink, 8.0);
    assert.equal(entity.nextthink, 8.0);

    entity.ltime = 7.25;
    entity._keepUp();

    assert.equal(entity._scheduledThinks.length, 1);
    assert.equal(entity._scheduledThinks[0].identifier, 'plat-go-down');
    assert.equal(entity._scheduledThinks[0].nextThink, 8.25);
    assert.equal(entity.nextthink, 8.25);
  });
});
