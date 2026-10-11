import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { eventBus } from '../../source/engine/common/EventBus.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { CollisionModelSource } from '../../source/engine/common/CollisionModelSource.ts';
import Server from '../../source/engine/server/Server.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';

// The game's bus is its own, fed by the engine for what a game may see. The game tests use a hand-made bus, so a game
// listening for something the engine never put on it (`cvar.changed.sv_nextmap` was one) only shows up here.

/**
 * Builds a server over silent stand-ins, which is all the cvar listener needs.
 * @returns A server that has not spawned a map.
 */
function createServer(): Server {
  const silent = (): void => {};
  const dependencies: ServerDependencies = {
    con: { Print: silent, DPrint: silent, PrintWarning: silent, PrintError: silent, PrintSuccess: silent, StartCapturing: silent, StopCapturing: () => '' },
    sys: { Print: silent, FloatTime: () => 0 },
    net: {} as ServerDependencies['net'],
    mod: {} as ServerDependencies['mod'],
    view: { CalcRoll: () => 0 },
    files: { LoadFile: () => Promise.resolve(null), WriteFile: () => Promise.resolve(true) },
    collisionModelSource: new CollisionModelSource(),
    engineVersion: () => 'test',
    gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }),
    dedicated: true,
  };

  return new Server(dependencies);
}

// One server for the file: cvars are global, a second `Init()` would replace the ones the first server holds.
const sv = createServer();
sv.Init();

after(() => {
  Cvar.Shutdown();
});

void describe('events the engine hands to the server game', () => {
  void test('delivers a cvar change under the cvar\'s own name, with the cvar', () => {
    const heard: string[] = [];
    const unsubscribe = sv.server.eventBus.subscribe('cvar.changed.sv_nextmap', (cvar: Cvar) => {
      heard.push(cvar.string);
    });

    sv.nextmap!.set('e1m2');
    unsubscribe();

    assert.deepEqual(heard, ['e1m2']);
  });

  void test('delivers a cvar change by name to a game that listens for all of them', () => {
    const heard: string[] = [];
    const unsubscribe = sv.server.eventBus.subscribe('cvar.changed', (name: string) => {
      heard.push(name);
    });

    sv.gravity!.set('400');
    unsubscribe();

    assert.deepEqual(heard, ['sv_gravity']);
  });

  void test('does not deliver a change that did not change the value', () => {
    const heard: string[] = [];
    const unsubscribe = sv.server.eventBus.subscribe('cvar.changed.sv_nextmap', () => {
      heard.push('changed');
    });

    sv.nextmap!.set('e1m2');
    unsubscribe();

    assert.deepEqual(heard, []);
  });

  void test('lets go of what a game listened for when the game bus is wiped, as it is on every map', () => {
    const heard: string[] = [];
    sv.server.eventBus.subscribe('cvar.changed.sv_gravity', () => {
      heard.push('stale');
    });

    sv.server.eventBus.unsubscribeAll();
    sv.gravity!.set('600');

    assert.deepEqual(heard, []);
  });
});

void describe('what a server game publishes itself', () => {
  void test('never reaches the engine bus, not even under the name of an event the server forwards to the page', () => {
    const received: string[] = [];
    const unsubscribers = [
      eventBus.subscribe('server.spawned', () => { received.push('server.spawned'); }),
      // `as never`: the engine's bus is typed by the engine's events, a game's name is not one of them
      eventBus.subscribe('game.monster.killed' as never, () => { received.push('game.monster.killed'); }),
    ];

    sv.server.eventBus.publish('game.monster.killed');
    sv.server.eventBus.publish('server.spawned' as never);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }

    assert.deepEqual(received, []);
  });
});

