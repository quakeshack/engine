import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import ServerSavegame from '../../source/engine/server/ServerSavegame.ts';
import { createTestServer } from '../physics/fixtures.mjs';

/**
 * Builds a server with one connected player, ready to be saved.
 * @param {{ active?: boolean, maxclients?: number, health?: number }} [options] what to change
 * @returns {ReturnType<typeof createTestServer>} the server
 */
function createSavableServer({ active = true, maxclients = 1, health = 100 } = {}) {
  const sv = createTestServer();
  const player = { classname: 'player', health, serialize: () => ({ health }) };

  sv.server.active = active;
  sv.server.mapname = 'e1m1';
  sv.server.gameVersion = '1.0.0';
  sv.server.time = 12.5;
  sv.server.lightstyles = ['m'];
  sv.server.gameAPI = /** @type {any} */ ({ serialize: () => ({ globals: true }) });
  sv.server.edicts = /** @type {any} */ ([{ entity: null, isFree: () => true }]);
  sv.server.num_edicts = 1;
  sv.svs.maxclients = maxclients;
  sv.svs.clients = /** @type {any} */ ([{ state: ServerClient.STATE.SPAWNED, spawn_parms: 'parms', edict: { entity: player } }]);

  return sv;
}

void describe('ServerSavegame.capture', () => {
  void test('collects the state of the running game', () => {
    const result = ServerSavegame.capture(createSavableServer());

    assert.equal(result.ok, true);
    assert.equal(result.state.version, Def.gamestateVersion);
    assert.equal(result.state.gameversion, '1.0.0');
    assert.equal(result.state.mapname, 'e1m1');
    assert.equal(result.state.time, 12.5);
    assert.equal(result.state.spawn_parms, 'parms');
    assert.deepEqual(result.state.globals, { globals: true });
    assert.deepEqual(result.state.edicts, [null]);
    assert.equal(result.state.num_edicts, 1);
  });

  void test('gives a reason when no game runs', () => {
    assert.deepEqual(ServerSavegame.capture(createSavableServer({ active: false })), { ok: false, reason: 'Not playing a local game.' });
  });

  void test('refuses multiplayer games', () => {
    assert.deepEqual(ServerSavegame.capture(createSavableServer({ maxclients: 4 })), { ok: false, reason: 'Can\'t save multiplayer games.' });
  });

  void test('refuses a dead player', () => {
    assert.deepEqual(ServerSavegame.capture(createSavableServer({ health: 0 })), { ok: false, reason: 'Can\'t savegame with a dead player' });
  });

  void test('can be sent between threads', () => {
    const result = ServerSavegame.capture(createSavableServer());

    assert.deepEqual(structuredClone(result), result);
  });
});

void describe('ServerSavegame.restore', () => {
  /**
   * @param {boolean} spawns whether the map can be spawned
   * @returns {{ sv: ReturnType<typeof createTestServer>, shutdowns: boolean[], warnings: string[] }} a server that records what happens to it
   */
  function createRestoringServer(spawns) {
    const shutdowns = [];
    const warnings = [];
    const sv = createTestServer({
      con: { Print() {}, DPrint() {}, PrintWarning: (text) => warnings.push(text), PrintError() {}, PrintSuccess() {}, StartCapturing() {}, StopCapturing: () => '' },
    });

    sv.SpawnServer = () => Promise.resolve(spawns);
    sv.ShutdownServer = (crash) => { shutdowns.push(crash); };

    return { sv, shutdowns, warnings };
  }

  const state = Object.freeze({
    version: Def.gamestateVersion, gameversion: '1.0.0', spawn_parms: null, mapname: 'e1m1', time: 1, lightstyles: [], globals: {}, cvars: [], edicts: [], num_edicts: 0,
  });

  void test('fails with a host error and shuts the server down when the map cannot be spawned', async () => {
    const { sv, shutdowns } = createRestoringServer(false);

    await assert.rejects(ServerSavegame.restore(sv, state, 'quick.json'), (error) => error.name === 'HostError' && /Couldn't load map e1m1 for save game quick\.json/.test(error.message));
    assert.deepEqual(shutdowns, [false]);
  });

  void test('fails with a host error when the savegame belongs to another game version', async () => {
    const { sv, shutdowns } = createRestoringServer(true);

    sv.server.gameVersion = '2.0.0';

    await assert.rejects(ServerSavegame.restore(sv, state, 'quick.json'), /Game is version 1\.0\.0, not 2\.0\.0/);
    assert.deepEqual(shutdowns, [false]);
  });

  void test('warns about a saved cvar that does not exist any more and goes on', async () => {
    const { sv, warnings } = createRestoringServer(false);

    await assert.rejects(ServerSavegame.restore(sv, { ...state, cvars: [['gone_cvar', '1']] }, 'quick.json'));
    assert.deepEqual(warnings, ['Saved cvar gone_cvar not found, skipping\n']);
  });
});
