import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: ShamblerMonsterEntity } = await import('../../source/game/id1/entity/monster/Shambler.ts');

ShamblerMonsterEntity._initStates();

/**
 * Create a minimal Shambler fixture for focused behavior tests.
 * @param {typeof ShamblerMonsterEntity} MonsterClass Monster constructor under test.
 * @returns {ShamblerMonsterEntity} Monster fixture instance.
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
    DispatchTempEntityEvent() {},
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

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector();
  entity.angles = new Vector();
  entity.enemy = null;

  return entity;
}

void describe('ShamblerMonsterEntity metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(ShamblerMonsterEntity.classname, 'monster_shambler');
    assert.equal(ShamblerMonsterEntity._health, 600);
    assert.equal(ShamblerMonsterEntity._modelDefault, 'progs/shambler.mdl');
    assert.equal(ShamblerMonsterEntity._modelHead, 'progs/h_shams.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = ShamblerMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-32, -32, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [32, 32, 64]);
  });
});

void describe('ShamblerMonsterEntity state machine', () => {
  void test('stand, walk, and run loops match the QuakeC frame counts', () => {
    const states = ShamblerMonsterEntity._states;

    for (let i = 1; i <= 17; i++) {
      assert.equal(states[`sham_stand${i}`].keyframe, `stand${i}`);
    }
    assert.equal(states.sham_stand17.nextState, 'sham_stand1');

    for (let i = 1; i <= 12; i++) {
      assert.equal(states[`sham_walk${i}`].keyframe, `walk${i}`);
    }
    assert.equal(states.sham_walk12.nextState, 'sham_walk1');

    for (let i = 1; i <= 6; i++) {
      assert.equal(states[`sham_run${i}`].keyframe, `run${i}`);
    }
    assert.equal(states.sham_run6.nextState, 'sham_run1');
  });

  void test('melee chains return to the run loop', () => {
    const states = ShamblerMonsterEntity._states;

    for (let i = 1; i <= 12; i++) {
      assert.equal(states[`sham_smash${i}`].keyframe, `smash${i}`);
    }
    assert.equal(states.sham_smash12.nextState, 'sham_run1');

    for (let i = 1; i <= 9; i++) {
      assert.equal(states[`sham_swingl${i}`].keyframe, `swingl${i}`);
      assert.equal(states[`sham_swingr${i}`].keyframe, `swingr${i}`);
    }
    assert.equal(states.sham_swingl9.nextState, 'sham_run1');
    assert.equal(states.sham_swingr9.nextState, 'sham_run1');
  });

  void test('magic sequence keeps the legacy extra magic3 state and skips directly to magic9', () => {
    const states = ShamblerMonsterEntity._states;

    assert.equal(states.sham_magic1.keyframe, 'magic1');
    assert.equal(states.sham_magic2.keyframe, 'magic2');
    assert.equal(states.sham_magic3.keyframe, 'magic3');
    assert.equal(states.sham_magic3.nextState, 'sham_magic3b');
    assert.equal(states.sham_magic3b.keyframe, 'magic3');
    assert.equal(states.sham_magic3b.nextState, 'sham_magic4');
    assert.equal(states.sham_magic4.keyframe, 'magic4');
    assert.equal(states.sham_magic5.keyframe, 'magic5');
    assert.equal(states.sham_magic6.keyframe, 'magic6');
    assert.equal(states.sham_magic6.nextState, 'sham_magic9');
    assert.equal(states.sham_magic9.keyframe, 'magic9');
    assert.equal(states.sham_magic10.keyframe, 'magic10');
    assert.equal(states.sham_magic11.keyframe, 'magic11');
    assert.equal(states.sham_magic12.keyframe, 'magic12');
    assert.equal(states.sham_magic12.nextState, 'sham_run1');
  });

  void test('pain and death sequences transition correctly', () => {
    const states = ShamblerMonsterEntity._states;

    for (let i = 1; i <= 6; i++) {
      assert.equal(states[`sham_pain${i}`].keyframe, `pain${i}`);
    }
    assert.equal(states.sham_pain6.nextState, 'sham_run1');

    for (let i = 1; i <= 11; i++) {
      assert.equal(states[`sham_death${i}`].keyframe, `death${i}`);
    }
    assert.equal(states.sham_death11.nextState, null);
  });

  void test('active states keep handlers while passive pain and death frames omit them', () => {
    const states = ShamblerMonsterEntity._states;

    for (const name of ['sham_stand1', 'sham_walk12', 'sham_run6', 'sham_smash10', 'sham_swingl7', 'sham_swingr7', 'sham_magic1', 'sham_magic3', 'sham_magic3b', 'sham_magic11']) {
      assert.equal(typeof states[name].handler, 'function', `${name} handler should be a function`);
    }

    for (const name of ['sham_pain1', 'sham_pain6', 'sham_magic12']) {
      assert.equal(states[name].handler, null, `${name} handler should be omitted`);
    }

    for (const name of ['sham_death1', 'sham_death11']) {
      assert.equal(typeof states[name].handler, 'function', `${name} handler should be a function`);
    }
  });
});

void describe('ShamblerMonsterEntity QC fixes', () => {
  void test('castLightning does not replay the boom sound on every pulse', () => {
    const shambler = createMonsterFixture(ShamblerMonsterEntity);
    let soundCalls = 0;
    let beamCalls = 0;

    shambler.enemy = {
      origin: new Vector(64, 0, 0),
    };
    shambler._ai.face = () => {};
    shambler.startSound = () => {
      soundCalls += 1;
    };
    shambler.traceline = () => ({
      point: new Vector(64, 0, 0),
    });
    shambler._damageInflictor = {
      lightningDamage() {},
      dispatchBeamEvent() {
        beamCalls += 1;
      },
    };

    shambler.castLightning();

    assert.equal(soundCalls, 0);
    assert.equal(beamCalls, 1);
  });
});
