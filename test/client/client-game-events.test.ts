import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import { eventBus } from '../../source/engine/common/EventBus.ts';
import { clientGameEvents, clientRuntimeState, moduleEventBus } from '../../source/engine/client/ClientState.ts';
import { useMenuOf } from '../support/menu.ts';

// Everything here goes through the real `ClientRuntimeState` and the real engine bus on purpose: the game tests use a
// hand-made bus, which is how a game listening for an event the engine never forwarded went unnoticed.

/** What a game needs from the engine, by name; `clientGameEvents` has to carry each of them. */
const eventsGamesListenFor = [
  'client.center-print',
  'client.disconnected',
  'server.spawning',
  'client.damage',
  'client.chat.message',
  'client.server-info.ready',
  'client.server-info.updated',
  'client.clientdata.field-changed',
  'vid.resize',
  'cvar.changed',
  'host.alert',
  'host.quit-requested',
];

const unsubscribers: Array<() => void> = [];

// Publishing `client.disconnected` for real makes the menu open its main page; this keeps it out of the way.
let restoreMenu: () => void = () => {};

before(() => {
  restoreMenu = useMenuOf({ Menu_Main_f() {} });
});

after(() => {
  restoreMenu();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }

  unsubscribers.length = 0;
  clientRuntimeState.clear();
});

void describe('events the engine hands to the client game', () => {
  void test('carries every event a game listens for', () => {
    for (const name of eventsGamesListenFor) {
      assert.ok((clientGameEvents as readonly string[]).includes(name), `${name} is missing from clientGameEvents`);
    }
  });

  void test('delivers each of them, with its arguments, to the per-map bus', () => {
    clientRuntimeState.clear();

    for (const name of clientGameEvents) {
      const received: unknown[][] = [];
      unsubscribers.push(clientRuntimeState.eventBus.subscribe(name, (...args: unknown[]) => { received.push(args); }));

      eventBus.publishUntyped(name, 'first', 2);

      assert.deepEqual(received, [['first', 2]], name);
    }
  });

  void test('delivers each of them to the module bus as well', () => {
    for (const name of clientGameEvents) {
      const received: unknown[][] = [];
      unsubscribers.push(moduleEventBus.subscribe(name, (...args: unknown[]) => { received.push(args); }));

      eventBus.publishUntyped(name, 'first');

      assert.deepEqual(received, [['first']], name);
    }
  });

  void test('does not pass on events a game was not given', () => {
    clientRuntimeState.clear();

    const received: string[] = [];
    // The compiler refuses a game's subscription to an engine event it was not given, hence `as never`: this checks
    // the whitelist at run time.
    unsubscribers.push(clientRuntimeState.eventBus.subscribe('worker.busy' as never, () => { received.push('worker.busy'); }));
    unsubscribers.push(moduleEventBus.subscribe('worker.busy' as never, () => { received.push('worker.busy'); }));

    eventBus.publish('worker.busy', 1);

    assert.deepEqual(received, []);
  });

  void test('lets go of the per-map listeners when the state is cleared, and keeps the module ones', () => {
    clientRuntimeState.clear();

    const received: string[] = [];
    clientRuntimeState.eventBus.subscribe('client.center-print', () => { received.push('map'); });
    unsubscribers.push(moduleEventBus.subscribe('client.center-print', () => { received.push('module'); }));

    clientRuntimeState.clear();
    eventBus.publish('client.center-print', 'Welcome');

    assert.deepEqual(received, ['module']);
  });
});

void describe('what a game publishes itself', () => {
  void test('stays on the bus it was published on, not reaching the module bus', () => {
    clientRuntimeState.clear();

    const received: string[] = [];
    unsubscribers.push(moduleEventBus.subscribe('game.phase.changed', () => { received.push('module'); }));
    unsubscribers.push(clientRuntimeState.eventBus.subscribe('game.phase.changed', () => { received.push('map'); }));

    clientRuntimeState.eventBus.publish('game.phase.changed');

    assert.deepEqual(received, ['map']);
  });

  void test('stays on the module bus, not reaching the per-map bus', () => {
    clientRuntimeState.clear();

    const received: string[] = [];
    unsubscribers.push(moduleEventBus.subscribe('game.phase.changed', () => { received.push('module'); }));
    unsubscribers.push(clientRuntimeState.eventBus.subscribe('game.phase.changed', () => { received.push('map'); }));

    moduleEventBus.publish('game.phase.changed');

    assert.deepEqual(received, ['module']);
  });

  void test('never reaches the engine bus, whatever the name', () => {
    clientRuntimeState.clear();

    const received: string[] = [];
    // `as never`: the engine's bus is typed by the engine's events, a game's name is not one of them
    unsubscribers.push(eventBus.subscribe('game.phase.changed' as never, () => { received.push('engine'); }));
    unsubscribers.push(eventBus.subscribe('client.clientdata.field-changed', () => { received.push('engine'); }));

    clientRuntimeState.eventBus.publish('game.phase.changed');
    // a game republishes an engine name for its own listeners (id1 does this with the clientdata fields)
    clientRuntimeState.eventBus.publish('client.clientdata.field-changed', 'health', 50, 100);

    assert.deepEqual(received, []);
  });
});

