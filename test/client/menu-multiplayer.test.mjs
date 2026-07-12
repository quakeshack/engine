import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GameModule from '../../source/engine/common/GameModule.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import MultiplayerMainMenu from '../../source/engine/client/menu/Multiplayer.ts';

/**
 * Installs the minimal registry and GameModule stubs MultiplayerMainMenu needs to run
 * init() and refreshSessions() without touching rendering.
 * @param {string} game active COM.game to simulate for the local client
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockMultiplayerRegistry(game, callback) {
  const previousCOM = registry.COM;
  const previousM = registry.M;
  const previousUrls = registry.urls;
  const previousActive = GameModule.active;

  registry.COM = { game };
  registry.M = { p_multi: null, CloseMenu() {} };
  registry.urls = { signalingURL: 'wss://master.example.test/signal' };
  GameModule.active = {
    ServerGameAPI: {
      GetStartServerList: () => [{ label: 'Start Deathmatch', callback() {} }],
    },
  };
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    registry.COM = previousCOM;
    registry.M = previousM;
    registry.urls = previousUrls;
    GameModule.active = previousActive;
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

void describe('MultiplayerMainMenu', () => {
  void describe('refreshSessions', () => {
    void test('only lists servers running the same game (mod) as this client', async () => {
      await withMockMultiplayerRegistry('hellwave', async () => {
        await withMockFetch({
          servers: [
            { sessionId: 'same-game', serverInfo: { map: 'start', mod: 'hellwave', currentPlayers: 1, maxPlayers: 8 } },
            { sessionId: 'other-game', serverInfo: { map: 'e1m1', mod: 'id1', currentPlayers: 2, maxPlayers: 8 } },
            { sessionId: 'no-mod', serverInfo: { map: 'unknown', currentPlayers: 0, maxPlayers: 8 } },
          ],
        }, async () => {
          const page = new MultiplayerMainMenu();
          await page.init();
          await page.refreshSessions();

          const labels = page.items.map((item) => item.label);
          assert.ok(labels.some((label) => label.startsWith('start near')), 'same-game session should be listed');
          assert.ok(!labels.some((label) => label.startsWith('e1m1 near')), 'other-game session must be filtered out');
          assert.ok(!labels.some((label) => label.startsWith('unknown near')), 'session without a mod must be filtered out');
        });
      });
    });

    void test('shows "No sessions found." when no server matches the active game', async () => {
      await withMockMultiplayerRegistry('hellwave', async () => {
        await withMockFetch({
          servers: [
            { sessionId: 'other-game', serverInfo: { map: 'e1m1', mod: 'id1', currentPlayers: 2, maxPlayers: 8 } },
          ],
        }, async () => {
          const page = new MultiplayerMainMenu();
          await page.init();
          await page.refreshSessions();

          const labels = page.items.map((item) => item.label);
          assert.ok(labels.includes('No sessions found.'));
        });
      });
    });

    void test('lists a server whose mod matches the default id1 game', async () => {
      await withMockMultiplayerRegistry('id1', async () => {
        await withMockFetch({
          servers: [
            { sessionId: 'same-game', serverInfo: { map: 'dm3', mod: 'id1', currentPlayers: 3, maxPlayers: 8 } },
          ],
        }, async () => {
          const page = new MultiplayerMainMenu();
          await page.init();
          await page.refreshSessions();

          const labels = page.items.map((item) => item.label);
          assert.ok(labels.some((label) => label.startsWith('dm3 near')));
        });
      });
    });
  });
});
