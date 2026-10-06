import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Def from '../../source/engine/common/Def.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import { KeyDestination } from '../../source/engine/client/Key.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';

/**
 * Builds a client runtime mock that records what the host does to it, in order.
 * @param {{ calls: Array, scheduled: Array<() => Promise<void>>, serverActive?: boolean, mapname?: string|null, startResult?: boolean, changelevelResult?: boolean, state?: number, demoplayback?: boolean }} options mock shape
 * @returns {object} registry members to install
 */
function createClientRuntime({ calls, scheduled, serverActive = true, mapname = 'e1m1', startResult = true, changelevelResult = true, state = Def.clientConnectionState.connected, demoplayback = false }) {
  const record = (name) => (...args) => { calls.push([name, ...args]); };

  const serverController = {
    state: { active: serverActive, mapname, maxclients: 1, paused: false },
    setSimulationAllowed: record('setSimulationAllowed'),
    runLocalFrame: record('runLocalFrame'),
    stop: record('stop'),
    announceChangelevel: record('announceChangelevel'),
    async start(name) { calls.push(['start', name]); return startResult; },
    async changelevel(name) { calls.push(['changelevel', name]); return changelevelResult; },
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
    Host: { speeds: null, ScheduleForNextFrame: (callback) => { scheduled.push(callback); } },
    Key: { destination: KeyDestination.menu },
    M: { AllowsSimulation: () => true },
    SCR: { UpdateScreen: record('UpdateScreen'), BeginLoadingPlaque: record('BeginLoadingPlaque') },
    R: { refdef: { vieworg: [0, 0, 0] }, vpn: [0, 0, 0], vright: [0, 0, 0], vup: [0, 0, 0], viewleaf: null },
    S: { Update: record('S.Update') },
  };
}

/**
 * Installs registry members and restores them afterwards.
 * @param {object} members registry members to install
 * @param {() => void | Promise<void>} callback test callback
 * @returns {Promise<void>} resolves once the callback and the cleanup are done
 */
async function withRegistryMembers(members, callback) {
  const previous = Object.fromEntries(Object.keys(members).map((name) => [name, registry[name]]));

  Object.assign(registry, members);
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    Object.assign(registry, previous);
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientHost', () => {
  void describe('Frame', () => {
    void test('only polls the connection while connecting, and reports that no frame ran', async () => {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [], state: Def.clientConnectionState.connecting });
      let result = null;

      await withRegistryMembers(runtime, () => {
        result = ClientHost.Frame(0.1, 5);
      });

      assert.equal(result, false);
      assert.deepEqual(calls.map(([name]) => name), ['CheckConnectingState', 'UpdateScreen']);
    });

    void test('lets the local server take its turn right after the client sent its command', async () => {
      const calls = [];
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
      const calls = [];
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
     * @param {boolean} hidden whether the page is in a background tab
     * @returns {Promise<Array<[string, ...unknown[]]>>} what the frame did
     */
    async function frameWith(hidden) {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');

      Object.defineProperty(globalThis, 'document', { value: { hidden }, configurable: true });

      try {
        await withRegistryMembers(runtime, () => {
          ClientHost.Frame(0.1, 5);
        });
      } finally {
        if (previous === undefined) {
          delete globalThis.document;
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
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, () => {
        ClientHost.Map_f.call({ client: null });
      });

      assert.deepEqual(calls, [['Print', 'Usage: map <map>\n']]);
    });

    void test('ignores a client asking for it', async () => {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, () => {
        ClientHost.Map_f.call({ client: {} }, 'e1m1');
      });

      assert.deepEqual(calls, []);
    });

    void test('leaves the old game, shows the loading plaque and spawns the map on the next frame', async () => {
      const calls = [];
      const scheduled = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        ClientHost.Map_f.call({ client: null }, 'e1m2', 'a', 'b');

        assert.equal(runtime.CL.cls.demonum, -1);
        assert.equal(runtime.CL.cls.spawnparms, 'a b');
        assert.equal(runtime.Key.destination, KeyDestination.game);
        assert.equal(scheduled.length, 1);
        assert.deepEqual(calls.map(([name]) => name), ['Disconnect', 'stop', 'BeginLoadingPlaque', 'SetConnectingStep'], 'nothing spawns before the next frame');

        await scheduled[0]();
      });

      assert.deepEqual(calls.slice(4), [['start', 'e1m2'], ['SetConnectingStep', null, null], ['Connect', 'local']]);
    });

    void test('fails the frame when the map cannot be spawned', async () => {
      const calls = [];
      const scheduled = [];
      const runtime = createClientRuntime({ calls, scheduled, startResult: false });

      await withRegistryMembers(runtime, async () => {
        ClientHost.Map_f.call({ client: null }, 'nowhere');

        await assert.rejects(scheduled[0](), /Could not spawn server with map nowhere/);
      });

      assert.ok(!calls.some(([name]) => name === 'Connect'));
    });
  });

  void describe('Changelevel_f', () => {
    void test('refuses without a running server', async () => {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [], serverActive: false });

      await withRegistryMembers(runtime, () => {
        ClientHost.Changelevel_f('e1m2');
      });

      assert.deepEqual(calls, [['Print', 'Only the server may changelevel\n']]);
    });

    void test('refuses during demo playback', async () => {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [], demoplayback: true });

      await withRegistryMembers(runtime, () => {
        ClientHost.Changelevel_f('e1m2');
      });

      assert.deepEqual(calls, [['Print', 'Only the server may changelevel\n']]);
    });

    void test('announces the change, resets the signon state and changes the level on the next frame', async () => {
      const calls = [];
      const scheduled = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        ClientHost.Changelevel_f('e1m2');

        assert.deepEqual(calls, [['announceChangelevel', 'e1m2']]);
        assert.equal(runtime.CL.cls.changelevel, true);
        assert.equal(runtime.CL.cls.signon, 0);

        await scheduled[0]();
      });

      assert.deepEqual(calls.slice(1), [['changelevel', 'e1m2'], ['SetConnectingStep', null, null]]);
    });
  });

  void describe('HandleSessionRequest', () => {
    void test('runs a requested level change like the console command', async () => {
      const calls = [];
      const scheduled = [];
      const runtime = createClientRuntime({ calls, scheduled });

      await withRegistryMembers(runtime, async () => {
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m2' });
        await scheduled[0]();
      });

      assert.deepEqual(calls, [['announceChangelevel', 'e1m2'], ['changelevel', 'e1m2'], ['SetConnectingStep', null, null]]);
    });

    void test('changes the level once when it is requested twice before the first ran', async () => {
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      await withRegistryMembers(runtime, () => {
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m2' });
        ClientHost.HandleSessionRequest({ kind: 'changelevel', mapname: 'e1m3' });
      });

      assert.deepEqual(calls, [['announceChangelevel', 'e1m2']]);
    });

    void test('runs a requested restart as the restart command', async () => {
      const executed = [];
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
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [], mapname: 'e1m3' });
      const executed = [];
      const Cmd = (await import('../../source/engine/common/Cmd.ts')).default;
      const originalExecuteString = Cmd.ExecuteString;

      Cmd.ExecuteString = (text) => { executed.push(text); return Promise.resolve(); };

      try {
        await withRegistryMembers(runtime, () => {
          ClientHost.Restart_f.call({ client: null });
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
      const calls = [];
      const runtime = createClientRuntime({ calls, scheduled: [] });

      runtime.CL.name = { string: 'Ranger' };
      runtime.Host.serverHost = { getLocalOperatorName: () => 'unset' };

      await withRegistryMembers(runtime, () => {
        ClientHost.Init();
        eventBus.publish('server.shutting-down');
      });

      assert.ok(calls.some(([name]) => name === 'Disconnect'));
    });
  });
});
