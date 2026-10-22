import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Cvar, { type CvarServerState } from '../../source/engine/common/Cvar.ts';

/**
 * Tells the cheat rule about a server.
 * @param state What the realm reports.
 * @param state.active Whether a server is running.
 * @param state.reportedCheats `sv_cheats` as the connected server reports it.
 */
function reportServer({ active, reportedCheats }: { active: boolean; reportedCheats?: string }): void {
  const serverState: CvarServerState = { isServerActive: () => active, reportedCheats: () => reportedCheats };

  Cvar.serverState = serverState;
}

void describe('Cvar.GetChangeBlock', () => {
  beforeEach(() => {
    Cvar.Shutdown();
  });

  afterEach(() => {
    Cvar.serverState = null;
    Cvar.Shutdown();
  });

  void test('blocks a read-only variable whatever the server says', () => {
    const variable = new Cvar('registered', '0', Cvar.FLAG.READONLY);

    assert.equal(Cvar.GetChangeBlock(variable), 'readonly');
  });

  void test('lets an ordinary variable change', () => {
    assert.equal(Cvar.GetChangeBlock(new Cvar('volume', '1')), null);
  });

  void test('lets a cheat variable change when the realm reports no server', () => {
    assert.equal(Cvar.GetChangeBlock(new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT)), null);
  });

  void test('lets a cheat variable change while no server is running', () => {
    reportServer({ active: false });

    assert.equal(Cvar.GetChangeBlock(new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT)), null);
  });

  void test('blocks a cheat variable while a server without cheats runs, by its own sv_cheats', () => {
    reportServer({ active: true });
    new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);

    assert.equal(Cvar.GetChangeBlock(new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT)), 'cheat');
  });

  void test('lets a cheat variable change while the server allows cheats', () => {
    reportServer({ active: true });
    new Cvar('sv_cheats', '1', Cvar.FLAG.SERVER);

    assert.equal(Cvar.GetChangeBlock(new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT)), null);
  });

  void test('goes by what the connected server reports over its own sv_cheats', () => {
    reportServer({ active: true, reportedCheats: '1' });
    new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);

    assert.equal(Cvar.GetChangeBlock(new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT)), null);
  });
});
