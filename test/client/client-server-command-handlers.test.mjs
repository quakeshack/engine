import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { parseServerMessage } from '../../source/engine/client/ClientServerCommandHandlers.ts';
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
