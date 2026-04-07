import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { moveType } from '../../source/game/id1/Defs.ts';

await import('../../source/game/id1/GameAPI.ts');

const { BodyqueEntity, CopyToBodyQue, WorldspawnEntity } = await import('../../source/game/id1/entity/Worldspawn.ts');

/**
 * Create a mock server edict that keeps entity fields in sync.
 * @param {number} num Edict slot number.
 * @returns {import('../../source/shared/GameInterfaces.ts').ServerEdict} Mock edict.
 */
function createMockEdict(num) {
  const entityRef = { current: null };

  return /** @type {import('../../source/shared/GameInterfaces.ts').ServerEdict} */ ({
    num,
    entity: null,
    freeEdict() {},
    setOrigin(origin) {
      entityRef.current.origin = origin.copy();
    },
    setModel(model) {
      entityRef.current.model = model;
    },
    setMinMaxSize(mins, maxs) {
      entityRef.current.mins = mins.copy();
      entityRef.current.maxs = maxs.copy();
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
    __setEntity(entity) {
      entityRef.current = entity;
      this.entity = entity;
    },
  });
}

/**
 * Create a minimal worldspawn fixture with spawnable body queue entities.
 * @returns {{ worldspawn: WorldspawnEntity, gameAPI: object, precachedSounds: string[], precachedModels: string[], lightstyles: Array<{ style: number, value: string }>, cvars: Array<{ name: string, value: string }>, spawnClassnames: string[] }} Fixture data.
 */
function createWorldspawnFixture() {
  const precachedSounds = [];
  const precachedModels = [];
  const lightstyles = [];
  const cvars = [];
  const spawnClassnames = [];
  let nextEdictNum = 10;
  const gameAPI = {
    engine: null,
    worldspawn: /** @type {WorldspawnEntity|null} */ (null),
    lastspawn: /** @type {WorldspawnEntity|null} */ (null),
    bodyque_head: /** @type {BodyqueEntity|null} */ (null),
  };

  const engine = {
    IsLoading() {
      return false;
    },
    PrecacheSound(sound) {
      precachedSounds.push(sound);
    },
    PrecacheModel(model) {
      precachedModels.push(model);
    },
    ParseQC() {
      return null;
    },
    SetCvar(name, value) {
      cvars.push({ name, value });
    },
    Lightstyle(style, value) {
      lightstyles.push({ style, value });
    },
    SpawnEntity(classname) {
      spawnClassnames.push(classname);
      if (classname !== BodyqueEntity.classname) {
        return { entity: null };
      }

      const edict = createMockEdict(nextEdictNum++);
      const entity = new BodyqueEntity(edict, gameAPI).initializeEntity().precacheEntity();
      edict.__setEntity(entity);
      return { entity };
    },
  };

  gameAPI.engine = engine;

  const worldspawnEdict = createMockEdict(1);
  const worldspawn = new WorldspawnEntity(worldspawnEdict, gameAPI).initializeEntity().precacheEntity();
  worldspawnEdict.__setEntity(worldspawn);
  worldspawn.origin = new Vector();
  worldspawn.model = 'maps/start.bsp';

  return { worldspawn, gameAPI, precachedSounds, precachedModels, lightstyles, cvars, spawnClassnames };
}

void describe('WorldspawnEntity spawn', () => {
  void test('creates a four-entry QC body queue ring and initializes world lighting', () => {
    const previousWorldspawn = /** @type {WorldspawnEntity} */ ({ marker: 'previous' });
    const { worldspawn, gameAPI, cvars, lightstyles, spawnClassnames, precachedSounds, precachedModels } = createWorldspawnFixture();

    gameAPI.worldspawn = previousWorldspawn;
    worldspawn.model = 'maps/e1m8.bsp';

    worldspawn.spawn();

    assert.equal(gameAPI.lastspawn, previousWorldspawn);
    assert.equal(gameAPI.worldspawn, worldspawn);
    assert.equal(spawnClassnames.length, 4);
    assert.ok(gameAPI.bodyque_head instanceof BodyqueEntity);
    assert.equal(gameAPI.bodyque_head.owner.owner.owner.owner, gameAPI.bodyque_head);
    assert.deepEqual(cvars, [{ name: 'sv_gravity', value: '100' }]);
    assert.equal(lightstyles.length, 13);
    assert.deepEqual(lightstyles[0], { style: 0, value: 'm' });
    assert.deepEqual(lightstyles.at(-1), { style: 63, value: 'a' });
    assert.ok(precachedSounds.includes('demon/dland2.wav'));
    assert.ok(precachedSounds.includes('misc/talk.wav'));
    assert.ok(precachedModels.includes('progs/bolt3.mdl'));
  });

  void test('uses normal gravity outside END and copies corpse data into the body queue', () => {
    const { worldspawn, gameAPI, cvars } = createWorldspawnFixture();
    worldspawn.spawn();

    const firstBody = gameAPI.bodyque_head;
    const nextBody = firstBody.owner;
    const player = {
      angles: new Vector(10, 20, 30),
      model: 'progs/player.mdl',
      frame: 7,
      colormap: 5,
      movetype: moveType.MOVETYPE_WALK,
      velocity: new Vector(1, 2, 3),
      origin: new Vector(100, 200, 300),
      mins: new Vector(-16, -16, -24),
      maxs: new Vector(16, 16, 32),
    };

    CopyToBodyQue(gameAPI, /** @type {import('../../source/game/id1/entity/Player.ts').PlayerEntity} */ (player));

    assert.deepEqual(cvars, [{ name: 'sv_gravity', value: '800' }]);
    assert.ok(firstBody.angles.equalsTo(10, 20, 30));
    assert.equal(firstBody.model, 'progs/player.mdl');
    assert.equal(firstBody.frame, 7);
    assert.equal(firstBody.colormap, 5);
    assert.equal(firstBody.movetype, moveType.MOVETYPE_WALK);
    assert.ok(firstBody.velocity.equalsTo(1, 2, 3));
    assert.ok(firstBody.origin.equalsTo(100, 200, 300));
    assert.ok(firstBody.mins.equalsTo(-16, -16, -24));
    assert.ok(firstBody.maxs.equalsTo(16, 16, 32));
    assert.equal(gameAPI.bodyque_head, nextBody);

    player.angles.setTo(1, 1, 1);
    player.velocity.setTo(9, 9, 9);
    assert.ok(firstBody.angles.equalsTo(10, 20, 30));
    assert.ok(firstBody.velocity.equalsTo(1, 2, 3));
  });
});
