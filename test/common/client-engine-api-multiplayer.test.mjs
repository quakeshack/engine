import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { engineMocks } from '../support/engineMocks.ts';

const engineApi = createClientEngineApi();

/**
 * Installs the minimal `COM`/`urls` registry SessionDiscovery (used internally by
 * engineApi.Multiplayer) needs, plus a mocked global fetch.
 * @param {object} jsonBody payload returned by response.json()
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockMultiplayerApi(jsonBody, callback) {
  const previousCOM = engineMocks.COM;
  const previousUrls = engineMocks.urls;
  const previousFetch = globalThis.fetch;

  engineMocks.COM = { game: 'id1' };
  engineMocks.urls = { signalingURL: 'wss://master.example.test/signal' };
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(jsonBody) });

  try {
    await callback();
  } finally {
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    engineMocks.COM = previousCOM;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    engineMocks.urls = previousUrls;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    globalThis.fetch = previousFetch;
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
      const sessions = await engineApi.Multiplayer.ListSessions();

      assert.deepEqual(sessions, [
        { sessionId: 'a', hostname: 'UNNAMED', map: 'dm3', currentPlayers: 1, maxPlayers: 4, colo: null, country: null, settings: {}, ping: null, pingUnreachable: false },
      ]);
    });
  });
});

void describe('ClientEngineAPI.Multiplayer.SubscribeSessions/RequestSessionsRefresh', () => {
  // Exercises the synchronous 'unavailable' path (no configured signaling URL) rather than a
  // live channel -- the channel's own connect/reconnect/diff behavior is covered exhaustively by
  // `test/client/session-discovery.test.mjs`; this file only needs to prove GameAPIs.ts wires
  // through to SessionDiscovery correctly.
  void test('delegates to SessionDiscovery.subscribe and .requestRefresh', () => {
    const previousCOM = engineMocks.COM;
    const previousUrls = engineMocks.urls;

    engineMocks.COM = { game: 'id1' };
    engineMocks.urls = {};

    try {
      const statuses = [];
      const unsubscribe = engineApi.Multiplayer.SubscribeSessions(() => {}, (status) => statuses.push(status));

      assert.deepEqual(statuses, ['unavailable']);
      assert.equal(typeof unsubscribe, 'function');
      unsubscribe();

      assert.doesNotThrow(() => { engineApi.Multiplayer.RequestSessionsRefresh(); });
    } finally {
      engineMocks.COM = previousCOM;
      engineMocks.urls = previousUrls;
    }
  });
});
