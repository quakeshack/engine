import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

/**
 * Installs the minimal registry ClientHost.EndGame/Host.Error need to reach their `host.alert`
 * publish, recording rather than performing the connection-state side effects
 * (CL.Disconnect/Host.ShutdownServer) they trigger along the way.
 * @param {{ demonum?: number, serverActive?: boolean }} options registry overrides
 * @param {(recorded: { prints: string[], disconnected: boolean }) => void} callback test callback
 */
function withMockHostAlertRegistry({ demonum = -1, serverActive = false }, callback) {
  const previous = {
    CL: engineMocks.CL,
    Con: engineMocks.Con,
    serverHost: Host.serverHost,
    SCR: engineMocks.SCR,
  };

  const prints = [];
  let disconnected = false;
  const shutdowns = [];

  engineMocks.CL = {
    cls: { demonum },
    NextDemo() { throw new Error('NextDemo should not be reached in these tests'); },
    Disconnect() { disconnected = true; },
  };
  const restoreClientState = useClientStateOf(engineMocks.CL);
  const previousRecovery = Host.recoverFromError;

  // What the page installs when it boots: an error leaves the game and stops the local server.
  Host.recoverFromError = () => { ClientHost.RecoverFromError(); };
  engineMocks.Con = {
    PrintSuccess(message) { prints.push(message); },
    PrintError(message) { prints.push(message); },
  };
  Host.serverHost = /** @type {any} */ ({ ShutdownServer() { shutdowns.push(serverActive); } });
  engineMocks.SCR = { EndLoadingPlaque() {} };

  try {
    callback({ prints, disconnected: () => disconnected });
  } finally {
    Host.recoverFromError = previousRecovery;
    restoreClientState();
    engineMocks.CL = previous.CL;
    engineMocks.Con = previous.Con;
    Host.serverHost = previous.serverHost;
    engineMocks.SCR = previous.SCR;
  }
}

void describe('ClientHost.EndGame', () => {
  void test('publishes host.alert with info severity and still prints to the console', () => {
    withMockHostAlertRegistry({}, ({ prints, disconnected }) => {
      const events = [];
      const unsubscribe = eventBus.subscribe('host.alert', (event) => events.push(event));

      try {
        ClientHost.EndGame('level complete');

        assert.deepEqual(events, [{ title: 'Host.EndGame', message: 'level complete', severity: 'info' }]);
        assert.deepEqual(prints, ['Host.EndGame: level complete\n']);
        assert.equal(disconnected(), true);
      } finally {
        unsubscribe();
      }
    });
  });

  void test('still prints to the console when nothing is subscribed to host.alert', () => {
    withMockHostAlertRegistry({}, ({ prints }) => {
      assert.doesNotThrow(() => ClientHost.EndGame('level complete'));
      assert.deepEqual(prints, ['Host.EndGame: level complete\n']);
    });
  });
});

void describe('Host.Error', () => {
  void test('publishes host.alert with error severity and still prints to the console', () => {
    withMockHostAlertRegistry({}, ({ prints, disconnected }) => {
      const events = [];
      const unsubscribe = eventBus.subscribe('host.alert', (event) => events.push(event));

      try {
        Host.Error('out of memory');

        assert.deepEqual(events, [{ title: 'Host Error', message: 'out of memory', severity: 'error' }]);
        assert.deepEqual(prints, ['Host Error: out of memory\n']);
        assert.equal(disconnected(), true);
      } finally {
        unsubscribe();
      }
    });
  });

  void test('still prints to the console when nothing is subscribed to host.alert', () => {
    withMockHostAlertRegistry({}, ({ prints }) => {
      assert.doesNotThrow(() => Host.Error('out of memory'));
      assert.deepEqual(prints, ['Host Error: out of memory\n']);
    });
  });
});
