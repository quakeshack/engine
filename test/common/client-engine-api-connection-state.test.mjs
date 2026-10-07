import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { useClientStateOf } from '../support/clientState.ts';

/**
 * Installs a minimal `CL` registry stub, with a server controller, for the duration of the callback.
 * @param {{ state?: import('../../source/engine/common/Def.ts').clientConnectionState, serverActive?: boolean }} options registry overrides
 * @param {() => void} callback test callback
 */
function withMockConnectionState({ state = clientConnectionState.disconnected, serverActive = false }, callback) {
  const previousCL = registry.CL;

  registry.CL = { cls: { state }, serverController: { state: { active: serverActive } } };
  const restoreClientState = useClientStateOf(registry.CL);
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.CL = previousCL;
    restoreClientState();
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientEngineAPI.CL.connected', () => {
  void test('is true while fully connected', () => {
    withMockConnectionState({ state: clientConnectionState.connected }, () => {
      assert.equal(ClientEngineAPI.CL.connected, true);
    });
  });

  void test('is false while disconnected', () => {
    withMockConnectionState({ state: clientConnectionState.disconnected }, () => {
      assert.equal(ClientEngineAPI.CL.connected, false);
    });
  });
});

void describe('ClientEngineAPI.SV.active', () => {
  void test('is true while hosting a local (listen) server', () => {
    withMockConnectionState({ serverActive: true }, () => {
      assert.equal(ClientEngineAPI.SV.active, true);
    });
  });

  void test('is false otherwise', () => {
    withMockConnectionState({ serverActive: false }, () => {
      assert.equal(ClientEngineAPI.SV.active, false);
    });
  });
});
