import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveType, solid } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { PathCornerEntity } = await import('../../source/game/id1/entity/Misc.ts');
const { PlatformEntity, PlatformTriggerEntity, TrainEntity, TeleportTrainEntity } = await import('../../source/game/id1/entity/props/Platforms.ts');
const { state } = await import('../../source/game/id1/entity/props/BasePropEntity.ts');

/**
 * Create a minimal mover harness for platform-family entity tests.
 * @returns {{ edict: object, engine: object, gameAPI: object, precachedSounds: string[], precachedModels: string[], setModelCalls: string[], spawnRequests: Array<{ classname: string, initialData: object }>, scheduledThinks: Array<{ nextThink: number, callback: Function, identifier?: string | null }> }} Harness data.
 */
function createMoverHarness() {
  const precachedSounds = [];
  const precachedModels = [];
  const setModelCalls = [];
  const spawnRequests = [];
  const scheduledThinks = [];
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
      if (boundEntity !== null) {
        boundEntity.model = model;
        boundEntity.modelindex = model ? 1 : 0;
      }
    },
    setMinMaxSize(mins, maxs) {
      if (boundEntity !== null) {
        boundEntity.mins.set(mins);
        boundEntity.maxs.set(maxs);
        boundEntity.size = maxs.copy().subtract(mins);
      }
    },
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
    PrecacheModel(model) {
      precachedModels.push(model);
    },
    PrecacheSound(sound) {
      precachedSounds.push(sound);
    },
    StartSound() {},
    SpawnAmbientSound() {},
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
    ParseQC() {
      return null;
    },
    Traceline() {
      return null;
    },
    SetAreaPortalState() {},
    GetCvar() {
      return { value: 0 };
    },
  };

  const gameAPI = {
    engine,
    time: 0,
  };

  return {
    edict,
    engine,
    gameAPI,
    precachedSounds,
    precachedModels,
    setModelCalls,
    spawnRequests,
    scheduledThinks,
    bindEntity(entity) {
      boundEntity = entity;
      edict.entity = entity;
      entity._scheduleThink = (nextThink, callback, identifier = null) => {
        scheduledThinks.push({ nextThink, callback, identifier });
      };
    },
  };
}

/**
 * Build a platform fixture for focused gameplay tests.
 * @returns {{ entity: InstanceType<typeof PlatformEntity>, edict: object, engine: object, gameAPI: object, precachedSounds: string[], precachedModels: string[], setModelCalls: string[], spawnRequests: Array<{ classname: string, initialData: object }>, scheduledThinks: Array<{ nextThink: number, callback: Function, identifier?: string | null }> }} Fixture data.
 */
function createPlatformFixture() {
  const harness = createMoverHarness();
  const entity = new PlatformEntity(harness.edict, harness.gameAPI).initializeEntity().precacheEntity();
  harness.bindEntity(entity);
  return { entity, ...harness };
}

/**
 * Build a train-family fixture for focused gameplay tests.
 * @param {typeof TrainEntity | typeof TeleportTrainEntity} [EntityClass] Constructor under test.
 * @returns {{ entity: InstanceType<typeof TrainEntity>, edict: object, engine: object, gameAPI: object, precachedSounds: string[], precachedModels: string[], setModelCalls: string[], spawnRequests: Array<{ classname: string, initialData: object }>, scheduledThinks: Array<{ nextThink: number, callback: Function, identifier?: string | null }> }} Fixture data.
 */
function createTrainFixture(EntityClass = TrainEntity) {
  const harness = createMoverHarness();
  const entity = new EntityClass(harness.edict, harness.gameAPI).initializeEntity().precacheEntity();
  harness.bindEntity(entity);
  return { entity, ...harness };
}

void describe('PlatformEntity', () => {
  void test('spawn applies QC defaults, positions the plat, and spawns its trigger', () => {
    const { entity, spawnRequests, setModelCalls, precachedSounds } = createPlatformFixture();

    entity.origin = new Vector(10, 20, 30);
    entity.model = 'progs/plat.bsp';
    entity.mins = new Vector(-32, -32, 0);
    entity.maxs = new Vector(32, 32, 64);
    entity.size = new Vector(64, 64, 64);

    entity.spawn();

    assert.deepEqual(precachedSounds, ['plats/medplat1.wav', 'plats/medplat2.wav']);
    assert.equal(entity.speed, 150);
    assert.equal(entity.t_length, 80);
    assert.equal(entity.t_width, 10);
    assert.equal(entity.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(entity.solid, solid.SOLID_BSP);
    assert.equal(entity.state, state.STATE_BOTTOM);
    assert.equal(entity.noise, 'plats/medplat1.wav');
    assert.equal(entity.noise1, 'plats/medplat2.wav');
    assert.ok(entity.pos1.equalsTo(10, 20, 30));
    assert.ok(entity.pos2.equalsTo(10, 20, -26));
    assert.ok(entity.origin.equalsTo(10, 20, -26));
    assert.deepEqual(setModelCalls, ['progs/plat.bsp']);
    assert.deepEqual(spawnRequests, [{ classname: PlatformTriggerEntity.classname, initialData: { owner: entity } }]);
  });

  void test('targeted plats only honor the remote use once, matching QC plat_use', () => {
    const { entity } = createPlatformFixture();
    const calcMoveCalls = [];

    entity.origin = new Vector();
    entity.model = 'progs/plat_targeted.bsp';
    entity.mins = new Vector(-16, -16, 0);
    entity.maxs = new Vector(16, 16, 32);
    entity.size = new Vector(32, 32, 32);
    entity.targetname = 'remote_plat';
    entity._sub = {
      calcMove(target, speed, callback) {
        calcMoveCalls.push({ target: target.copy(), speed, callback });
      },
      setMovedir() {},
      useTargets() {},
      reset() {},
    };

    entity.spawn();
    entity.use(entity);
    entity.state = state.STATE_UP;
    entity.use(entity);

    assert.equal(calcMoveCalls.length, 1);
    assert.equal(entity.state, state.STATE_UP);
  });
});

void describe('TrainEntity', () => {
  void test('finds the first corner, updates target to the next corner, and only activates once when targeted', () => {
    const { entity } = createTrainFixture();
    const calcMoveCalls = [];
    const firstCorner = Object.assign(Object.create(PathCornerEntity.prototype), {
      origin: new Vector(100, 200, 300),
      target: 'corner_2',
      wait: 0,
    });
    const secondCorner = Object.assign(Object.create(PathCornerEntity.prototype), {
      origin: new Vector(400, 500, 600),
      target: 'corner_3',
      wait: 1.5,
    });

    entity.model = 'progs/train.bsp';
    entity.target = 'corner_1';
    entity.targetname = 'remote_train';
    entity.mins = new Vector(-16, -16, -16);
    entity.maxs = new Vector(16, 16, 16);
    entity.size = new Vector(32, 32, 32);
    entity._sub = {
      calcMove(target, speed, callback) {
        calcMoveCalls.push({ target: target.copy(), speed, callback });
      },
      setMovedir() {},
      useTargets() {},
      reset() {},
    };
    entity.findFirstEntityByFieldAndValue = (_field, value) => {
      if (value === 'corner_1') {
        return firstCorner;
      }
      if (value === 'corner_2') {
        return secondCorner;
      }
      return null;
    };

    entity.spawn();
    entity._trainFind();

    assert.ok(entity.origin.equalsTo(116, 216, 316));
    assert.equal(entity.target, 'corner_2');

    entity.use(entity);
    entity.use(entity);

    assert.equal(calcMoveCalls.length, 1);
    assert.ok(calcMoveCalls[0].target.equalsTo(416, 516, 616));
    assert.equal(calcMoveCalls[0].speed, 100);
    assert.equal(entity.target, 'corner_3');
    assert.equal(entity.wait, 1.5);
  });
});

void describe('TeleportTrainEntity', () => {
  void test('spawns with the teleport model, no collision, and the initial find think', () => {
    const { entity, setModelCalls, precachedModels, precachedSounds, scheduledThinks } = createTrainFixture(TeleportTrainEntity);

    entity.target = 'tele_corner';
    entity.mins = new Vector(-8, -8, -8);
    entity.maxs = new Vector(8, 8, 8);
    entity.size = new Vector(16, 16, 16);

    entity.spawn();

    assert.deepEqual(precachedSounds, ['misc/null.wav']);
    assert.deepEqual(precachedModels, ['progs/teleport.mdl']);
    assert.deepEqual(setModelCalls, ['progs/teleport.mdl']);
    assert.equal(entity.movetype, moveType.MOVETYPE_PUSH);
    assert.equal(entity.solid, solid.SOLID_NOT);
    assert.ok(entity.avelocity.equalsTo(100, 200, 300));
    assert.equal(scheduledThinks.length, 1);
    assert.equal(scheduledThinks[0].nextThink, 0.1);
  });
});
