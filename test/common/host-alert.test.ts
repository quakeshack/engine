import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import type { HostAlertEvent } from '../../source/shared/GameInterfaces.ts';
import type ServerHost from '../../source/engine/server/ServerHost.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

/**
 * Installs the minimal registry ClientHost.EndGame/Host.Error need to reach their `host.alert`
 * publish, recording rather than performing the connection-state side effects
 * (CL.Disconnect/Host.ShutdownServer) they trigger along the way.
 * @param options registry overrides
 * @param callback test callback
 */
function withMockHostAlertRegistry({ demonum = -1, serverActive = false }: { demonum?: number; serverActive?: boolean }, callback: (recorded: { prints: string[]; disconnected: () => boolean }) => void): void {
  const previous = {
    CL: engineMocks.CL,
    Con: engineMocks.Con,
    serverHost: Host.serverHost,
    SCR: engineMocks.SCR,
  };

  const prints: string[] = [];
  let disconnected = false;
  const shutdowns: boolean[] = [];

  const mockedClient = {
    cls: { demonum },
    NextDemo() { throw new Error('NextDemo should not be reached in these tests'); },
    Disconnect() { disconnected = true; },
  };

  engineMocks.CL = mockedClient;
  const restoreClientState = useClientStateOf(mockedClient);
  const previousRecovery = Host.recoverFromError;

  // What the page installs when it boots: an error leaves the game and stops the local server.
  Host.recoverFromError = () => { ClientHost.RecoverFromError(); };
  engineMocks.Con = {
    PrintSuccess(message: string) { prints.push(message); },
    PrintError(message: string) { prints.push(message); },
  };
  // Only the shutdown of the server host is called.
  Host.serverHost = { ShutdownServer() { shutdowns.push(serverActive); } } as unknown as ServerHost;
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
      const events: HostAlertEvent[] = [];
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
      assert.doesNotThrow(() => { ClientHost.EndGame('level complete'); });
      assert.deepEqual(prints, ['Host.EndGame: level complete\n']);
    });
  });
});

void describe('Host.Error', () => {
  void test('publishes host.alert with error severity and still prints to the console', () => {
    withMockHostAlertRegistry({}, ({ prints, disconnected }) => {
      const events: HostAlertEvent[] = [];
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
      assert.doesNotThrow(() => { Host.Error('out of memory'); });
      assert.deepEqual(prints, ['Host Error: out of memory\n']);
    });
  });
});
