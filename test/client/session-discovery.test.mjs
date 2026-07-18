import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventBus, registry } from '../../source/engine/registry.ts';
import SessionDiscovery from '../../source/engine/client/menu/SessionDiscovery.ts';

/**
 * Installs the minimal `COM`/`urls` registry SessionDiscovery needs.
 * @param {string} game active COM.game to simulate for the local client
 * @param {() => Promise<void>} callback async test callback
 * @param {{ urls?: { signalingURL?: string } }} [options] registry overrides, e.g. to simulate no signaling URL
 */
async function withMockDiscoveryRegistry(game, callback, options = {}) {
  const previousCOM = registry.COM;
  const previousUrls = registry.urls;

  registry.COM = { game };
  registry.urls = options.urls ?? { signalingURL: 'wss://master.example.test/signal' };
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    registry.COM = previousCOM;
    registry.urls = previousUrls;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Temporarily replaces the global fetch with one that resolves to the given JSON body.
 * @param {object} jsonBody payload returned by response.json()
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockFetch(jsonBody, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(jsonBody) });

  try {
    await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

void describe('SessionDiscovery.listSessions', () => {
  void test('only returns sessions running the same game (mod) as this client', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockFetch({
        servers: [
          { sessionId: 'same-game', serverInfo: { map: 'start', mod: 'hellwave', currentPlayers: 1, maxPlayers: 8, colo: 'sea', country: 'US' } },
          { sessionId: 'other-game', serverInfo: { map: 'e1m1', mod: 'id1', currentPlayers: 2, maxPlayers: 8 } },
          { sessionId: 'no-mod', serverInfo: { map: 'unknown', currentPlayers: 0, maxPlayers: 8 } },
        ],
      }, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, [
          { sessionId: 'same-game', map: 'start', currentPlayers: 1, maxPlayers: 8, colo: 'sea', country: 'US' },
        ]);
      });
    });
  });

  void test('fills in defaults for missing serverInfo fields', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockFetch({
        servers: [{ sessionId: 'sparse', serverInfo: { mod: 'id1' } }],
      }, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, [
          { sessionId: 'sparse', map: '?', currentPlayers: 0, maxPlayers: 0, colo: null, country: null },
        ]);
      });
    });
  });

  void test('returns an empty list when the response has no servers', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockFetch({}, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, []);
      });
    });
  });

  void test('throws when no signaling URL is configured', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await assert.rejects(() => SessionDiscovery.listSessions(), /Signaling URL is unavailable/);
    }, { urls: {} });
  });
});
