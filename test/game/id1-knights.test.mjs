import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';

await import('../../source/game/id1/GameAPI.ts');

const { channel, tentType } = await import('../../source/game/id1/Defs.ts');
const { HellKnightMonster, KnightMonster, KnightSpike } = await import('../../source/game/id1/entity/monster/Knights.ts');

KnightMonster._initStates();
HellKnightMonster._initStates();

function createMonsterFixture(MonsterClass, gameOverrides = {}) {
  const soundCalls = [];
  const spawnRequests = [];
  const edict = { entity: null };
  const engine = {
    IsLoading() {
      return false;
    },
    ParseQC() {
      return null;
    },
    PrecacheSound() {
    },
    PrecacheModel() {
    },
    SpawnEntity(classname, initialData = {}) {
      spawnRequests.push({ classname, initialData });
      return { entity: null };
    },
    DispatchTempEntityEvent() {
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    eventBus: {
      publish() {
      },
    },
  };
  const gameAPI = {
    engine,
    time: 10,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
    gravity: 800,
    hasFeature() {
      return false;
    },
    ...gameOverrides,
  };

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector();
  entity.view_ofs = new Vector();
  entity.movedir = new Vector();
  entity.startSound = (...args) => {
    soundCalls.push(args);
  };

  return { entity, gameAPI, soundCalls, spawnRequests };
}

function assertVectorNear(actual, expected, epsilon = 1e-6) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `component ${i} mismatch: ${actual[i]} !== ${expected[i]}`);
  }
}

void describe('KnightMonster metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(KnightMonster.classname, 'monster_knight');
    assert.equal(KnightMonster._health, 75);
    assert.equal(KnightMonster._modelDefault, 'progs/knight.mdl');
    assert.equal(KnightMonster._modelHead, 'progs/h_knight.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = KnightMonster._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-16, -16, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [16, 16, 40]);
  });
});

void describe('KnightMonster state machine', () => {
  void test('core movement sequences loop', () => {
    const states = KnightMonster._states;
    assert.equal(states.knight_stand9.nextState, 'knight_stand1');
    assert.equal(states.knight_walk14.nextState, 'knight_walk1');
    assert.equal(states.knight_run8.nextState, 'knight_run1');
  });

  void test('combat and death chains return or terminate correctly', () => {
    const states = KnightMonster._states;
    assert.equal(states.knight_runatk11.nextState, 'knight_run1');
    assert.equal(states.knight_atk10.nextState, 'knight_run1');
    assert.equal(states.knight_pain3.nextState, 'knight_run1');
    assert.equal(states.knight_painb11.nextState, 'knight_run1');
    assert.equal(states.knight_die10.nextState, null);
    assert.equal(states.knight_dieb11.nextState, null);
  });

  void test('bow states keep the kneel loop and return to walking', () => {
    const states = KnightMonster._states;
    assert.equal(states.knight_bow5.nextState, 'knight_bow5');
    assert.equal(states.knight_bow10.nextState, 'knight_walk1');
  });

  void test('sequence-generated handlers remain present on knight states', () => {
    const states = KnightMonster._states;
    assert.equal(typeof states.knight_runatk2.handler, 'function');
    assert.equal(typeof states.knight_bow1.handler, 'function');
    assert.equal(typeof states.knight_die1.handler, 'function');
    assert.equal(typeof states.knight_pain2.handler, 'function');
  });

  void test('thinkMelee keeps the legacy distance split between melee and run attack', () => {
    const { entity } = createMonsterFixture(KnightMonster);
    const runStates = [];

    entity._runState = (state) => {
      runStates.push(state);
      return true;
    };

    entity.enemy = {
      origin: new Vector(60, 0, 0),
      view_ofs: new Vector(),
    };
    entity.thinkMelee();

    entity.enemy = {
      origin: new Vector(120, 0, 0),
      view_ofs: new Vector(),
    };
    entity.thinkMelee();

    entity.enemy = null;
    entity.thinkMelee();

    assert.deepEqual(runStates, ['knight_atk1', 'knight_runatk1', 'knight_atk1']);
  });
});

void describe('KnightSpike metadata', () => {
  void test('projectile metadata matches the original spike', () => {
    assert.equal(KnightSpike.classname, 'knightspike');
    assert.equal(KnightSpike._damage, 9);
    assert.equal(KnightSpike._tentType, tentType.TE_SPIKE);
    assert.equal(KnightSpike._model, 'progs/k_spike.mdl');
  });
});

void describe('HellKnightMonster metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(HellKnightMonster.classname, 'monster_hell_knight');
    assert.equal(HellKnightMonster._health, 250);
    assert.equal(HellKnightMonster._modelDefault, 'progs/hknight.mdl');
    assert.equal(HellKnightMonster._modelHead, 'progs/h_hellkn.mdl');
  });
});

void describe('HellKnightMonster state machine', () => {
  void test('core movement sequences loop', () => {
    const states = HellKnightMonster._states;
    assert.equal(states.hknight_stand9.nextState, 'hknight_stand1');
    assert.equal(states.hknight_walk20.nextState, 'hknight_walk1');
    assert.equal(states.hknight_run8.nextState, 'hknight_run1');
  });

  void test('missile and charge chains return as expected', () => {
    const states = HellKnightMonster._states;
    assert.equal(states.hknight_magica14.nextState, 'hknight_run1');
    assert.equal(states.hknight_magicb13.nextState, 'hknight_run1');
    assert.equal(states.hknight_magicc11.nextState, 'hknight_run1');
    assert.equal(states.hknight_char_a16.nextState, 'hknight_run1');
    assert.equal(states.hknight_char_b6.nextState, 'hknight_char_b1');
    assert.equal(states.hknight_slice10.nextState, 'hknight_run1');
    assert.equal(states.hknight_smash11.nextState, 'hknight_run1');
    assert.equal(states.hknight_watk22.nextState, 'hknight_run1');
  });

  void test('death chains terminate correctly', () => {
    const states = HellKnightMonster._states;
    assert.equal(states.hknight_die12.nextState, null);
    assert.equal(states.hknight_dieb9.nextState, null);
  });

  void test('sequence-generated handlers remain present on hell knight states', () => {
    const states = HellKnightMonster._states;
    assert.equal(typeof states.hknight_run1.handler, 'function');
    assert.equal(typeof states.hknight_char_b1.handler, 'function');
    assert.equal(typeof states.hknight_pain2.handler, 'function');
    assert.equal(typeof states.hknight_dieb1.handler, 'function');
  });

  void test('attackShot preserves the projectile spawn contract and aimed movedir', () => {
    const { entity, soundCalls, spawnRequests } = createMonsterFixture(HellKnightMonster);
    const originalRandom = Math.random;

    entity.origin = new Vector(5, -10, 20);
    entity.enemy = {
      origin: new Vector(45, 10, 20),
    };

    Math.random = () => 0.5;

    try {
      entity.attackShot(2);
    } finally {
      Math.random = originalRandom;
    }

    const offsetAngles = entity.enemy.origin.copy().subtract(entity.origin).toAngles();
    offsetAngles[1] += 12;
    const { forward } = offsetAngles.angleVectors();
    forward.normalize();
    forward[2] = -forward[2];

    assert.equal(spawnRequests.length, 1);
    assert.equal(spawnRequests[0].classname, KnightSpike.classname);
    assert.equal(spawnRequests[0].initialData.speed, 300);
    assert.equal(spawnRequests[0].initialData.owner, entity);
    assert.equal(soundCalls.length, 1);
    assert.deepEqual(soundCalls[0].slice(0, 2), [channel.CHAN_WEAPON, 'hknight/attack1.wav']);
    assertVectorNear(entity.movedir, forward);
  });
});
