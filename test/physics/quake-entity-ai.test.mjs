import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { worldType } from '../../source/game/id1/Defs.mjs';
import { entityClasses } from '../../source/game/id1/GameAPI.mjs';

const OgreEntity = entityClasses.find((entityClass) => entityClass.classname === 'monster_ogre');

assert.ok(OgreEntity, 'monster_ogre must be registered in GameAPI');

/**
 * @returns {InstanceType<typeof OgreEntity>} monster fixture with a minimal engine API
 */
function createMonsterVisibilityFixture() {
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
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 0,
    worldspawn: {
      worldtype: worldType.MEDIEVAL,
    },
    gameAI: {
      _sightEntity: null,
      _sightEntityTime: 0,
    },
  };

  const entity = new OgreEntity(edict, gameAPI);
  edict.entity = entity;

  return entity;
}

void describe('QuakeEntityAI._isVisible', () => {
  void test('treats a clear ignoreMonsters traceline as visible even when no entity is returned', () => {
    const entity = createMonsterVisibilityFixture();
    const target = createMonsterVisibilityFixture();

    entity.engine.Traceline = () => ({
      fraction: 1.0,
      entity: null,
      contents: {
        inOpen: false,
        inWater: false,
      },
    });

    assert.equal(entity._ai._isVisible(target), true);
  });

  void test('rejects blocked sight lines when the trace stops short', () => {
    const entity = createMonsterVisibilityFixture();
    const target = createMonsterVisibilityFixture();

    entity.engine.Traceline = () => ({
      fraction: 0.5,
      entity: null,
      contents: {
        inOpen: false,
        inWater: false,
      },
    });

    assert.equal(entity._ai._isVisible(target), false);
  });
});
