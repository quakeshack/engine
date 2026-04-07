import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';

await import('../../source/game/id1/GameAPI.ts');

const { ArmySoldierMonster, ArmyEnforcerMonster } = await import('../../source/game/id1/entity/monster/Soldier.ts');
const { Laser } = await import('../../source/game/id1/entity/Weapons.ts');

ArmySoldierMonster._initStates();
ArmyEnforcerMonster._initStates();

function createMonsterFixture(MonsterClass, gameOverrides = {}) {
  const spawnRequests = [];
  const edict = { entity: null };
  const engine = {
    IsLoading() {
      return false;
    },
    ParseQC() {
      return null;
    },
    PrecacheModel() {
    },
    PrecacheSound() {
    },
    SpawnEntity(classname, initialData = {}) {
      spawnRequests.push({ classname, initialData });
      return { entity: null };
    },
    DispatchTempEntityEvent() {
    },
    FindByFieldAndValue() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    eventBus: {
      publish() {
      },
    },
  };
  const gameAPI = {
    engine,
    time: 10,
    skill: 1,
    deathmatch: 0,
    nomonsters: 0,
    gravity: 800,
    hasFeature() {
      return false;
    },
    ...gameOverrides,
  };

  const entity = new MonsterClass(edict, gameAPI).initializeEntity();
  edict.entity = entity;
  entity.origin = new Vector();

  return { entity, gameAPI, spawnRequests };
}

function assertVectorNear(actual, expected, epsilon = 1e-6) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `component ${i} mismatch: ${actual[i]} !== ${expected[i]}`);
  }
}

void describe('ArmySoldierMonster class metadata', () => {
  void test('classname is monster_army', () => {
    assert.equal(ArmySoldierMonster.classname, 'monster_army');
  });

  void test('health and model metadata match QC setup', () => {
    assert.equal(ArmySoldierMonster._health, 30);
    assert.equal(ArmySoldierMonster._modelDefault, 'progs/soldier.mdl');
    assert.equal(ArmySoldierMonster._modelHead, 'progs/h_guard.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = ArmySoldierMonster._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-16, -16, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [16, 16, 40]);
  });

  void test('preserves the legacy serialized AI state field and keeps helpers runtime-only', () => {
    const { entity } = createMonsterFixture(ArmySoldierMonster);
    const serialized = entity._serializer.serialize();

    assert.ok(Array.isArray(ArmySoldierMonster.serializableFields));
    assert.ok(Object.isFrozen(ArmySoldierMonster.serializableFields));
    assert.deepEqual(ArmySoldierMonster.serializableFields, ['_aiState']);
    assert.equal(entity._aiState, null);
    assert.ok('_aiState' in serialized);
    assert.ok(!('_damageInflictor' in serialized));
  });

  void test('fire keeps the QuakeC lead target calculation and spread values', () => {
    const { entity } = createMonsterFixture(ArmySoldierMonster);
    const shots = [];
    let faceCalls = 0;

    entity.enemy = {
      origin: new Vector(100, 20, 40),
      velocity: new Vector(15, -10, 0),
    };
    entity._ai = {
      face() {
        faceCalls++;
      },
    };
    entity.attackSound = () => {
    };
    entity._damageInflictor.fireBullets = (count, direction, spread) => {
      shots.push({ count, direction: direction.copy(), spread: spread.copy() });
    };

    entity._fire();

    const expectedDirection = entity.enemy.origin.copy()
      .subtract(entity.enemy.velocity.copy().multiply(0.2))
      .subtract(entity.origin);
    expectedDirection.normalize();

    assert.equal(faceCalls, 1);
    assert.equal(shots.length, 1);
    assert.equal(shots[0].count, 4);
    assertVectorNear(shots[0].direction, expectedDirection);
    assertVectorNear(shots[0].spread, new Vector(0.1, 0.1, 0));
  });
});

void describe('ArmySoldierMonster state machine', () => {
  void test('stand, walk, and run sequences loop correctly', () => {
    const states = ArmySoldierMonster._states;

    for (let i = 1; i <= 8; i++) {
      assert.equal(states[`army_stand${i}`].keyframe, `stand${i}`);
      assert.equal(states[`army_run${i}`].keyframe, `run${i}`);
    }
    assert.equal(states.army_stand8.nextState, 'army_stand1');
    assert.equal(states.army_run8.nextState, 'army_run1');

    for (let i = 1; i <= 24; i++) {
      assert.equal(states[`army_walk${i}`].keyframe, `prowl_${i}`);
    }
    assert.equal(states.army_walk24.nextState, 'army_walk1');
  });

  void test('attack, pain, and death transitions match the QuakeC flow', () => {
    const states = ArmySoldierMonster._states;

    for (let i = 1; i <= 9; i++) {
      assert.equal(states[`army_atk${i}`].keyframe, `shoot${i}`);
    }
    assert.equal(states.army_atk9.nextState, 'army_run1');
    assert.equal(states.army_pain6.nextState, 'army_run1');
    assert.equal(states.army_painb14.nextState, 'army_run1');
    assert.equal(states.army_painc13.nextState, 'army_run1');
    assert.equal(states.army_die10.nextState, null);
    assert.equal(states.army_cdie11.nextState, null);
  });

  void test('inactive sequences omit handlers where expected', () => {
    const states = ArmySoldierMonster._states;
    assert.equal(states.army_pain1.handler, null);
    assert.equal(states.army_pain6.handler !== null, true);
    assert.equal(typeof states.army_painb2.handler, 'function');
    assert.equal(typeof states.army_atk4.handler, 'function');
  });
});

void describe('ArmyEnforcerMonster class metadata', () => {
  void test('classname is monster_enforcer', () => {
    assert.equal(ArmyEnforcerMonster.classname, 'monster_enforcer');
  });

  void test('health and model metadata match QC setup', () => {
    assert.equal(ArmyEnforcerMonster._health, 80);
    assert.equal(ArmyEnforcerMonster._modelDefault, 'progs/enforcer.mdl');
    assert.equal(ArmyEnforcerMonster._modelHead, 'progs/h_mega.mdl');
  });

  void test('size vectors are correct', () => {
    const [mins, maxs] = ArmyEnforcerMonster._size;
    assert.deepEqual([mins[0], mins[1], mins[2]], [-16, -16, -24]);
    assert.deepEqual([maxs[0], maxs[1], maxs[2]], [16, 16, 40]);
  });

  void test('serializableFields is a frozen empty array', () => {
    assert.ok(Array.isArray(ArmyEnforcerMonster.serializableFields));
    assert.ok(Object.isFrozen(ArmyEnforcerMonster.serializableFields));
    assert.deepEqual(ArmyEnforcerMonster.serializableFields, []);
  });

  void test('fire spawns a laser from the muzzle origin and updates movedir', () => {
    const { entity, spawnRequests } = createMonsterFixture(ArmyEnforcerMonster);
    let laserOrigin = null;
    const laser = Object.create(Laser.prototype);

    laser.setOrigin = (origin) => {
      laserOrigin = origin.copy();
    };

    entity.origin = new Vector(10, 20, 30);
    entity.angles = new Vector();
    entity.enemy = {
      origin: new Vector(70, 60, 30),
    };
    entity.engine.SpawnEntity = (classname, initialData = {}) => {
      spawnRequests.push({ classname, initialData });
      return {
        entity: laser,
      };
    };

    entity.fire();

    const movedir = entity.enemy.origin.copy().subtract(entity.origin);
    movedir.normalize();
    const { forward, right } = entity.angles.angleVectors();
    const expectedOrigin = entity.origin.copy().add(forward.multiply(30)).add(right.multiply(8.5)).add(new Vector(0, 0, 16));

    assert.equal(spawnRequests.length, 1);
    assert.equal(spawnRequests[0].initialData.owner, entity);
    assertVectorNear(entity.movedir, movedir);
    assertVectorNear(laserOrigin, expectedOrigin);
  });
});

void describe('ArmyEnforcerMonster state machine', () => {
  void test('stand, walk, and run sequences loop correctly', () => {
    const states = ArmyEnforcerMonster._states;

    for (let i = 1; i <= 7; i++) {
      assert.equal(states[`enf_stand${i}`].keyframe, `stand${i}`);
    }
    assert.equal(states.enf_stand7.nextState, 'enf_stand1');

    for (let i = 1; i <= 16; i++) {
      assert.equal(states[`enf_walk${i}`].keyframe, `walk${i}`);
    }
    assert.equal(states.enf_walk16.nextState, 'enf_walk1');

    for (let i = 1; i <= 8; i++) {
      assert.equal(states[`enf_run${i}`].keyframe, `run${i}`);
    }
    assert.equal(states.enf_run8.nextState, 'enf_run1');
  });

  void test('attack and pain sequences transition back to run', () => {
    const states = ArmyEnforcerMonster._states;
    const attackFrames = ['attack1', 'attack2', 'attack3', 'attack4', 'attack5', 'attack6', 'attack7', 'attack8', 'attack5', 'attack6', 'attack7', 'attack8', 'attack9', 'attack10'];

    for (let i = 0; i < attackFrames.length; i++) {
      assert.equal(states[`enf_atk${i + 1}`].keyframe, attackFrames[i]);
    }

    assert.equal(states.enf_atk14.nextState, 'enf_run1');
    assert.equal(states.enf_paina4.nextState, 'enf_run1');
    assert.equal(states.enf_painb5.nextState, 'enf_run1');
    assert.equal(states.enf_painc8.nextState, 'enf_run1');
    assert.equal(states.enf_paind19.nextState, 'enf_run1');
  });

  void test('death sequences remain terminal', () => {
    const states = ArmyEnforcerMonster._states;
    assert.equal(states.enf_die14.nextState, 'enf_die14');
    assert.equal(states.enf_fdie11.nextState, 'enf_fdie11');
  });

  void test('inactive sequences omit handlers where expected', () => {
    const states = ArmyEnforcerMonster._states;
    assert.equal(states.enf_paina1.handler, null);
    assert.equal(states.enf_painb1.handler, null);
    assert.equal(states.enf_painc1.handler, null);
    assert.equal(typeof states.enf_paind4.handler, 'function');
    assert.equal(typeof states.enf_atk6.handler, 'function');
  });
});
