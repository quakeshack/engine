import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { damage, moveType, solid } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { PlayerEntity } = await import('../../source/game/id1/entity/Player.ts');
const { ButtonEntity } = await import('../../source/game/id1/entity/props/Buttons.ts');
const { state } = await import('../../source/game/id1/entity/props/BasePropEntity.ts');

/**
 * Create a minimal button fixture for focused behavior tests.
 * @returns {{ button: ButtonEntity, engine: object, setModelCalls: string[], precachedSounds: string[] }} Button fixture data.
 */
function createButtonFixture() {
  const setModelCalls = [];
  const precachedSounds = [];
  const edict = {
    num: 1,
    entity: null,
    freeEdict() {},
    setOrigin() {},
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
    SpawnEntity() {
      return { entity: null };
    },
    DispatchTempEntityEvent() {},
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 3,
    deathmatch: 0,
    nomonsters: 0,
  };

  const button = new ButtonEntity(edict, gameAPI).initializeEntity().precacheEntity();
  edict.entity = button;
  button.origin = new Vector(10, 20, 30);
  button.angles = new Vector();
  button.size = new Vector(64, 16, 8);
  button.model = 'progs/button.bsp';

  return { button, engine, setModelCalls, precachedSounds };
}

void describe('ButtonEntity spawn', () => {
  void test('applies QC defaults and computes the travel destination', () => {
    const { button, precachedSounds, setModelCalls } = createButtonFixture();
    let setMovedirCalls = 0;

    button._sub = {
      setMovedir() {
        setMovedirCalls++;
        button.movedir.setTo(1, 0, 0);
      },
      calcMove() {},
      useTargets() {},
    };

    button.spawn();

    assert.deepEqual(precachedSounds, ['buttons/airbut1.wav']);
    assert.equal(setMovedirCalls, 1);
    assert.deepEqual(setModelCalls, ['progs/button.bsp']);
    assert.equal(button.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(button.solid, solid.SOLID_BSP);
    assert.equal(button.speed, 40);
    assert.equal(button.wait, 1);
    assert.equal(button.lip, 4);
    assert.equal(button.state, state.STATE_BOTTOM);
    assert.ok(button.pos1.equalsTo(10, 20, 30));
    assert.ok(button.pos2.equalsTo(70, 20, 30));
  });

  void test('enables takedamage and stores max health for shootable buttons', () => {
    const { button } = createButtonFixture();

    button._sub = {
      setMovedir() {
        button.movedir.setTo(0, 1, 0);
      },
      calcMove() {},
      useTargets() {},
    };
    button.health = 25;

    button.spawn();

    assert.equal(button.max_health, 25);
    assert.equal(button.takedamage, damage.DAMAGE_YES);
  });
});

void describe('ButtonEntity interaction', () => {
  void test('touch ignores non-player entities and shootable buttons', () => {
    const { button } = createButtonFixture();
    const player = Object.create(PlayerEntity.prototype);
    const pushVector = new Vector();
    const firedWith = [];

    button._buttonFire = (userEntity) => {
      firedWith.push(userEntity);
    };

    button.touch(button, pushVector);
    button.max_health = 5;
    button.touch(player, pushVector);

    assert.deepEqual(firedWith, []);
  });

  void test('use starts the opening move and ignores repeat triggers while already active', () => {
    const { button } = createButtonFixture();
    const calcMoveCalls = [];
    const soundCalls = [];
    const userEntity = button;

    button._sub = {
      setMovedir() {},
      calcMove(target, speed, callback) {
        calcMoveCalls.push({ target, speed, callback });
      },
      useTargets() {},
    };
    button.pos2 = new Vector(100, 20, 30);
    button.speed = 55;
    button.noise = 'buttons/switch02.wav';
    button.state = state.STATE_BOTTOM;
    button.startSound = (_channel, soundName) => {
      soundCalls.push(soundName);
    };

    button.use(userEntity);
    button.use(userEntity);

    assert.equal(button.state, state.STATE_UP);
    assert.deepEqual(soundCalls, ['buttons/switch02.wav']);
    assert.equal(calcMoveCalls.length, 1);
    assert.ok(calcMoveCalls[0].target.equalsTo(100, 20, 30));
    assert.equal(calcMoveCalls[0].speed, 55);
    assert.equal(typeof calcMoveCalls[0].callback, 'function');
  });

  void test('wait, return, and death preserve the QC button cycle', () => {
    const { button } = createButtonFixture();
    const calcMoveCalls = [];
    const scheduledThinks = [];
    const usedTargets = [];
    const attacker = button;

    button._sub = {
      setMovedir() {},
      calcMove(target, speed, callback) {
        calcMoveCalls.push({ target, speed, callback });
      },
      useTargets(userEntity) {
        usedTargets.push(userEntity);
      },
    };
    button._scheduleThink = (nextThink, callback) => {
      scheduledThinks.push({ nextThink, callback });
    };
    button.pos1 = new Vector(10, 20, 30);
    button.speed = 30;
    button.wait = 2;
    button.ltime = 5;
    button.health = 9;
    button.max_health = 9;
    button.takedamage = damage.DAMAGE_YES;
    button.noise = 'buttons/airbut1.wav';
    button.state = state.STATE_BOTTOM;

    button.thinkDie(attacker);

    assert.equal(button.health, 9);
    assert.equal(button.takedamage, damage.DAMAGE_NO);
    assert.equal(button.state, state.STATE_UP);
    assert.equal(calcMoveCalls.length, 1);

    calcMoveCalls[0].callback();

    assert.equal(button.state, state.STATE_TOP);
    assert.equal(button.frame, 1);
    assert.deepEqual(usedTargets, [attacker]);
    assert.equal(scheduledThinks.length, 1);
    assert.equal(scheduledThinks[0].nextThink, 7);

    scheduledThinks[0].callback();

    assert.equal(button.state, state.STATE_DOWN);
    assert.equal(button.frame, 0);
    assert.equal(button.takedamage, damage.DAMAGE_YES);
    assert.equal(calcMoveCalls.length, 2);
    assert.ok(calcMoveCalls[1].target.equalsTo(10, 20, 30));
    assert.equal(calcMoveCalls[1].speed, 30);

    calcMoveCalls[1].callback();

    assert.equal(button.state, state.STATE_BOTTOM);
  });
});
