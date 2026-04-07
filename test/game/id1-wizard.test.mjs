import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { range } from '../../source/game/id1/Defs.ts';
import { ATTACK_STATE } from '../../source/game/id1/helper/AI.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: WizardMonsterEntity } = await import('../../source/game/id1/entity/monster/Wizard.ts');

WizardMonsterEntity._initStates();

/**
 * Create a minimal Wizard fixture for focused behavior tests.
 * @param {typeof WizardMonsterEntity} MonsterClass Monster constructor under test.
 * @returns {WizardMonsterEntity} Monster fixture instance.
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
    time: 5,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
  };

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector();
  entity.angles = new Vector();
  entity.enemy = {
    origin: new Vector(128, 0, 0),
    velocity: new Vector(),
    view_ofs: new Vector(0, 0, 22),
    mins: new Vector(-16, -16, -24),
    size: new Vector(32, 32, 56),
    health: 100,
  };

  return entity;
}

void describe('WizardMonsterEntity metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(WizardMonsterEntity.classname, 'monster_wizard');
    assert.equal(WizardMonsterEntity._health, 80);
    assert.equal(WizardMonsterEntity._modelDefault, 'progs/wizard.mdl');
    assert.equal(WizardMonsterEntity._modelHead, 'progs/h_wizard.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = WizardMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-16, -16, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [16, 16, 40]);
  });
});

void describe('WizardMonsterEntity state machine', () => {
  void test('stand, walk, side, and run loops match the QuakeC frame counts', () => {
    const states = WizardMonsterEntity._states;

    for (let i = 1; i <= 8; i++) {
      assert.equal(states[`wiz_stand${i}`].keyframe, `hover${i}`);
      assert.equal(states[`wiz_walk${i}`].keyframe, `hover${i}`);
      assert.equal(states[`wiz_side${i}`].keyframe, `hover${i}`);
    }
    assert.equal(states.wiz_stand8.nextState, 'wiz_stand1');
    assert.equal(states.wiz_walk8.nextState, 'wiz_walk1');
    assert.equal(states.wiz_side8.nextState, 'wiz_side1');

    for (let i = 1; i <= 14; i++) {
      assert.equal(states[`wiz_run${i}`].keyframe, `fly${i}`);
    }
    assert.equal(states.wiz_run14.nextState, 'wiz_run1');
  });

  void test('fast attack, pain, and death chains keep the original frame ordering', () => {
    const states = WizardMonsterEntity._states;

    assert.equal(states.wiz_fast1.keyframe, 'magatt1');
    assert.equal(states.wiz_fast7.keyframe, 'magatt5');
    assert.equal(states.wiz_fast8.keyframe, 'magatt4');
    assert.equal(states.wiz_fast10.keyframe, 'magatt2');
    assert.equal(states.wiz_fast10.nextState, 'wiz_run1');

    for (let i = 1; i <= 4; i++) {
      assert.equal(states[`wiz_pain${i}`].keyframe, `pain${i}`);
    }
    assert.equal(states.wiz_pain4.nextState, 'wiz_run1');

    for (let i = 1; i <= 8; i++) {
      assert.equal(states[`wiz_death${i}`].keyframe, `death${i}`);
    }
    assert.equal(states.wiz_death8.nextState, null);
  });
});

void describe('WizardMonsterEntity QC fixes', () => {
  void test('pain can fail to flinch on low damage', () => {
    const wizard = createMonsterFixture(WizardMonsterEntity);
    const originalRandom = Math.random;
    let stateName = null;

    wizard.startSound = () => {};
    wizard._ai = {
      foundTarget() {},
    };
    wizard._runState = (nextState) => {
      stateName = nextState;
      return true;
    };

    try {
      Math.random = () => 0.99;
      wizard.thinkPain({ origin: new Vector() }, 10);
    } finally {
      Math.random = originalRandom;
    }

    assert.equal(stateName, null);
  });

  void test('pain still flinches when the damage check succeeds', () => {
    const wizard = createMonsterFixture(WizardMonsterEntity);
    const originalRandom = Math.random;
    let stateName = null;

    wizard.startSound = () => {};
    wizard._ai = {
      foundTarget() {},
    };
    wizard._runState = (nextState) => {
      stateName = nextState;
      return true;
    };

    try {
      Math.random = () => 0;
      wizard.thinkPain({ origin: new Vector() }, 10);
    } finally {
      Math.random = originalRandom;
    }

    assert.equal(stateName, 'wiz_pain1');
  });

  void test('attack finish applies the original cooldown and resumes straight movement at mid range', () => {
    const wizard = createMonsterFixture(WizardMonsterEntity);
    let stateName = null;

    wizard._ai = {
      enemyRange: range.RANGE_MID,
      enemyIsVisible: true,
      _attackState: ATTACK_STATE.AS_MISSILE,
    };
    wizard._runState = (nextState) => {
      stateName = nextState;
      return true;
    };

    wizard._attackFinished();

    assert.equal(wizard.attack_finished, 7);
    assert.equal(wizard._ai._attackState, ATTACK_STATE.AS_STRAIGHT);
    assert.equal(stateName, 'wiz_run1');
  });

  void test('attack finish switches to sliding movement at close visible range', () => {
    const wizard = createMonsterFixture(WizardMonsterEntity);
    let stateName = null;

    wizard._ai = {
      enemyRange: range.RANGE_NEAR,
      enemyIsVisible: true,
      _attackState: ATTACK_STATE.AS_MISSILE,
    };
    wizard._runState = (nextState) => {
      stateName = nextState;
      return true;
    };

    wizard._attackFinished();

    assert.equal(wizard._ai._attackState, ATTACK_STATE.AS_SLIDING);
    assert.equal(stateName, 'wiz_side1');
  });
});
