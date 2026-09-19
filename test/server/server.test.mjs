import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import SV from '../../source/engine/server/Server.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';

/**
 * Runs a callback with SV's static server state replaced, restoring it afterwards.
 * @param {{ gameAPI: object, clients?: object[] }} options replacement state
 * @param {() => void} callback test callback
 */
function withServerState({ gameAPI, clients = [] }, callback) {
  const previous = {
    gameAPI: SV.server.gameAPI,
    serverflags: SV.svs.serverflags,
    maxclients: SV.svs.maxclients,
    clients: SV.svs.clients,
  };

  SV.server.gameAPI = gameAPI;
  SV.svs.serverflags = 0;
  SV.svs.maxclients = clients.length;
  SV.svs.clients = clients;

  try {
    callback();
  } finally {
    SV.server.gameAPI = previous.gameAPI;
    SV.svs.serverflags = previous.serverflags;
    SV.svs.maxclients = previous.maxclients;
    SV.svs.clients = previous.clients;
  }
}

void describe('SV.SaveSpawnparms', () => {
  void test('carries the game serverflags into the state that survives level changes', () => {
    withServerState({ gameAPI: { serverflags: 0b0101 } }, () => {
      SV.SaveSpawnparms();

      assert.equal(SV.svs.serverflags, 0b0101);
    });
  });

  void test('has connected clients save their spawn parameters and skips clients that are not connected yet', () => {
    const saved = [];
    const createClient = (name, state) => ({
      state,
      saveSpawnparms() {
        saved.push(name);
      },
    });

    withServerState({
      gameAPI: { serverflags: 0 },
      clients: [
        createClient('free', ServerClient.STATE.FREE),
        createClient('connecting', ServerClient.STATE.CONNECTING),
        createClient('connected', ServerClient.STATE.CONNECTED),
        createClient('spawned', ServerClient.STATE.SPAWNED),
      ],
    }, () => {
      SV.SaveSpawnparms();
    });

    assert.deepEqual(saved, ['connected', 'spawned']);
  });
});
