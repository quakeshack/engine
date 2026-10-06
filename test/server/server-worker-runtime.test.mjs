import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HostError } from '../../source/engine/common/Errors.ts';
import ServerWorkerRuntime from '../../source/engine/server/ServerWorkerRuntime.ts';

/**
 * Builds a runtime around stand-ins and records everything it does.
 * @param {{ frame?: () => Promise<void>, startMap?: (mapname: string) => Promise<boolean>, interval?: number }} [options] what to replace
 * @returns {{ runtime: ServerWorkerRuntime, sent: object[], calls: string[], world: { active: boolean, maxclients: number, mapname: string | null, paused: boolean }, host: object }} the runtime and what it recorded
 */
function createRuntime({ frame = async () => {}, startMap = async () => true, interval = 0 } = {}) {
  const sent = [];
  const calls = [];
  const world = { active: false, maxclients: 1, mapname: null, paused: false };

  const host = {
    simulationAllowed: false,
    async StartMap(mapname) {
      calls.push(`start ${mapname}`);
      const result = await startMap(mapname);
      world.active = result;
      world.mapname = result ? mapname : null;
      return result;
    },
    AnnounceChangelevel(mapname) { calls.push(`announce ${mapname}`); },
    async Changelevel(mapname) {
      calls.push(`changelevel ${mapname}`);
      world.mapname = mapname;
      return true;
    },
    ShutdownServer(crash = false) {
      calls.push(`shutdown ${crash}`);
      world.active = false;
      world.mapname = null;
    },
    getViewthing: () => ({ modelindex: 3, frame: 1 }),
    setViewthingFrame(frame) { calls.push(`viewframe ${frame}`); },
  };
  const console = {
    describe: () => ({ cvars: [{ name: 'sv_gravity', value: '800', flags: 4, description: null }], commands: ['status'] }),
    setCvar(name, value) { calls.push(`cvar ${name} ${value}`); },
    execute(text, operator) { calls.push(`command ${text} as ${operator}`); },
  };
  const savegame = {
    capture: () => ({ ok: false, reason: 'no' }),
    restore: (state, source) => { calls.push(`restore ${state.mapname} from ${source}`); return Promise.resolve(); },
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
 * @param {ServerWorkerRuntime} runtime the runtime to feed
 * @param {number} id request id
 * @param {object} request the request
 */
function request(runtime, id, request) {
  runtime.handle({ kind: 'request', id, request });
}

/**
 * Waits until all work that is already queued has run.
 * @returns {Promise<void>} settles after a turn of the event loop
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

void describe('ServerWorkerRuntime', () => {
  void describe('start', () => {
    void test('publishes the state and says it is ready', () => {
      const { runtime, sent } = createRuntime();

      runtime.start();
      runtime.stop();

      assert.deepEqual(sent.map((message) => message.kind), ['state', 'ready']);
      assert.deepEqual(sent[1].commands, ['status']);
      assert.equal(sent[1].cvars[0].name, 'sv_gravity');
    });
  });

  void describe('requests', () => {
    void test('starting a map answers true once the map runs and publishes the state first', async () => {
      const { runtime, sent } = createRuntime();

      request(runtime, 1, { kind: 'start', mapname: 'start' });
      await settle();

      const kinds = sent.map((message) => message.kind);

      assert.deepEqual(kinds, ['state', 'response']);
      assert.deepEqual(sent[0].state, { active: true, maxclients: 1, mapname: 'start', paused: false });
      assert.deepEqual(sent[1], { kind: 'response', id: 1, ok: true, result: true });
    });

    void test('a map that cannot be spawned answers false', async () => {
      const { runtime, sent } = createRuntime({ startMap: async () => false });

      request(runtime, 7, { kind: 'start', mapname: 'nowhere' });
      await settle();

      assert.deepEqual(sent.find((message) => message.kind === 'response'), { kind: 'response', id: 7, ok: true, result: false });
    });

    void test('runs requests one after the other, in the order they were made', async () => {
      const order = [];
      const { runtime, calls } = createRuntime({
        startMap: async (mapname) => {
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
      assert.deepEqual(sent.filter((message) => message.kind === 'response').map((message) => message.id), [1, 2]);
    });

    void test('stops the server and passes on whether it was a crash', async () => {
      const { runtime, calls } = createRuntime();

      request(runtime, 1, { kind: 'stop', crash: true });
      await settle();

      assert.ok(calls.includes('shutdown true'));
    });

    void test('answers a host error with the error, and keeps running', async () => {
      const { runtime, sent } = createRuntime({
        startMap: async () => { throw new HostError('no such map'); },
      });

      request(runtime, 3, { kind: 'start', mapname: 'nowhere' });
      await settle();

      assert.deepEqual(sent.find((message) => message.kind === 'response'), { kind: 'response', id: 3, ok: false, error: 'no such map' });
      assert.equal(sent.some((message) => message.kind === 'crash'), false);
    });

    void test('crashes on any other error', async () => {
      const { runtime, sent } = createRuntime({
        startMap: async () => { throw new TypeError('boom'); },
      });

      request(runtime, 3, { kind: 'start', mapname: 'x' });
      await settle();

      const crash = sent.find((message) => message.kind === 'crash');

      assert.deepEqual([crash.name, crash.message], ['TypeError', 'boom']);
      assert.match(crash.stack, /TypeError: boom/);
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
      const { runtime, sent, world } = createRuntime({ frame: async () => { world.paused = true; } });

      runtime.requestFrame();
      await settle();

      assert.deepEqual(sent.map((message) => message.kind), ['state']);
      assert.equal(sent[0].state.paused, true);
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
        frame: () => new Promise((resolve) => { release = resolve; }),
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
        startMap: () => new Promise((resolve) => { finish = () => resolve(true); }),
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
        frame: async () => { throw new HostError('bad entity'); },
      });

      runtime.requestFrame();
      await settle();

      assert.ok(calls.includes('shutdown false'));
      assert.deepEqual(sent.at(-1), { kind: 'error', message: 'bad entity' });
    });

    void test('any other error in a frame is a crash and ends the runtime', async () => {
      const { runtime, sent, calls } = createRuntime({
        frame: async () => { throw new RangeError('out of range'); },
      });

      runtime.requestFrame();
      await settle();
      runtime.requestFrame();
      await settle();

      const crash = sent.find((message) => message.kind === 'crash');

      assert.deepEqual([crash.name, crash.message], ['RangeError', 'out of range']);
      assert.equal(calls.filter((call) => call === 'frame').length, 1);
    });

    void test('an outside failure crashes the runtime', () => {
      const { runtime, sent } = createRuntime();

      runtime.fail(new Error('helper died'));

      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0].kind, sent[0].name, sent[0].message], ['crash', 'Error', 'helper died']);
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

      assert.deepEqual(sent.find((message) => message.kind === 'response'), { kind: 'response', id: 1, ok: true, result: { ok: false, reason: 'no' } });
    });

    void test('restores a savegame and names where it came from', async () => {
      const { runtime, calls } = createRuntime();

      request(runtime, 1, { kind: 'restore', state: { mapname: 'e1m1' }, source: 'quick.json' });
      await settle();

      assert.ok(calls.includes('restore e1m1 from quick.json'));
    });

    void test('reads and sets the frame of the viewthing', async () => {
      const { runtime, sent, calls } = createRuntime();

      request(runtime, 1, { kind: 'viewthing' });
      request(runtime, 2, { kind: 'viewthing-frame', frame: 4 });
      await settle();

      assert.deepEqual(sent.filter((message) => message.kind === 'response').map((message) => message.result), [{ modelindex: 3, frame: 1 }, true]);
      assert.ok(calls.includes('viewframe 4'));
    });
  });
});
