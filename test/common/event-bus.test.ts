import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EventBus, GameEventBus, type ClientGameEventMap, type ServerGameEventMap } from '../../source/engine/common/EventBus.ts';
import { clientGameEventNames } from '../../source/shared/EngineEvents.ts';

void describe('EventBus', () => {
  void test('calls the listeners of a name with the arguments it was published with', () => {
    const bus = new EventBus('test');
    const received: unknown[][] = [];

    bus.subscribe('client.players.frags-updated', (num, frags) => { received.push([num, frags]); });
    bus.publish('client.players.frags-updated', 3, 12);

    assert.deepEqual(received, [[3, 12]]);
  });

  void test('removes a listener with the function subscribe returns', () => {
    const bus = new EventBus('test');
    let calls = 0;

    const unsubscribe = bus.subscribe('client.paused', () => { calls += 1; });
    bus.publish('client.paused');
    unsubscribe();
    bus.publish('client.paused');

    assert.equal(calls, 1);
  });

  void test('types a parameterized name by its family', () => {
    const bus = new EventBus('test');
    const seen: string[] = [];

    bus.subscribe('cvar.changed.sv_nextmap', (cvar) => { seen.push(cvar.name); });
    bus.publishUntyped('cvar.changed.sv_nextmap', { name: 'sv_nextmap' });

    assert.deepEqual(seen, ['sv_nextmap']);
  });

  void test('refuses a wrong name or payload at compile time', () => {
    const bus = new EventBus('test');

    // @ts-expect-error not an engine event
    bus.publish('client.paused-ish');
    // @ts-expect-error `client.cdtrack` carries a track number
    bus.publish('client.cdtrack', 'one');
    // @ts-expect-error `client.damage` carries one argument
    bus.publish('client.damage');
    // @ts-expect-error the listener has to take what is published
    bus.subscribe('client.cdtrack', (track: string) => { assert.equal(typeof track, 'string'); });
  });

  void describe('publishUntyped', () => {
    void test('reaches the listeners of the name', () => {
      const bus = new EventBus('test');
      const received: unknown[][] = [];

      bus.subscribe('client.server-info.updated', (name, value) => { received.push([name, value]); });
      bus.publishUntyped('client.server-info.updated', 'hostname', 'test');

      assert.deepEqual(received, [['hostname', 'test']]);
    });

    void test('does nothing for a name nobody listens to', () => {
      assert.doesNotThrow(() => { new EventBus('test').publishUntyped('nobody.listens', 1); });
    });
  });

  void describe('forward', () => {
    void test('passes the named events on, with their arguments', () => {
      const source = new EventBus('test');
      const target = new GameEventBus<ClientGameEventMap>('target');
      const received: unknown[][] = [];

      target.subscribe('client.center-print', (message) => { received.push([message]); });
      source.forward(['client.center-print'], target);
      source.publish('client.center-print', 'Welcome');

      assert.deepEqual(received, [['Welcome']]);
    });

    void test('leaves out events that were not named', () => {
      const source = new EventBus('test');
      const target = new GameEventBus<ClientGameEventMap>('target');
      const received: string[] = [];

      target.subscribe('client.paused', () => { received.push('paused'); });
      source.forward(['client.unpaused'], target);
      source.publish('client.paused');

      assert.deepEqual(received, []);
    });

    void test('stops when the returned function is called', () => {
      const source = new EventBus('test');
      const target = new GameEventBus<ClientGameEventMap>('target');
      let calls = 0;

      target.subscribe('client.paused', () => { calls += 1; });
      const stop = source.forward(['client.paused'], target);
      source.publish('client.paused');
      stop();
      source.publish('client.paused');

      assert.equal(calls, 1);
    });

    void test('carries every event a client game is given', () => {
      const source = new EventBus('test');
      const target = new GameEventBus<ClientGameEventMap>('target');
      const seen: string[] = [];

      for (const name of clientGameEventNames) {
        target.subscribe(name, () => { seen.push(name); });
      }

      source.forward(clientGameEventNames, target);

      for (const name of clientGameEventNames) {
        source.publishUntyped(name);
      }

      assert.deepEqual(seen, [...clientGameEventNames]);
    });
  });
});

void describe('GameEventBus', () => {
  void test('takes the events a game publishes itself, with the arguments the game gives them', () => {
    const bus = new GameEventBus<ClientGameEventMap>('client-game');
    const received: unknown[][] = [];

    bus.subscribe('game.phase.changed', (phase: string, previous: string) => { received.push([phase, previous]); });
    bus.publish('game.phase.changed', 'quiet', 'normal');

    assert.deepEqual(received, [['quiet', 'normal']]);
  });

  void test('checks the engine events it was given like the engine bus does', () => {
    const bus = new GameEventBus<ServerGameEventMap>('server-game');

    // @ts-expect-error `cvar.changed` carries the cvar's name
    bus.subscribe('cvar.changed', (name: number) => { assert.equal(typeof name, 'number'); });
    // @ts-expect-error a game does not make up the arguments of an engine event
    bus.publish('cvar.changed', 1);
  });

  void test('refuses an engine event it was not given', () => {
    const bus = new GameEventBus<ServerGameEventMap>('server-game');

    // @ts-expect-error `client.center-print` is not an event of the server game
    bus.subscribe('client.center-print', () => {});
    // @ts-expect-error the server game is not given the renderer's events
    bus.publish('gl.ready', {});
  });

  void test('gives the server game the per-name cvar events', () => {
    const bus = new GameEventBus<ServerGameEventMap>('server-game');
    const seen: string[] = [];

    bus.subscribe('cvar.changed.sv_nextmap', (cvar) => { seen.push(cvar.name); });
    bus.publishUntyped('cvar.changed.sv_nextmap', { name: 'sv_nextmap' });

    assert.deepEqual(seen, ['sv_nextmap']);
  });
});
