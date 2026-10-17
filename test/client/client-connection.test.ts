import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Protocol from '../../source/engine/network/Protocol.ts';
import * as Def from '../../source/engine/common/Def.ts';
import ClientConnection from '../../source/engine/client/ClientConnection.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import type ClientDemos from '../../source/engine/client/ClientDemos.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Build a minimal demo subsystem stub for connection tests.
 * @returns Demo playback stub.
 */
function createMockClientDemos(): ClientDemos {
  // The connection reads the playback flags and stops playback.
  return {
    demoplayback: false,
    demorecording: false,
    getMessage() {
      return 0;
    },
    writeDemoMessage() {},
    stopPlayback() {},
  } as unknown as ClientDemos;
}

/** The engine parts the connection reads and calls, as the tests mock them. */
type MockClientRegistry = Record<'Con' | 'Host' | 'IN' | 'Mod' | 'NET' | 'SCR' | 'S' | 'SV', object>;

/**
 * Build the registry surface needed by ClientConnection.
 * @param [overrides] Per-module overrides.
 * @returns Client registry fixture.
 */
function createMockClientRegistry(overrides: Partial<MockClientRegistry> = {}): MockClientRegistry {
  return {
    Con: {
      DPrint() {},
      Print() {},
      forcedup: false,
      ...overrides.Con,
    },
    Host: {
      realtime: 12.5,
      ShutdownServer() {},
      ...overrides.Host,
    },
    IN: {
      Move() {},
      ...overrides.IN,
    },
    Mod: {
      scope: { client: 'client' },
      ClearAll() {},
      ...overrides.Mod,
    },
    NET: {
      Connect() {
        return null;
      },
      SendMessage() {
        return 1;
      },
      SendUnreliableMessage() {
        return 1;
      },
      CanSendMessage() {
        return true;
      },
      Close() {},
      message: clientStaticState.message,
      ...overrides.NET,
    },
    SCR: {
      con_current: 1,
      EndLoadingPlaque() {},
      ...overrides.SCR,
    },
    S: {
      StopAllSounds() {},
      LoadPendingFiles() {},
      ...overrides.S,
    },
    SV: {
      server: { active: false },
      ...overrides.SV,
    },
  };
}

/**
 * Run a callback with a mocked client registry.
 * @param mockedRegistry Mock registry values.
 * @param callback Test body.
 * @returns Callback result.
 */
function withMockClientRegistry(mockedRegistry: ReturnType<typeof createMockClientRegistry>, callback: () => void | Promise<void>): void | Promise<void> {
  const { Con, Host, IN, Mod, NET, SCR, S, SV } = mockedRegistry;

  // The menu listens for connection events too; this test is about the connection, so the menu does nothing.
  return withEngineMocks({ Con, Host, IN, Mod, NET, SCR, S, SV, M: { Menu_Main_f() {}, ReturnToGame() {} } }, callback);
}

/**
 *
 */
function resetClientConnectionState() {
  clientRuntimeState.clear();
  clientStaticState.clear();
  clientStaticState.state = Def.clientConnectionState.disconnected;
  clientStaticState.netcon = null;
  clientStaticState.connecting = null;
  clientStaticState.signon = 0;
  clientStaticState.changelevel = false;
  clientStaticState.isLocalGame = false;
}

void describe('ClientConnection', () => {
  void test('marks loopback connects as local games', () => {
    resetClientConnectionState();

    const connectingSocket = {
      state: QSocket.STATE_CONNECTING,
      address: 'local',
    };

    void withMockClientRegistry(createMockClientRegistry({
      NET: {
        Connect() {
          return connectingSocket;
        },
      },
    }), () => {
      const connection = new ClientConnection({ clientDemos: createMockClientDemos() });

      connection.connect('local');

      assert.equal(clientStaticState.isLocalGame, true);
      assert.equal(clientStaticState.state, Def.clientConnectionState.connecting);
      assert.equal(clientStaticState.netcon, connectingSocket);
    });

    resetClientConnectionState();
  });

  void test('tells the game that the client is gone before it drops the game\'s listeners', () => {
    resetClientConnectionState();

    const heard: string[] = [];
    const gameListener = clientRuntimeState.eventBus.subscribe('client.disconnected', () => {
      heard.push('disconnected');
    });

    try {
      void withMockClientRegistry(createMockClientRegistry(), () => {
        const connection = new ClientConnection({ clientDemos: createMockClientDemos() });

        connection.disconnect();
      });

      assert.deepEqual(heard, ['disconnected']);

      // dropped with the rest of the per-map state, so a second disconnect finds nobody listening
      eventBus.publish('client.disconnected');
      assert.deepEqual(heard, ['disconnected']);
    } finally {
      gameListener();
      resetClientConnectionState();
    }
  });

  void test('shuts the game down first, then tells it that the client is gone, then drops its listeners', () => {
    resetClientConnectionState();

    const order: string[] = [];
    const gameListener = clientRuntimeState.eventBus.subscribe('client.disconnected', () => {
      order.push(`disconnected (game instance: ${clientRuntimeState.gameAPI === null ? 'gone' : 'still there'})`);
    });
    // The connection only shuts the game down.
    clientRuntimeState.gameAPI = { shutdown() { order.push('shutdown'); } } as unknown as typeof clientRuntimeState.gameAPI;

    try {
      void withMockClientRegistry(createMockClientRegistry(), () => {
        const connection = new ClientConnection({ clientDemos: createMockClientDemos() });

        connection.disconnect();
      });

      // this is the order `ClientGameInterface.shutdown` documents
      assert.deepEqual(order, ['shutdown', 'disconnected (game instance: gone)']);
      assert.equal(clientRuntimeState.eventBus.listenerCount, 0);
    } finally {
      gameListener();
      resetClientConnectionState();
    }
  });

  void test('establishes a connection and transitions into the connected state', () => {
    resetClientConnectionState();

    const publishedEvents: string[][] = [];
    const connectingSocket = {
      state: QSocket.STATE_CONNECTING,
      address: 'quake.example',
    };
    const socket = {
      ...connectingSocket,
      state: QSocket.STATE_CONNECTED,
    };

    const unsubscribeConnecting = eventBus.subscribe('client.connecting', (host: string) => {
      publishedEvents.push(['connecting', host]);
    });
    const unsubscribeConnected = eventBus.subscribe('client.connected', (host: string | null) => {
      publishedEvents.push(['connected', String(host)]);
    });

    try {
      void withMockClientRegistry(createMockClientRegistry({
        NET: {
          Connect(host: string) {
            connectingSocket.address = host;
            return connectingSocket;
          },
        },
      }), () => {
        const connection = new ClientConnection({ clientDemos: createMockClientDemos() });

        connection.connect('quake.example');

        assert.equal(clientStaticState.state, Def.clientConnectionState.connecting);
        assert.equal(clientStaticState.netcon, connectingSocket);
        assert.equal(clientStaticState.connecting?.percentage, 5);
        assert.equal(clientStaticState.connecting?.message, 'Connecting to quake.example');
        assert.deepEqual(publishedEvents[0], ['connecting', 'quake.example']);

        // The connection reads the address and the state of the socket.
        clientStaticState.netcon = socket as unknown as QSocket;
        connection.checkConnectingState();

        assert.equal(clientStaticState.state, Def.clientConnectionState.connected);
        assert.equal(clientStaticState.signon, 0);
        assert.equal(clientStaticState.lastcmdsent, 12.5);
        assert.equal(clientStaticState.connecting?.percentage, 10);
        assert.equal(clientStaticState.connecting?.message, 'Connecting to quake.example');
        assert.deepEqual(publishedEvents[1], ['connected', 'quake.example']);
      });
    } finally {
      unsubscribeConnecting();
      unsubscribeConnected();
      resetClientConnectionState();
    }
  });

  void test('writes the expected signon commands for the prespawn and spawn stages', () => {
    resetClientConnectionState();

    void withMockClientRegistry(createMockClientRegistry(), () => {
      const connection = new ClientConnection({ clientDemos: createMockClientDemos() });
      connection.configureIdentityCvars({
        name: createCvarStub('PlayerOne'),
        color: createCvarStub(0x4f),
        rcon_password: null,
      });

      clientStaticState.spawnparms = 'skill 2';
      clientStaticState.serverInfo = { map: 'start' };

      clientStaticState.signon = 1;
      clientStaticState.message.clear();
      connection.signonReply();

      clientStaticState.message.beginReading();
      assert.equal(clientStaticState.message.readByte(), Protocol.clc.stringcmd);
      assert.equal(clientStaticState.message.readString(), 'prespawn');

      clientStaticState.signon = 2;
      clientStaticState.message.clear();
      connection.signonReply();

      clientStaticState.message.beginReading();
      assert.equal(clientStaticState.message.readByte(), Protocol.clc.stringcmd);
      assert.equal(clientStaticState.message.readString(), 'name "PlayerOne"\n');
      assert.equal(clientStaticState.message.readByte(), Protocol.clc.stringcmd);
      assert.equal(clientStaticState.message.readString(), 'color 4 15\n');
      assert.equal(clientStaticState.message.readByte(), Protocol.clc.stringcmd);
      assert.equal(clientStaticState.message.readString(), 'spawn skill 2');
    });

    resetClientConnectionState();
  });
});
