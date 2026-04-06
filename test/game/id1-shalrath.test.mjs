import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { effect } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: ShalrathMonsterEntity, ShalrathMissileEntity } = await import('../../source/game/id1/entity/monster/Shalrath.mjs');

ShalrathMonsterEntity._initStates();

/**
 * Create a minimal Shalrath fixture for focused behavior tests.
 * @param {typeof ShalrathMonsterEntity} MonsterClass Monster constructor under test.
 * @returns {ShalrathMonsterEntity} Monster fixture instance.
 */
function createMonsterFixture(MonsterClass) {
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
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 0,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
  };

  const entity = new MonsterClass(edict, gameAPI);
  edict.entity = entity;
  entity.origin = new Vector(10, 20, 30);
  entity.angles = new Vector();
  entity.enemy = {
    origin: new Vector(90, 20, 30),
    health: 100,
  };

  return entity;
}

void describe('ShalrathMonsterEntity metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(ShalrathMonsterEntity.classname, 'monster_shalrath');
    assert.equal(ShalrathMonsterEntity._health, 400);
    assert.equal(ShalrathMonsterEntity._modelDefault, 'progs/shalrath.mdl');
    assert.equal(ShalrathMonsterEntity._modelHead, 'progs/h_shal.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = ShalrathMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-32, -32, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [32, 32, 64]);
  });
});

void describe('ShalrathMonsterEntity state machine', () => {
  void test('walk and run loops match the QuakeC frame counts', () => {
    const states = ShalrathMonsterEntity._states;

    assert.equal(states.shal_stand.keyframe, 'walk1');
    assert.equal(states.shal_stand.nextState, 'shal_stand');

    for (let i = 1; i <= 12; i++) {
      assert.ok(states[`shal_walk${i}`], `missing shal_walk${i}`);
      assert.ok(states[`shal_run${i}`], `missing shal_run${i}`);
    }
    assert.equal(states.shal_walk12.nextState, 'shal_walk1');
    assert.equal(states.shal_run12.nextState, 'shal_run1');
  });

  void test('attack, pain, and death chains keep the original frame counts', () => {
    const states = ShalrathMonsterEntity._states;

    for (let i = 1; i <= 11; i++) {
      assert.equal(states[`shal_attack${i}`].keyframe, `attack${i}`);
    }
    assert.equal(states.shal_attack11.nextState, 'shal_run1');

    for (let i = 1; i <= 5; i++) {
      assert.equal(states[`shal_pain${i}`].keyframe, `pain${i}`);
    }
    assert.equal(states.shal_pain5.nextState, 'shal_run1');

    for (let i = 1; i <= 7; i++) {
      assert.equal(states[`shal_death${i}`].keyframe, `death${i}`);
    }
    assert.equal(states.shal_death7.nextState, null);
  });
});

void describe('ShalrathMonsterEntity QC fixes', () => {
  void test('launchMissile adds muzzleflash, plays attack2, and spawns a missile', () => {
    const shalrath = createMonsterFixture(ShalrathMonsterEntity);
    const spawned = [];
    const sounds = [];

    shalrath.engine.SpawnEntity = (classname, initialData) => {
      spawned.push({ classname, initialData });
      return { entity: null };
    };
    shalrath.startSound = (_channel, soundName) => {
      sounds.push(soundName);
    };

    shalrath.launchMissile();

    assert.equal((shalrath.effects & effect.EF_MUZZLEFLASH) !== 0, true);
    assert.deepEqual(sounds, ['shalrath/attack2.wav']);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].classname, ShalrathMissileEntity.classname);
    assert.equal(spawned[0].initialData.owner, shalrath);
  });

  void test('missile spawn starts above the owner and adds the classic spin', () => {
    const owner = createMonsterFixture(ShalrathMonsterEntity);
    const edict = {
      num: 2,
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

    const missile = new ShalrathMissileEntity(edict, owner.game);
    edict.entity = missile;
    missile.owner = owner;
    owner.movedir = new Vector(1, 0, 0);

    missile.spawn();

    assert.deepEqual([missile.origin[0], missile.origin[1], missile.origin[2]], [10, 20, 40]);
    assert.deepEqual([missile.avelocity[0], missile.avelocity[1], missile.avelocity[2]], [300, 300, 300]);
    assert.equal(Math.round(missile.velocity.len()), 400);
  });
});
