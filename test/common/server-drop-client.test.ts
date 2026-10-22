import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';

import { createTestServer } from '../support/fixtures.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import type Server from '../../source/engine/server/Server.ts';

/**
 * Builds a server whose network and system services record what dropping a client does to them.
 * @param options server state to expose
 * @returns the server and what it printed
 */
function createDropServer({ gameAPI, clients }: { gameAPI: Server['server']['gameAPI']; clients: ServerClient[] }): { sv: Server, printed: string[] } {
  const printed: string[] = [];
  const sv = createTestServer({
    // Dropping a client asks the network layer whether it can send, sends the goodbye and closes the connection.
    net: {
      CanSendMessage() { return false; },
      SendMessage() { return 1; },
      Close() {},
      activeconnections: clients.length,
    } as unknown as ServerDependencies['net'],
    sys: { Print(text: string) { printed.push(text); }, FloatTime: () => 0 },
  });

  sv.server.gameAPI = gameAPI;
  sv.svs.maxclients = clients.length;
  sv.svs.clients = clients;

  return { sv, printed };
}

/**
 * Builds a minimal client stub carrying only what Server.dropClient reads and writes.
 * @param options client shape
 * @returns a mock ServerClient-shaped object
 */
function createDroppableClient({ state, edict = { num: 1 } as unknown as ServerEdict }: { state: number; edict?: ServerEdict }): ServerClient {
  return {
    num: 0,
    name: 'Player',
    state,
    edict,
    netconnection: {},
    message: { writeByte() {}, writeShort() {}, writeString() {} },
    clear(this: { state: number }) {
      this.state = ServerClient.STATE.FREE;
    },
  } as unknown as ServerClient;
}

/**
 * Builds a game API that records ClientDisconnect calls and throws on any other member access, so a
 * test fails when the engine starts touching more of the game than the contract allows.
 * @param disconnected receives the edicts passed to ClientDisconnect
 * @returns a strict game API stub
 */
function createStrictGameAPI(disconnected: ServerEdict[]): Server['server']['gameAPI'] {
  return new Proxy({
    ClientDisconnect(edict: ServerEdict) {
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
  }) as unknown as Server['server']['gameAPI'];
}

void describe('Server.dropClient', () => {
  void test('tells the game exactly once when a spawned client is removed and touches no other game API member', () => {
    const disconnected: ServerEdict[] = [];
    const edict = { num: 1 } as unknown as ServerEdict;
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED, edict });
    const { sv, printed } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, false, 'bye');

    assert.deepEqual(disconnected, [edict]);
    assert.deepEqual(printed, ['Client Player removed\n']);
  });

  void test('does not tell the game about a client that never spawned', () => {
    const disconnected: ServerEdict[] = [];
    const client = createDroppableClient({ state: ServerClient.STATE.CONNECTED });
    const { sv } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, false, 'bye');

    assert.deepEqual(disconnected, []);
  });

  void test('does not tell the game when the server goes down because of an error', () => {
    const disconnected: ServerEdict[] = [];
    const client = createDroppableClient({ state: ServerClient.STATE.SPAWNED });
    const { sv, printed } = createDropServer({ gameAPI: createStrictGameAPI(disconnected), clients: [client] });

    sv.dropClient(client, true, 'crash');

    assert.deepEqual(printed, ['Client Player dropped\n']);
    assert.deepEqual(disconnected, []);
  });
});
