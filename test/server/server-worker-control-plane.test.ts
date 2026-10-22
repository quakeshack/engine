import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import WorkerServerController from '../../source/engine/client/WorkerServerController.ts';
import { ControlLink, type ControlFromServer, type ControlToServer } from '../../source/engine/common/ServerWorkerProtocol.ts';
import { ChannelDriver, MessagePortEndpoint, type ChannelEndpoint, type ChannelPortLike } from '../../source/engine/network/ChannelDriver.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import type { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import ServerWorkerRuntime, { type ServerWorkerHostControls } from '../../source/engine/server/ServerWorkerRuntime.ts';

const INIT = Object.freeze({
  searchpaths: [], gamedir: null, game: 'id1', urls: {}, engineVersion: 'test', edition: { registered: true, hipnotic: false, rogue: false }, argv: [], buildConfig: undefined,
});

/**
 * @param endpoint the end of the channel it uses
 * @returns a network layer that only talks through the channel
 */
function createNet(endpoint: ChannelEndpoint): NET {
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

/** What {@link createPair} builds: both ends of the channel and what happened on them. */
interface TestPair {
  controller: WorkerServerController;
  pageNet: NET;
  /** What the fake server did each frame. */
  frames: string[];
  /** Engine events the controller published. */
  published: unknown[][];
  /** What the server printed through the controller. */
  prints: string[];
  /** The state the fake server reports. */
  world: { active: boolean; maxclients: number; mapname: string | null; paused: boolean };
  host: ServerWorkerHostControls;
  /** The packets the fake server read from the player. */
  received: number[][];
  close(): void;
}

/**
 * Wires a controller on one end of a real message channel to a runtime on the other, the way the
 * browser wires the page to its server worker, with a fake server in the middle.
 * @returns both ends and what happened
 */
function createPair(): TestPair {
  const channel = new MessageChannel();
  const world: TestPair['world'] = { active: false, maxclients: 1, mapname: null, paused: false };
  const frames: string[] = [];
  const published: unknown[][] = [];
  const prints: string[] = [];
  const received: number[][] = [];
  let runtime: ServerWorkerRuntime | null = null;
  let workerNet: NET | null = null;
  let workerSocket: QSocket | null = null;

  const host: ServerWorkerHostControls = {
    simulationAllowed: false,
    StartMap(mapname: string) {
      world.active = true;
      world.mapname = mapname;
      send({ kind: 'event', name: 'server.spawned', args: [{ mapname }] });
      return Promise.resolve(true);
    },
    AnnounceChangelevel() {},
    Changelevel(mapname: string) {
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
    postMessage(boot: unknown) {
      const message = boot as { event: string; port: ChannelPortLike };

      assert.equal(message.event, 'server.worker.boot');

      const port = message.port;
      const link = new ControlLink<ControlFromServer, ControlToServer>(port, (control) => { runtime!.handle(control); });

      send = (control) => { link.send(control); };

      const portEndpoint = new MessagePortEndpoint(port);

      // Anything that arrives is a reason for a server frame, like in createServerWorker.
      workerNet = createNet({
        post: (m, t) => { portEndpoint.post(m, t); },
        setReceiver: (receiver) => {
          portEndpoint.setReceiver((m) => {
            receiver(m);
            runtime!.requestFrame();
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
          const accepted = workerNet!.CheckNewConnections();

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
          while (workerNet!.GetMessage(workerSocket) > 0) {
            received.push([...new Uint8Array(workerNet!.message.data, 0, workerNet!.message.cursize)]);

            const answer = new SzBuffer(16, 'answer');

            answer.writeByte(7);
            workerNet!.SendUnreliableMessage(workerSocket, answer);
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

  let send: (control: ControlFromServer) => void = () => {};

  const controller = new WorkerServerController({
    worker,
    // Node's channel and the DOM's differ in types only.
    channel: channel as unknown as { port1: MessagePort; port2: MessagePort },
    createInit: () => INIT,
    con: { Print: (t: string) => prints.push(t), PrintSuccess() {}, PrintWarning() {}, PrintError() {}, DPrint() {} },
    operatorName: () => 'Ranger',
    onNoclipAnglehack() {},
    publish: (name: string, ...args: unknown[]) => published.push([name, ...args]),
    onSessionRequest() {},
    onError() {},
    onCrash() {},
  });

  // The page's network layer talks to the same port as the controller does.
  const pageNet = createNet(new MessagePortEndpoint(channel.port1 as unknown as ChannelPortLike));

  return {
    controller, pageNet, frames, published, prints, world, host, received,
    close() { runtime?.stop(); channel.port1.close(); channel.port2.close(); },
  };
}

/**
 * @param condition what to wait for
 * @returns settles once the condition holds
 */
async function until(condition: () => boolean): Promise<void> {
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
