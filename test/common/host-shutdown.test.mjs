import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs the minimal registry Host.ShutdownServer needs, stubbing Host.DropClient so the test
 * can isolate the pending-message flush loop from DropClient's own (separately-tested) concerns.
 * @param {{ clients?: object[], canSendMessage?: (client: object) => boolean, floatTimes?: number[] }} options registry overrides
 * @param {(recorded: { getMessageCalls: object[], sendMessageCalls: object[], droppedClients: object[], floatTimeCallCount: () => number }) => void} callback test callback
 */
function withMockShutdownRegistry({ clients = [], canSendMessage = () => false, floatTimes = [0] }, callback) {
  const previous = {
    Con: registry.Con,
    NET: registry.NET,
    SV: registry.SV,
    Sys: registry.Sys,
    isDedicatedServer: registry.isDedicatedServer,
  };
  const previousDropClient = Host.DropClient;

  const getMessageCalls = [];
  const sendMessageCalls = [];
  const droppedClients = [];
  let floatTimeCallIndex = 0;

  registry.Con = { DPrint() {}, Print() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} };
  registry.NET = {
    CanSendMessage(sock) { return canSendMessage(sock); },
    SendMessage(sock, data) { sendMessageCalls.push({ sock, data }); return 1; },
    GetMessage(sock) { getMessageCalls.push(sock); return 0; },
  };
  registry.SV = {
    server: { active: true },
    svs: { maxclients: clients.length, clients },
    ShutdownServer() {},
  };
  registry.Sys = {
    FloatTime() {
      const value = floatTimes[Math.min(floatTimeCallIndex, floatTimes.length - 1)];
      floatTimeCallIndex++;
      return value;
    },
  };
  registry.isDedicatedServer = true;
  Host.DropClient = (client) => { droppedClients.push(client); };
  eventBus.publish('registry.frozen');

  try {
    callback({ getMessageCalls, sendMessageCalls, droppedClients, floatTimeCallCount: () => floatTimeCallIndex });
  } finally {
    registry.Con = previous.Con;
    registry.NET = previous.NET;
    registry.SV = previous.SV;
    registry.Sys = previous.Sys;
    registry.isDedicatedServer = previous.isDedicatedServer;
    Host.DropClient = previousDropClient;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Builds a minimal client stub carrying only the fields Host.ShutdownServer's flush loop reads.
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

void describe('Host.ShutdownServer', () => {
  void test('does not retry a client whose connection already finished closing', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_DISCONNECTED });

    withMockShutdownRegistry({ clients: [client], canSendMessage: () => false }, ({ getMessageCalls, floatTimeCallCount }) => {
      Host.ShutdownServer();

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

    withMockShutdownRegistry({ clients: [client], canSendMessage: () => false }, ({ getMessageCalls, floatTimeCallCount }) => {
      Host.ShutdownServer();

      assert.deepEqual(getMessageCalls, []);
      assert.equal(floatTimeCallCount(), 2);
    });
  });

  void test('still retries a client that is connected but temporarily cannot send, until the timeout', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_CONNECTED });

    withMockShutdownRegistry({
      clients: [client],
      canSendMessage: () => false,
      floatTimes: [0, 4.0],
    }, ({ getMessageCalls, floatTimeCallCount }) => {
      Host.ShutdownServer();

      assert.deepEqual(getMessageCalls, [client.netconnection]);
      assert.equal(floatTimeCallCount(), 2);
    });
  });

  void test('flushes a pending message and clears it when the connection can send', () => {
    const client = createMockShutdownClient({ connectionState: QSocket.STATE_CONNECTED, cursize: 12 });

    withMockShutdownRegistry({ clients: [client], canSendMessage: () => true }, ({ sendMessageCalls, droppedClients }) => {
      Host.ShutdownServer();

      assert.equal(sendMessageCalls.length, 1);
      assert.equal(sendMessageCalls[0].sock, client.netconnection);
      assert.equal(client.message.cursize, 0);
      assert.deepEqual(droppedClients, [client]);
    });
  });

  void test('does nothing when the server is not active', () => {
    withMockShutdownRegistry({ clients: [] }, ({ getMessageCalls, sendMessageCalls, droppedClients }) => {
      registry.SV.server.active = false;

      Host.ShutdownServer();

      assert.deepEqual(getMessageCalls, []);
      assert.deepEqual(sendMessageCalls, []);
      assert.deepEqual(droppedClients, []);
    });
  });
});
