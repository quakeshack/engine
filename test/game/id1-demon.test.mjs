import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../source/game/id1/GameAPI.ts');

const { default: DemonMonster } = await import('../../source/game/id1/entity/monster/Demon.ts');

DemonMonster._initStates();

void describe('DemonMonster class metadata', () => {
  void test('classname is monster_demon1', () => {
    assert.equal(DemonMonster.classname, 'monster_demon1');
  });

  void test('health is 300', () => {
    assert.equal(DemonMonster._health, 300);
  });

  void test('models are precached from demon assets', () => {
    assert.equal(DemonMonster._modelDefault, 'progs/demon.mdl');
    assert.equal(DemonMonster._modelHead, 'progs/h_demon.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = DemonMonster._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-32, -32, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [32, 32, 64]);
  });

  void test('serializableFields is a frozen array from @entity', () => {
    const { serializableFields } = /** @type {{ serializableFields: unknown }} */ (/** @type {unknown} */ (DemonMonster));
    assert.ok(Array.isArray(serializableFields));
    assert.ok(Object.isFrozen(serializableFields));
    assert.deepEqual(serializableFields, ['_isLeaping']);
  });
});

void describe('DemonMonster state machine', () => {
  void test('_states is populated after _initStates', () => {
    assert.ok(DemonMonster['_states'] !== null);
    assert.equal(typeof DemonMonster['_states'], 'object');
  });

  void test('stand sequence has 13 frames that loop', () => {
    const states = DemonMonster['_states'];
    for (let i = 1; i <= 13; i++) {
      const key = `demon1_stand${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `stand${i}`);
    }
    assert.equal(states.demon1_stand13.nextState, 'demon1_stand1');
  });

  void test('walk and run sequences loop', () => {
    const states = DemonMonster['_states'];
    for (let i = 1; i <= 8; i++) {
      const key = `demon1_walk${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `walk${i}`);
    }
    assert.equal(states.demon1_walk8.nextState, 'demon1_walk1');

    for (let i = 1; i <= 6; i++) {
      const key = `demon1_run${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `run${i}`);
    }
    assert.equal(states.demon1_run6.nextState, 'demon1_run1');
  });

  void test('jump sequence keeps the retry loop and returns to run', () => {
    const states = DemonMonster['_states'];
    for (let i = 1; i <= 10; i++) {
      const key = `demon1_jump${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `leap${i}`);
    }
    assert.equal(states.demon1_jump10.nextState, 'demon1_jump1');
    assert.equal(states.demon1_jump11.keyframe, 'leap11');
    assert.equal(states.demon1_jump12.keyframe, 'leap12');
    assert.equal(states.demon1_jump12.nextState, 'demon1_run1');
  });

  void test('attack sequence ends at demon1_run1', () => {
    const states = DemonMonster['_states'];
    for (let i = 1; i <= 15; i++) {
      const key = `demon1_atta${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `attacka${i}`);
    }
    assert.equal(states.demon1_atta15.nextState, 'demon1_run1');
  });

  void test('pain and death sequences terminate as expected', () => {
    const states = DemonMonster['_states'];
    for (let i = 1; i <= 6; i++) {
      const key = `demon1_pain${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `pain${i}`);
    }
    assert.equal(states.demon1_pain6.nextState, 'demon1_run1');

    for (let i = 1; i <= 9; i++) {
      const key = `demon1_die${i}`;
      assert.ok(key in states, `missing state ${key}`);
      assert.equal(states[key].keyframe, `death${i}`);
    }
    assert.equal(states.demon1_die9.nextState, null);
  });

  void test('active states keep handlers and passive states omit them', () => {
    const states = DemonMonster['_states'];

    for (const name of ['demon1_stand1', 'demon1_walk1', 'demon1_run1', 'demon1_jump1', 'demon1_jump3', 'demon1_jump5', 'demon1_jump10', 'demon1_atta5', 'demon1_die6', 'demon1_die9']) {
      assert.equal(typeof states[name].handler, 'function', `${name} handler should be a function`);
    }

    for (const name of ['demon1_jump11', 'demon1_jump12', 'demon1_pain1', 'demon1_pain6']) {
      assert.equal(states[name].handler, null, `${name} handler should be omitted`);
    }
  });
});
