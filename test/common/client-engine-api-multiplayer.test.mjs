import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { pageServices } from '../support/pageServices.ts';

const engineApi = createClientEngineApi();

/**
 * Installs the minimal `COM`/`urls` registry SessionDiscovery (used internally by
 * engineApi.Multiplayer) needs, plus a mocked global fetch.
 * @param {object} jsonBody payload returned by response.json()
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockMultiplayerApi(jsonBody, callback) {
  const previousCOM = pageServices.COM;
  const previousUrls = pageServices.urls;
  const previousFetch = globalThis.fetch;

  pageServices.COM = { game: 'id1' };
  pageServices.urls = { signalingURL: 'wss://master.example.test/signal' };
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(jsonBody) });
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    pageServices.COM = previousCOM;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    pageServices.urls = previousUrls;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
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
    const previousCOM = pageServices.COM;
    const previousUrls = pageServices.urls;

    pageServices.COM = { game: 'id1' };
    pageServices.urls = {};
    eventBus.publish('registry.frozen');

    try {
      const statuses = [];
      const unsubscribe = engineApi.Multiplayer.SubscribeSessions(() => {}, (status) => statuses.push(status));

      assert.deepEqual(statuses, ['unavailable']);
      assert.equal(typeof unsubscribe, 'function');
      unsubscribe();

      assert.doesNotThrow(() => { engineApi.Multiplayer.RequestSessionsRefresh(); });
    } finally {
      pageServices.COM = previousCOM;
      pageServices.urls = previousUrls;
      eventBus.publish('registry.frozen');
    }
  });
});
