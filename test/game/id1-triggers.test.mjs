import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';

await import('../../source/game/id1/GameAPI.ts');

const { damage, flags, solid } = await import('../../source/game/id1/Defs.ts');
const { default: BaseEntity } = await import('../../source/game/id1/entity/BaseEntity.ts');
const { TeleportEffectEntity } = await import('../../source/game/id1/entity/Misc.ts');
const { PlayerEntity, TelefragTriggerEntity } = await import('../../source/game/id1/entity/Player.ts');
const {
  CountTriggerEntity,
  InfoTeleportDestination,
  MultipleTriggerEntity,
  TeleportTriggerEntity,
  TriggerMonsterjumpEntity,
} = await import('../../source/game/id1/entity/Triggers.ts');

/**
 * Create a minimal mock game API for trigger tests.
 * @param {object} overrides Optional engine/game overrides.
 * @returns {object} Mock game API object.
 */
function createMockGameAPI(overrides = {}) {
  const engine = {
    SpawnEntity() {
      return null;
    },
    SpawnAmbientSound() {},
    PrecacheSound() {},
    BroadcastPrint() {},
    SetCvar() {},
    eventBus: {
      publish() {},
    },
    ...overrides.engine,
  };

  return {
    time: 0,
    engine,
    noexit: 0,
    mapname: 'e1m1',
    coop: 0,
    deathmatch: 0,
    force_retouch: 0,
    loadNextMap() {},
    startIntermission() {},
    ...overrides,
  };
}

class TestEntity extends BaseEntity {
  static classname = 'test_trigger_entity';

  removed = false;

  remove() {
    this.removed = true;
  }
}

/**
 * Build a player-shaped test double that satisfies instanceof checks.
 * @param {object} overrides Optional field or method overrides.
 * @returns {PlayerEntity} Player-like test entity.
 */
function createPlayerStub(overrides = {}) {
  return Object.assign(Object.create(PlayerEntity.prototype), {
    health: 100,
    solid: solid.SOLID_SLIDEBOX,
    flags: flags.FL_ONGROUND,
    origin: new Vector(),
    angles: new Vector(),
    velocity: new Vector(),
    fixangle: false,
    teleport_time: 0,
    fly_time: 0,
    netname: 'Player',
    centerPrint() {},
    startSound() {},
    setOrigin(origin) {
      this.origin.set(origin);
    },
    ...overrides,
  });
}

void describe('Triggers port', () => {
  void test('MultipleTriggerEntity applies QC defaults and rearms health-gated triggers', () => {
    const scheduledThinks = [];
    const entity = new MultipleTriggerEntity(null, createMockGameAPI()).initializeEntity();
    entity.model = '*1';
    entity.health = 12;
    entity.setModel = () => {};
    entity.setOrigin = () => {};
    entity._scheduleThink = (nextThink, callback) => {
      scheduledThinks.push({ nextThink, callback });
    };

    entity.spawn();

    assert.equal(entity.wait, 0.2);
    assert.equal(entity.max_health, 12);
    assert.equal(entity.takedamage, damage.DAMAGE_YES);
    assert.equal(entity.solid, solid.SOLID_BBOX);

    entity._sub = {
      useTargets() {},
      setMovedir() {},
    };
    entity._trigger(new TestEntity(null, createMockGameAPI()).initializeEntity());

    assert.equal(scheduledThinks.length, 1);
    scheduledThinks[0].callback();
    assert.equal(entity._isActive, false);
    assert.equal(entity.health, 12);
  });

  void test('CountTriggerEntity shows countdown text and fires when it reaches zero', () => {
    const prints = [];
    const usedTargets = [];
    const player = createPlayerStub({
      centerPrint(message) {
        prints.push(message);
      },
    });
    const entity = new CountTriggerEntity(null, createMockGameAPI()).initializeEntity();
    entity._sub = {
      useTargets(userEntity) {
        usedTargets.push(userEntity);
      },
      setMovedir() {},
    };
    entity.lazyRemove = () => {
      entity.removed = true;
    };
    entity.count = 2;

    entity.use(player);
    entity.use(player);

    assert.deepEqual(prints, ['Only 1 more to go...', 'Sequence completed!']);
    assert.deepEqual(usedTargets, [player]);
  });

  void test('TeleportTriggerEntity moves players, spawns effects, and sets exit velocity', () => {
    const spawnRequests = [];
    const usedTargets = [];
    const player = createPlayerStub();
    player.origin.setTo(10, 20, 30);
    player.velocity.setTo(1, 2, 3);

    const destination = new InfoTeleportDestination(null, createMockGameAPI()).initializeEntity();
    destination.origin.setTo(100, 200, 300);
    destination.mangle.setTo(0, 0, 0);

    const entity = new TeleportTriggerEntity(null, createMockGameAPI({
      time: 5,
      engine: {
        SpawnEntity(classname, initialData) {
          spawnRequests.push({ classname, initialData });
          return { entity: null };
        },
      },
    })).initializeEntity();
    entity._sub = {
      useTargets(userEntity) {
        usedTargets.push(userEntity);
      },
      setMovedir() {},
    };
    entity.target = 'tele_dest';
    entity.findFirstEntityByFieldAndValue = () => destination;

    entity.touch(player);

    assert.deepEqual(usedTargets, [player]);
    assert.equal(spawnRequests.length, 3);
    assert.equal(spawnRequests[0].classname, TeleportEffectEntity.classname);
    assert.equal(spawnRequests[1].classname, TeleportEffectEntity.classname);
    assert.equal(spawnRequests[2].classname, TelefragTriggerEntity.classname);
    assert.ok(player.origin.equalsTo(100, 200, 300));
    assert.ok(player.angles.equalsTo(0, 0, 0));
    assert.equal(player.fixangle, true);
    assert.equal(player.teleport_time, 5.7);
    assert.ok(player.velocity.equalsTo(300, 0, 0));
    assert.equal((player.flags & flags.FL_ONGROUND) === 0, true);
  });

  void test('TriggerMonsterjumpEntity applies defaults and launches grounded monsters', () => {
    const entity = new TriggerMonsterjumpEntity(null, createMockGameAPI()).initializeEntity();
    entity.model = '*2';
    entity.setModel = () => {};
    entity.spawn();

    assert.equal(entity.speed, 200);
    assert.equal(entity.height, 200);
    entity.movedir.setTo(1, 0, 0);

    const monster = new TestEntity(null, createMockGameAPI()).initializeEntity();
    monster.flags = flags.FL_MONSTER | flags.FL_ONGROUND;
    monster.velocity.setTo(0, 0, 5);

    entity.touch(monster);

    assert.ok(monster.velocity.equalsTo(200, 0, 200));
    assert.equal((monster.flags & flags.FL_ONGROUND) === 0, true);
  });
});
