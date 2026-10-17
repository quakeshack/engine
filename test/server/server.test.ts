import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';

import { createTestServer } from '../support/fixtures.ts';
import type Server from '../../source/engine/server/Server.ts';

/**
 * Builds a server with the given game and client slots.
 * @param options server state
 * @returns the server
 */
function createServer({ gameAPI, clients = [] }: { gameAPI: object; clients?: object[] }): Server {
  const sv = createTestServer();

  // Only the serverflags of the game are read.
  sv.server.gameAPI = gameAPI as Server['server']['gameAPI'];
  sv.svs.serverflags = 0;
  sv.svs.maxclients = clients.length;
  // The clients have the state and the spawn parameter saving that SaveSpawnparms asks for.
  sv.svs.clients = clients as ServerClient[];

  return sv;
}

void describe('SV.SaveSpawnparms', () => {
  void test('carries the game serverflags into the state that survives level changes', () => {
    const sv = createServer({ gameAPI: { serverflags: 0b0101 } });

    sv.SaveSpawnparms();

    assert.equal(sv.svs.serverflags, 0b0101);
  });

  void test('has connected clients save their spawn parameters and skips clients that are not connected yet', () => {
    const saved: string[] = [];
    const createClient = (name: string, state: number) => ({
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
