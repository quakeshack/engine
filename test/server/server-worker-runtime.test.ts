import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HostError } from '../../source/engine/common/Errors.ts';
import type { ControlFromServer, ServerRequest } from '../../source/engine/common/ServerWorkerProtocol.ts';
import type { ServerSaveResult, ServerSaveState } from '../../source/engine/common/ServerController.ts';
import ServerWorkerRuntime, { type ServerWorkerHostControls } from '../../source/engine/server/ServerWorkerRuntime.ts';

/** A message of the runtime's, by its kind. */
type SentOfKind<K extends ControlFromServer['kind']> = Extract<ControlFromServer, { kind: K }>;

/**
 * Finds what the runtime sent of one kind.
 * @param sent Everything the runtime sent.
 * @param kind The kind to look for.
 * @returns The first message of that kind, narrowed to its shape.
 */
function firstOfKind<K extends ControlFromServer['kind']>(sent: ControlFromServer[], kind: K): SentOfKind<K> {
  const found = sent.find((message): message is SentOfKind<K> => message.kind === kind);

  assert.ok(found, `the runtime sent no ${kind}`);

  return found;
}

/**
 * Filters what the runtime sent by kind.
 * @param sent Everything the runtime sent.
 * @param kind The kind to keep.
 * @returns The messages of that kind, narrowed to their shape.
 */
function allOfKind<K extends ControlFromServer['kind']>(sent: ControlFromServer[], kind: K): Array<SentOfKind<K>> {
  return sent.filter((message): message is SentOfKind<K> => message.kind === kind);
}

/**
 * Builds a runtime around stand-ins and records everything it does.
 * @param [options] what to replace
 * @returns the runtime and what it recorded
 */
function createRuntime({ frame = () => Promise.resolve(), startMap = () => Promise.resolve(true), interval = 0 }: { frame?: () => Promise<void>; startMap?: (mapname: string) => Promise<boolean>; interval?: number } = {}): { runtime: ServerWorkerRuntime; sent: ControlFromServer[]; calls: string[]; world: { active: boolean; maxclients: number; mapname: string | null; paused: boolean }; host: ServerWorkerHostControls } {
  const sent: ControlFromServer[] = [];
  const calls: string[] = [];
  const world: { active: boolean; maxclients: number; mapname: string | null; paused: boolean } = { active: false, maxclients: 1, mapname: null, paused: false };

  const host: ServerWorkerHostControls = {
    simulationAllowed: false,
    async StartMap(mapname: string) {
      calls.push(`start ${mapname}`);
      const result = await startMap(mapname);
      world.active = result;
      world.mapname = result ? mapname : null;
      return result;
    },
    AnnounceChangelevel(mapname: string) { calls.push(`announce ${mapname}`); },
    Changelevel(mapname: string) {
      calls.push(`changelevel ${mapname}`);
      world.mapname = mapname;
      return Promise.resolve(true);
    },
    ShutdownServer(crash = false) {
      calls.push(`shutdown ${crash}`);
      world.active = false;
      world.mapname = null;
    },
    getViewthing: () => ({ modelindex: 3, frame: 1 }),
    setViewthingFrame(frame: number) { calls.push(`viewframe ${frame}`); },
  };
  const console = {
    describe: () => ({ cvars: [{ name: 'sv_gravity', value: '800', flags: 4, description: null }], commands: ['status'] }),
    setCvar(name: string, value: string) { calls.push(`cvar ${name} ${value}`); },
    execute(text: string, operator: string) { calls.push(`command ${text} as ${operator}`); },
  };
  const savegame = {
    capture: (): ServerSaveResult => ({ ok: false, reason: 'no' }),
    restore: (state: ServerSaveState, source: string) => { calls.push(`restore ${state.mapname} from ${source}`); return Promise.resolve(); },
  };

  const runtime = new ServerWorkerRuntime({
    send: (message) => sent.push(message),
    readState: () => ({ ...world }),
    host,
    console,
    savegame,
    frame: async () => {
      calls.push('frame');
      await frame();
    },
    fallbackInterval: () => interval,
    isServerActive: () => world.active,
  });

  return { runtime, sent, calls, world, host };
}

/**
 * @param runtime the runtime to feed
 * @param id request id
 * @param request the request
 */
function request(runtime: ServerWorkerRuntime, id: number, request: ServerRequest) {
  runtime.handle({ kind: 'request', id, request });
}

/**
 * Waits until all work that is already queued has run.
 * @returns settles after a turn of the event loop
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

void describe('ServerWorkerRuntime', () => {
  void describe('start', () => {
    void test('publishes the state and says it is ready', () => {
      const { runtime, sent } = createRuntime();

      runtime.start();
      runtime.stop();

      assert.deepEqual(sent.map((message) => message.kind), ['state', 'ready']);
      const ready = firstOfKind(sent, 'ready');

      assert.deepEqual(ready.commands, ['status']);
      assert.equal(ready.cvars[0].name, 'sv_gravity');
    });
  });

  void describe('requests', () => {
    void test('starting a map answers true once the map runs and publishes the state first', async () => {
      const { runtime, sent } = createRuntime();

      request(runtime, 1, { kind: 'start', mapname: 'start' });
      await settle();

      const kinds = sent.map((message) => message.kind);

      assert.deepEqual(kinds, ['state', 'response']);
      assert.deepEqual(firstOfKind(sent, 'state').state, { active: true, maxclients: 1, mapname: 'start', paused: false });
      assert.deepEqual(sent[1], { kind: 'response', id: 1, ok: true, result: true });
    });

    void test('a map that cannot be spawned answers false', async () => {
      const { runtime, sent } = createRuntime({ startMap: () => Promise.resolve(false) });

      request(runtime, 7, { kind: 'start', mapname: 'nowhere' });
      await settle();

      assert.deepEqual(firstOfKind(sent, 'response'), { kind: 'response', id: 7, ok: true, result: false });
    });

    void test('runs requests one after the other, in the order they were made', async () => {
      const order: string[] = [];
      const { runtime, calls } = createRuntime({
        startMap: async (mapname: string) => {
          order.push(`begin ${mapname}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`end ${mapname}`);
          return true;
        },
      });

      request(runtime, 1, { kind: 'start', mapname: 'a' });
      request(runtime, 2, { kind: 'start', mapname: 'b' });
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.deepEqual(order, ['begin a', 'end a', 'begin b', 'end b']);
      assert.deepEqual(calls.filter((call) => call.startsWith('start')), ['start a', 'start b']);
    });

    void test('announces and performs a level change', async () => {
      const { runtime, sent, calls } = createRuntime();

      request(runtime, 1, { kind: 'announce-changelevel', mapname: 'e1m2' });
      request(runtime, 2, { kind: 'changelevel', mapname: 'e1m2' });
      await settle();

      assert.deepEqual(calls.filter((call) => !call.startsWith('frame')), ['announce e1m2', 'changelevel e1m2']);
      assert.deepEqual(allOfKind(sent, 'response').map((message) => message.id), [1, 2]);
    });

    void test('stops the server and passes on whether it was a crash', async () => {
      const { runtime, calls } = createRuntime();

      request(runtime, 1, { kind: 'stop', crash: true });
      await settle();

      assert.ok(calls.includes('shutdown true'));
    });

    void test('answers a host error with the error, and keeps running', async () => {
      const { runtime, sent } = createRuntime({
        startMap: () => Promise.reject(new HostError('no such map')),
      });

      request(runtime, 3, { kind: 'start', mapname: 'nowhere' });
      await settle();

      assert.deepEqual(firstOfKind(sent, 'response'), { kind: 'response', id: 3, ok: false, error: 'no such map' });
      assert.equal(sent.some((message) => message.kind === 'crash'), false);
    });

    void test('crashes on any other error', async () => {
      const { runtime, sent } = createRuntime({
        startMap: () => Promise.reject(new TypeError('boom')),
      });

      request(runtime, 3, { kind: 'start', mapname: 'x' });
      await settle();

      const crash = firstOfKind(sent, 'crash');

      assert.deepEqual([crash.name, crash.message], ['TypeError', 'boom']);
      assert.match(crash.stack!, /TypeError: boom/);
    });

    void test('ignores everything after it stopped', async () => {
      const { runtime, sent } = createRuntime();

      runtime.stop();
      request(runtime, 1, { kind: 'start', mapname: 'a' });
      await settle();

      assert.deepEqual(sent, []);
    });
  });

  void describe('simulation gate', () => {
    void test('is handed to the server host', () => {
      const { runtime, host } = createRuntime();

      runtime.handle({ kind: 'simulation-allowed', allowed: true });

      assert.equal(host.simulationAllowed, true);
    });
  });

  void describe('frames', () => {
    void test('runs a frame when asked and publishes a changed state afterwards', async () => {
      const { runtime, sent, world } = createRuntime({ frame: () => { world.paused = true; return Promise.resolve(); } });

      runtime.requestFrame();
      await settle();

      assert.deepEqual(sent.map((message) => message.kind), ['state']);
      assert.equal(firstOfKind(sent, 'state').state.paused, true);
    });

    void test('does not repeat a state that did not change', async () => {
      const { runtime, sent } = createRuntime();

      runtime.requestFrame();
      await settle();
      sent.length = 0;
      runtime.requestFrame();
      await settle();

      assert.equal(sent.length, 0);
    });

    void test('folds requests that arrive during a frame into one more frame', async () => {
      let release = () => {};
      const { runtime, calls } = createRuntime({
        frame: () => new Promise<void>((resolve) => { release = resolve; }),
      });

      runtime.requestFrame();
      runtime.requestFrame();
      runtime.requestFrame();
      release();
      await settle();
      release();
      await settle();

      assert.equal(calls.filter((call) => call === 'frame').length, 2);
    });

    void test('holds frames back while a request is in progress, and runs one afterwards', async () => {
      let finish = () => {};
      const { runtime, calls } = createRuntime({
        startMap: () => new Promise<boolean>((resolve) => { finish = () => { resolve(true); }; }),
      });

      request(runtime, 1, { kind: 'start', mapname: 'a' });
      await settle();
      runtime.requestFrame();
      await settle();

      assert.equal(calls.includes('frame'), false);

      finish();
      await settle();

      assert.equal(calls.filter((call) => call === 'frame').length, 1);
    });

    void test('a host error in a frame shuts the server down and tells the player', async () => {
      const { runtime, sent, calls } = createRuntime({
        frame: () => Promise.reject(new HostError('bad entity')),
      });

      runtime.requestFrame();
      await settle();

      assert.ok(calls.includes('shutdown false'));
      assert.deepEqual(sent.at(-1), { kind: 'error', message: 'bad entity' });
    });

    void test('any other error in a frame is a crash and ends the runtime', async () => {
      const { runtime, sent, calls } = createRuntime({
        frame: () => Promise.reject(new RangeError('out of range')),
      });

      runtime.requestFrame();
      await settle();
      runtime.requestFrame();
      await settle();

      const crash = firstOfKind(sent, 'crash');

      assert.deepEqual([crash.name, crash.message], ['RangeError', 'out of range']);
      assert.equal(calls.filter((call) => call === 'frame').length, 1);
    });

    void test('an outside failure crashes the runtime', () => {
      const { runtime, sent } = createRuntime();

      runtime.fail(new Error('helper died'));

      assert.equal(sent.length, 1);
      const crash = firstOfKind(sent, 'crash');

      assert.deepEqual([crash.kind, crash.name, crash.message], ['crash', 'Error', 'helper died']);
    });
  });

  void describe('fallback timer', () => {
    void test('keeps an active server running when nothing arrives', async () => {
      const { runtime, world, calls } = createRuntime({ interval: 0.02 });

      world.active = true;
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      runtime.stop();

      assert.ok(calls.filter((call) => call === 'frame').length >= 2);
    });

    void test('leaves an idle server alone', async () => {
      const { runtime, calls } = createRuntime({ interval: 0.02 });

      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      runtime.stop();

      assert.equal(calls.includes('frame'), false);
    });

    void test('is off when the interval is zero', async () => {
      const { runtime, world, calls } = createRuntime({ interval: 0 });

      world.active = true;
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      runtime.stop();

      assert.equal(calls.includes('frame'), false);
    });
  });

  void describe('console', () => {
    void test('applies a cvar the page set', () => {
      const { runtime, calls } = createRuntime();

      runtime.handle({ kind: 'cvar-set', name: 'sv_gravity', value: '400' });

      assert.ok(calls.includes('cvar sv_gravity 400'));
    });

    void test('runs a line the player typed and gives the server a frame for it', async () => {
      const { runtime, calls } = createRuntime();

      runtime.handle({ kind: 'command', text: 'maxplayers 4', operator: 'Ranger' });
      await settle();

      assert.ok(calls.includes('command maxplayers 4 as Ranger'));
      assert.ok(calls.includes('frame'));
    });
  });

  void describe('savegame and viewthing requests', () => {
    void test('answers a save with what the savegame collected', async () => {
      const { runtime, sent } = createRuntime();

      request(runtime, 1, { kind: 'save' });
      await settle();

      assert.deepEqual(firstOfKind(sent, 'response'), { kind: 'response', id: 1, ok: true, result: { ok: false, reason: 'no' } });
    });

    void test('restores a savegame and names where it came from', async () => {
      const { runtime, calls } = createRuntime();

      // Only the map name of the state is looked at by the stand-in savegame.
      request(runtime, 1, { kind: 'restore', state: { mapname: 'e1m1' } as unknown as ServerSaveState, source: 'quick.json' });
      await settle();

      assert.ok(calls.includes('restore e1m1 from quick.json'));
    });

    void test('reads and sets the frame of the viewthing', async () => {
      const { runtime, sent, calls } = createRuntime();

      request(runtime, 1, { kind: 'viewthing' });
      request(runtime, 2, { kind: 'viewthing-frame', frame: 4 });
      await settle();

      assert.deepEqual(allOfKind(sent, 'response').map((message) => (message as SentOfKind<'response'> & { ok: true }).result), [{ modelindex: 3, frame: 1 }, true]);
      assert.ok(calls.includes('viewframe 4'));
    });
  });
});
