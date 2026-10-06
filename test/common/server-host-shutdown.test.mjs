import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';

import { createTestServer, createTestServerHost } from '../physics/fixtures.mjs';

/** @typedef {import('../../source/engine/server/Server.ts').default} Server */
/** @typedef {import('../../source/engine/server/ServerHost.ts').default} ServerHost */

/**
 * Builds a server host whose network and clock record what ShutdownServer does, with `dropClient`
 * stubbed so the test can isolate the pending-message flush loop from dropping's own concerns.
 * @param {{ clients?: object[], canSendMessage?: (client: object) => boolean, floatTimes?: number[] }} options the server's clients and services
 * @param {(recorded: { serverHost: ServerHost, sv: Server, getMessageCalls: object[], sendMessageCalls: object[], droppedClients: object[], floatTimeCallCount: () => number }) => void} callback test callback
 */
function withMockShutdown({ clients = [], canSendMessage = () => false, floatTimes = [0] }, callback) {
  const getMessageCalls = [];
  const sendMessageCalls = [];
  const droppedClients = [];
  let floatTimeCallIndex = 0;

  const sv = createTestServer({
    net: /** @type {any} */ ({
      CanSendMessage(sock) { return canSendMessage(sock); },
      SendMessage(sock, data) { sendMessageCalls.push({ sock, data }); return 1; },
      GetMessage(sock) { getMessageCalls.push(sock); return 0; },
    }),
    sys: {
      Print() {},
      FloatTime() {
        const value = floatTimes[Math.min(floatTimeCallIndex, floatTimes.length - 1)];
        floatTimeCallIndex++;
        return value;
      },
    },
  });

  sv.server.active = true;
  sv.svs.maxclients = clients.length;
  sv.svs.clients = clients;
  sv.ShutdownServer = () => {};
  sv.dropClient = (client) => { droppedClients.push(client); };

  const { serverHost } = createTestServerHost({ server: sv });

  callback({ serverHost, sv, getMessageCalls, sendMessageCalls, droppedClients, floatTimeCallCount: () => floatTimeCallIndex });
}

/**
 * Builds a minimal client stub carrying only the fields ServerHost.ShutdownServer's flush loop reads.
 * @param {{ state?: number, cursize?: number, connectionState?: string }} options client shape overrides
 * @returns {object} a mock ServerClient-shaped object
 */
function createMockShutdownClient({ state = ServerClient.STATE.SPAWNED, cursize = 5, connectionState = QSocket.STATE_CONNECTED }) {
  return {
    state,
    message: { cursize, clear() { this.cursize = 0; } },
    netconnection: { state: connectionState },
  };
}

void describe('ServerHost.ShutdownServer', () => {
  void test('does not retry a client whose connection already finished closing', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_DISCONNECTED });

    withMockShutdown({ clients: [client], canSendMessage: () => false }, ({ serverHost, getMessageCalls, floatTimeCallCount }) => {
      serverHost.ShutdownServer();

      // GetMessage pumping the connection can never unblock a socket that already finished
      // closing, so the fix skips it outright instead of counting it as still-pending.
      assert.deepEqual(getMessageCalls, []);
      // Sys.FloatTime is read once for `start` and once for the post-pass timeout check; the loop
      // must not have taken a second pass waiting on a message that can never be delivered.
      assert.equal(floatTimeCallCount(), 2);
    });
  });

  void test('does not retry a client whose connection is in the middle of disconnecting', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_DISCONNECTING });

    withMockShutdown({ clients: [client], canSendMessage: () => false }, ({ serverHost, getMessageCalls, floatTimeCallCount }) => {
      serverHost.ShutdownServer();

      assert.deepEqual(getMessageCalls, []);
      assert.equal(floatTimeCallCount(), 2);
    });
  });

  void test('still retries a client that is connected but temporarily cannot send, until the timeout', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_CONNECTED });

    withMockShutdown({
      clients: [client],
      canSendMessage: () => false,
      floatTimes: [0, 4.0],
    }, ({ serverHost, getMessageCalls, floatTimeCallCount }) => {
      serverHost.ShutdownServer();

      assert.deepEqual(getMessageCalls, [client.netconnection]);
      assert.equal(floatTimeCallCount(), 2);
    });
  });

  void test('flushes a pending message and clears it when the connection can send', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_CONNECTED, cursize: 12 });

    withMockShutdown({ clients: [client], canSendMessage: () => true }, ({ serverHost, sendMessageCalls, droppedClients }) => {
      serverHost.ShutdownServer();

      assert.equal(sendMessageCalls.length, 1);
      assert.equal(sendMessageCalls[0].sock, client.netconnection);
      assert.equal(client.message.cursize, 0);
      assert.deepEqual(droppedClients, [client]);
    });
  });

  void test('does nothing when the server is not active', () => {
    withMockShutdown({ clients: [] }, ({ serverHost, sv, getMessageCalls, sendMessageCalls, droppedClients }) => {
      sv.server.active = false;

      serverHost.ShutdownServer();

      assert.deepEqual(getMessageCalls, []);
      assert.deepEqual(sendMessageCalls, []);
      assert.deepEqual(droppedClients, []);
    });
  });
});
