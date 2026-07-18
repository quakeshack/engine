import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs minimal `CL`/`SV` registry stubs for the duration of the callback.
 * @param {{ state?: import('../../source/engine/common/Def.ts').clientConnectionState, serverActive?: boolean }} options registry overrides
 * @param {() => void} callback test callback
 */
function withMockConnectionState({ state = clientConnectionState.disconnected, serverActive = false }, callback) {
  const previousCL = registry.CL;
  const previousSV = registry.SV;

  registry.CL = { cls: { state } };
  registry.SV = { server: { active: serverActive } };
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.CL = previousCL;
    registry.SV = previousSV;
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
