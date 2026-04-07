import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { clientEvent } = await import('../../source/game/id1/Defs.ts');
const gameStatsModule = await import('../../source/game/id1/helper/GameStats.ts');

const GameStats = gameStatsModule.default;
const { gameStatSlots } = gameStatsModule;

/**
 * Create an event bus with subscribe/publish support for stats tests.
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
 * Create the minimal engine API surface used by GameStats.
 * @returns {object} Mock engine API.
 */
function createEngineAPI() {
  const eventBus = createEventBus();
  const broadcasts = [];
  const dispatches = [];

  return {
    eventBus,
    broadcasts,
    dispatches,
    BroadcastClientEvent(...args) {
      broadcasts.push(args);
    },
    DispatchClientEvent(...args) {
      dispatches.push(args);
    },
  };
}

/**
 * Create a mock entity wrapper with an edict number.
 * @param {number} edictNum Edict slot number.
 * @returns {object} Mock entity.
 */
function createEntity(edictNum) {
  return {
    edict: { num: edictNum },
  };
}

void describe('GameStats', () => {
  void test('tracks decorated stat fields for serialization', () => {
    const engineAPI = createEngineAPI();
    const stats = new GameStats({}, engineAPI);

    assert.ok(Array.isArray(GameStats.serializableFields));
    assert.ok(Object.isFrozen(GameStats.serializableFields));
    assert.deepEqual(GameStats.serializableFields, [...gameStatSlots]);
    assert.deepEqual(stats._serializer.serialize(), {
      monsters_killed: ['P', 0],
      monsters_total: ['P', 0],
      secrets_found: ['P', 0],
      secrets_total: ['P', 0],
    });
  });

  void test('subscribes to gameplay events and broadcasts stat updates', () => {
    const engineAPI = createEngineAPI();
    const stats = new GameStats({}, engineAPI);
    const secretFinder = createEntity(17);
    const attacker = createEntity(42);

    stats.subscribeToEvents();

    engineAPI.eventBus.publish('game.secret.spawned');
    engineAPI.eventBus.publish('game.monster.spawned');
    engineAPI.eventBus.publish('game.secret.found', createEntity(8), secretFinder);
    engineAPI.eventBus.publish('game.monster.killed', createEntity(9), attacker);

    assert.equal(stats.secrets_total, 1);
    assert.equal(stats.monsters_total, 1);
    assert.equal(stats.secrets_found, 1);
    assert.equal(stats.monsters_killed, 1);
    assert.deepEqual(engineAPI.broadcasts, [
      [true, clientEvent.STATS_UPDATED, 'secrets_found', 1, secretFinder.edict],
      [true, clientEvent.STATS_UPDATED, 'monsters_killed', 1, attacker.edict],
    ]);
  });

  void test('sends every stat slot to a player in slot order', () => {
    const engineAPI = createEngineAPI();
    const stats = new GameStats({}, engineAPI);
    const playerEntity = createEntity(7);

    stats.monsters_total = 10;
    stats.monsters_killed = 4;
    stats.secrets_total = 3;
    stats.secrets_found = 2;

    stats.sendToPlayer(playerEntity);

    assert.deepEqual(engineAPI.dispatches, [
      [playerEntity.edict, true, clientEvent.STATS_INIT, 'monsters_total', 10],
      [playerEntity.edict, true, clientEvent.STATS_INIT, 'monsters_killed', 4],
      [playerEntity.edict, true, clientEvent.STATS_INIT, 'secrets_total', 3],
      [playerEntity.edict, true, clientEvent.STATS_INIT, 'secrets_found', 2],
    ]);
  });

  void test('reset clears all stat counters', () => {
    const engineAPI = createEngineAPI();
    const stats = new GameStats({}, engineAPI);

    stats.monsters_total = 8;
    stats.monsters_killed = 5;
    stats.secrets_total = 4;
    stats.secrets_found = 1;

    stats.reset();

    for (const statSlot of gameStatSlots) {
      assert.equal(stats[statSlot], 0);
    }
  });
});
