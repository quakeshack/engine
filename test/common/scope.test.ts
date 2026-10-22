import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { EventBus, type ClientGameEventMap, type ServerGameEventMap } from '../../source/engine/common/EventBus.ts';
import { Scope } from '../../source/engine/common/Scope.ts';
import type { EngineEventMap } from '../../source/shared/EngineEvents.ts';

/**
 * Creates a realm bus of its own, so a test can count what a scope leaves on it.
 * @returns An empty engine bus.
 */
function createRealm(): EventBus<EngineEventMap> {
  return new EventBus('realm');
}

/**
 * Builds a client-like scope over a realm bus.
 * @param realm The bus the scope forwards from.
 * @param parent The scope it lives inside, if any.
 * @returns The scope, begun or not as asked.
 */
function createClientScope(realm: EventBus<EngineEventMap>, parent: Scope<ClientGameEventMap> | null = null): Scope<ClientGameEventMap> {
  return new Scope<ClientGameEventMap>('map', {
    parent,
    source: realm,
    names: ['client.center-print', 'client.damage', 'cvar.changed'],
  });
}

void describe('Scope', () => {
  void describe('events', () => {
    void test('are not forwarded before the scope has begun', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.events.subscribe('client.center-print', (message) => { heard.push(message); });
      realm.publish('client.center-print', 'before');

      assert.deepEqual(heard, []);
      assert.equal(scope.active, false);
    });

    void test('are forwarded with their arguments while the scope lives', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('client.center-print', (message) => { heard.push(message); });
      realm.publish('client.center-print', 'welcome');

      assert.deepEqual(heard, ['welcome']);
      assert.equal(scope.active, true);
    });

    void test('leave out the names the scope was not given', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('client.paused', () => { heard.push('paused'); });
      realm.publish('client.paused');

      assert.deepEqual(heard, []);
    });

    void test('carry a parameterized family by its prefix', () => {
      const realm = createRealm();
      const scope = new Scope<ServerGameEventMap>('map', {
        source: realm,
        names: ['cvar.changed'],
        families: ['cvar.changed.'],
      });
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('cvar.changed.sv_nextmap', (cvar) => { heard.push(cvar.name); });
      realm.publishUntyped('cvar.changed.sv_nextmap', { name: 'sv_nextmap' });
      realm.publishUntyped('cvar.changed.sv_gravity', { name: 'sv_gravity' });

      assert.deepEqual(heard, ['sv_nextmap']);
    });
  });

  void describe('end', () => {
    void test('releases every listener of the game and stops forwarding', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('client.center-print', () => { heard.push('print'); });
      scope.events.subscribe('game.phase.changed', () => { heard.push('phase'); });
      scope.end();

      realm.publish('client.center-print', 'late');
      scope.events.publish('game.phase.changed');

      assert.deepEqual(heard, []);
      assert.equal(scope.events.listenerCount, 0);
      assert.equal(realm.listenerCount, 0);
      assert.equal(scope.active, false);
    });

    void test('runs what engine code registered, last registered first, once', () => {
      const scope = createClientScope(createRealm());
      const order: string[] = [];

      scope.begin();
      scope.onDispose(() => { order.push('first'); });
      scope.onDispose(() => { order.push('second'); });
      scope.end();
      scope.end();

      assert.deepEqual(order, ['second', 'first']);
    });

    void test('ends the scopes inside it before its own callbacks', () => {
      const realm = createRealm();
      const module = new Scope<ClientGameEventMap>('module', { source: realm, names: ['client.center-print'] });
      const map = createClientScope(realm, module);
      const order: string[] = [];

      module.begin();
      map.begin();
      module.onDispose(() => { order.push('module'); });
      map.onDispose(() => { order.push('map'); });
      module.end();

      assert.deepEqual(order, ['map', 'module']);
      assert.equal(map.active, false);
      assert.equal(realm.listenerCount, 0);
    });

    void test('leaves the parent alone when a child ends', () => {
      const realm = createRealm();
      const module = new Scope<ClientGameEventMap>('module', { source: realm, names: ['client.center-print'] });
      const map = createClientScope(realm, module);
      const heard: string[] = [];

      module.begin();
      map.begin();
      module.events.subscribe('client.center-print', () => { heard.push('module'); });
      map.end();
      realm.publish('client.center-print', 'x');

      assert.deepEqual(heard, ['module']);
      assert.equal(module.active, true);
    });

    void test('lets go of everything even when a callback throws, then throws the first error', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const ran: string[] = [];

      scope.begin();
      scope.events.subscribe('client.center-print', () => {});
      scope.onDispose(() => { ran.push('last'); });
      scope.onDispose(() => { throw new Error('first failure'); });
      scope.onDispose(() => { ran.push('first'); });

      assert.throws(() => { scope.end(); }, /first failure/);
      assert.deepEqual(ran, ['first', 'last']);
      assert.equal(scope.events.listenerCount, 0);
      assert.equal(realm.listenerCount, 0);
    });
  });

  void describe('restart', () => {
    void test('keeps the bus object and drops what was registered on it', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const bus = scope.events;
      const heard: string[] = [];

      scope.begin();
      bus.subscribe('client.center-print', () => { heard.push('old'); });
      scope.restart();
      bus.subscribe('client.center-print', () => { heard.push('new'); });
      realm.publish('client.center-print', 'x');

      assert.equal(scope.events, bus);
      assert.deepEqual(heard, ['new']);
    });

    void test('leaves nothing behind on the realm bus over a hundred maps', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);

      scope.begin();
      const baseline = realm.listenerCount;

      for (let map = 0; map < 100; map++) {
        scope.events.subscribe('client.center-print', () => {});
        scope.events.subscribe('cvar.changed', () => {});
        scope.restart();
      }

      assert.equal(realm.listenerCount, baseline);
      assert.equal(scope.events.listenerCount, 0);
    });
  });

  void describe('while an event is being delivered', () => {
    void test('calls a listener that a listener added', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('client.center-print', () => {
        heard.push('first');
        scope.events.subscribe('client.center-print', () => { heard.push('added'); });
      });
      realm.publish('client.center-print', 'x');

      assert.deepEqual(heard, ['first', 'added']);
    });

    void test('survives a listener that ends the scope, and delivers nothing afterwards', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      scope.events.subscribe('client.center-print', () => {
        heard.push('first');
        scope.end();
      });
      scope.events.subscribe('client.center-print', () => { heard.push('second'); });

      assert.doesNotThrow(() => { realm.publish('client.center-print', 'x'); });
      realm.publish('client.center-print', 'y');

      // listeners of the delivery in progress still hear it, which is how the bus has always behaved
      assert.deepEqual(heard, ['first', 'second']);
      assert.equal(realm.listenerCount, 0);
    });
  });

  void describe('isolation', () => {
    void test('keeps a game\'s own event out of the realm and out of the other scopes', () => {
      const realm = createRealm();
      const module = new Scope<ClientGameEventMap>('module', { source: realm, names: ['client.center-print'] });
      const map = createClientScope(realm, module);
      const heard: string[] = [];

      module.begin();
      map.begin();
      module.events.subscribe('game.phase.changed', () => { heard.push('module'); });
      map.events.subscribe('game.phase.changed', () => { heard.push('map'); });
      realm.subscribe('game.phase.changed' as never, () => { heard.push('realm'); });

      map.events.publish('game.phase.changed');

      assert.deepEqual(heard, ['map']);
    });

    void test('keeps a republished engine name away from the realm', () => {
      const realm = createRealm();
      const scope = createClientScope(realm);
      const heard: string[] = [];

      scope.begin();
      realm.subscribe('client.damage', () => { heard.push('realm'); });
      scope.events.subscribe('client.damage', () => { heard.push('game'); });

      scope.events.publish('client.damage', { damageReceived: 1, armorLost: 0, attackOrigin: [0, 0, 0] } as never);

      assert.deepEqual(heard, ['game']);
    });
  });

  void describe('what a game is given', () => {
    void test('asserts, in development builds, on an engine event it was not given', () => {
      const scope = createClientScope(createRealm());
      const assertion = mock.method(console, 'assert', () => {});

      try {
        // `as never`: the compiler refuses this as well
        scope.events.subscribe('gl.ready' as never, () => {});
        scope.events.subscribe('client.center-print', () => {});
        scope.events.subscribe('game.phase.changed', () => {});

        const failed = assertion.mock.calls.filter((call) => call.arguments[0] === false);
        assert.equal(failed.length, 1);
        assert.match(String(failed[0].arguments[1]), /gl\.ready/);
      } finally {
        assertion.mock.restore();
      }
    });
  });

  void test('asserts that a scope is not begun twice', () => {
    const scope = createClientScope(createRealm());
    const assertion = mock.method(console, 'assert', () => {});

    try {
      scope.begin();
      scope.begin();

      assert.equal(assertion.mock.calls.filter((call) => call.arguments[0] === false).length, 1);
    } finally {
      assertion.mock.restore();
    }
  });
});
