import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import MultiplayerMainMenu from '../../source/engine/client/menu/Multiplayer.ts';
import { Toggle } from '../../source/engine/client/menu/MenuItem.ts';

/**
 * Installs the minimal registry and GameModule stubs MultiplayerMainMenu needs to run
 * init() and refreshSessions() without touching rendering.
 * @param {string} game active COM.game to simulate for the local client
 * @param {() => Promise<void>} callback async test callback
 * @param {{ urls?: { signalingURL?: string } }} [options] registry overrides, e.g. to simulate no signaling URL
 */
async function withMockMultiplayerRegistry(game, callback, options = {}) {
  const previousCOM = registry.COM;
  const previousM = registry.M;
  const previousUrls = registry.urls;
  const previousActive = GameModule.active;

  registry.COM = { game };
  registry.M = { p_multi: null, CloseMenu() {} };
  registry.urls = options.urls ?? { signalingURL: 'wss://master.example.test/signal' };
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
  void describe('init', () => {
    void test('exposes a Private Session toggle bound to sv_public when signaling is available', async () => {
      await withMockMultiplayerRegistry('id1', async () => {
        const cvar = new Cvar('sv_public', '1');

        try {
          const page = new MultiplayerMainMenu();
          await page.init();

          const toggle = page.items.find((item) => item instanceof Toggle);
          assert.ok(toggle, 'expected a Toggle item for the private session setting');
          assert.equal(toggle.label, 'Private Session');
          assert.equal(toggle.cvar, 'sv_public');

          // sv_public 1 (public) means the toggle reads as "off" (not private).
          assert.equal(toggle.isOn(), false);

          toggle.toggle();
          assert.equal(Cvar.FindVar('sv_public').value, 0, 'toggling private on should clear sv_public');
          assert.equal(toggle.isOn(), true);
        } finally {
          cvar.free();
        }
      });
    });

    void test('omits the Private Session toggle when no signaling URL is configured', async () => {
      await withMockMultiplayerRegistry('id1', async () => {
        const page = new MultiplayerMainMenu();
        await page.init();

        assert.ok(!page.items.some((item) => item instanceof Toggle));
      }, { urls: {} });
    });
  });

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
