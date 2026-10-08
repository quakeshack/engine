import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { parseServerMessage } from '../../source/engine/client/ClientServerCommandHandlers.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { installPageServices } from '../../source/engine/client/PageServices.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { useRendererOf } from '../support/renderer.ts';
import { useHostOf } from '../support/host.ts';
import { facades } from '../support/facades.ts';
import { pageServices } from '../support/pageServices.ts';

/**
 * Builds the minimal client registry surface required by parseServerMessage().
 * @param {object} [overrides] Registry overrides for the test case.
 * @returns {object} Mocked registry values.
 */
function createMockClientRegistry(overrides = {}) {
  const message = new SzBuffer(256, 'NET.message');

  return {
    CL: {
      shownet: { value: 0 },
      state: {
        onground: true,
      },
      connection: {
        processingServerDataState: 0,
        lastServerMessages: [],
      },
      cls: {
        state: Def.clientConnectionState.connected,
        signon: 0,
      },
      svc_strings: Object.entries(Protocol.svc),
      PrintLastServerMessages() {},
      SignonReply() {},
      ...overrides.CL,
    },
    Con: {
      Print() {},
      DPrint() {},
      ...overrides.Con,
    },
    Host: {
      ...overrides.Host,
    },
    Mod: {
      ...overrides.Mod,
    },
    NET: {
      message,
      ...overrides.NET,
    },
    R: {
      ...overrides.R,
    },
    S: {
      ...overrides.S,
    },
    SCR: {
      recalc_refdef: false,
      ...overrides.SCR,
    },
    V: {
      ...overrides.V,
    },
  };
}

/**
 * Runs a test body with a mocked client registry and restores it afterwards.
 * @param {ReturnType<typeof createMockClientRegistry>} mockedRegistry Registry overrides.
 * @param {() => void | Promise<void>} callback Test body.
 * @returns {void | Promise<void>} Callback result.
 */
function withMockClientRegistry(mockedRegistry, callback) {
  const previousValues = {
    CL: registry.CL,
    Con: registry.Con,
    Host: registry.Host,
    Mod: registry.Mod,
    NET: pageServices.NET,
    R: registry.R,
    S: facades.S,
    SCR: facades.SCR,
    V: facades.V,
  };

  registry.CL = mockedRegistry.CL;
  const restoreClientState = useClientStateOf(registry.CL);
  registry.Con = mockedRegistry.Con;
  registry.Host = mockedRegistry.Host;
  const restoreHost = useHostOf(registry.Host);
  registry.Mod = mockedRegistry.Mod;
  pageServices.NET = mockedRegistry.NET;
  registry.R = mockedRegistry.R;
  const restoreRenderer = useRendererOf(registry.R);
  facades.S = mockedRegistry.S;
  facades.SCR = mockedRegistry.SCR;
  facades.V = mockedRegistry.V;
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousValues.CL;
    restoreClientState();
    registry.Con = previousValues.Con;
    registry.Host = previousValues.Host;
    restoreHost();
    registry.Mod = previousValues.Mod;
    pageServices.NET = previousValues.NET;
    registry.R = previousValues.R;
    restoreRenderer();
    facades.S = previousValues.S;
    facades.SCR = previousValues.SCR;
    facades.V = previousValues.V;
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

void describe('parseServerMessage', () => {
  void test('rejects Protocol 15 serverdata payloads', () => {
    const mockedRegistry = createMockClientRegistry();
    const { message } = mockedRegistry.NET;

    message.writeByte(Protocol.svc.serverdata);
    message.writeLong(15);

    void withMockClientRegistry(mockedRegistry, () => {
      assert.throws(
        () => parseServerMessage(),
        /Protocol 15 \/ WinQuake serverdata is no longer supported\./,
      );

      assert.equal(facades.SCR.recalc_refdef, true);
      assert.deepEqual(mockedRegistry.CL.connection.lastServerMessages, ['serverdata']);
    });
  });
});

/**
 * Builds a client game class that records how the engine drives it.
 * @param {{ compatible?: boolean }} [options] Whether IsServerCompatible accepts the server.
 * @returns {{ ClientGameAPI: Function, constructedWith: object[], compatibilityChecks: number[][] }} The class and its call records.
 */
function createRecordingClientGame({ compatible = true } = {}) {
  const constructedWith = [];
  const compatibilityChecks = [];

  class RecordingClientGameAPI {
    constructor(engineAPI) {
      constructedWith.push(engineAPI);
    }

    static IsServerCompatible(version) {
      compatibilityChecks.push(version);
      return compatible;
    }
  }

  return { ClientGameAPI: RecordingClientGameAPI, constructedWith, compatibilityChecks };
}

/**
 * Runs a callback with the given game module installed as the active one.
 * @param {object} clientGameAPI The ClientGameAPI class the module exports.
 * @param {() => void} callback Test body.
 */
function withActiveGameModule(clientGameAPI, callback) {
  const previous = GameModule.active;

  GameModule.active = {
    identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
    ClientGameAPI: clientGameAPI,
  };

  try {
    callback();
  } finally {
    GameModule.active = previous;
  }
}

/**
 * Writes a serverdata message up to and including maxclients into the mocked network buffer.
 * @param {SzBuffer} message The mocked NET.message buffer.
 * @param {{ name?: string, author?: string }} [options] Game identification the server announces.
 */
function writeServerData(message, { name = 'Test Game', author = 'test' } = {}) {
  message.writeByte(Protocol.svc.serverdata);
  message.writeByte(Protocol.version);
  message.writeString(name);
  message.writeString(author);
  message.writeByte(1); // server game version 1.0.0
  message.writeByte(0);
  message.writeByte(0);
  message.writeByte(0); // maxclients: invalid on purpose, it aborts parsing right after the game was constructed
}

void describe('parseServerMessage serverdata game construction', () => {
  void test('constructs the client game with the engine API after the server passed the compatibility check', () => {
    const { ClientGameAPI, constructedWith, compatibilityChecks } = createRecordingClientGame();
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message);

    let gameAPI = null;

    const engineApi = createClientEngineApi();
    const restorePageServices = installPageServices({ engineApi });

    try {
      void withMockClientRegistry(mockedRegistry, () => {
        withActiveGameModule(ClientGameAPI, () => {
          assert.throws(() => parseServerMessage(), /Bad maxclients \(0\)/);
          gameAPI = clientRuntimeState.gameAPI;
        });
      });
    } finally {
      restorePageServices();
    }

    assert.deepEqual(compatibilityChecks, [[1, 0, 0]]);
    assert.equal(constructedWith.length, 1);
    assert.equal(constructedWith[0], engineApi);
    assert.ok(gameAPI instanceof ClientGameAPI);
  });

  void test('rejects an incompatible server before constructing the client game', () => {
    const { ClientGameAPI, constructedWith } = createRecordingClientGame({ compatible: false });
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message);

    void withMockClientRegistry(mockedRegistry, () => {
      withActiveGameModule(ClientGameAPI, () => {
        assert.throws(() => parseServerMessage(), /is not compatible/);
      });
    });

    assert.equal(constructedWith.length, 0);
    assert.equal(mockedRegistry.CL.state.gameAPI, null);
  });

  void test('rejects a server running a different game before asking for compatibility or constructing', () => {
    const { ClientGameAPI, constructedWith, compatibilityChecks } = createRecordingClientGame();
    const mockedRegistry = createMockClientRegistry({
      CL: { ClearState() {}, state: { onground: true, gameAPI: null, maxclients: 0 } },
    });

    writeServerData(mockedRegistry.NET.message, { name: 'Another Game' });

    void withMockClientRegistry(mockedRegistry, () => {
      withActiveGameModule(ClientGameAPI, () => {
        assert.throws(() => parseServerMessage(), /game mismatch/);
      });
    });

    assert.deepEqual(compatibilityChecks, []);
    assert.equal(constructedWith.length, 0);
  });
});
