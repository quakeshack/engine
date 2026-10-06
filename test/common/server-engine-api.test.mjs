import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Cvar from '../../source/engine/common/Cvar.ts';
import { GameFlavors } from '../../source/engine/common/GameApiSupport.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import { createTestServer } from '../physics/fixtures.mjs';

void describe('ServerEngineAPI', () => {
  void describe('ownership', () => {
    void test('every server has its own engine API instance', () => {
      const first = createTestServer();
      const second = createTestServer();

      assert.ok(first.engineAPI instanceof ServerEngineAPI);
      assert.notEqual(first.engineAPI, second.engineAPI);
    });

    void test('answers from the server it was built for', () => {
      const first = createTestServer();
      const second = createTestServer();

      first.svs.maxclients = 4;
      second.svs.maxclients = 1;

      assert.equal(first.engineAPI.maxplayers, 4);
      assert.equal(second.engineAPI.maxplayers, 1);
    });

    void test('hands out the event bus of the server it belongs to', () => {
      const server = createTestServer();

      assert.equal(server.engineAPI.eventBus, server.server.eventBus);
    });
  });

  void describe('game edition', () => {
    void test('registered data has no flavors', () => {
      const server = createTestServer({ gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }) });

      assert.equal(server.engineAPI.registered, true);
      assert.deepEqual(server.engineAPI.gameFlavors, []);
    });

    void test('shareware data is flagged as such', () => {
      const server = createTestServer({ gameEdition: () => ({ registered: false, hipnotic: false, rogue: false }) });

      assert.equal(server.engineAPI.registered, false);
      assert.deepEqual(server.engineAPI.gameFlavors, [GameFlavors.shareware]);
    });

    void test('mission packs are reported as flavors', () => {
      const hipnotic = createTestServer({ gameEdition: () => ({ registered: true, hipnotic: true, rogue: false }) });
      const rogue = createTestServer({ gameEdition: () => ({ registered: true, hipnotic: false, rogue: true }) });

      assert.deepEqual(hipnotic.engineAPI.gameFlavors, [GameFlavors.hipnotic]);
      assert.deepEqual(rogue.engineAPI.gameFlavors, [GameFlavors.rogue]);
    });

    void test('is read when asked, not when the server was built', () => {
      let edition = { registered: false, hipnotic: false, rogue: false };
      const server = createTestServer({ gameEdition: () => edition });

      assert.equal(server.engineAPI.registered, false);

      edition = { registered: true, hipnotic: false, rogue: false };

      assert.equal(server.engineAPI.registered, true);
    });

    void test('does not accumulate flavors across reads', () => {
      const server = createTestServer({ gameEdition: () => ({ registered: false, hipnotic: true, rogue: false }) });

      void server.engineAPI.gameFlavors;

      assert.equal(server.engineAPI.gameFlavors.length, 2);
    });
  });

  void describe('RegisterCvar', () => {
    void test('marks the variable as owned by the game and the server', () => {
      const server = createTestServer();
      const name = 'test_server_engine_api_cvar';

      try {
        const cvar = server.engineAPI.RegisterCvar(name, '1', Cvar.FLAG.ARCHIVE);

        assert.equal(cvar.flags, Cvar.FLAG.ARCHIVE | Cvar.FLAG.GAME | Cvar.FLAG.SERVER);
        assert.equal(server.engineAPI.GetCvar(name), cvar);
      } finally {
        Cvar.FindVar(name)?.free();
      }
    });
  });

  void describe('console', () => {
    void test('prints through the console of its server', () => {
      const printed = [];
      const server = createTestServer({
        con: {
          Print: (text) => printed.push(['print', text]),
          DPrint: (text) => printed.push(['debug', text]),
          PrintWarning: (text) => printed.push(['warning', text]),
          PrintError: (text) => printed.push(['error', text]),
          PrintSuccess() {},
          StartCapturing() {},
          StopCapturing: () => '',
        },
      });

      server.engineAPI.ConsolePrint('a');
      server.engineAPI.ConsoleDebug('b');
      server.engineAPI.ConsoleWarning('c');
      server.engineAPI.ConsoleError('d');

      assert.deepEqual(printed, [['print', 'a'], ['debug', 'b'], ['warning', 'c'], ['error', 'd']]);
    });
  });

  void describe('PrecacheSound', () => {
    void test('records a sound once', () => {
      const server = createTestServer();

      server.engineAPI.PrecacheSound('misc/null.wav');
      server.engineAPI.PrecacheSound('misc/null.wav');

      assert.deepEqual(server.server.soundPrecache, ['misc/null.wav']);
    });
  });
});
