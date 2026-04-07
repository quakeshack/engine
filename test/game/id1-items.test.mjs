import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { channel, items, solid, tentType, worldType } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: BaseEntity } = await import('../../source/game/id1/entity/BaseEntity.ts');
const {
  BackpackEntity,
  HealthItemEntity,
  ItemShellsEntity,
  SilverKeyEntity,
} = await import('../../source/game/id1/entity/Items.ts');

/**
 * Create the minimal game API surface required by the item tests.
 * @param {object} overrides Optional engine/game overrides.
 * @returns {object} Mock game API.
 */
function createMockGameAPI(overrides = {}) {
  const engine = {
    DispatchTempEntityEvent() {},
    FindAllByFieldAndValue() {
      return [];
    },
    IsLoading() {
      return false;
    },
    PrecacheModel() {},
    PrecacheSound() {},
    SpawnEntity() {
      return null;
    },
    StartSound() {},
    ...overrides.engine,
  };

  return {
    time: 0,
    deathmatch: 0,
    coop: 0,
    serverflags: 0,
    engine,
    worldspawn: overrides.worldspawn ?? {
      worldtype: worldType.MEDIEVAL,
      findNextEntityByFieldAndValue() {
        return null;
      },
    },
    ...overrides,
  };
}

void describe('Items', () => {
  void test('serializes shared pickup fields and backpack timeout fields', () => {
    const backpack = new BackpackEntity(null, createMockGameAPI()).initializeEntity();
    const serialized = backpack._serializer.serialize();

    for (const field of [
      'ammo_shells',
      'ammo_nails',
      'ammo_rockets',
      'ammo_cells',
      'items',
      'weapon',
      'regeneration_time',
      '_model_original',
      'noise',
      'netname',
      'remove_after',
    ]) {
      assert.ok(field in serialized, `missing serialized field "${field}"`);
    }
  });

  void test('hides picked items in deathmatch and restores them on regeneration', () => {
    const gameAPI = createMockGameAPI({ deathmatch: 1, time: 12 });
    const activator = new BaseEntity(null, gameAPI).initializeEntity();
    const backpack = new BackpackEntity(null, gameAPI).initializeEntity();
    const scheduled = [];
    const sounds = [];
    const tempEvents = [];

    backpack.model = 'progs/backpack.mdl';
    backpack.regeneration_time = 30;
    backpack._scheduleThink = (time, callback, identifier) => {
      scheduled.push({ time, callback, identifier });
    };
    backpack.setOrigin = () => {};
    backpack.startSound = (soundChannel, sfxName) => {
      sounds.push({ soundChannel, sfxName });
    };
    backpack.engine.DispatchTempEntityEvent = (eventType, origin) => {
      tempEvents.push({ eventType, origin: origin.copy() });
    };

    backpack._afterTouch(activator);

    assert.equal(backpack.solid, solid.SOLID_NOT);
    assert.equal(backpack.model, null);
    assert.equal(backpack._model_original, 'progs/backpack.mdl');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].time, 42);

    scheduled[0].callback.call(backpack, backpack);

    assert.equal(backpack.model, 'progs/backpack.mdl');
    assert.equal(backpack.solid, solid.SOLID_TRIGGER);
    assert.deepEqual(sounds, [{ soundChannel: channel.CHAN_VOICE, sfxName: 'items/itembk2.wav' }]);
    assert.equal(tempEvents.length, 1);
    assert.equal(tempEvents[0].eventType, tentType.TE_TELEPORT);
  });

  void test('prefers the super shotgun when a shell pickup makes it usable', () => {
    const shellBox = new ItemShellsEntity(null, createMockGameAPI()).initializeEntity();
    let appliedBackpack = false;

    shellBox.ammo_shells = 20;
    shellBox.weapon = items.IT_SHOTGUN;

    const player = {
      items: items.IT_SUPER_SHOTGUN,
      ammo_shells: 0,
      applyBackpack(entity) {
        appliedBackpack = entity === shellBox;
        return true;
      },
    };

    assert.equal(shellBox._pickup(player), true);
    assert.equal(shellBox.weapon, items.IT_SUPER_SHOTGUN);
    assert.equal(appliedBackpack, true);
  });

  void test('falls back to medieval key assets for unknown world types', () => {
    const key = new SilverKeyEntity(null, createMockGameAPI({
      worldspawn: { worldtype: 99 },
    })).initializeEntity();

    key._setInfo();

    assert.equal(key.noise, 'misc/medkey.wav');
    assert.equal(key.netname, 'silver key');
    assert.equal(key.model, 'progs/w_s_key.mdl');
  });

  void test('chips megahealth back to max and clears the superhealth flag', () => {
    const gameAPI = createMockGameAPI({ time: 5 });
    const megaHealth = new HealthItemEntity(null, gameAPI).initializeEntity();
    const scheduled = [];
    let removed = false;

    megaHealth.spawnflags = HealthItemEntity.H_MEGA;
    megaHealth.model = 'maps/b_bh100.bsp';
    megaHealth._scheduleThink = (time, callback, identifier) => {
      scheduled.push({ time, callback, identifier });
    };
    megaHealth.remove = () => {
      removed = true;
    };

    const player = {
      health: 101,
      max_health: 100,
      items: items.IT_SUPERHEALTH,
    };

    megaHealth._afterTouch(player);

    assert.equal(megaHealth.owner, player);
    assert.equal(megaHealth.model, null);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].time, 10);

    scheduled.length = 0;
    megaHealth._takeHealth();
    assert.equal(player.health, 100);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].time, 6);

    scheduled.length = 0;
    megaHealth._takeHealth();
    assert.equal(player.items & items.IT_SUPERHEALTH, 0);
    assert.equal(megaHealth.owner, null);
    assert.equal(removed, true);
  });
});
