import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../source/game/id1/GameAPI.ts');

const { tentType } = await import('../../source/game/id1/Defs.ts');
const { HellKnightMonster, KnightMonster, KnightSpike } = await import('../../source/game/id1/entity/monster/Knights.ts');

KnightMonster._initStates();
HellKnightMonster._initStates();

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
});
