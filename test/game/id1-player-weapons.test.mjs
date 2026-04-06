import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

await import('../../source/game/id1/GameAPI.ts');

const defsModule = await import('../../source/game/id1/Defs.ts');
const playerModule = await import('../../source/game/id1/entity/Player.mjs');
const weaponsModule = await import('../../source/game/id1/entity/Weapons.mjs');

const { items, waterlevel } = defsModule;
const { PlayerEntity } = playerModule;
const { DamageHandler, PlayerWeapons, weaponConfig } = weaponsModule;

PlayerEntity._initStates();

/**
 * Create a player-like object for weapon selection tests.
 * @param {object} overrides Field overrides for the mock player.
 * @returns {object} Mock player state.
 */
function createWeaponSelectionPlayer(overrides = {}) {
  return {
    items: items.IT_AXE,
    ammo_shells: 0,
    ammo_nails: 0,
    ammo_rockets: 0,
    ammo_cells: 0,
    waterlevel: waterlevel.WATERLEVEL_NONE,
    ...overrides,
  };
}

void describe('Player and weapon module surface', () => {
  void test('exports the current gameplay classes and weapon config map', () => {
    assert.equal(typeof PlayerEntity, 'function');
    assert.equal(typeof playerModule.GibEntity, 'function');
    assert.equal(typeof PlayerWeapons, 'function');
    assert.equal(typeof DamageHandler, 'function');
    assert.equal(weaponConfig instanceof Map, true);
  });
});

void describe('PlayerEntity state machine', () => {
  void test('standing and running loops wrap correctly', () => {
    const states = PlayerEntity._states;

    assert.equal(states.player_stand5.nextState, 'player_stand1');
    assert.equal(states.player_stand_axe12.nextState, 'player_stand_axe1');
    assert.equal(states.player_run6.nextState, 'player_run1');
    assert.equal(states.player_run_axe6.nextState, 'player_run_axe1');
  });

  void test('continuous-fire states alternate correctly', () => {
    const states = PlayerEntity._states;

    assert.equal(states.player_nail1.keyframe, 'nailatt1');
    assert.equal(states.player_nail1.nextState, 'player_nail2');
    assert.equal(states.player_nail2.nextState, 'player_nail1');

    assert.equal(states.player_light1.keyframe, 'nailatt1');
    assert.equal(states.player_light1.nextState, 'player_light2');
    assert.equal(states.player_light2.nextState, 'player_light1');
  });

  void test('pain and death chains terminate and keep handlers where needed', () => {
    const states = PlayerEntity._states;

    assert.equal(states.player_pain6.nextState, null);
    assert.equal(states.player_pain_axe6.nextState, null);
    assert.equal(states.player_diea11.nextState, null);
    assert.equal(states.player_die_ax9.nextState, null);

    assert.equal(typeof states.player_stand1.handler, 'function');
    assert.equal(typeof states.player_shot1.handler, 'function');
    assert.equal(typeof states.player_nail1.handler, 'function');
    assert.equal(typeof states.player_light1.handler, 'function');
  });
});

void describe('PlayerEntity weapon selection', () => {
  void test('falls back to the axe when stronger owned weapons are out of ammo', () => {
    const player = createWeaponSelectionPlayer({
      items: items.IT_AXE | items.IT_SHOTGUN | items.IT_SUPER_SHOTGUN,
    });

    assert.equal(PlayerEntity.prototype.chooseBestWeapon.call(player), items.IT_AXE);
  });

  void test('skips lightning underwater and keeps the best safe weapon', () => {
    const player = createWeaponSelectionPlayer({
      items: items.IT_AXE | items.IT_ROCKET_LAUNCHER | items.IT_LIGHTNING,
      ammo_rockets: 5,
      ammo_cells: 30,
      waterlevel: waterlevel.WATERLEVEL_WAIST,
    });

    assert.equal(PlayerEntity.prototype.chooseBestWeapon.call(player), items.IT_ROCKET_LAUNCHER);
  });

  void test('prefers the highest-priority usable weapon', () => {
    const player = createWeaponSelectionPlayer({
      items: items.IT_AXE | items.IT_SHOTGUN | items.IT_SUPER_NAILGUN | items.IT_GRENADE_LAUNCHER,
      ammo_shells: 25,
      ammo_nails: 20,
      ammo_rockets: 1,
    });

    assert.equal(PlayerEntity.prototype.chooseBestWeapon.call(player), items.IT_GRENADE_LAUNCHER);
  });
});
