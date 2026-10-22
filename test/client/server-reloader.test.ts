import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SavegameState } from '../../source/engine/client/ClientHost.ts';
import ServerReloader, { type ServerReloaderDependencies } from '../../source/engine/client/ServerReloader.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';

/** What the reloader asked its collaborators to do, in order, and what they answer. */
interface Setup {
  readonly reloader: ServerReloader;
  readonly calls: string[];
  readonly prints: string[];
  answer: { capture: Awaited<ReturnType<ServerReloaderDependencies['capture']>>; restoreError: Error | null };
}

const SAVED = { mapname: 'e1m2', comment: 'The Tomb of Terror' } as unknown as SavegameState;

/**
 * Builds a reloader over stand-ins that write down what they were asked.
 * @param active Whether a server is running.
 * @param mapname The map it runs.
 * @returns The reloader and its record.
 */
function createSetup(active = true, mapname: string | null = 'e1m2'): Setup {
  const calls: string[] = [];
  const prints: string[] = [];
  const answer: Setup['answer'] = { capture: { ok: true, state: SAVED }, restoreError: null };
  const channel = { port1: {} as MessagePort, port2: {} as MessagePort };

  const reloader = new ServerReloader({
    controller: {
      state: { active, mapname },
      replaceWorker: () => { calls.push('replaceWorker'); return Promise.resolve(); },
    },
    spawn: () => { calls.push('spawn'); return { worker: { postMessage() {}, shutdown: () => Promise.resolve() }, channel }; },
    attachChannel: () => { calls.push('attachChannel'); },
    closePeers: () => { calls.push('closePeers'); },
    capture: () => { calls.push('capture'); return Promise.resolve(answer.capture); },
    restore: (_state, source) => {
      calls.push(`restore ${source}`);
      return answer.restoreError === null ? Promise.resolve() : Promise.reject(answer.restoreError);
    },
    disconnect: () => { calls.push('disconnect'); },
    startMap: (name) => { calls.push(`map ${name}`); },
    con: {
      Print: (text: string) => { prints.push(text); },
      PrintSuccess: (text: string) => { prints.push(text); },
      PrintWarning: (text: string) => { prints.push(text); },
      PrintError: (text: string) => { prints.push(text); },
      DPrint: () => {},
    },
  });

  return { reloader, calls, prints, answer };
}

void describe('ServerReloader', () => {
  void test('captures the game first, then replaces the worker, then puts the game back', async () => {
    const { reloader, calls } = createSetup();

    await reloader.reload(true);

    assert.deepEqual(calls, ['capture', 'disconnect', 'closePeers', 'spawn', 'attachChannel', 'replaceWorker', 'restore server_reload']);
  });

  void test('starts the level from scratch when asked to restart', async () => {
    const { reloader, calls } = createSetup();

    await reloader.reload(false);

    assert.deepEqual(calls, ['disconnect', 'closePeers', 'spawn', 'attachChannel', 'replaceWorker', 'map e1m2']);
  });

  void test('starts the level from scratch when the game cannot be saved, and says why', async () => {
    const { reloader, calls, prints, answer } = createSetup();
    answer.capture = { ok: false, reason: 'Can\'t save multiplayer games.' };

    await reloader.reload(true);

    assert.deepEqual(calls.slice(-1), ['map e1m2']);
    assert.ok(prints.some((line) => line.includes('Can\'t save multiplayer games.') && line.includes('from scratch')));
  });

  void test('starts the level from scratch when the new server cannot take the savegame', async () => {
    const { reloader, calls, prints, answer } = createSetup();
    answer.restoreError = new Error('Game is version 1, not 2\n');

    await reloader.reload(true);

    assert.deepEqual(calls.slice(-2), ['restore server_reload', 'map e1m2']);
    assert.ok(prints.some((line) => line.includes('version 1, not 2')));
  });

  void test('only replaces the worker when no server was running', async () => {
    const { reloader, calls } = createSetup(false, null);

    await reloader.reload(true);

    assert.deepEqual(calls, ['disconnect', 'closePeers', 'spawn', 'attachChannel', 'replaceWorker']);
  });

  void test('is not entered twice at once', async () => {
    const { reloader, calls, prints } = createSetup();

    await Promise.all([reloader.reload(true), reloader.reload(true)]);

    assert.equal(calls.filter((call) => call === 'spawn').length, 1);
    assert.ok(prints.some((line) => line.includes('already being reloaded')));
  });

  void describe('server_reload', () => {
    void test('keeps the state by default and restarts the level with `restart`', async () => {
      const keeping = createSetup();
      const restarting = createSetup();
      const Command = keeping.reloader.createCommand();
      const Restart = restarting.reloader.createCommand();

      await runConsoleCommand(Command, { client: null });
      await runConsoleCommand(Restart, { client: null }, 'restart');

      assert.ok(keeping.calls.includes('capture'));
      assert.deepEqual(restarting.calls.slice(-1), ['map e1m2']);
    });

    void test('is for the local console only', async () => {
      const { reloader, calls } = createSetup();
      const Command = reloader.createCommand();

      await runConsoleCommand(Command, { client: {} as never });

      assert.deepEqual(calls, []);
    });
  });
});
