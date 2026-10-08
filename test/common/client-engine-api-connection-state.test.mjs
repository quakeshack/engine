import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

const engineApi = createClientEngineApi();

/**
 * Installs a minimal `CL` registry stub, with a server controller, for the duration of the callback.
 * @param {{ state?: import('../../source/engine/common/Def.ts').clientConnectionState, serverActive?: boolean }} options registry overrides
 * @param {() => void} callback test callback
 */
function withMockConnectionState({ state = clientConnectionState.disconnected, serverActive = false }, callback) {
  const previousCL = engineMocks.CL;

  engineMocks.CL = { cls: { state }, serverController: { state: { active: serverActive } } };
  const restoreClientState = useClientStateOf(engineMocks.CL);

  try {
    callback();
  } finally {
    engineMocks.CL = previousCL;
    restoreClientState();
  }
}

void describe('ClientEngineAPI.CL.connected', () => {
  void test('is true while fully connected', () => {
    withMockConnectionState({ state: clientConnectionState.connected }, () => {
      assert.equal(engineApi.CL.connected, true);
    });
  });

  void test('is false while disconnected', () => {
    withMockConnectionState({ state: clientConnectionState.disconnected }, () => {
      assert.equal(engineApi.CL.connected, false);
    });
  });
});

void describe('ClientEngineAPI.SV.active', () => {
  void test('is true while hosting a local (listen) server', () => {
    withMockConnectionState({ serverActive: true }, () => {
      assert.equal(engineApi.SV.active, true);
    });
  });

  void test('is false otherwise', () => {
    withMockConnectionState({ serverActive: false }, () => {
      assert.equal(engineApi.SV.active, false);
    });
  });
});
