import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs the minimal `COM`/`urls` registry SessionDiscovery (used internally by
 * ClientEngineAPI.Multiplayer) needs, plus a mocked global fetch.
 * @param {object} jsonBody payload returned by response.json()
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockMultiplayerApi(jsonBody, callback) {
  const previousCOM = registry.COM;
  const previousUrls = registry.urls;
  const previousFetch = globalThis.fetch;

  registry.COM = { game: 'id1' };
  registry.urls = { signalingURL: 'wss://master.example.test/signal' };
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(jsonBody) });
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    registry.COM = previousCOM;
    registry.urls = previousUrls;
    globalThis.fetch = previousFetch;
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientEngineAPI.Multiplayer.ListSessions', () => {
  void test('delegates to SessionDiscovery, filtered to the active game', async () => {
    await withMockMultiplayerApi({
      servers: [
        { sessionId: 'a', serverInfo: { map: 'dm3', mod: 'id1', currentPlayers: 1, maxPlayers: 4 } },
        { sessionId: 'b', serverInfo: { map: 'start', mod: 'hellwave', currentPlayers: 1, maxPlayers: 4 } },
      ],
    }, async () => {
      const sessions = await ClientEngineAPI.Multiplayer.ListSessions();

      assert.deepEqual(sessions, [
        { sessionId: 'a', map: 'dm3', currentPlayers: 1, maxPlayers: 4, colo: null, country: null },
      ]);
    });
  });
});
