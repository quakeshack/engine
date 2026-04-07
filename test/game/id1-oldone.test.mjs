import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { damage, moveType, solid } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: OldOneMonster } = await import('../../source/game/id1/entity/monster/OldOne.ts');

OldOneMonster._initStates();

/**
 * Create a minimal OldOne fixture for focused behavior tests.
 * @param {typeof OldOneMonster} MonsterClass Monster constructor under test.
 * @param {object} [gameOverrides] Optional game API overrides.
 * @returns {OldOneMonster} Monster fixture instance.
 */
function createMonsterFixture(MonsterClass, gameOverrides = {}) {
  const edict = {
    num: 1,
    entity: null,
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
    moveToGoal() {
      return false;
    },
    isInPXS() {
      return true;
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
    ParseQC() {
      return null;
    },
    StartSound() {},
    SpawnEntity() {
      return { entity: null };
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    DispatchTempEntityEvent() {},
    Lightstyle() {},
    PlayTrack() {},
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 10,
    deathmatch: 0,
    nomonsters: 0,
    intermission_running: 0,
    intermission_exittime: 0,
    ...gameOverrides,
  };

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector(10, 20, 30);
  entity.angles = new Vector();

  return entity;
}

void describe('OldOneMonster metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(OldOneMonster.classname, 'monster_oldone');
    assert.equal(OldOneMonster._modelDefault, 'progs/oldone.mdl');
    assert.ok(Array.isArray(OldOneMonster.serializableFields));
    assert.ok(Object.isFrozen(OldOneMonster.serializableFields));
  });

  void test('thrash light levels preserve the QuakeC sequence', () => {
    assert.deepEqual(OldOneMonster._thrashLightLevels, ['m', 'k', 'k', 'i', 'g', 'e', 'c', 'a', 'c', 'e', 'g', 'i', 'k', 'm', 'm', 'g', 'c', 'b', 'a', 'a']);
  });
});

void describe('OldOneMonster state machine', () => {
  void test('idle sequence keeps all 46 frames and loops', () => {
    const states = OldOneMonster._states;

    for (let i = 1; i <= 46; i++) {
      assert.equal(states[`old_idle${i}`].keyframe, `old${i}`);
    }
    assert.equal(states.old_idle46.nextState, 'old_idle1');
  });

  void test('thrash sequence keeps the duplicate shake12 frame and terminal loop', () => {
    const states = OldOneMonster._states;

    for (let i = 1; i <= 11; i++) {
      assert.equal(states[`old_thrash${i}`].keyframe, `shake${i}`);
    }
    assert.equal(states.old_thrash12.keyframe, 'shake12');
    assert.equal(states.old_thrash13.keyframe, 'shake13');
    assert.equal(states.old_thrash20.keyframe, 'shake20');
    assert.equal(states.old_thrash20.nextState, 'old_thrash20');
  });
});

void describe('OldOneMonster QC fixes', () => {
  void test('pain resets health so only the telefrag finale can kill the boss', () => {
    const oldOne = createMonsterFixture(OldOneMonster);

    oldOne.health = 1;
    oldOne.thinkPain();

    assert.equal(oldOne.health, 40000);
  });

  void test('thrash15 restarts the cycle until the third pass', () => {
    const oldOne = createMonsterFixture(OldOneMonster);
    const lightStyles = [];
    let stateName = null;

    oldOne.engine.Lightstyle = (_style, level) => {
      lightStyles.push(level);
    };
    oldOne._runState = (nextState) => {
      stateName = nextState;
      return true;
    };

    oldOne._thrash15Callback();
    assert.equal(oldOne.cnt, 1);
    assert.deepEqual(lightStyles, ['m']);
    assert.equal(stateName, 'old_thrash1');

    stateName = null;
    oldOne.cnt = 2;
    oldOne._thrash15Callback();
    assert.equal(oldOne.cnt, 3);
    assert.equal(stateName, null);
  });

  void test('spawn sets the classic boss bounds and telefrag-only health', () => {
    const oldOne = createMonsterFixture(OldOneMonster);
    let stateName = null;
    let published = null;

    oldOne._runState = (nextState) => {
      stateName = nextState;
      return true;
    };
    oldOne.engine.eventBus.publish = (eventName, entity) => {
      published = { eventName, entity };
    };

    oldOne.spawn();

    assert.equal(oldOne.movetype, moveType.MOVETYPE_STEP);
    assert.equal(oldOne.solid, solid.SOLID_SLIDEBOX);
    assert.equal(oldOne.health, 40000);
    assert.equal(oldOne.takedamage, damage.DAMAGE_YES);
    assert.equal(stateName, 'old_idle1');
    assert.deepEqual(published, { eventName: 'game.monster.spawned', entity: oldOne });
  });

  void test('finale4 tolerates a stand-in edict without an entity', () => {
    const oldOne = createMonsterFixture(OldOneMonster);
    let playTrack = null;
    const lightStyles = [];
    let removed = false;

    oldOne.engine.SpawnEntity = (classname) => {
      if (classname === 'misc_null') {
        return { entity: null };
      }

      return { entity: null };
    };
    oldOne.engine.PlayTrack = (track) => {
      playTrack = track;
    };
    oldOne.engine.Lightstyle = (_style, level) => {
      lightStyles.push(level);
    };
    oldOne.remove = () => {
      removed = true;
    };

    assert.doesNotThrow(() => {
      oldOne._finale4();
    });

    assert.equal(playTrack, 3);
    assert.deepEqual(lightStyles, ['m']);
    assert.equal(removed, true);
  });
});
