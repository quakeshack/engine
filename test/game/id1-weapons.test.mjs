import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

await import('../../source/game/id1/GameAPI.ts');

const weaponsModule = await import('../../source/game/id1/entity/Weapons.ts');

const { Backpack, Spike } = weaponsModule;

/**
 * Create the minimal game API surface required by the weapon helper tests.
 * @returns {object} Mock game API.
 */
function createMockGameAPI() {
  return {
    time: 0,
    engine: {
      IsLoading() {
        return false;
      },
    },
  };
}

void describe('Weapons projectile helpers', () => {
  void test('registers Backpack ammo and weapon fields through serializer decorators', () => {
    const serializableFields = Reflect.get(Backpack, 'serializableFields');

    assert.equal(Array.isArray(serializableFields), true);
    assert.equal(serializableFields.includes('ammo_shells'), true);
    assert.equal(serializableFields.includes('ammo_nails'), true);
    assert.equal(serializableFields.includes('ammo_rockets'), true);
    assert.equal(serializableFields.includes('ammo_cells'), true);
    assert.equal(serializableFields.includes('items'), true);
    assert.equal(serializableFields.includes('weapon'), true);
  });

  void test('inherits the shared explosion state chain on projectile classes', () => {
    Spike._initStates();

    const states = Spike._states;

    assert.equal(states.s_explode1.keyframe, 0);
    assert.equal(states.s_explode1.nextState, 's_explode2');
    assert.equal(states.s_explode5.nextState, 's_explode6');
    assert.equal(states.s_explode6.nextState, null);
    assert.equal(typeof states.s_explode6.handler, 'function');
  });

  void test('keeps spike speed serializable while helper wrappers stay runtime-only', () => {
    const spike = new Spike(null, createMockGameAPI()).initializeEntity();
    const serialized = spike._serializer.serialize();

    assert.equal(spike.speed, 0);
    assert.ok('_damageInflictor' in spike);
    assert.ok('speed' in serialized);
    assert.ok(!('_damageInflictor' in serialized), '_damageInflictor should not be serialized');
    assert.ok(!('_explosions' in serialized), '_explosions should not be serialized');
  });
});
