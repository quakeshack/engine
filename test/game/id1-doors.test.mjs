import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { attn, channel, damage, items, moveType, solid, worldType } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { PlayerEntity } = await import('../../source/game/id1/entity/Player.ts');
const { DoorEntity, SecretDoorEntity, flag } = await import('../../source/game/id1/entity/props/Doors.ts');
const { state } = await import('../../source/game/id1/entity/props/BasePropEntity.ts');

/**
 * Create a minimal engine/game harness for door tests.
 * @returns {{ edict: object, engine: object, gameAPI: object, precachedSounds: string[], portalCalls: Array<{ portal: number | null, isOpen: boolean }>, setModelCalls: Array<string | null>, spawnRequests: Array<{ classname: string, initialData: object }> }} Harness data.
 */
function createDoorHarness() {
  const precachedSounds = [];
  const portalCalls = [];
  const setModelCalls = [];
  const spawnRequests = [];
  let boundEntity = null;

  const edict = {
    num: 1,
    entity: null,
    freeEdict() {},
    setOrigin(origin) {
      boundEntity?.origin.set(origin);
    },
    setModel(model) {
      setModelCalls.push(model);
    },
    setMinMaxSize() {},
    walkMove() {
      return false;
    },
    changeYaw() {
      return 0;
    },
    dropToFloor() {
      return true;
    },
    isOnTheFloor() {
      return false;
    },
    makeStatic() {},
    aim() {
      return null;
    },
    moveToGoal() {
      return false;
    },
    isInPXS() {
      return true;
    },
    getNextBestClient() {
      return null;
    },
  };

  const engine = {
    IsLoading() {
      return false;
    },
    PrecacheModel() {},
    PrecacheSound(sound) {
      precachedSounds.push(sound);
    },
    ParseQC() {
      return null;
    },
    StartSound() {},
    SpawnEntity(classname, initialData = {}) {
      spawnRequests.push({ classname, initialData });
      return { entity: null };
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    SetAreaPortalState(portal, isOpen) {
      portalCalls.push({ portal, isOpen });
    },
    GetModelPortal() {
      return 7;
    },
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    worldspawn: {
      worldtype: worldType.MEDIEVAL,
    },
    time: 3,
    deathmatch: 0,
    nomonsters: 0,
  };

  return {
    edict,
    engine,
    gameAPI,
    precachedSounds,
    portalCalls,
    setModelCalls,
    spawnRequests,
    bindEntity(entity) {
      boundEntity = entity;
      edict.entity = entity;
    },
  };
}

/**
 * Create a minimal DoorEntity fixture that exercises explicit instance precache.
 * @returns {{ door: import('../../source/game/id1/entity/props/Doors.ts').DoorEntity, gameAPI: object, precachedSounds: string[], portalCalls: Array<{ portal: number | null, isOpen: boolean }>, setModelCalls: Array<string | null>, spawnRequests: Array<{ classname: string, initialData: object }> }} Fixture data.
 */
function createDoorFixture() {
  const harness = createDoorHarness();
  const door = new DoorEntity(harness.edict, harness.gameAPI).initializeEntity().precacheEntity();
  harness.bindEntity(door);
  return { door, ...harness };
}

/**
 * Create a minimal SecretDoorEntity fixture for focused behavior tests.
 * @returns {{ door: import('../../source/game/id1/entity/props/Doors.ts').SecretDoorEntity, gameAPI: object, precachedSounds: string[], portalCalls: Array<{ portal: number | null, isOpen: boolean }>, setModelCalls: Array<string | null>, spawnRequests: Array<{ classname: string, initialData: object }> }} Fixture data.
 */
function createSecretDoorFixture() {
  const harness = createDoorHarness();
  const door = new SecretDoorEntity(harness.edict, harness.gameAPI).initializeEntity().precacheEntity();
  harness.bindEntity(door);
  return { door, ...harness };
}

void describe('DoorEntity instance precache', () => {
  void test('defaults sounds before precache so map load does not crash', () => {
    const { door, precachedSounds } = createDoorFixture();

    assert.equal(door.sounds, 1);
    assert.deepEqual(precachedSounds, [
      'doors/medtry.wav',
      'doors/meduse.wav',
      'doors/drclos4.wav',
      'doors/doormv1.wav',
    ]);
  });
});

void describe('DoorEntity spawn and touch', () => {
  void test('applies QC defaults, key-door setup, and portal state during spawn', () => {
    const { door, portalCalls, setModelCalls } = createDoorFixture();
    const scheduledThinks = [];
    let setMovedirCalls = 0;

    door._sub = {
      setMovedir() {
        setMovedirCalls++;
        door.movedir.setTo(1, 0, 0);
      },
      calcMove() {},
      useTargets() {},
      reset() {},
    };
    door._scheduleThink = (nextThink, callback) => {
      scheduledThinks.push({ nextThink, callback });
    };
    door.origin = new Vector(10, 20, 30);
    door.size = new Vector(64, 16, 8);
    door.model = 'progs/door.bsp';
    door.health = 20;
    door.spawnflags = flag.DOOR_SILVER_KEY;

    door.spawn();

    assert.equal(setMovedirCalls, 1);
    assert.deepEqual(setModelCalls, ['progs/door.bsp']);
    assert.equal(door.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(door.solid, solid.SOLID_BSP);
    assert.equal(door.speed, 100);
    assert.equal(door.wait, -1);
    assert.equal(door.lip, 8);
    assert.equal(door.dmg, 2);
    assert.equal(door.items, items.IT_KEY1);
    assert.equal(door.max_health, 20);
    assert.equal(door.takedamage, damage.DAMAGE_YES);
    assert.equal(door.state, state.STATE_BOTTOM);
    assert.equal(door.noise1, 'doors/drclos4.wav');
    assert.equal(door.noise2, 'doors/doormv1.wav');
    assert.equal(door.noise3, 'doors/medtry.wav');
    assert.equal(door.noise4, 'doors/meduse.wav');
    assert.ok(door.pos1.equalsTo(10, 20, 30));
    assert.ok(door.pos2.equalsTo(66, 20, 30));
    assert.deepEqual(portalCalls, [{ portal: 7, isOpen: false }]);
    assert.equal(scheduledThinks.length, 1);
    assert.equal(scheduledThinks[0].nextThink, 0.1);
  });

  void test('touch prints messages, enforces keys, and consumes the used key', () => {
    const { door, gameAPI } = createDoorFixture();
    const centerPrints = [];
    const soundCalls = [];
    const usedBy = [];
    const player = Object.create(PlayerEntity.prototype);

    player.items = 0;
    player.centerPrint = (message) => {
      centerPrints.push(message);
    };
    player.startSound = (...args) => {
      soundCalls.push(args);
    };

    door.owner = door;
    door._linkedDoor = door;
    door.use = (usedByEntity) => {
      usedBy.push(usedByEntity);
    };

    door.message = 'Door message';
    door.items = 0;
    door.touch(player);

    assert.deepEqual(centerPrints, ['Door message']);
    assert.deepEqual(soundCalls, [[channel.CHAN_VOICE, 'misc/talk.wav', 1.0, attn.ATTN_NONE]]);

    centerPrints.length = 0;
    soundCalls.length = 0;
    gameAPI.time = 6;

    door.message = null;
    door._doorKeyUsed = false;
    door.items = items.IT_KEY1;
    door.owner.attack_finished = 0;
    door.touch(player);

    assert.deepEqual(centerPrints, ['You need the Silver Key']);
    assert.deepEqual(soundCalls, [[channel.CHAN_VOICE, 'misc/talk.wav', 1.0, attn.ATTN_NONE]]);
    assert.deepEqual(usedBy, []);

    centerPrints.length = 0;
    soundCalls.length = 0;
    player.items = items.IT_KEY1;
    door.owner.attack_finished = 0;
    gameAPI.time = 9;

    door.touch(player);

    assert.equal(player.items, 0);
    assert.equal(door._doorKeyUsed, true);
    assert.deepEqual(usedBy, [player]);
    assert.deepEqual(centerPrints, []);
  });
});

void describe('SecretDoorEntity', () => {
  void test('spawn applies defaults and closes the linked area portal', () => {
    const { door, portalCalls, setModelCalls } = createSecretDoorFixture();

    door.model = 'progs/secret.bsp';
    door.origin = new Vector(4, 5, 6);
    door.angles = new Vector();
    door.size = new Vector(16, 32, 64);

    door.spawn();

    assert.equal(door.sounds, 3);
    assert.equal(door.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(door.solid, solid.SOLID_BSP);
    assert.equal(door.speed, 50);
    assert.equal(door.wait, 5);
    assert.equal(door.health, 10000);
    assert.equal(door.takedamage, damage.DAMAGE_YES);
    assert.deepEqual(setModelCalls, ['progs/secret.bsp']);
    assert.deepEqual(portalCalls, [{ portal: 7, isOpen: false }]);
    assert.ok(door.oldorigin.equalsTo(4, 5, 6));
  });

  void test('use runs the open-close sequence and restores the closed state', () => {
    const { door, portalCalls } = createSecretDoorFixture();
    const calcMoveCalls = [];
    const scheduledThinks = [];
    const usedTargets = [];
    const soundCalls = [];

    door.model = 'progs/secret.bsp';
    door.origin = new Vector();
    door.angles = new Vector();
    door.size = new Vector(16, 32, 64);
    door.spawn();

    door._sub = {
      calcMove(target, speed, callback) {
        calcMoveCalls.push({ target: target.copy(), speed, callback });
      },
      useTargets(usedByEntity) {
        usedTargets.push(usedByEntity);
      },
      reset() {},
      setMovedir() {},
    };
    door._scheduleThink = (nextThink, callback) => {
      scheduledThinks.push({ nextThink, callback });
    };
    door.startSound = (_channel, soundName) => {
      soundCalls.push(soundName);
    };

    door.use(door);

    assert.deepEqual(usedTargets, [door]);
    assert.equal(door.takedamage, damage.DAMAGE_NO);
    assert.equal(calcMoveCalls.length, 1);
    assert.equal(calcMoveCalls[0].speed, 50);
    assert.deepEqual(portalCalls.at(-1), { portal: 7, isOpen: true });

    calcMoveCalls[0].callback();
    assert.equal(scheduledThinks.length, 1);

    scheduledThinks[0].callback();
    assert.equal(calcMoveCalls.length, 2);

    calcMoveCalls[1].callback();
    assert.equal(scheduledThinks.length, 2);

    scheduledThinks[1].callback();
    assert.equal(calcMoveCalls.length, 3);

    calcMoveCalls[2].callback();
    assert.equal(scheduledThinks.length, 3);

    scheduledThinks[2].callback();
    assert.equal(calcMoveCalls.length, 4);

    calcMoveCalls[3].callback();

    assert.equal(door.takedamage, damage.DAMAGE_YES);
    assert.deepEqual(portalCalls.at(-1), { portal: 7, isOpen: false });
    assert.equal(soundCalls.at(-1), 'doors/basesec2.wav');
  });
});
