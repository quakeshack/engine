import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import WorkerServerController from '../../source/engine/client/WorkerServerController.ts';
import { ControlLink } from '../../source/engine/common/ServerWorkerProtocol.ts';
import { ChannelDriver, MessagePortEndpoint } from '../../source/engine/network/ChannelDriver.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import ServerWorkerRuntime from '../../source/engine/server/ServerWorkerRuntime.ts';

const INIT = Object.freeze({
  searchpaths: [], gamedir: null, game: 'id1', urls: {}, engineVersion: 'test', edition: { registered: true, hipnotic: false, rogue: false }, argv: [], buildConfig: undefined,
});

/**
 * @param {import('../../source/engine/network/ChannelDriver.ts').ChannelEndpoint} endpoint the end of the channel it uses
 * @returns {NET} a network layer that only talks through the channel
 */
function createNet(endpoint) {
  const net = new NET({
    con: { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {}, PrintSuccess() {} },
    sys: { Print() {}, FloatTime: () => 1 },
    dedicated: false,
    urls: () => undefined,
    serverInfo: () => ({ maxPlayers: 1, mapname: 'start', game: 'id1' }),
    webSocketModule: () => undefined,
    createDrivers: (owner) => [['channel', new ChannelDriver(owner, endpoint)]],
  });

  net.Init();
  net.message = new SzBuffer(64, 'test net message');

  return net;
}

/**
 * Wires a controller on one end of a real message channel to a runtime on the other, the way the
 * browser wires the page to its server worker, with a fake server in the middle.
 * @returns {object} both ends and what happened
 */
function createPair() {
  const channel = new MessageChannel();
  const world = { active: false, maxclients: 1, mapname: null, paused: false };
  const frames = [];
  const published = [];
  const prints = [];
  const received = [];
  let runtime = null;
  let workerNet = null;
  let workerSocket = null;

  const host = {
    simulationAllowed: false,
    StartMap(mapname) {
      world.active = true;
      world.mapname = mapname;
      send({ kind: 'event', name: 'server.spawned', args: [{ mapname }] });
      return Promise.resolve(true);
    },
    AnnounceChangelevel() {},
    Changelevel(mapname) {
      world.mapname = mapname;
      return Promise.resolve(true);
    },
    ShutdownServer() {
      world.active = false;
      world.mapname = null;
    },
    getViewthing: () => null,
    setViewthingFrame() {},
  };

  /** The far end boots when the page hands it the port, like the worker entry does. */
  const worker = {
    postMessage(message) {
      assert.equal(message.event, 'server.worker.boot');

      const port = message.port;
      const link = new ControlLink(/** @type {any} */ (port), (control) => runtime.handle(control));

      send = (control) => { link.send(control); };

      const portEndpoint = new MessagePortEndpoint(/** @type {any} */ (port));

      // Anything that arrives is a reason for a server frame, like in createServerWorker.
      workerNet = createNet({
        post: (m, t) => { portEndpoint.post(m, t); },
        setReceiver: (receiver) => {
          portEndpoint.setReceiver((m) => {
            receiver(m);
            runtime.requestFrame();
          });
        },
      });

      runtime = new ServerWorkerRuntime({
        send,
        readState: () => ({ ...world }),
        host,
        console: { describe: () => ({ cvars: [], commands: [] }), setCvar() {}, execute() {} },
        savegame: { capture: () => ({ ok: false, reason: 'x' }), restore: () => Promise.resolve() },
        frame: () => {
          const accepted = workerNet.CheckNewConnections();

          if (accepted !== null) {
            workerSocket = accepted;
            frames.push('new connection');
            return Promise.resolve();
          }

          frames.push('frame');

          if (workerSocket === null) {
            return Promise.resolve();
          }

          // Read what the player sent and answer it, like the server does every frame.
          while (workerNet.GetMessage(workerSocket) > 0) {
            received.push([...new Uint8Array(workerNet.message.data, 0, workerNet.message.cursize)]);

            const answer = new SzBuffer(16, 'answer');

            answer.writeByte(7);
            workerNet.SendUnreliableMessage(workerSocket, answer);
          }

          return Promise.resolve();
        },
        fallbackInterval: () => 0,
        isServerActive: () => world.active,
      });
      runtime.start();
    },
    shutdown() { runtime?.stop(); return Promise.resolve(); },
  };

  let send = () => {};

  const controller = new WorkerServerController({
    worker,
    channel: /** @type {any} */ (channel),
    createInit: () => INIT,
    con: { Print: (t) => prints.push(t), PrintSuccess() {}, PrintWarning() {}, PrintError() {}, DPrint() {} },
    operatorName: () => 'Ranger',
    onNoclipAnglehack() {},
    publish: (name, ...args) => published.push([name, ...args]),
    onError() {},
    onCrash() {},
  });

  // The page's network layer talks to the same port as the controller does.
  const pageNet = createNet(new MessagePortEndpoint(/** @type {any} */ (channel.port1)));

  return {
    controller, pageNet, frames, published, prints, world, host, received,
    close() { runtime?.stop(); channel.port1.close(); channel.port2.close(); },
  };
}

/**
 * @param {() => boolean} condition what to wait for
 * @returns {Promise<void>} settles once the condition holds
 */
async function until(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(condition(), 'condition was not met in time');
}

void describe('server worker control plane', () => {
  void test('boots, starts a map and mirrors the state back', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();
      assert.equal(pair.controller.state.active, false);

      const started = await pair.controller.start('e1m1');

      assert.equal(started, true);
      // The state arrives before the answer, so the caller can rely on it right after awaiting.
      assert.equal(pair.controller.state.active, true);
      assert.equal(pair.controller.state.mapname, 'e1m1');
    } finally {
      pair.close();
    }
  });

  void test('forwards engine events of the server', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();
      await pair.controller.start('e1m1');
      await until(() => pair.published.length > 0);

      assert.deepEqual(pair.published, [['server.spawned', { mapname: 'e1m1' }]]);
    } finally {
      pair.close();
    }
  });

  void test('changes level and stops', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();
      await pair.controller.start('e1m1');

      assert.equal(await pair.controller.changelevel('e1m2'), true);
      assert.equal(pair.controller.state.mapname, 'e1m2');

      pair.controller.stop();
      await until(() => !pair.world.active);

      assert.equal(pair.controller.state.active, false);
    } finally {
      pair.close();
    }
  });

  void test('hands the simulation gate to the server', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();
      pair.controller.setSimulationAllowed(true);
      await until(() => pair.host.simulationAllowed);

      pair.controller.setSimulationAllowed(false);
      await until(() => !pair.host.simulationAllowed);
    } finally {
      pair.close();
    }
  });

  void test('a connection to the server shows up there and runs a server frame', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();

      assert.ok(pair.pageNet.Connect('local') !== null);
      await until(() => pair.frames.length > 0);

      assert.equal(pair.frames[0], 'new connection');
    } finally {
      pair.close();
    }
  });

  void test('a packet of the player runs a server frame and gets an answer', async () => {
    const pair = createPair();

    try {
      await pair.controller.init();

      const pageSocket = pair.pageNet.Connect('local');

      await until(() => pair.frames.length > 0);

      const packet = new SzBuffer(16, 'packet');

      packet.writeByte(42);
      pair.pageNet.SendUnreliableMessage(pageSocket, packet);
      await until(() => pair.received.length > 0);

      assert.deepEqual(pair.received, [[42]]);

      // Reading consumes the packet, so this must not be done by the condition that is checked twice.
      let type = 0;

      await until(() => {
        type ||= pair.pageNet.GetMessage(pageSocket);
        return type > 0;
      });

      assert.equal(type, 2);
      assert.deepEqual([...new Uint8Array(pair.pageNet.message.data, 0, pair.pageNet.message.cursize)], [7]);
    } finally {
      pair.close();
    }
  });
});
