import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../source/game/id1/GameAPI.ts');

const { default: DogMonsterEntity } = await import('../../source/game/id1/entity/monster/Dog.ts');

DogMonsterEntity._initStates();

void describe('DogMonsterEntity class metadata', () => {
  void test('classname is monster_dog', () => {
    assert.equal(DogMonsterEntity.classname, 'monster_dog');
  });

  void test('health is 25', () => {
    assert.equal(DogMonsterEntity._health, 25);
  });

  void test('models are precached from dog assets', () => {
    assert.equal(DogMonsterEntity._modelDefault, 'progs/dog.mdl');
    assert.equal(DogMonsterEntity._modelHead, 'progs/h_dog.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = DogMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-32, -32, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [32, 32, 40]);
  });

  void test('serializableFields is a frozen array from @entity', () => {
    assert.ok(Array.isArray(DogMonsterEntity.serializableFields));
    assert.ok(Object.isFrozen(DogMonsterEntity.serializableFields));
    assert.deepEqual(DogMonsterEntity.serializableFields, ['_isLeaping']);
  });
});

void describe('DogMonsterEntity state machine', () => {
  void test('_states is populated after _initStates', () => {
    assert.ok(DogMonsterEntity._states !== null);
    assert.equal(typeof DogMonsterEntity._states, 'object');
  });

  void test('stand sequence has 9 frames that loop', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 9; i++) {
      const key = `dog_stand${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `stand${i}`);
    }
    assert.equal(states.dog_stand9.nextState, 'dog_stand1');
  });

  void test('walk sequence has 8 frames that loop', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 8; i++) {
      const key = `dog_walk${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `walk${i}`);
    }
    assert.equal(states.dog_walk8.nextState, 'dog_walk1');
  });

  void test('run sequence has 12 frames that loop', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 12; i++) {
      const key = `dog_run${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `run${i}`);
    }
    assert.equal(states.dog_run12.nextState, 'dog_run1');
  });

  void test('attack sequence has 8 frames ending at dog_run1', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 8; i++) {
      const key = `dog_atta${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `attack${i}`);
    }
    assert.equal(states.dog_atta8.nextState, 'dog_run1');
  });

  void test('leap sequence has 9 frames ending at dog_run1', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 9; i++) {
      const key = `dog_leap${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `leap${i}`);
    }
    assert.equal(states.dog_leap9.nextState, 'dog_run1');
  });

  void test('pain sequences end at dog_run1', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 6; i++) {
      const key = `dog_pain${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `pain${i}`);
    }
    assert.equal(states.dog_pain6.nextState, 'dog_run1');

    for (let i = 1; i <= 16; i++) {
      const key = `dog_painb${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `painb${i}`);
    }
    assert.equal(states.dog_painb16.nextState, 'dog_run1');
  });

  void test('death sequences do not loop', () => {
    const states = DogMonsterEntity._states;
    for (let i = 1; i <= 9; i++) {
      const key = `dog_die${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `death${i}`);
    }
    assert.equal(states.dog_die9.nextState, null);

    for (let i = 1; i <= 9; i++) {
      const key = `dog_dieb${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `deathb${i}`);
    }
    assert.equal(states.dog_dieb9.nextState, null);
  });

  void test('active states keep handlers and passive states omit them', () => {
    const states = DogMonsterEntity._states;

    for (const name of ['dog_stand1', 'dog_walk1', 'dog_run1', 'dog_atta1', 'dog_leap1', 'dog_leap2', 'dog_painb1', 'dog_painb2']) {
      assert.equal(typeof states[name].handler, 'function', `${name} handler should be a function`);
    }

    for (const name of ['dog_leap9', 'dog_pain1', 'dog_pain6', 'dog_painb16', 'dog_die1', 'dog_die9', 'dog_dieb1', 'dog_dieb9']) {
      assert.equal(states[name].handler, null, `${name} handler should be omitted`);
    }
  });
});
