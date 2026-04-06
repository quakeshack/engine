import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Establish correct ESM evaluation order — GameAPI is the production entry point.
await import('../../source/game/id1/GameAPI.ts');

const { default: FishMonsterEntity } = await import('../../source/game/id1/entity/monster/Fish.ts');

// _initStates is normally called by the game registry during bootstrap.
// In unit tests we trigger it manually so the state machine is available.
FishMonsterEntity._initStates();

void describe('FishMonsterEntity class metadata', () => {
  void test('classname is monster_fish', () => {
    assert.equal(FishMonsterEntity.classname, 'monster_fish');
  });

  void test('health is 25', () => {
    assert.equal(FishMonsterEntity._health, 25);
  });

  void test('model default is progs/fish.mdl', () => {
    assert.equal(FishMonsterEntity._modelDefault, 'progs/fish.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = FishMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-16, -16, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [16, 16, 24]);
  });

  void test('serializableFields is a frozen array from @entity', () => {
    assert.ok(Array.isArray(FishMonsterEntity.serializableFields));
    assert.ok(Object.isFrozen(FishMonsterEntity.serializableFields));
  });
});

void describe('FishMonsterEntity state machine', () => {
  void test('_states is populated after _initStates', () => {
    assert.ok(FishMonsterEntity._states !== null);
    assert.equal(typeof FishMonsterEntity._states, 'object');
  });

  void test('stand sequence has 18 frames that loop', () => {
    const states = FishMonsterEntity._states;
    // f_stand1 through f_stand18, last loops to f_stand1
    for (let i = 1; i <= 18; i++) {
      const key = `f_stand${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `swim${i}`);
    }
    assert.equal(states.f_stand18.nextState, 'f_stand1');
  });

  void test('walk sequence has 18 frames that loop', () => {
    const states = FishMonsterEntity._states;
    for (let i = 1; i <= 18; i++) {
      const key = `f_walk${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `swim${i}`);
    }
    assert.equal(states.f_walk18.nextState, 'f_walk1');
  });

  void test('run sequence uses odd swim frames and loops', () => {
    const states = FishMonsterEntity._states;
    // 9 run frames: swim1, swim3, swim5, ..., swim17
    const expectedKeyframes = [1, 3, 5, 7, 9, 11, 13, 15, 17];
    for (let i = 0; i < 9; i++) {
      const key = `f_run${i + 1}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `swim${expectedKeyframes[i]}`);
    }
    assert.equal(states.f_run9.nextState, 'f_run1');
  });

  void test('attack sequence has 18 frames ending at f_run1', () => {
    const states = FishMonsterEntity._states;
    for (let i = 1; i <= 18; i++) {
      const key = `f_atta${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `attack${i}`);
    }
    // Last attack frame transitions to run, not loop
    assert.equal(states.f_atta18.nextState, 'f_run1');
  });

  void test('death sequence has 21 frames and does not loop', () => {
    const states = FishMonsterEntity._states;
    for (let i = 1; i <= 21; i++) {
      const key = `f_death${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `death${i}`);
    }
    // Last death frame has no next state
    assert.equal(states.f_death21.nextState, null);
  });

  void test('pain sequence has 9 frames ending at f_run1', () => {
    const states = FishMonsterEntity._states;
    for (let i = 1; i <= 9; i++) {
      const key = `f_pain${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `pain${i}`);
    }
    assert.equal(states.f_pain9.nextState, 'f_run1');
  });

  void test('all state handlers are functions', () => {
    const states = FishMonsterEntity._states;
    for (const [name, state] of Object.entries(states)) {
      assert.equal(typeof state.handler, 'function', `${name} handler should be a function`);
    }
  });
});
