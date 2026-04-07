import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';

const { clientEvent, clientEventName, effect, items } = await import('../../source/game/id1/Defs.ts');
await import('../../source/game/id1/GameAPI.ts');

const syncModule = await import('../../source/game/id1/client/Sync.ts');
const hudModule = await import('../../source/game/id1/client/HUD.ts');
const clientApiModule = await import('../../source/game/id1/client/ClientAPI.ts');

const { ClientStats, ServerInfo } = syncModule;
const { Q1HUD } = hudModule;
const { ClientGameAPI } = clientApiModule;

/**
 * Create an event bus with subscribe and publish support.
 * @returns {object} Mock event bus.
 */
function createEventBus() {
  const listeners = new Map();

  return {
    subscribe(eventName, handler) {
      const handlers = listeners.get(eventName) ?? [];
      handlers.push(handler);
      listeners.set(eventName, handlers);

      return () => {
        const currentHandlers = listeners.get(eventName) ?? [];
        listeners.set(eventName, currentHandlers.filter((currentHandler) => currentHandler !== handler));
      };
    },

    publish(eventName, ...args) {
      for (const handler of listeners.get(eventName) ?? []) {
        handler(...args);
      }
    },
  };
}

/**
 * Create a mock texture with the surface expected by HUD and ClientGameAPI.
 * @param {string} name Debug name.
 * @param {number} width Texture width.
 * @param {number} height Texture height.
 * @returns {object} Mock texture.
 */
function createMockTexture(name, width = 24, height = 24) {
  return {
    name,
    width,
    height,
    freed: false,
    free() {
      this.freed = true;
    },
    wrapClamped() {
    },
  };
}

/**
 * Create a minimal client engine API mock for HUD and client API tests.
 * @param {object} overrides Override values.
 * @returns {object} Mock engine API.
 */
function createMockClientEngine(overrides = {}) {
  const eventBus = createEventBus();
  const sounds = [];
  const commands = new Map();

  return {
    eventBus,
    sounds,
    commands,
    DrawPic() {
    },
    DrawRect() {
    },
    DrawString() {
    },
    LoadPicFromWad(name) {
      return createMockTexture(name);
    },
    LoadPicFromLump(name) {
      return createMockTexture(name, 64, 16);
    },
    LoadPicFromFile(name) {
      return Promise.resolve(createMockTexture(name));
    },
    LoadSound(name) {
      const sound = {
        name,
        playCount: 0,
        play() {
          this.playCount += 1;
        },
      };
      sounds.push(sound);
      return sound;
    },
    ConsoleDebug() {
    },
    ConsoleError() {
    },
    ConsolePrint() {
    },
    RegisterCommand(name, handler) {
      commands.set(name, handler);
    },
    UnregisterCommand(name) {
      commands.delete(name);
    },
    ContentShift() {
    },
    IndexToRGB() {
      return [1.0, 1.0, 1.0];
    },
    PlaceDecal() {
    },
    ModForName(name) {
      return { name };
    },
    AllocDlight() {
      return {};
    },
    VID: {
      width: 320,
      height: 200,
    },
    SCR: {
      viewsize: 100,
    },
    CL: {
      gametime: 0,
      frametime: 0.1,
      entityNum: 1,
      intermission: false,
      levelname: 'e1m1',
      maxclients: 1,
      time: 0,
      viewangles: new Vector(),
      vieworigin: new Vector(),
      score() {
        return {
          isActive: false,
          frags: 0,
          name: '',
          ping: 0,
          colors: 0,
        };
      },
    },
    ...overrides,
  };
}

/**
 * Create a minimal clientdata map for HUD and client API tests.
 * @param {object} overrides Override values.
 * @returns {object} Mock clientdata.
 */
function createClientdata(overrides = {}) {
  return {
    health: 100,
    armorvalue: 0,
    armortype: 0,
    items: 0,
    ammo_shells: 0,
    ammo_nails: 0,
    ammo_rockets: 0,
    ammo_cells: 0,
    weapon: 0,
    weaponframe: 0,
    effects: 0,
    ...overrides,
  };
}

void describe('id1 client sync', () => {
  void test('updates stats and server info from client events', () => {
    const engine = createMockClientEngine();
    const stats = new ClientStats(engine);
    const serverInfo = new ServerInfo(engine);

    engine.eventBus.publish(clientEventName(clientEvent.STATS_INIT), 'monsters_total', 13);
    engine.eventBus.publish(clientEventName(clientEvent.STATS_UPDATED), 'secrets_found', 2);
    engine.eventBus.publish('client.server-info.ready', {
      hostname: 'Shub Hub',
      coop: '1',
      deathmatch: '0',
      skill: '3',
      map: 'e1m8',
    });
    engine.eventBus.publish('client.server-info.updated', 'hostname', 'Slipgate Complex');

    assert.equal(stats.monsters_total, 13);
    assert.equal(stats.secrets_found, 2);
    assert.equal(serverInfo.hostname, 'Slipgate Complex');
    assert.equal(serverInfo.coop, '1');
    assert.equal(serverInfo.map, 'e1m8');
  });
});

void describe('id1 client HUD state', () => {
  void test('restores saved vectors and stat counters when loading HUD state', () => {
    const engine = createMockClientEngine();
    const game = {
      clientdata: createClientdata(),
      serverInfo: new ServerInfo(engine),
    };
    const hud = new Q1HUD(game, engine);

    hud.init();
    hud.loadState({
      damage: {
        time: 4,
        attackOrigin: [1, 2, 3],
        damageReceived: 9,
      },
      intermission: {
        running: true,
        message: 'Episode complete',
        mapCompletedTime: 17,
      },
      stats: {
        monsters_total: 10,
        monsters_killed: 7,
        secrets_total: 5,
        secrets_found: 4,
      },
    });

    assert.ok(hud.damage.attackOrigin instanceof Vector);
    assert.deepEqual(Array.from(hud.damage.attackOrigin), [1, 2, 3]);
    assert.equal(hud.damage.damageReceived, 9);
    assert.equal(hud.intermission.message, 'Episode complete');
    assert.equal(hud.stats.monsters_killed, 7);
  });
});

void describe('id1 client API', () => {
  void test('publishes client events and restores saved game state', () => {
    const engine = createMockClientEngine();
    const receivedEvents = [];
    const clientGame = new ClientGameAPI(engine);

    clientGame.init();

    engine.eventBus.subscribe(clientEventName(clientEvent.TEST_EVENT), (...args) => {
      receivedEvents.push(args);
    });

    clientGame.clientdata.health = 33;
    clientGame.serverInfo.hostname = 'Old Name';
    clientGame.hud.damage.time = 2;
    clientGame.hud.damage.damageReceived = 11;
    clientGame.hud.damage.attackOrigin = new Vector(4, 5, 6);

    const savedGame = clientGame.saveGame();

    clientGame.clientdata.health = 100;
    clientGame.serverInfo.hostname = 'New Name';
    clientGame.handleClientEvent(clientEvent.TEST_EVENT, 'alpha', 7);
    clientGame.loadGame(savedGame);

    assert.deepEqual(receivedEvents, [['alpha', 7]]);
    assert.equal(clientGame.clientdata.health, 33);
    assert.equal(clientGame.serverInfo.hostname, 'Old Name');
    assert.ok(clientGame.hud.damage.attackOrigin instanceof Vector);
    assert.deepEqual(Array.from(clientGame.hud.damage.attackOrigin), [4, 5, 6]);
  });

  void test('updates the viewmodel and muzzleflash effects during the frame', () => {
    const dlight = {};
    const engine = createMockClientEngine({
      AllocDlight() {
        return dlight;
      },
      CL: {
        gametime: 0,
        frametime: 0.1,
        entityNum: 3,
        intermission: false,
        levelname: 'e1m1',
        maxclients: 1,
        time: 10,
        viewangles: new Vector(),
        vieworigin: new Vector(10, 20, 30),
        score() {
          return {
            isActive: false,
            frags: 0,
            name: '',
            ping: 0,
            colors: 0,
          };
        },
      },
    });
    const clientGame = new ClientGameAPI(engine);

    clientGame.init();
    clientGame.clientdata = createClientdata({
      weapon: items.IT_SHOTGUN,
      weaponframe: 3,
      effects: effect.EF_MUZZLEFLASH,
    });

    clientGame.startFrame();

    assert.equal(clientGame.viewmodel.visible, true);
    assert.equal(clientGame.viewmodel.model.name, 'progs/v_shot.mdl');
    assert.equal(clientGame.viewmodel.frame, 3);
    assert.deepEqual(Array.from(dlight.origin), [30, 20, 62]);
    assert.equal(dlight.minlight, 32);
    assert.equal(dlight.die, 10.2);
  });
});
