import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';

import { createTestServer } from '../physics/fixtures.mjs';

/**
 * Builds a server whose network and system services record what dropping a client does to them.
 * @param {{ gameAPI: object, clients: object[] }} options server state to expose
 * @returns {{ sv: import('../../source/engine/server/Server.ts').default, printed: string[] }} the server and what it printed
 */
function createDropServer({ gameAPI, clients }) {
  const printed = [];
  const sv = createTestServer({
    net: /** @type {any} */ ({
      CanSendMessage() { return false; },
      SendMessage() { return 1; },
      Close() {},
      activeconnections: clients.length,
    }),
    sys: { Print(text) { printed.push(text); }, FloatTime: () => 0 },
  });

  sv.server.gameAPI = gameAPI;
  sv.svs.maxclients = clients.length;
  sv.svs.clients = clients;

  return { sv, printed };
}

/**
 * Builds a minimal client stub carrying only what Server.dropClient reads and writes.
 * @param {{ state: number, edict?: object | null }} options client shape
 * @returns {object} a mock ServerClient-shaped object
 */
function createDroppableClient({ state, edict = { num: 1 } }) {
  return {
    num: 0,
    name: 'Player',
    state,
    edict,
    netconnection: {},
    message: { writeByte() {}, writeShort() {}, writeString() {} },
    clear() {
      this.state = ServerClient.STATE.FREE;
    },
  };
}

/**
 * Builds a game API that records ClientDisconnect calls and throws on any other member access, so a
 * test fails when the engine starts touching more of the game than the contract allows.
 * @param {object[]} disconnected receives the edicts passed to ClientDisconnect
 * @returns {object} a strict game API stub
 */
function createStrictGameAPI(disconnected) {
  return new Proxy({
    ClientDisconnect(edict) {
      disconnected.push(edict);
    },
  }, {
    get(target, property) {
      if (property !== 'ClientDisconnect') {
        throw new Error(`unexpected read of game API member ${String(property)}`);
      }

      return target[property];
    },
    set(_target, property) {
      throw new Error(`unexpected write to game API member ${String(property)}`);
    },
  });
}

void describe('Server.dropClient', () => {
  void test('tells the game exactly once when a spawned client is removed and touches no other game API member', () => {
    const disconnected = [];
    const edict = { num: 1 };
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED, edict });
    const { sv, printed } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, false, 'bye');

    assert.deepEqual(disconnected, [edict]);
    assert.deepEqual(printed, ['Client Player removed\n']);
  });

  void test('does not tell the game about a client that never spawned', () => {
    const disconnected = [];
    const client = createDroppableClient({ state: ServerClient.STATE.CONNECTED });
    const { sv } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, false, 'bye');

    assert.deepEqual(disconnected, []);
  });

  void test('does not tell the game when the server goes down because of an error', () => {
    const disconnected = [];
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED });
    const { sv, printed } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, true, 'crash');

    assert.deepEqual(printed, ['Client Player dropped\n']);
    assert.deepEqual(disconnected, []);
  });
});
