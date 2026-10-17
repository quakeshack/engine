import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';
import type { SzBuffer } from '../../source/engine/network/MSG.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';

import { createTestServer, createTestServerHost } from '../support/fixtures.ts';
import type Server from '../../source/engine/server/Server.ts';
import type ServerHost from '../../source/engine/server/ServerHost.ts';

/** What {@link withMockShutdown} hands to a test. */
interface ShutdownContext {
  serverHost: ServerHost;
  sv: Server;
  /** The sockets the flush loop pumped. */
  getMessageCalls: Array<QSocket | null>;
  /** The messages the flush loop sent. */
  sendMessageCalls: Array<{ sock: QSocket | null; data: SzBuffer }>;
  /** The clients the host dropped. */
  droppedClients: ServerClient[];
  /** How often the clock was read. */
  floatTimeCallCount: () => number;
}

/** A client with the fields the flush loop reads. */
interface MockShutdownClient {
  state: number;
  message: { cursize: number; clear(): void };
  netconnection: { state: string };
}

/**
 * Builds a server host whose network and clock record what ShutdownServer does, with `dropClient`
 * stubbed so the test can isolate the pending-message flush loop from dropping's own concerns.
 * @param options the server's clients and services
 * @param callback test callback
 */
function withMockShutdown({ clients = [], canSendMessage = () => false, floatTimes = [0] }: { clients?: MockShutdownClient[]; canSendMessage?: (sock: QSocket | null) => boolean; floatTimes?: number[] }, callback: (context: ShutdownContext) => void): void {
  const getMessageCalls: Array<QSocket | null> = [];
  const sendMessageCalls: Array<{ sock: QSocket | null; data: SzBuffer }> = [];
  const droppedClients: ServerClient[] = [];
  let floatTimeCallIndex = 0;

  const sv = createTestServer({
    // The flush loop asks whether a socket can send, sends and pumps the connection.
    net: {
      CanSendMessage(sock: QSocket | null) { return canSendMessage(sock); },
      SendMessage(sock: QSocket | null, data: SzBuffer) { sendMessageCalls.push({ sock, data }); return 1; },
      GetMessage(sock: QSocket | null) { getMessageCalls.push(sock); return 0; },
    } as unknown as ServerDependencies['net'],
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
  sv.svs.clients = clients as unknown as ServerClient[];
  sv.ShutdownServer = () => {};
  sv.dropClient = (client: ServerClient) => { droppedClients.push(client); };

  const { serverHost } = createTestServerHost({ server: sv });

  callback({ serverHost, sv, getMessageCalls, sendMessageCalls, droppedClients, floatTimeCallCount: () => floatTimeCallIndex });
}

/**
 * Builds a minimal client stub carrying only the fields ServerHost.ShutdownServer's flush loop reads.
 * @param options client shape overrides
 * @returns a mock ServerClient-shaped object
 */
function createMockShutdownClient({ state = ServerClient.STATE.SPAWNED, cursize = 5, connectionState = QSocket.STATE_CONNECTED }: { state?: number; cursize?: number; connectionState?: string }): MockShutdownClient {
  return {
    state,
    message: { cursize, clear(this: { cursize: number }) { this.cursize = 0; } },
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
