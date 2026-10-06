import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';

import { createTestServer } from '../physics/fixtures.mjs';

/** @typedef {import('../../source/engine/server/Server.ts').default} Server */

/**
 * Builds a server with the given game and client slots.
 * @param {{ gameAPI: object, clients?: object[] }} options server state
 * @returns {Server} the server
 */
function createServer({ gameAPI, clients = [] }) {
  const sv = createTestServer();

  sv.server.gameAPI = gameAPI;
  sv.svs.serverflags = 0;
  sv.svs.maxclients = clients.length;
  sv.svs.clients = clients;

  return sv;
}

void describe('SV.SaveSpawnparms', () => {
  void test('carries the game serverflags into the state that survives level changes', () => {
    const sv = createServer({ gameAPI: { serverflags: 0b0101 } });

    sv.SaveSpawnparms();

    assert.equal(sv.svs.serverflags, 0b0101);
  });

  void test('has connected clients save their spawn parameters and skips clients that are not connected yet', () => {
    const saved = [];
    const createClient = (name, state) => ({
      state,
      saveSpawnparms() {
        saved.push(name);
      },
    });

    createServer({
      gameAPI: { serverflags: 0 },
      clients: [
        createClient('free', ServerClient.STATE.FREE),
        createClient('connecting', ServerClient.STATE.CONNECTING),
        createClient('connected', ServerClient.STATE.CONNECTED),
        createClient('spawned', ServerClient.STATE.SPAWNED),
      ],
    }).SaveSpawnparms();

    assert.deepEqual(saved, ['connected', 'spawned']);
  });
});
