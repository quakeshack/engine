import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';

import { flags, items, worldType } from '../../source/game/id1/Defs.mjs';
import { entityClasses } from '../../source/game/id1/GameAPI.mjs';

const OgreEntity = entityClasses.find((entityClass) => entityClass.classname === 'monster_ogre');
const PlayerCtor = entityClasses.find((entityClass) => entityClass.classname === 'player');

assert.ok(OgreEntity, 'monster_ogre must be registered in GameAPI');
assert.ok(PlayerCtor, 'player must be registered in GameAPI');

/**
 * Create a minimal edict stub for AI tests.
 * @param {number} num Edict slot number.
 * @returns {object} Mock edict.
 */
function createMockEdict(num) {
  return {
    num,
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
    moveToGoal() {
      return false;
    },
    isInPXS() {
      return true;
    },
  };
}

/**
 * Create the minimal engine surface required by the AI harness.
 * @returns {object} Mock engine API.
 */
function createMockEngine() {
  return {
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
    GetPHS() {
      return null;
    },
    GetAreaForPoint() {
      return 0;
    },
    AreasConnected() {
      return true;
    },
    NavigateAsync() {
      return Promise.resolve(null);
    },
    ConsoleDebug() {},
    eventBus: {
      publish() {},
    },
  };
}

/**
 * Create shared game-wide AI state for the harness.
 * @returns {object} Mock game AI state.
 */
function createMockGameAI() {
  return {
    _sightEntity: null,
    _sightEntityTime: 0,
    _sightEntityLastOrigin: new Vector(),
  };
}

/**
 * @returns {InstanceType<typeof OgreEntity>} monster fixture with a minimal engine API
 */
function createMonsterVisibilityFixture() {
  const edict = createMockEdict(1);
  const engine = createMockEngine();

  const gameAPI = {
    engine,
    time: 1,
    coop: 0,
    worldspawn: {
      worldtype: worldType.MEDIEVAL,
    },
    gameAI: createMockGameAI(),
  };

  const entity = new OgreEntity(edict, gameAPI);
  edict.entity = entity;

  entity.health = 200;
  entity.origin = new Vector();
  entity.view_ofs = new Vector();
  entity.angles = new Vector();
  entity.enemy = null;
  entity.goalentity = null;
  entity.movetarget = null;
  entity.show_hostile = 0;
  entity.spawnflags = 0;
  entity.effects = 0;
  entity.flags = 0;
  entity.items = 0;
  entity.ideal_yaw = 0;
  entity.attack_finished = 0;
  entity.nextthink = 0;
  entity.yaw_speed = 20;
  entity.pausetime = Infinity;
  entity.sightSound = () => {};
  entity.thinkRun = () => {};
  entity.thinkStand = () => {};
  entity.thinkWalk = () => {};
  entity._scheduleThink = (...args) => {
    entity._scheduledThinkArgs = args;
  };
  entity.attackFinished = (delay) => {
    entity.attack_finished = gameAPI.time + delay;
  };
  entity.getNextBestClient = () => null;

  return entity;
}

/**
 * Create a player fixture compatible with the monster AI routines.
 * @returns {InstanceType<typeof PlayerCtor>} Mock player entity.
 */
function createPlayerFixture() {
  const edict = createMockEdict(2);
  const engine = createMockEngine();

  const gameAPI = {
    engine,
    time: 0,
    coop: 0,
    worldspawn: {
      worldtype: worldType.MEDIEVAL,
    },
    gameAI: createMockGameAI(),
    stats: {
      sendToPlayer() {},
    },
  };

  const player = new PlayerCtor(edict, gameAPI);
  edict.entity = player;

  player.health = 100;
  player.origin = new Vector(64, 0, 0);
  player.view_ofs = new Vector(0, 0, 22);
  player.flags = flags.FL_CLIENT;
  player.effects = 0;
  player.items = 0;
  player.show_hostile = 0;

  return player;
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

void describe('QuakeEntityAI.findTarget', () => {
  void test('acquires a visible player and schedules a run state', () => {
    const monster = createMonsterVisibilityFixture();
    const player = createPlayerFixture();

    monster.getNextBestClient = () => player;
    monster.engine.Traceline = () => ({
      fraction: 1.0,
      entity: null,
      contents: {
        inOpen: false,
        inWater: false,
      },
    });

    const found = monster._ai.findTarget();

    assert.equal(found, true);
    assert.equal(monster.enemy, player);
    assert.equal(monster.goalentity, player);
    assert.equal(monster.show_hostile, monster.game.time + 1.0);
    assert.deepEqual(monster.game.gameAI._sightEntityLastOrigin, player.origin);
    assert.equal(monster._scheduledThinkArgs[0], monster.game.time + 0.05);
    assert.equal(typeof monster._scheduledThinkArgs[1], 'function');
    assert.equal(monster._scheduledThinkArgs[2], 'animation-state-machine');
  });

  void test('rejects invisible players before visibility and range checks', () => {
    const monster = createMonsterVisibilityFixture();
    const player = createPlayerFixture();

    player.items = items.IT_INVISIBILITY;

    let visibilityChecks = 0;
    monster.getNextBestClient = () => player;
    monster.engine.Traceline = () => {
      visibilityChecks += 1;
      return {
        fraction: 1.0,
        entity: null,
        contents: {
          inOpen: false,
          inWater: false,
        },
      };
    };

    const found = monster._ai.findTarget();

    assert.equal(found, false);
    assert.equal(monster.enemy, null);
    assert.equal(visibilityChecks, 0);
  });

  void test('ignores undefined client lookups without throwing', () => {
    const monster = createMonsterVisibilityFixture();

    monster.getNextBestClient = () => undefined;

    assert.doesNotThrow(() => {
      assert.equal(monster._ai.findTarget(), false);
    });
    assert.equal(monster.enemy, null);
  });
});
