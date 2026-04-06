import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../source/game/id1/GameAPI.ts');

const { default: OgreMonsterEntity } = await import('../../source/game/id1/entity/monster/Ogre.ts');

OgreMonsterEntity._initStates();

void describe('OgreMonsterEntity metadata', () => {
  void test('class metadata matches the original monster', () => {
    assert.equal(OgreMonsterEntity.classname, 'monster_ogre');
    assert.equal(OgreMonsterEntity._health, 200);
    assert.equal(OgreMonsterEntity._modelDefault, 'progs/ogre.mdl');
    assert.equal(OgreMonsterEntity._modelHead, 'progs/h_ogre.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = OgreMonsterEntity._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-32, -32, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [32, 32, 64]);
  });

  void test('serializableFields is a frozen empty array', () => {
    const { serializableFields } = /** @type {{ serializableFields: unknown }} */ (/** @type {unknown} */ (OgreMonsterEntity));
    assert.ok(Array.isArray(serializableFields));
    assert.ok(Object.isFrozen(serializableFields));
    assert.deepEqual(serializableFields, []);
  });
});

void describe('OgreMonsterEntity state machine', () => {
  void test('core movement sequences loop', () => {
    const states = OgreMonsterEntity['_states'];
    assert.equal(states.ogre_stand9.nextState, 'ogre_stand1');
    assert.equal(states.ogre_walk16.nextState, 'ogre_walk1');
    assert.equal(states.ogre_run8.nextState, 'ogre_run1');
  });

  void test('melee and missile attacks return to the run loop', () => {
    const states = OgreMonsterEntity['_states'];
    assert.equal(states.ogre_swing14.nextState, 'ogre_run1');
    assert.equal(states.ogre_smash14.nextState, 'ogre_run1');
    assert.equal(states.ogre_nail7.nextState, 'ogre_run1');
  });

  void test('pain variants return to the run loop', () => {
    const states = OgreMonsterEntity['_states'];
    assert.equal(states.ogre_pain5.nextState, 'ogre_run1');
    assert.equal(states.ogre_pain1b3.nextState, 'ogre_run1');
    assert.equal(states.ogre_pain1c6.nextState, 'ogre_run1');
    assert.equal(states.ogre_pain1d16.nextState, 'ogre_run1');
    assert.equal(states.ogre_pain1e15.nextState, 'ogre_run1');
  });

  void test('death chains terminate correctly', () => {
    const states = OgreMonsterEntity['_states'];
    assert.equal(states.ogre_die14.nextState, null);
    assert.equal(states.ogre_bdie10.nextState, null);
  });

  void test('sequence handlers remain present on active states', () => {
    const states = OgreMonsterEntity['_states'];
    assert.equal(typeof states.ogre_stand5.handler, 'function');
    assert.equal(typeof states.ogre_walk6.handler, 'function');
    assert.equal(typeof states.ogre_run1.handler, 'function');
    assert.equal(typeof states.ogre_swing5.handler, 'function');
    assert.equal(typeof states.ogre_smash12.handler, 'function');
    assert.equal(typeof states.ogre_nail4.handler, 'function');
    assert.equal(typeof states.ogre_bdie2.handler, 'function');
  });
});
