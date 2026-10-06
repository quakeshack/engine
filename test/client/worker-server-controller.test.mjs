import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import WorkerServerController from '../../source/engine/client/WorkerServerController.ts';
import { HostError } from '../../source/engine/common/Errors.ts';
import { ControlLink } from '../../source/engine/common/ServerWorkerProtocol.ts';

const INIT = Object.freeze({
  searchpaths: [], gamedir: null, game: 'id1', urls: {}, engineVersion: 'test', edition: { registered: true, hipnotic: false, rogue: false }, argv: [], buildConfig: undefined,
});

/**
 * Builds a controller whose worker is a stand-in that records what it was sent and lets the test
 * answer through a control link on the far end of the channel.
 * @returns {object} the controller, the far end and what the controller reported
 */
function createController() {
  const channel = new MessageChannel();
  const booted = [];
  const prints = [];
  const published = [];
  const errors = [];
  const crashes = [];
  const received = [];
  const noclip = [];
  const sessionRequests = [];
  const worker = {
    shutdowns: 0,
    postMessage(message, transfer) { booted.push({ message, transfer }); },
    shutdown() { this.shutdowns++; return Promise.resolve(); },
  };
  const con = {
    Print: (text, color) => prints.push(color === undefined ? ['print', text] : ['print', text, [...color]]),
    PrintSuccess: (text) => prints.push(['success', text]),
    PrintWarning: (text) => prints.push(['warning', text]),
    PrintError: (text) => prints.push(['error', text]),
    DPrint: (text) => prints.push(['debug', text]),
  };

  const controller = new WorkerServerController({
    worker,
    channel: /** @type {any} */ (channel),
    createInit: () => INIT,
    con,
    operatorName: () => 'Ranger',
    onNoclipAnglehack: (enabled) => noclip.push(enabled),
    onSessionRequest: (request) => sessionRequests.push(request),
    publish: (name, ...args) => published.push([name, ...args]),
    onError: (message) => errors.push(message),
    onCrash: (error) => crashes.push(error),
  });

  const far = new ControlLink(/** @type {any} */ (channel.port2), (message) => received.push(message));

  return {
    controller, far, worker, booted, prints, published, errors, crashes, received, noclip, sessionRequests,
    close() { channel.port1.close(); channel.port2.close(); },
  };
}

/**
 * @returns {Promise<void>} settles after the messages that are in flight were delivered
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

void describe('WorkerServerController', () => {
  void describe('init', () => {
    void test('boots the worker with the port and the settings, moving the port', async () => {
      const setup = createController();

      void setup.controller.init();

      try {
        assert.equal(setup.booted.length, 1);
        assert.equal(setup.booted[0].message.event, 'server.worker.boot');
        assert.equal(setup.booted[0].message.init, INIT);
        assert.deepEqual(setup.booted[0].transfer, [setup.booted[0].message.port]);
      } finally {
        setup.close();
      }
    });

    void test('settles when the worker says it is ready', async () => {
      const setup = createController();
      let ready = false;

      void setup.controller.init().then(() => { ready = true; });
      await flush();
      assert.equal(ready, false);

      setup.far.send({ kind: 'ready', cvars: [], commands: [] });
      await flush();

      try {
        assert.equal(ready, true);
      } finally {
        setup.close();
      }
    });

    void test('boots only once', () => {
      const setup = createController();

      const first = setup.controller.init();
      const second = setup.controller.init();

      try {
        assert.equal(first, second);
        assert.equal(setup.booted.length, 1);
      } finally {
        setup.close();
      }
    });

    void test('fails when the worker crashes while booting', async () => {
      const setup = createController();
      const booting = setup.controller.init();

      setup.far.send({ kind: 'crash', name: 'Error', message: 'no game' });

      try {
        await assert.rejects(booting, /Error: no game/);
        assert.equal(setup.crashes.length, 1);
      } finally {
        setup.close();
      }
    });
  });

  void describe('state', () => {
    void test('starts out as no server', () => {
      const setup = createController();

      try {
        assert.deepEqual({ ...setup.controller.state }, { active: false, maxclients: 0, mapname: null, paused: false });
      } finally {
        setup.close();
      }
    });

    void test('follows what the worker reports', async () => {
      const setup = createController();

      setup.far.send({ kind: 'state', state: { active: true, maxclients: 4, mapname: 'e1m1', paused: true } });
      await flush();

      try {
        assert.equal(setup.controller.state.active, true);
        assert.equal(setup.controller.state.maxclients, 4);
        assert.equal(setup.controller.state.mapname, 'e1m1');
        assert.equal(setup.controller.state.paused, true);
      } finally {
        setup.close();
      }
    });
  });

  void describe('requests', () => {
    void test('start asks the worker and returns what it answers', async () => {
      const setup = createController();
      const started = setup.controller.start('e1m1');

      await flush();
      assert.deepEqual(setup.received, [{ kind: 'request', id: 1, request: { kind: 'start', mapname: 'e1m1' } }]);

      setup.far.send({ kind: 'response', id: 1, ok: true, result: true });

      try {
        assert.equal(await started, true);
      } finally {
        setup.close();
      }
    });

    void test('answers each request with its own response', async () => {
      const setup = createController();
      const first = setup.controller.start('a');
      const second = setup.controller.changelevel('b');

      await flush();
      setup.far.send({ kind: 'response', id: 2, ok: true, result: false });
      setup.far.send({ kind: 'response', id: 1, ok: true, result: true });

      try {
        assert.equal(await first, true);
        assert.equal(await second, false);
      } finally {
        setup.close();
      }
    });

    void test('a failed request becomes a host error', async () => {
      const setup = createController();
      const started = setup.controller.start('nowhere');

      await flush();
      setup.far.send({ kind: 'response', id: 1, ok: false, error: 'no such map' });

      try {
        await assert.rejects(started, (error) => error instanceof HostError && error.message === 'no such map');
      } finally {
        setup.close();
      }
    });

    void test('announcing a level change does not wait for an answer', async () => {
      const setup = createController();

      setup.controller.announceChangelevel('e1m2');
      await flush();

      try {
        assert.deepEqual(setup.received.map((message) => message.request.kind), ['announce-changelevel']);
      } finally {
        setup.close();
      }
    });

    void test('stop shows no server right away and asks the worker to shut down', async () => {
      const setup = createController();

      setup.far.send({ kind: 'state', state: { active: true, maxclients: 1, mapname: 'e1m1', paused: false } });
      await flush();

      setup.controller.stop(true);

      try {
        assert.equal(setup.controller.state.active, false);
        assert.equal(setup.controller.state.mapname, null);

        await flush();
        assert.deepEqual(setup.received.at(-1).request, { kind: 'stop', crash: true });
      } finally {
        setup.close();
      }
    });

    void test('stop does nothing without a running server', async () => {
      const setup = createController();

      setup.controller.stop();
      await flush();

      try {
        assert.deepEqual(setup.received, []);
      } finally {
        setup.close();
      }
    });
  });

  void describe('simulation gate', () => {
    void test('is only sent when it changes', async () => {
      const setup = createController();

      setup.controller.setSimulationAllowed(true);
      setup.controller.setSimulationAllowed(true);
      setup.controller.setSimulationAllowed(false);
      setup.controller.setSimulationAllowed(false);
      await flush();

      try {
        assert.deepEqual(setup.received, [
          { kind: 'simulation-allowed', allowed: true },
          { kind: 'simulation-allowed', allowed: false },
        ]);
      } finally {
        setup.close();
      }
    });

    void test('a local frame has nothing to do for a server in a worker', async () => {
      const setup = createController();

      setup.controller.runLocalFrame(0.016, 12.3);
      await flush();

      try {
        assert.deepEqual(setup.received, []);
      } finally {
        setup.close();
      }
    });
  });

  void describe('what the worker reports', () => {
    void test('prints go to the console with their level', async () => {
      const setup = createController();

      for (const level of ['print', 'success', 'warning', 'error', 'debug']) {
        setup.far.send({ kind: 'print', level, text: `${level}\n` });
      }

      await flush();

      try {
        assert.deepEqual(setup.prints, [
          ['print', 'print\n'], ['success', 'success\n'], ['warning', 'warning\n'], ['error', 'error\n'], ['debug', 'debug\n'],
        ]);
      } finally {
        setup.close();
      }
    });

    void test('engine events are published with their arguments', async () => {
      const setup = createController();

      setup.far.send({ kind: 'event', name: 'server.spawned', args: [{ mapname: 'e1m1' }] });
      await flush();

      try {
        assert.deepEqual(setup.published, [['server.spawned', { mapname: 'e1m1' }]]);
      } finally {
        setup.close();
      }
    });

    void test('a recovered error is shown to the player', async () => {
      const setup = createController();

      setup.far.send({ kind: 'error', message: 'bad entity' });
      await flush();

      try {
        assert.deepEqual(setup.errors, ['bad entity']);
        assert.deepEqual(setup.crashes, []);
      } finally {
        setup.close();
      }
    });

    void test('a crash keeps the trace of the worker, that is the one that helps', async () => {
      const setup = createController();

      setup.far.send({ kind: 'crash', name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at serverFrame (worker.js:1:1)' });
      await flush();

      try {
        assert.match(setup.crashes[0].stack, /in the server worker:\nTypeError: boom\n {4}at serverFrame/);
      } finally {
        setup.close();
      }
    });

    void test('a crash is reported, the server is gone and waiting requests fail', async () => {
      const setup = createController();

      setup.far.send({ kind: 'state', state: { active: true, maxclients: 1, mapname: 'e1m1', paused: false } });
      await flush();

      const waiting = setup.controller.changelevel('e1m2');

      await flush();
      setup.far.send({ kind: 'crash', name: 'TypeError', message: 'boom' });

      try {
        await assert.rejects(waiting, /TypeError: boom/);
        assert.equal(setup.controller.state.active, false);
        assert.equal(setup.crashes[0].message, 'TypeError: boom');
        await assert.rejects(setup.controller.start('e1m1'), /not running/);
      } finally {
        setup.close();
      }
    });
  });

  void describe('dispose', () => {
    void test('ends the worker and fails what still waits', async () => {
      const setup = createController();
      const waiting = setup.controller.start('e1m1');

      await setup.controller.dispose('going away');

      try {
        await assert.rejects(waiting, /going away/);
        assert.equal(setup.worker.shutdowns, 1);
      } finally {
        setup.close();
      }
    });
  });

  void describe('savegame and viewthing', () => {
    void test('asks the server for its half of a savegame', async () => {
      const setup = createController();
      const saving = setup.controller.saveState();

      await flush();
      assert.deepEqual(setup.received.at(-1), { kind: 'request', id: 1, request: { kind: 'save' } });

      setup.far.send({ kind: 'response', id: 1, ok: true, result: { ok: false, reason: 'dead' } });

      try {
        assert.deepEqual(await saving, { ok: false, reason: 'dead' });
      } finally {
        setup.close();
      }
    });

    void test('hands the server its half of a savegame and where it came from', async () => {
      const setup = createController();
      const restoring = setup.controller.restoreState(/** @type {any} */ ({ mapname: 'e1m1' }), 'quick.json');

      await flush();
      assert.deepEqual(setup.received.at(-1).request, { kind: 'restore', state: { mapname: 'e1m1' }, source: 'quick.json' });

      setup.far.send({ kind: 'response', id: 1, ok: true, result: true });

      try {
        await restoring;
      } finally {
        setup.close();
      }
    });

    void test('a savegame the server cannot take is a host error', async () => {
      const setup = createController();
      const restoring = setup.controller.restoreState(/** @type {any} */ ({}), 'quick.json');

      await flush();
      setup.far.send({ kind: 'response', id: 1, ok: false, error: 'Game is version 1, not 2' });

      try {
        await assert.rejects(restoring, (error) => error instanceof HostError);
      } finally {
        setup.close();
      }
    });

    void test('reads and sets the viewthing', async () => {
      const setup = createController();
      const reading = setup.controller.getViewthing();

      await flush();
      setup.far.send({ kind: 'response', id: 1, ok: true, result: { modelindex: 4, frame: 2 } });

      const setting = setup.controller.setViewthingFrame(3);

      await flush();
      setup.far.send({ kind: 'response', id: 2, ok: true, result: true });

      try {
        assert.deepEqual(await reading, { modelindex: 4, frame: 2 });
        await setting;
        assert.deepEqual(setup.received.at(-1).request, { kind: 'viewthing-frame', frame: 3 });
      } finally {
        setup.close();
      }
    });
  });

  void describe('what else the server tells the page', () => {
    void test('the view hack for flying through walls is handed on', async () => {
      const setup = createController();

      setup.far.send({ kind: 'noclip-anglehack', enabled: true });
      await flush();

      try {
        assert.deepEqual(setup.noclip, [true]);
      } finally {
        setup.close();
      }
    });

    void test('a level change or restart the game asked for is handed to the page', async () => {
      const setup = createController();

      setup.far.send({ kind: 'session-request', request: { kind: 'changelevel', mapname: 'e1m2' } });
      setup.far.send({ kind: 'session-request', request: { kind: 'restart' } });
      await flush();

      try {
        assert.deepEqual(setup.sessionRequests, [{ kind: 'changelevel', mapname: 'e1m2' }, { kind: 'restart' }]);
      } finally {
        setup.close();
      }
    });

    void test('a colored line keeps its color', async () => {
      const setup = createController();
      setup.far.send({ kind: 'print', level: 'print', text: 'red\n', color: [1, 0, 0] });
      await flush();

      try {
        assert.deepEqual(setup.prints, [['print', 'red\n', [1, 0, 0]]]);
      } finally {
        setup.close();
      }
    });
  });
});
