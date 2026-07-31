import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs the minimal registry Host.EndGame/Host.Error need to reach their `host.alert`
 * publish, recording rather than performing the connection-state side effects
 * (CL.Disconnect/Host.ShutdownServer) they trigger along the way.
 * @param {{ demonum?: number, serverActive?: boolean }} options registry overrides
 * @param {(recorded: { prints: string[], disconnected: boolean }) => void} callback test callback
 */
function withMockHostAlertRegistry({ demonum = -1, serverActive = false }, callback) {
  const previous = {
    CL: registry.CL,
    Con: registry.Con,
    SV: registry.SV,
    isDedicatedServer: registry.isDedicatedServer,
  };

  const prints = [];
  let disconnected = false;

  registry.CL = {
    cls: { demonum },
    NextDemo() { throw new Error('NextDemo should not be reached in these tests'); },
    Disconnect() { disconnected = true; },
  };
  registry.Con = {
    PrintSuccess(message) { prints.push(message); },
    PrintError(message) { prints.push(message); },
  };
  registry.SV = { server: { active: serverActive } };
  // Skips Host.Error's SCR.EndLoadingPlaque() call, so no SCR mock is needed.
  registry.isDedicatedServer = true;
  eventBus.publish('registry.frozen');

  try {
    callback({ prints, disconnected: () => disconnected });
  } finally {
    registry.CL = previous.CL;
    registry.Con = previous.Con;
    registry.SV = previous.SV;
    registry.isDedicatedServer = previous.isDedicatedServer;
    eventBus.publish('registry.frozen');
  }
}

void describe('Host.EndGame', () => {
  void test('publishes host.alert with info severity and still prints to the console', () => {
    withMockHostAlertRegistry({}, ({ prints, disconnected }) => {
      const events = [];
      const unsubscribe = eventBus.subscribe('host.alert', (event) => events.push(event));

      try {
        Host.EndGame('level complete');

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
      assert.doesNotThrow(() => Host.EndGame('level complete'));
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
