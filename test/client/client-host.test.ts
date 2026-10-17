/* eslint-disable @typescript-eslint/unbound-method -- a test swaps Cmd.ExecuteString and puts the original back, never calling it detached */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import type { ConsoleCommand } from '../../source/engine/common/Cmd.ts';
import type { ServerClient } from '../../source/engine/server/Client.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import { clientStaticState } from '../../source/engine/client/ClientState.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { useRendererOf } from '../support/renderer.ts';
import { useMenuOf } from '../support/menu.ts';
import { useHostOf } from '../support/host.ts';
import { engineMocks } from '../support/engineMocks.ts';

/** What {@link createClientRuntime} is told about the client and the local server. */
interface ClientRuntimeOptions {
  /** Receives what the host does to the mock, in order. */
  calls: Array<[string, ...unknown[]]>;
  /** Receives the work scheduled for the next frame. */
  scheduled: Array<() => void | Promise<void>>;
  serverActive?: boolean;
  mapname?: string;
  startResult?: boolean;
  changelevelResult?: boolean;
  state?: number;
  demoplayback?: boolean;
}

/** The registry members {@link createClientRuntime} builds. */
interface ClientRuntimeMock {
  CL: Record<string, unknown>;
  Con: object;
  Host: Record<string, unknown>;
  Key: object;
  M: { AllowsSimulation: () => boolean };
  SCR: object;
  R: object;
  S: object;
}

/**
 * Builds a client runtime mock that records what the host does to it, in order.
 * @param options mock shape
 * @returns registry members to install
 */
function createClientRuntime({ calls, scheduled, serverActive = true, mapname = 'e1m1', startResult = true, changelevelResult = true, state = Def.clientConnectionState.connected, demoplayback = false }: ClientRuntimeOptions): ClientRuntimeMock {
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };

  const serverController = {
    state: { active: serverActive, mapname, maxclients: 1, paused: false },
    setSimulationAllowed: record('setSimulationAllowed'),
    runLocalFrame: record('runLocalFrame'),
    stop: record('stop'),
    announceChangelevel: record('announceChangelevel'),
    start(name: string) { calls.push(['start', name]); return Promise.resolve(startResult); },
    changelevel(name: string) { calls.push(['changelevel', name]); return Promise.resolve(changelevelResult); },
  };

  const CL = {
    cls: { state, signon: 4, demonum: 3, demoplayback, spawnparms: '', changelevel: false },
    state: { clientEntities: { emit: record('emit') } },
    serverController,
    CheckConnectingState: record('CheckConnectingState'),
    ReadFromServer: record('ReadFromServer'),
    ClientFrame: record('ClientFrame'),
    SendCmd: record('SendCmd'),
    SetUpPlayerPrediction: record('SetUpPlayerPrediction'),
    PredictMove: record('PredictMove'),
    Disconnect: record('Disconnect'),
    SetConnectingStep: record('SetConnectingStep'),
    Connect: record('Connect'),
  };

  return {
    CL,
    Con: { Print: record('Print'), DPrint() {}, PrintWarning() {} },
    Host: { speeds: null, ScheduleForNextFrame: (callback: () => void | Promise<void>) => { scheduled.push(callback); } },
    Key: { destination: KeyDestination.menu },
    M: { AllowsSimulation: () => true },
    SCR: { UpdateScreen: record('UpdateScreen'), BeginLoadingPlaque: record('BeginLoadingPlaque') },
    R: { refdef: { vieworg: [0, 0, 0] }, vpn: [0, 0, 0], vright: [0, 0, 0], vup: [0, 0, 0], viewleaf: null },
    S: { Update: record('S.Update') },
  };
}

/**
 * Installs registry members and restores them afterwards.
 * @param members registry members to install
 * @param callback test callback
 * @returns resolves once the callback and the cleanup are done
 */
async function withRegistryMembers(members: Partial<ClientRuntimeMock>, callback: () => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(members).map((name) => [name, engineMocks[name]]));

  Object.assign(engineMocks, members);
  const restoreClientState = useClientStateOf(members.CL);
  const restoreRenderer = useRendererOf(members.R);
  const restoreMenu = useMenuOf(members.M);
  const restoreHost = useHostOf(members.Host);

  try {
    await callback();
  } finally {
    restoreHost();
    restoreMenu();
    restoreRenderer();
    restoreClientState();
    Object.assign(engineMocks, previous);
  }
}

void describe('ClientHost', () => {
  void describe('Frame', () => {
    void test('only polls the connection while connecting, and reports that no frame ran', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [], state: Def.clientConnectionState.connecting });
      let result = null;

      await withRegistryMembers(runtime, () => {
        result = ClientHost.Frame(0.1, 5);
      });

      assert.equal(result, false);
      assert.deepEqual(calls.map(([name]) => name), ['CheckConnectingState', 'UpdateScreen']);
    });

    void test('lets the local server take its turn right after the client sent its command', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });
      let result = null;

      await withRegistryMembers(runtime, () => {
        result = ClientHost.Frame(0.1, 5);
      });

      const names = calls.map(([name]) => name);

      assert.equal(result, true);
      assert.ok(names.indexOf('SendCmd') < names.indexOf('runLocalFrame'));
      assert.ok(names.indexOf('runLocalFrame') < names.indexOf('PredictMove'));
      assert.deepEqual(calls.find(([name]) => name === 'runLocalFrame'), ['runLocalFrame', 0.1, 5]);
    });

    void test('tells the server whether the menu lets the world run before its turn', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      runtime.M.AllowsSimulation = () => false;

      await withRegistryMembers(runtime, () => {
        ClientHost.Frame(0.1, 5);
      });

      const names = calls.map(([name]) => name);

      assert.deepEqual(calls.find(([name]) => name === 'setSimulationAllowed'), ['setSimulationAllowed', false]);
      assert.ok(names.indexOf('setSimulationAllowed') < names.indexOf('runLocalFrame'));
    });
  });

  void describe('hidden page', () => {
    /**
     * Runs a frame while the page is hidden or shown.
     * @param hidden whether the page is in a background tab
     * @returns what the frame did
     */
    async function frameWith(hidden: boolean | undefined): Promise<Array<[string, ...unknown[]]>> {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');

      Object.defineProperty(globalThis, 'document', { value: { hidden }, configurable: true });

      try {
        await withRegistryMembers(runtime, () => {
          ClientHost.Frame(0.1, 5);
        });
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(globalThis, 'document');
        } else {
          Object.defineProperty(globalThis, 'document', previous);
        }
      }

      return calls;
    }

    void test('keeps the world from running, even though the menu would let it', async () => {
      const calls = await frameWith(true);

      assert.deepEqual(calls.find(([name]) => name === 'setSimulationAllowed'), ['setSimulationAllowed', false]);
    });

    void test('lets the world run while the page is visible', async () => {
      const calls = await frameWith(false);

      assert.deepEqual(calls.find(([name]) => name === 'setSimulationAllowed'), ['setSimulationAllowed', true]);
    });

    void test('lets the world run where there is no page at all, like a test', async () => {
      const calls = await frameWith(undefined);

      assert.deepEqual(calls.find(([name]) => name === 'setSimulationAllowed'), ['setSimulationAllowed', true]);
    });
  });

  void describe('Map_f', () => {
    void test('prints the usage without a map name', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, async () => {
        await runConsoleCommand(ClientHost.Map_f, { client: null });
      });

      assert.deepEqual(calls, [['Print', 'Usage: map <map>\n']]);
    });

    void test('ignores a client asking for it', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, async () => {
        await runConsoleCommand(ClientHost.Map_f, { client: {} as ServerClient }, 'e1m1');
      });

      assert.deepEqual(calls, []);
    });

    void test('leaves the old game, shows the loading plaque and spawns the map on the next frame', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const scheduled: Array<() => void | Promise<void>> = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        await runConsoleCommand(ClientHost.Map_f, { client: null }, 'e1m2', 'a', 'b');

        assert.equal(clientStaticState.demonum, -1);
        assert.equal(clientStaticState.spawnparms, 'a b');
        assert.equal(Key.destination, KeyDestination.game);
        assert.equal(scheduled.length, 1);
        assert.deepEqual(calls.map(([name]) => name), ['Disconnect', 'stop', 'BeginLoadingPlaque', 'SetConnectingStep'], 'nothing spawns before the next frame');

        await scheduled[0]();
      });

      assert.deepEqual(calls.slice(4), [['start', 'e1m2'], ['SetConnectingStep', null, null], ['Connect', 'local']]);
    });

    void test('fails the frame when the map cannot be spawned', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const scheduled: Array<() => void | Promise<void>> = [];
      const runtime = createClientRuntime({ calls, scheduled, startResult: false });

      await withRegistryMembers(runtime, async () => {
        await runConsoleCommand(ClientHost.Map_f, { client: null }, 'nowhere');

        await assert.rejects(Promise.resolve(scheduled[0]()), /Could not spawn server with map nowhere/);
      });

      assert.ok(!calls.some(([name]) => name === 'Connect'));
    });
  });

  void describe('Changelevel_f', () => {
    void test('refuses without a running server', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [], serverActive: false });

      await withRegistryMembers(runtime, () => {
        ClientHost.Changelevel_f('e1m2');
      });

      assert.deepEqual(calls, [['Print', 'Only the server may changelevel\n']]);
    });

    void test('refuses during demo playback', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [], demoplayback: true });

      await withRegistryMembers(runtime, () => {
        ClientHost.Changelevel_f('e1m2');
      });

      assert.deepEqual(calls, [['Print', 'Only the server may changelevel\n']]);
    });

    void test('announces the change, resets the signon state and changes the level on the next frame', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const scheduled: Array<() => void | Promise<void>> = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        ClientHost.Changelevel_f('e1m2');

        assert.deepEqual(calls, [['announceChangelevel', 'e1m2']]);
        assert.equal(clientStaticState.changelevel, true);
        assert.equal(clientStaticState.signon, 0);

        await scheduled[0]();
      });

      assert.deepEqual(calls.slice(1), [['changelevel', 'e1m2'], ['SetConnectingStep', null, null]]);
    });
  });

  void describe('ForwardToServer', () => {
    /**
     * Builds a command that asks to be forwarded.
     * @param name name it was typed with
     * @param argv arguments after the name
     * @returns the command
     */
    function createCommand(name: string, argv: string[]): ConsoleCommand {
      // Forwarding reads the command name, its arguments and who typed it.
      return { client: null, command: name, argv, args: [name, ...argv].join(' ') } as unknown as ConsoleCommand;
    }

    /**
     * Runs a forward with a message buffer that records what is written to it.
     * @param command command to forward
     * @param [options] connection state
     * @returns what the player saw and what was sent
     */
    async function forward(command: ConsoleCommand, { state = Def.clientConnectionState.connected, demoplayback = false } = {}): Promise<{ prints: unknown[], written: unknown[] }> {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [], state, demoplayback });
      const written: Array<[string, unknown]> = [];

      // Forwarding writes a stringcmd to the message of the connection.
      (runtime.CL as { cls: { message: unknown } }).cls.message = { writeByte: (value: number) => written.push(['byte', value]), writeString: (value: string) => written.push(['string', value]) };

      await withRegistryMembers(runtime, () => {
        assert.equal(ClientHost.ForwardToServer(command), true);
      });

      return { prints: calls.filter(([name]) => name === 'Print').map(([, text]) => text), written };
    }

    void test('sends the line to the server in behalf of the player', async () => {
      const { written, prints } = await forward(createCommand('god', []));

      assert.deepEqual(written, [['byte', Protocol.clc.stringcmd], ['string', 'god']]);
      assert.deepEqual(prints, []);
    });

    void test('says so when not connected, and sends nothing', async () => {
      const { written, prints } = await forward(createCommand('god', []), { state: Def.clientConnectionState.disconnected });

      assert.deepEqual(written, []);
      assert.deepEqual(prints, ['Can\'t "god", not connected\n']);
    });

    void test('sends nothing during demo playback', async () => {
      const { written, prints } = await forward(createCommand('god', []), { demoplayback: true });

      assert.deepEqual(written, []);
      assert.deepEqual(prints, []);
    });

    void test('explains `cmd` typed without a command', async () => {
      const { prints } = await forward(createCommand('cmd', []));

      assert.deepEqual(prints, ['Usage: cmd <command> <args>\n']);
    });

    void test('names the command after `cmd` in its answer', async () => {
      const { prints } = await forward(createCommand('cmd', ['give']), { state: Def.clientConnectionState.disconnected });

      assert.deepEqual(prints, ['Can\'t "give", not connected\n']);
    });
  });

  void describe('HandleSessionRequest', () => {
    void test('runs a requested level change like the console command', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const scheduled: Array<() => void | Promise<void>> = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m2' });
        await scheduled[0]();
      });

      assert.deepEqual(calls, [['announceChangelevel', 'e1m2'], ['changelevel', 'e1m2'], ['SetConnectingStep', null, null]]);
    });

    void test('changes the level once when it is requested twice before the first ran', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, () => {
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m2' });
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m3' });
      });

      assert.deepEqual(calls, [['announceChangelevel', 'e1m2']]);
    });

    void test('runs a requested restart as the restart command', async () => {
      const executed: string[] = [];
      const Cmd = (await import('../../source/engine/common/Cmd.ts')).default;
      const originalExecuteString = Cmd.ExecuteString;

      Cmd.ExecuteString = (text) => { executed.push(text); return Promise.resolve(); };

      try {
        ClientHost.HandleSessionRequest({ kind: 'restart' });
      } finally {
        Cmd.ExecuteString = originalExecuteString;
      }

      assert.deepEqual(executed, ['restart']);
    });
  });

  void describe('Restart_f', () => {
    void test('restarts the running map from the local console', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [], mapname: 'e1m3' });
      const executed: string[] = [];
      const Cmd = (await import('../../source/engine/common/Cmd.ts')).default;
      const originalExecuteString = Cmd.ExecuteString;

      Cmd.ExecuteString = (text) => { executed.push(text); return Promise.resolve(); };

      try {
        await withRegistryMembers(runtime, async () => {
          await runConsoleCommand(ClientHost.Restart_f, { client: null });
        });
      } finally {
        Cmd.ExecuteString = originalExecuteString;
      }

      assert.deepEqual(executed, ['map e1m3']);
    });
  });

  void describe('Init', () => {
    void test('names the local player as the operator of local kicks', async () => {
      const serverHost = { getLocalOperatorName: () => 'unset' };

      await withRegistryMembers({ CL: { name: { string: 'Ranger' }, cls: {} }, Host: { serverHost } }, () => {
        ClientHost.Init();
        assert.equal(serverHost.getLocalOperatorName(), 'Ranger');
      });
    });

    void test('disconnects a connected client when its server shuts down', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      runtime.CL.name = { string: 'Ranger' };
      runtime.Host.serverHost = { getLocalOperatorName: () => 'unset' };

      await withRegistryMembers(runtime, () => {
        ClientHost.Init();
        eventBus.publish('server.shutting-down');
      });

      assert.ok(calls.some(([name]) => name === 'Disconnect'));
    });

    void test('does not disconnect when the host is already shutting down, the page is closing', async () => {
      const calls: Array<[string, ...unknown[]]> = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      runtime.CL.name = { string: 'Ranger' };
      runtime.Host.serverHost = { getLocalOperatorName: () => 'unset' };
      runtime.Host.isdown = true;

      await withRegistryMembers(runtime, () => {
        ClientHost.Init();
        eventBus.publish('server.shutting-down');
      });

      assert.equal(calls.some(([name]) => name === 'Disconnect'), false);
    });
  });
});
