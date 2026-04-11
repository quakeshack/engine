import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Protocol from '../../source/engine/network/Protocol.ts';
import * as Def from '../../source/engine/common/Def.ts';
import ClientConnection from '../../source/engine/client/ClientConnection.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Build a minimal demo subsystem stub for connection tests.
 * @returns {object} Demo playback stub.
 */
function createMockClientDemos() {
  return {
    demoplayback: false,
    demorecording: false,
    getMessage() {
      return 0;
    },
    writeDemoMessage() {},
    stopPlayback() {},
  };
}

/**
 * Build the registry surface needed by ClientConnection.
 * @param {Record<string, object>} [overrides] Per-module overrides.
 * @returns {object} Client registry fixture.
 */
function createMockClientRegistry(overrides = {}) {
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
 * @param {ReturnType<typeof createMockClientRegistry>} mockedRegistry Mock registry values.
 * @param {() => void | Promise<void>} callback Test body.
 * @returns {void | Promise<void>} Callback result.
 */
function withMockClientRegistry(mockedRegistry, callback) {
  const previousValues = {
    Con: registry.Con,
    Host: registry.Host,
    IN: registry.IN,
    Mod: registry.Mod,
    NET: registry.NET,
    SCR: registry.SCR,
    S: registry.S,
    SV: registry.SV,
  };

  registry.Con = mockedRegistry.Con;
  registry.Host = mockedRegistry.Host;
  registry.IN = mockedRegistry.IN;
  registry.Mod = mockedRegistry.Mod;
  registry.NET = mockedRegistry.NET;
  registry.SCR = mockedRegistry.SCR;
  registry.S = mockedRegistry.S;
  registry.SV = mockedRegistry.SV;
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.Con = previousValues.Con;
    registry.Host = previousValues.Host;
    registry.IN = previousValues.IN;
    registry.Mod = previousValues.Mod;
    registry.NET = previousValues.NET;
    registry.SCR = previousValues.SCR;
    registry.S = previousValues.S;
    registry.SV = previousValues.SV;
    eventBus.publish('registry.frozen');
  };

  try {
    const result = callback();

    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(restore);
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
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

  void test('establishes a connection and transitions into the connected state', () => {
    resetClientConnectionState();

    const publishedEvents = [];
    const connectingSocket = {
      state: QSocket.STATE_CONNECTING,
      address: 'quake.example',
    };
    const socket = {
      ...connectingSocket,
      state: QSocket.STATE_CONNECTED,
    };

    const unsubscribeConnecting = eventBus.subscribe('client.connecting', (host) => {
      publishedEvents.push(['connecting', host]);
    });
    const unsubscribeConnected = eventBus.subscribe('client.connected', (host) => {
      publishedEvents.push(['connected', host]);
    });

    try {
      void withMockClientRegistry(createMockClientRegistry({
        NET: {
          Connect(host) {
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

        clientStaticState.netcon = socket;
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
        name: { string: 'PlayerOne' },
        color: { value: 0x4f },
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
