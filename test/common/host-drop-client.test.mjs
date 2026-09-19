import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs the minimal registry Host.DropClient needs and runs the callback.
 * @param {{ gameAPI: object, clients: object[] }} options server state to expose
 * @param {(recorded: { printed: string[] }) => void} callback test callback
 */
function withMockDropRegistry({ gameAPI, clients }, callback) {
  const previous = { NET: registry.NET, SV: registry.SV, Sys: registry.Sys };
  const printed = [];

  registry.NET = {
    CanSendMessage() { return false; },
    SendMessage() { return 1; },
    Close() {},
    activeconnections: clients.length,
  };
  registry.Sys = { Print(text) { printed.push(text); } };
  registry.SV = { server: { gameAPI }, svs: { maxclients: clients.length, clients } };
  eventBus.publish('registry.frozen');

  try {
    callback({ printed });
  } finally {
    registry.NET = previous.NET;
    registry.SV = previous.SV;
    registry.Sys = previous.Sys;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Builds a minimal client stub carrying only what Host.DropClient reads and writes.
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

void describe('Host.DropClient', () => {
  void test('tells the game exactly once when a spawned client is removed and touches no other game API member', () => {
    const disconnected = [];
    const edict = { num: 1 };
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED, edict });

    withMockDropRegistry({ gameAPI: createStrictGameAPI(disconnected), clients: [client] }, ({ printed }) => {
      Host.DropClient(client, false, 'bye');

      assert.deepEqual(disconnected, [edict]);
      assert.deepEqual(printed, ['Client Player removed\n']);
    });
  });

  void test('does not tell the game about a client that never spawned', () => {
    const disconnected = [];
    const client = createDroppableClient({ state: ServerClient.STATE.CONNECTED });

    withMockDropRegistry({ gameAPI: createStrictGameAPI(disconnected), clients: [client] }, () => {
      Host.DropClient(client, false, 'bye');
    });

    assert.deepEqual(disconnected, []);
  });

  void test('does not tell the game when the server goes down because of an error', () => {
    const disconnected = [];
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED });

    withMockDropRegistry({ gameAPI: createStrictGameAPI(disconnected), clients: [client] }, ({ printed }) => {
      Host.DropClient(client, true, 'crash');

      assert.deepEqual(printed, ['Client Player dropped\n']);
    });

    assert.deepEqual(disconnected, []);
  });
});
