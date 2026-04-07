import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

await import('../../source/game/id1/GameAPI.ts');

const defsModule = await import('../../source/game/id1/Defs.ts');
const playerModule = await import('../../source/game/id1/entity/Player.ts');
const worldspawnModule = await import('../../source/game/id1/entity/Worldspawn.ts');
const vectorModule = await import('../../source/shared/Vector.ts');

const { clientEvent, items } = defsModule;
const { PlayerEntity } = playerModule;
const { BodyqueEntity } = worldspawnModule;
const { default: Vector } = vectorModule;

/**
 * Create a minimal game API surface for BodyqueEntity construction.
 * @returns {{engine: object}} Minimal game API object.
 */
function createBodyqueGameAPI() {
  return {
    engine: {},
  };
}

/**
 * Create a body queue node with edict-bound methods stubbed for unit tests.
 * @returns {BodyqueEntity} Stubbed body queue entity.
 */
function createBodyqueNode() {
  const body = new BodyqueEntity(null, createBodyqueGameAPI()).initializeEntity();

  body.setModel = function setModel(model) {
    this.model = model;
  };

  body.setOrigin = function setOrigin(origin) {
    this.origin = origin.copy();
  };

  body.setSize = function setSize(mins, maxs) {
    this.mins = mins.copy();
    this.maxs = maxs.copy();
  };

  return body;
}

void describe('PlayerEntity respawn flow', () => {
  void test('singleplayer respawn restarts the map', () => {
    const appendedConsoleText = [];
    const player = {
      game: {
        coop: false,
        deathmatch: false,
      },
      engine: {
        AppendConsoleText(command) {
          appendedConsoleText.push(command);
        },
      },
    };

    PlayerEntity.prototype._respawn.call(player);

    assert.deepEqual(appendedConsoleText, ['restart\n']);
  });

  void test('deathmatch respawn refreshes spawn state and advances the body queue ring', () => {
    const bodyA = createBodyqueNode();
    const bodyB = createBodyqueNode();
    bodyA.owner = bodyB;
    bodyB.owner = bodyA;

    const calls = [];
    const player = {
      game: {
        coop: false,
        deathmatch: true,
        bodyque_head: bodyA,
      },
      angles: new Vector(1, 2, 3),
      model: 'progs/player.mdl',
      frame: 4,
      colormap: 16,
      movetype: 7,
      velocity: new Vector(10, 20, 30),
      origin: new Vector(100, 200, 300),
      mins: new Vector(-16, -16, -24),
      maxs: new Vector(16, 16, 32),
      clear() {
        calls.push('clear');
      },
      putPlayerInServer() {
        calls.push('putPlayerInServer');
      },
      _freshSpawnParameters() {
        calls.push('freshSpawnParameters');
      },
    };

    PlayerEntity.prototype._respawn.call(player);

    assert.deepEqual(calls, ['freshSpawnParameters', 'clear', 'putPlayerInServer']);
    assert.equal(player.game.bodyque_head, bodyB);
    assert.equal(bodyA.model, 'progs/player.mdl');
    assert.deepEqual(bodyA.origin, new Vector(100, 200, 300));
    assert.deepEqual(bodyA.velocity, new Vector(10, 20, 30));
  });
});

void describe('PlayerEntity intermission flow', () => {
  void test('deathmatch intermission exits directly to the next map', () => {
    let loadNextMapCalls = 0;
    const player = {
      game: {
        deathmatch: true,
        intermission_exittime: 0,
        intermission_running: 1,
        time: 10,
        loadNextMap() {
          loadNextMapCalls++;
        },
      },
    };

    PlayerEntity.prototype._intermissionExit.call(player);

    assert.equal(loadNextMapCalls, 1);
  });

  void test('episode-ending intermission prints finale text before loading the next map', () => {
    const centerPrints = [];
    let trackPlayed = null;
    let loadNextMapCalls = 0;
    const player = {
      game: {
        deathmatch: false,
        intermission_exittime: 0,
        intermission_running: 1,
        time: 42,
        mapname: 'e1m7',
        serverflags: 0,
        loadNextMap() {
          loadNextMapCalls++;
        },
      },
      engine: {
        registered: true,
        PlayTrack(track) {
          trackPlayed = track;
        },
      },
      centerPrint(message) {
        centerPrints.push(message);
      },
      _getEpisodeFinaleText: PlayerEntity.prototype._getEpisodeFinaleText,
    };

    PlayerEntity.prototype._intermissionExit.call(player);

    assert.equal(player.game.intermission_running, 2);
    assert.equal(player.game.intermission_exittime, 43);
    assert.equal(trackPlayed, 2);
    assert.equal(centerPrints.length, 1);
    assert.equal(centerPrints[0].includes('Rune of Earth'), true);
    assert.equal(loadNextMapCalls, 0);
  });
});

void describe('PlayerEntity powerup timers', () => {
  void test('expired invisibility restores the player model and clears the item flag', () => {
    const dispatchedEvents = [];
    const sounds = [];
    const player = {
      health: 100,
      game: { time: 20 },
      items: items.IT_INVISIBILITY,
      invisible_finished: 19,
      invisible_time: 5,
      invisible_sound: 0,
      invincible_finished: 0,
      super_damage_finished: 0,
      radsuit_finished: 0,
      air_finished: 0,
      modelindex: 5,
      _modelIndex: {
        player: 11,
        eyes: 22,
      },
      frame: 3,
      dispatchEvent(eventType) {
        dispatchedEvents.push(eventType);
      },
      consolePrint() {
      },
      startSound(_channel, soundName) {
        sounds.push(soundName);
      },
    };

    PlayerEntity.prototype._powerupFrame.call(player);

    assert.equal(player.items & items.IT_INVISIBILITY, 0);
    assert.equal(player.invisible_finished, 0);
    assert.equal(player.invisible_time, 0);
    assert.equal(player.modelindex, 11);
    assert.deepEqual(dispatchedEvents, [clientEvent.BONUS_FLASH]);
    assert.deepEqual(sounds, ['items/inv3.wav']);
  });

  void test('expired invulnerability clears cached attacker sound gates', () => {
    const player = {
      health: 100,
      game: { time: 20 },
      items: items.IT_INVULNERABILITY,
      invisible_finished: 0,
      invincible_finished: 19,
      invincible_time: 5,
      invincible_sound_time: { 1: 9, 7: 15 },
      super_damage_finished: 0,
      radsuit_finished: 0,
      air_finished: 0,
      dispatchEvent() {
      },
      consolePrint() {
      },
      startSound() {
      },
    };

    PlayerEntity.prototype._powerupFrame.call(player);

    assert.equal(player.items & items.IT_INVULNERABILITY, 0);
    assert.equal(player.invincible_finished, 0);
    assert.equal(player.invincible_time, 0);
    assert.deepEqual(player.invincible_sound_time, {});
  });

  void test('expiring biosuit keeps resetting air supply until the suit ends', () => {
    const player = {
      health: 100,
      game: { time: 10 },
      items: items.IT_SUIT,
      invisible_finished: 0,
      invincible_finished: 0,
      super_damage_finished: 0,
      radsuit_finished: 11,
      rad_time: 0,
      air_finished: 0,
      dispatchEvent() {
      },
      consolePrint() {
      },
      startSound() {
      },
    };

    PlayerEntity.prototype._powerupFrame.call(player);

    assert.equal(player.air_finished, 22);
    assert.equal(player.items & items.IT_SUIT, items.IT_SUIT);
  });
});
