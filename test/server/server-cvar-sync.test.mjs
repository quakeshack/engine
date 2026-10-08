import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import ServerCvarSync from '../../source/engine/server/ServerCvarSync.ts';
import { defaultMockEngine, withMockEngine } from '../physics/fixtures.mjs';

/**
 * @returns {{ sync: ServerCvarSync, sent: object[] }} the sync and what it sent to the page
 */
function createSync() {
  const sent = [];

  return { sync: new ServerCvarSync((message) => sent.push(message)), sent };
}

void describe('ServerCvarSync', () => {
  beforeEach(() => {
    Cvar.Shutdown();
  });

  afterEach(() => {
    Cvar.Shutdown();
  });

  void test('describes every variable of the realm', () => {
    new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER, 'Gravity.');
    new Cvar('developer', '0');
    const { sync } = createSync();

    assert.deepEqual(sync.describe(), [
      { name: 'sv_gravity', value: '800', flags: Cvar.FLAG.SERVER, description: 'Gravity.' },
      { name: 'developer', value: '0', flags: Cvar.FLAG.NONE, description: null },
    ]);
  });

  void test('reports a variable that is registered after it started', () => {
    const { sync, sent } = createSync();

    sync.start();
    new Cvar('hw_maxplayers', '4', Cvar.FLAG.GAME | Cvar.FLAG.SERVER);
    sync.stop();

    assert.deepEqual(sent, [{ kind: 'cvar-registered', cvar: { name: 'hw_maxplayers', value: '4', flags: Cvar.FLAG.GAME | Cvar.FLAG.SERVER, description: null } }]);
  });

  void test('reports a change the server made itself', () => {
    const gravity = new Cvar('sv_gravity', '800');
    const { sync, sent } = createSync();

    sync.start();
    gravity.set('600');
    sync.stop();

    assert.deepEqual(sent, [{ kind: 'cvar-changed', name: 'sv_gravity', value: '600' }]);
  });

  void test('stops reporting once stopped', () => {
    const gravity = new Cvar('sv_gravity', '800');
    const { sync, sent } = createSync();

    sync.start();
    sync.stop();
    gravity.set('600');

    assert.deepEqual(sent, []);
  });

  void describe('apply', () => {
    void test('sets what the page asked for and answers with the value the variable has', () => {
      const gravity = new Cvar('sv_gravity', '800');
      const { sync, sent } = createSync();

      sync.start();
      sync.apply('sv_gravity', ' 400 ');
      sync.stop();

      assert.equal(gravity.string, '400');
      // One answer, not also the report of a change the server made, the page would have to tell them apart.
      assert.deepEqual(sent, [{ kind: 'cvar-changed', name: 'sv_gravity', value: '400' }]);
    });

    void test('leaves a read-only variable alone and answers with its value', () => {
      const readonly = new Cvar('registered', '0', Cvar.FLAG.READONLY);
      const { sync, sent } = createSync();

      sync.apply('registered', '1');

      assert.equal(readonly.string, '0');
      assert.deepEqual(sent, [{ kind: 'cvar-changed', name: 'registered', value: '0' }]);
    });

    void test('leaves a cheat variable alone while a server without cheats runs', () => {
      const cheat = new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT);
      new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
      const { sync, sent } = createSync();

      withMockEngine(defaultMockEngine({ server: { active: true } }, null), () => {
        sync.apply('nav_debug_path', '1');
      });

      assert.equal(cheat.string, '0');
      assert.deepEqual(sent, [{ kind: 'cvar-changed', name: 'nav_debug_path', value: '0' }]);
    });

    void test('changes a cheat variable when the server allows cheats', () => {
      const cheat = new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT);
      new Cvar('sv_cheats', '1', Cvar.FLAG.SERVER);
      const { sync } = createSync();

      withMockEngine(defaultMockEngine({ server: { active: true } }, null), () => {
        sync.apply('nav_debug_path', '1');
      });

      assert.equal(cheat.string, '1');
    });

    void test('changes a cheat variable while no server runs', () => {
      const cheat = new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT);
      const { sync } = createSync();

      withMockEngine(defaultMockEngine({ server: { active: false } }, null), () => {
        sync.apply('nav_debug_path', '1');
      });

      assert.equal(cheat.string, '1');
    });

    void test('ignores a variable it does not know', () => {
      const { sync, sent } = createSync();

      sync.apply('not_here', '1');

      assert.deepEqual(sent, []);
    });
  });
});
