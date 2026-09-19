import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { parseServerMessage } from '../../source/engine/client/ClientServerCommandHandlers.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

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
    NET: registry.NET,
    R: registry.R,
    S: registry.S,
    SCR: registry.SCR,
    V: registry.V,
  };

  registry.CL = mockedRegistry.CL;
  registry.Con = mockedRegistry.Con;
  registry.Host = mockedRegistry.Host;
  registry.Mod = mockedRegistry.Mod;
  registry.NET = mockedRegistry.NET;
  registry.R = mockedRegistry.R;
  registry.S = mockedRegistry.S;
  registry.SCR = mockedRegistry.SCR;
  registry.V = mockedRegistry.V;
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousValues.CL;
    registry.Con = previousValues.Con;
    registry.Host = previousValues.Host;
    registry.Mod = previousValues.Mod;
    registry.NET = previousValues.NET;
    registry.R = previousValues.R;
    registry.S = previousValues.S;
    registry.SCR = previousValues.SCR;
    registry.V = previousValues.V;
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

      assert.equal(mockedRegistry.SCR.recalc_refdef, true);
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

    void withMockClientRegistry(mockedRegistry, () => {
      withActiveGameModule(ClientGameAPI, () => {
        assert.throws(() => parseServerMessage(), /Bad maxclients \(0\)/);
      });
    });

    assert.deepEqual(compatibilityChecks, [[1, 0, 0]]);
    assert.equal(constructedWith.length, 1);
    assert.equal(constructedWith[0], ClientEngineAPI);
    assert.ok(mockedRegistry.CL.state.gameAPI instanceof ClientGameAPI);
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
