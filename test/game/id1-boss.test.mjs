import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { effect, moveType, solid, tentType } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { BossLavaball, BossMonster, EventLightningEntity } = await import('../../source/game/id1/entity/monster/Boss.ts');

const ELECTRODE_STATE_TOP = 0;

BossMonster._initStates();

/**
 * Create a minimal boss fixture for focused behavior tests.
 * @param {typeof BossMonster} MonsterClass Monster constructor under test.
 * @param {object} [gameOverrides] Optional game API overrides.
 * @returns {BossMonster} Monster fixture instance.
 */
function createBossFixture(MonsterClass, gameOverrides = {}) {
  const edict = {
    num: 1,
    entity: null,
    freeEdict() {},
    setOrigin() {},
    setModel() {},
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
    PrecacheSound() {},
    ParseQC() {
      return null;
    },
    StartSound() {},
    SpawnEntity() {
      return { entity: null };
    },
    DispatchTempEntityEvent() {},
    DispatchBeamEvent() {},
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 3,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
    ...gameOverrides,
  };

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector(10, 20, 30);
  entity.angles = new Vector();
  entity.enemy = {
    origin: new Vector(90, 20, 30),
    velocity: new Vector(20, 0, 0),
    health: 100,
  };

  return entity;
}

/**
 * Create a minimal event_lightning fixture.
 * @returns {EventLightningEntity} Lightning fixture instance.
 */
function createLightningFixture() {
  const edict = {
    num: 2,
    entity: null,
    freeEdict() {},
    setOrigin() {},
    setModel() {},
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
    PrecacheSound() {},
    ParseQC() {
      return null;
    },
    StartSound() {},
    DispatchBeamEvent() {},
    eventBus: {
      publish() {},
    },
  };

  const gameAPI = {
    engine,
    time: 5,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
  };

  const entity = new EventLightningEntity(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  return entity;
}

void describe('Boss module metadata', () => {
  void test('exports the boss, lavaball, and lightning classes', () => {
    assert.equal(BossMonster.classname, 'monster_boss');
    assert.equal(BossLavaball.classname, 'monster_boss_lavaball');
    assert.equal(EventLightningEntity.classname, 'event_lightning');
  });
});

void describe('BossMonster state machine', () => {
  void test('rise, idle, missile, and shock loops keep the QuakeC transitions', () => {
    const states = BossMonster._states;

    assert.equal(states.boss_rise17.nextState, 'boss_missile1');
    assert.equal(states.boss_idle31.nextState, 'boss_idle1');
    assert.equal(states.boss_missile23.nextState, 'boss_missile1');
    assert.equal(states.boss_shocka10.nextState, 'boss_missile1');
    assert.equal(states.boss_shockb7.keyframe, 'shockb1');
    assert.equal(states.boss_shockb10.nextState, 'boss_missile1');
    assert.equal(states.boss_shockc10.nextState, 'boss_death1');
    assert.equal(states.boss_death10.nextState, 'boss_death10');
  });
});

void describe('BossMonster QC fixes', () => {
  void test('use wakes the boss with the skill-scaled health and lava splash', () => {
    const boss = createBossFixture(BossMonster, { skill: 0 });
    let stateName = null;
    const tempEvents = [];

    boss._runState = (nextState) => {
      stateName = nextState;
      return true;
    };
    boss.engine.DispatchTempEntityEvent = (eventType, origin) => {
      tempEvents.push({ eventType, origin });
    };

    boss.use({ classname: 'player', origin: new Vector() });

    assert.equal(boss.health, 1);
    assert.equal(boss.movetype, moveType.MOVETYPE_STEP);
    assert.equal(boss.solid, solid.SOLID_SLIDEBOX);
    assert.equal(stateName, 'boss_rise1');
    assert.deepEqual(tempEvents, [{ eventType: tentType.TE_LAVASPLASH, origin: boss.origin }]);
  });

  void test('takeLightningDamage steps through the classic shock states', () => {
    const boss = createBossFixture(BossMonster);
    let stateName = null;

    boss._runState = (nextState) => {
      stateName = nextState;
      return true;
    };
    boss.health = 3;

    boss.takeLightningDamage({ classname: 'player', origin: new Vector() });
    assert.equal(boss.health, 2);
    assert.equal(stateName, 'boss_shocka1');

    boss.takeLightningDamage({ classname: 'player', origin: new Vector() });
    assert.equal(boss.health, 1);
    assert.equal(stateName, 'boss_shockb1');

    boss.takeLightningDamage({ classname: 'player', origin: new Vector() });
    assert.equal(boss.health, 0);
    assert.equal(stateName, 'boss_shockc1');
  });
});

void describe('BossLavaball', () => {
  void test('spawn keeps the classic lavaball movement and fullbright effect', () => {
    const boss = createBossFixture(BossMonster);
    const edict = {
      num: 3,
      entity: null,
      freeEdict() {},
      setOrigin() {},
      setModel() {},
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

    const lavaball = new BossLavaball(edict, boss.game).initializeEntity();
    edict.entity = lavaball;
    lavaball.movedir = new Vector(1, 0, 0);

    lavaball.spawn();

    assert.equal(lavaball.movetype, moveType.MOVETYPE_FLYMISSILE);
    assert.equal(lavaball.solid, solid.SOLID_BBOX);
    assert.equal((lavaball.effects & effect.EF_FULLBRIGHT) !== 0, true);
    assert.deepEqual([lavaball.avelocity[0], lavaball.avelocity[1], lavaball.avelocity[2]], [200, 100, 300]);
    assert.equal(Math.round(lavaball.velocity.len()), 300);
  });
});

void describe('EventLightningEntity', () => {
  void test('fires aligned top electrodes and damages the boss once', () => {
    const lightning = createLightningFixture();
    const beams = [];
    const sounds = [];
    const activator = { classname: 'player', origin: new Vector() };
    let damageCalls = 0;
    const boss = createBossFixture(BossMonster);
    boss.health = 3;

    const electrode1 = {
      state: ELECTRODE_STATE_TOP,
      nextthink: 0,
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      absmin: new Vector(0, 0, 40),
      _doorGoDown() {},
    };
    const electrode2 = {
      state: ELECTRODE_STATE_TOP,
      nextthink: 0,
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      absmin: new Vector(200, 0, 40),
      _doorGoDown() {},
    };
    boss.takeLightningDamage = (entity) => {
      damageCalls += 1;
      assert.equal(entity, activator);
    };

    lightning.findFirstEntityByFieldAndValue = (fieldName, value) => {
      if (fieldName === 'target' && value === 'lightning') {
        return electrode1;
      }
      if (fieldName === 'classname' && value === BossMonster.classname) {
        return boss;
      }
      return null;
    };
    lightning.findNextEntityByFieldAndValue = (fieldName, value, current) => {
      if (fieldName === 'target' && value === 'lightning' && current === electrode1) {
        return electrode2;
      }
      return null;
    };
    lightning.engine.DispatchBeamEvent = (eventType, edictId, start, end) => {
      beams.push({ eventType, edictId, start, end });
    };
    lightning.startSound = (_channel, soundName) => {
      sounds.push(soundName);
    };

    lightning.use(activator);

    assert.equal(lightning.lightning_end, 6);
    assert.equal(electrode1.nextthink, -1);
    assert.equal(electrode2.nextthink, -1);
    assert.deepEqual(sounds, ['misc/power.wav']);
    assert.equal(beams.length, 1);
    assert.equal(beams[0].eventType, tentType.TE_LIGHTNING3);
    assert.equal(damageCalls, 1);
  });
});
