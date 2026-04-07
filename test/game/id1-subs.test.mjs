import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';

await import('../../source/game/id1/GameAPI.ts');

const { default: BaseEntity } = await import('../../source/game/id1/entity/BaseEntity.ts');
const { DelayedThinkEntity, Sub, TriggerFieldEntity, TriggerFieldFlag } = await import('../../source/game/id1/entity/Subs.ts');

/**
 * Create a minimal mock game API for helper tests.
 * @param {object} overrides Optional engine/game overrides.
 * @returns {object} Mock game API object.
 */
function createMockGameAPI(overrides = {}) {
  const engine = {
    SpawnEntity() {
      return null;
    },
    FindAllByFieldAndValue() {
      return [];
    },
    PrecacheSound() {},
    StartSound() {},
    ...overrides.engine,
  };

  return {
    time: 0,
    engine,
    worldspawn: overrides.worldspawn ?? null,
    ...overrides,
  };
}

class TestTargetEntity extends BaseEntity {
  static classname = 'test_subs_target';

  usedBy = null;
  removed = false;

  use(activatorEntity) {
    this.usedBy = activatorEntity;
  }

  remove() {
    this.removed = true;
  }
}

void describe('Sub helpers', () => {
  void test('useTargets keeps stock killtarget early-return behavior', () => {
    const activator = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    const firstKilltarget = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    const target = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();

    let findCallCount = 0;
    const worldspawn = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    worldspawn.findNextEntityByFieldAndValue = (field, value) => {
      assert.equal(field, 'targetname');
      assert.equal(value, 'remove_me');
      findCallCount++;
      return findCallCount === 1 ? firstKilltarget : null;
    };
    firstKilltarget.findNextEntityByFieldAndValue = () => {
      findCallCount++;
      return null;
    };

    const owner = new TestTargetEntity(null, createMockGameAPI({
      worldspawn,
      engine: {
        FindAllByFieldAndValue() {
          return [{ entity: target }];
        },
      },
    })).initializeEntity();
    owner.killtarget = 'remove_me';
    owner.target = 'fire_me';

    const sub = new Sub(owner);
    sub.useTargets(activator);

    assert.equal(firstKilltarget.removed, true);
    assert.equal(target.usedBy, null);
  });

  void test('useTargets spawns delayed helper entities when delay is set', () => {
    const activator = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    const spawnCalls = [];
    const owner = new TestTargetEntity(null, createMockGameAPI({
      engine: {
        SpawnEntity(classname, initialData) {
          spawnCalls.push({ classname, initialData });
          return null;
        },
      },
    })).initializeEntity();
    owner.delay = 0.75;

    const sub = new Sub(owner);
    sub.useTargets(activator);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].classname, DelayedThinkEntity.classname);
    assert.equal(spawnCalls[0].initialData.owner, owner);
    assert.equal(spawnCalls[0].initialData.activator, activator);
    assert.equal(spawnCalls[0].initialData.delay, 0.75);
  });
});

void describe('TriggerFieldEntity', () => {
  void test('expands the touch bounds on spawn', () => {
    const sizeCalls = [];
    const entity = new TriggerFieldEntity(null, createMockGameAPI()).initializeEntity();
    entity.mins.setTo(10, 20, 30);
    entity.maxs.setTo(40, 50, 60);
    entity.setSize = (mins, maxs) => {
      sizeCalls.push({ mins: mins.copy(), maxs: maxs.copy() });
    };

    entity.spawn();

    assert.equal(sizeCalls.length, 1);
    assert.ok(sizeCalls[0].mins.equalsTo(-50, -40, 22));
    assert.ok(sizeCalls[0].maxs.equalsTo(100, 110, 68));
  });

  void test('respects actor and debounce gating before forwarding use', () => {
    const usedBy = [];
    const owner = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    owner.use = (entity) => {
      usedBy.push(entity);
    };

    const field = new TriggerFieldEntity(null, createMockGameAPI()).initializeEntity();
    field.owner = owner;

    const nonActor = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    field.touch(nonActor);
    assert.equal(usedBy.length, 0);

    class ActorEntity extends TestTargetEntity {
      isActor() {
        return true;
      }
    }

    const actor = new ActorEntity(null, createMockGameAPI()).initializeEntity();
    actor.health = 25;
    field.touch(actor);
    assert.equal(usedBy.length, 1);
    assert.equal(usedBy[0], actor);
    assert.equal(field.attack_finished, 1);

    field.touch(actor);
    assert.equal(usedBy.length, 1);

    field.game.time = 1.5;
    field.flags = TriggerFieldFlag.TFF_ANY_ENTITY_TRIGGERS;
    field.touch(nonActor);
    assert.equal(usedBy.length, 2);
    assert.equal(usedBy[1], nonActor);
  });
});

void describe('Sub movement helpers', () => {
  void test('setMovedir preserves Quake up/down angle sentinels', () => {
    const entity = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    entity.angles.setTo(0, -1, 0);

    const sub = new Sub(entity);
    sub.setMovedir();
    assert.ok(entity.movedir.equalsTo(0, 0, 1));
    assert.ok(entity.angles.equalsTo(0, 0, 0));

    entity.angles.setTo(0, -2, 0);
    sub.setMovedir();
    assert.ok(entity.movedir.equalsTo(0, 0, -1));

    entity.angles.setTo(0, 0, 0);
    sub.setMovedir();
    assert.ok(entity.movedir.equalsTo(1, 0, 0));
  });

  void test('calcMove schedules a completion think and velocity toward the destination', () => {
    const scheduleCalls = [];
    const entity = new TestTargetEntity(null, createMockGameAPI()).initializeEntity();
    entity.origin.setTo(0, 0, 0);
    entity.ltime = 10;
    entity._scheduleThink = (time, callback, identifier) => {
      scheduleCalls.push({ time, callback, identifier });
    };
    entity.setOrigin = (origin) => {
      entity.origin.set(origin);
    };

    const sub = new Sub(entity);
  entity._sub = sub;
    const destination = new Vector(100, 0, 0);
    let callbackCount = 0;

    sub.calcMove(destination, 50, function () {
      callbackCount++;
    });

    assert.equal(scheduleCalls.length, 1);
    assert.equal(scheduleCalls[0].time, 12);
    assert.equal(scheduleCalls[0].identifier, 'sub-calcmove');
    assert.ok(entity.velocity.equalsTo(50, 0, 0));

    scheduleCalls[0].callback.call(entity, entity);

    assert.ok(entity.origin.equalsTo(100, 0, 0));
    assert.ok(entity.velocity.equalsTo(0, 0, 0));
    assert.equal(callbackCount, 1);
  });
});
