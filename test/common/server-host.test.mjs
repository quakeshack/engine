import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import COM from '../../source/engine/common/Com.ts';

import { createTestServer, createTestServerHost, defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

/** @typedef {import('../../source/engine/server/Server.ts').default} Server */
/** @typedef {import('../../source/engine/server/ServerHost.ts').default} ServerHost */

/**
 * Builds a server host over a server whose frame parts record the order in which a frame calls them.
 * @param {{ paused?: boolean, maxclients?: number, calls?: string[], active?: boolean, profiling?: boolean }} options server shape
 * @returns {{ serverHost: ServerHost, sv: Server, calls: string[] }} the host, its server and the recorded calls
 */
function createFrameHost({ paused = false, maxclients = 1, calls = [], active = true, profiling = false } = {}) {
  const datagram = (name) => ({ clear() { calls.push(`${name}.clear`); } });
  const sv = createTestServer();

  sv.server.gameAPI = /** @type {any} */ ({ frametime: 0 });
  sv.server.datagram = /** @type {any} */ (datagram('datagram'));
  sv.server.expedited_datagram = /** @type {any} */ (datagram('expedited_datagram'));
  sv.server.paused = paused;
  sv.server.active = active;
  sv.svs.maxclients = maxclients;
  sv.CheckForNewClients = () => { calls.push('CheckForNewClients'); };
  sv.RunClients = () => { calls.push('RunClients'); };
  sv.RunScheduledGameCommands = () => { calls.push('RunScheduledGameCommands'); };
  sv.physics.physics = () => { calls.push('physics'); };
  sv.messages.sendClientMessages = () => { calls.push('sendClientMessages'); };

  return { ...createTestServerHost({ server: sv, host: { profiling: () => profiling } }), calls };
}

void describe('ServerHost', () => {
  void describe('ServerFrame', () => {
    void test('hands the time step to the server and the game instead of reading a global', () => {
      const { serverHost, sv } = createFrameHost();

      serverHost.ServerFrame(0.05, 123.5);

      assert.equal(sv.server.frametime, 0.05);
      assert.equal(sv.server.gameAPI.frametime, 0.05);
      assert.equal(sv.svs.realtime, 123.5);
    });

    void test('runs the parts of a frame in order', () => {
      const { serverHost, calls } = createFrameHost({ maxclients: 4 });

      serverHost.ServerFrame(0.1, 0);

      assert.deepEqual(calls, [
        'datagram.clear',
        'expedited_datagram.clear',
        'CheckForNewClients',
        'RunClients',
        'physics',
        'RunScheduledGameCommands',
        'sendClientMessages',
      ]);
    });

    void test('simulates a multiplayer server regardless of the simulation gate', () => {
      const { serverHost, calls } = createFrameHost({ maxclients: 2 });

      serverHost.simulationAllowed = false;
      serverHost.ServerFrame(0.1, 0);

      assert.ok(calls.includes('physics'));
    });

    void test('holds the world of a single player server while the gate is closed', () => {
      const { serverHost, calls } = createFrameHost({ maxclients: 1 });

      serverHost.simulationAllowed = false;
      serverHost.ServerFrame(0.1, 0);

      assert.ok(!calls.includes('physics'));
      assert.ok(calls.includes('sendClientMessages'), 'clients are still served');
    });

    void test('simulates a single player server once the gate is open', () => {
      const { serverHost, calls } = createFrameHost({ maxclients: 1 });

      serverHost.simulationAllowed = true;
      serverHost.ServerFrame(0.1, 0);

      assert.ok(calls.includes('physics'));
    });

    void test('never simulates a paused server', () => {
      const { serverHost, calls } = createFrameHost({ maxclients: 4, paused: true });

      serverHost.ServerFrame(0.1, 0);

      assert.ok(!calls.includes('physics'));
    });

    void test('keeps the gate of one server host apart from the gate of another', () => {
      const first = createFrameHost({ maxclients: 1 });
      const second = createFrameHost({ maxclients: 1 });

      first.serverHost.simulationAllowed = true;
      first.serverHost.ServerFrame(0.1, 0);
      second.serverHost.ServerFrame(0.1, 0);

      assert.ok(first.calls.includes('physics'));
      assert.ok(!second.calls.includes('physics'));
    });
  });

  void describe('Frame', () => {
    void test('does nothing while no server is active', () => {
      const { serverHost, calls } = createFrameHost({ active: false });

      serverHost.Frame(0.1, 0);

      assert.deepEqual(calls, []);
    });

    void test('runs a server frame while a server is active', () => {
      const { serverHost, calls } = createFrameHost();

      serverHost.Frame(0.1, 0);

      assert.ok(calls.includes('sendClientMessages'));
    });

    void test('profiles the frame when host_speeds asks for it', () => {
      const { serverHost } = createFrameHost({ profiling: true });
      const profile = console.profile;
      const profileEnd = console.profileEnd;
      const recorded = [];

      console.profile = (label) => { recorded.push(['start', label]); };
      console.profileEnd = (label) => { recorded.push(['end', label]); };

      try {
        serverHost.Frame(0.1, 0);
      } finally {
        console.profile = profile;
        console.profileEnd = profileEnd;
      }

      assert.deepEqual(recorded, [['start', 'ServerHost.ServerFrame'], ['end', 'ServerHost.ServerFrame']]);
    });
  });

  void describe('ShutdownServer', () => {
    void test('is already inactive when it announces the shutdown, so a listener cannot shut it down twice', () => {
      const sv = createTestServer({ sys: { Print() {}, FloatTime: () => 0 } });
      const { serverHost } = createTestServerHost({ server: sv });
      let activeWhenAnnounced = null;

      sv.server.active = true;
      sv.ShutdownServer = () => {};

      const unsubscribe = eventBus.subscribe('server.shutting-down', () => {
        activeWhenAnnounced = sv.server.active;
      });

      try {
        serverHost.ShutdownServer();
      } finally {
        unsubscribe();
      }

      assert.equal(activeWhenAnnounced, false);
    });
  });

  void describe('AnnounceChangelevel', () => {
    void test('holds the server frame and tells every connected client, but nobody else', () => {
      const writes = [];
      const makeClient = (state) => ({
        state,
        message: {
          writeByte(value) { writes.push(['byte', state, value]); },
          writeString(value) { writes.push(['string', state, value]); },
        },
      });
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.maxclients = 3;
      sv.svs.clients = [makeClient(ServerClient.STATE.SPAWNED), makeClient(ServerClient.STATE.FREE), makeClient(ServerClient.STATE.CONNECTED)];

      serverHost.AnnounceChangelevel('e1m2');

      assert.equal(sv.svs.changelevelIssued, true);
      assert.deepEqual(writes.filter(([kind]) => kind === 'string'), [
        ['string', ServerClient.STATE.SPAWNED, 'e1m2'],
        ['string', ServerClient.STATE.CONNECTED, 'e1m2'],
      ]);
    });
  });

  void describe('StartMap', () => {
    void test('resets the carried-over server flags and reports a successful spawn', async () => {
      const spawned = [];
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.serverflags = 7;
      sv.SpawnServer = async (mapname) => { spawned.push(mapname); return true; };
      sv.ShutdownServer = () => { assert.fail('must not shut down a server that spawned'); };

      assert.equal(await serverHost.StartMap('start'), true);
      assert.deepEqual(spawned, ['start']);
      assert.equal(sv.svs.serverflags, 0);
    });

    void test('shuts the server down again when the map cannot be spawned', async () => {
      let shutdowns = 0;
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.SpawnServer = async () => false;
      sv.ShutdownServer = () => { shutdowns++; };

      assert.equal(await serverHost.StartMap('nowhere'), false);
      assert.equal(shutdowns, 1);
    });
  });

  void describe('Changelevel', () => {
    void test('keeps the players spawn parameters and does not reset the server flags', async () => {
      const calls = [];
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.serverflags = 3;
      sv.SaveSpawnparms = () => { calls.push('SaveSpawnparms'); };
      sv.SpawnServer = async (mapname) => { calls.push(`SpawnServer ${mapname}`); return true; };
      sv.ShutdownServer = () => { assert.fail('must not shut down a server that spawned'); };

      assert.equal(await serverHost.Changelevel('e1m2'), true);
      assert.deepEqual(calls, ['SaveSpawnparms', 'SpawnServer e1m2']);
      assert.equal(sv.svs.serverflags, 3);
    });
  });

  void describe('maxplayers', () => {
    void test('reports the current value without an argument', () => {
      const printed = [];
      const sv = createTestServer({ con: { Print(text) { printed.push(text); }, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {}, StartCapturing() {}, StopCapturing: () => '' } });
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.maxclients = 4;
      serverHost.maxplayers();

      assert.deepEqual(printed, ['"maxplayers" is "4"\n']);
    });

    void test('cannot be changed while a server is running', () => {
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.maxclients = 2;
      sv.server.active = true;
      serverHost.maxplayers('8');

      assert.equal(sv.svs.maxclients, 2);
    });

    void test('is at least one and at most the limit', () => {
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });

      sv.svs.maxclientslimit = 16;

      serverHost.maxplayers('0');
      assert.equal(sv.svs.maxclients, 1);

      serverHost.maxplayers('99');
      assert.equal(sv.svs.maxclients, 16);
    });
  });

  void describe('console commands that name a client', () => {
    void test('name gives a renamed client a unique name and tells the others', () => {
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });
      const taken = { state: ServerClient.STATE.CONNECTED, name: 'Ranger' };
      const client = { num: 2, name: 'unconnected' };
      const written = [];

      sv.svs.maxclients = 1;
      sv.svs.clients = [/** @type {any} */ (taken)];
      sv.server.reliable_datagram = /** @type {any} */ ({
        writeByte(value) { written.push(value); },
        writeString(value) { written.push(value); },
      });

      serverHost.name(/** @type {any} */ ({ client }), 'Ranger');

      assert.equal(client.name, 'Ranger2');
      assert.deepEqual(written.slice(1), [2, 'Ranger2']);
    });

    void test('name ignores the local console, which has no client to rename', () => {
      const { serverHost, sv } = createFrameHost();

      assert.doesNotThrow(() => { serverHost.name(/** @type {any} */ ({ client: null }), 'Ranger'); });
      assert.equal(sv.svs.clients.length, 0);
    });

    void test('kick names the local operator as the one who kicked', () => {
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });
      const dropped = [];
      const target = { state: ServerClient.STATE.SPAWNED, name: 'Victim' };

      serverHost.getLocalOperatorName = () => 'Operator';
      sv.svs.maxclients = 1;
      sv.svs.clients = [/** @type {any} */ (target)];
      sv.dropClient = (client, crash, reason) => { dropped.push([client, crash, reason]); };
      sv.server.active = true;

      serverHost.kick(/** @type {any} */ ({ client: null, argv: ['kick', 'victim'], args: null, forward: () => false }));

      assert.deepEqual(dropped, [[target, false, 'Kicked by Operator']]);
    });
  });

  void describe('InitIdentityCommands', () => {
    void test('registers name and color for a server that has no client sharing its command table', () => {
      const { serverHost } = createFrameHost();

      Cmd.Init();
      serverHost.InitIdentityCommands();

      const names = Cmd.GetCommandNames();

      assert.ok(names.includes('name'));
      assert.ok(names.includes('color'));
    });
  });

  void describe('InitSessionRequestCommands', () => {
    /**
     * Registers the commands over a running server and collects what they hand over.
     * @param {{ active?: boolean, changelevelIssued?: boolean }} [options] server state
     * @returns {{ requests: object[], run: (text: string, client?: object|null) => Promise<void>, sv: Server }} the collected requests and a way to run a line
     */
    function createSessionCommands({ active = true, changelevelIssued = false } = {}) {
      const { serverHost, sv } = createFrameHost({ active });
      const requests = [];

      sv.svs.changelevelIssued = changelevelIssued;
      Cmd.Init();
      serverHost.InitSessionRequestCommands((request) => requests.push(request));

      return { requests, sv, run: async (text, client = null) => {
          // The command parser reads the text through the registry's `COM`.
          await withMockRegistry({ ...defaultMockRegistry({}, null), COM }, async () => { await Cmd.ExecuteString(text, client); });
        },
      };
    }

    void test('hands a level change over instead of acting on the server', async () => {
      const { requests, run } = createSessionCommands();

      await run('changelevel e1m2');

      assert.deepEqual(requests, [{ kind: 'changelevel', mapname: 'e1m2' }]);
    });

    void test('hands a restart over', async () => {
      const { requests, run } = createSessionCommands();

      await run('restart');

      assert.deepEqual(requests, [{ kind: 'restart' }]);
    });

    void test('ignores both without a running server', async () => {
      const { requests, run } = createSessionCommands({ active: false });

      await run('changelevel e1m2');
      await run('restart');

      assert.deepEqual(requests, []);
    });

    void test('asks for one level change only, once it was announced', async () => {
      const { requests, run } = createSessionCommands({ changelevelIssued: true });

      await run('changelevel e1m2');

      assert.deepEqual(requests, []);
    });

    void test('does not let a remote player change the level or restart', async () => {
      const { requests, run } = createSessionCommands();
      const remote = /** @type {any} */ ({ edict: null, name: 'guest' });

      await run('changelevel e1m2', remote);
      await run('restart', remote);

      assert.deepEqual(requests, []);
    });
  });

  void describe('viewthing', () => {
    /**
     * @param {object[]} entities entities on the map, null for a free edict
     * @returns {{ serverHost: ServerHost, edicts: object[] }} a host over a map with these entities
     */
    function createMapHost(entities) {
      const sv = createTestServer();
      const { serverHost } = createTestServerHost({ server: sv });
      const edicts = entities.map((entity) => ({ entity, isFree: () => entity === null }));

      sv.server.active = true;
      sv.server.edicts = /** @type {any} */ (edicts);
      sv.server.num_edicts = edicts.length;

      return { serverHost, edicts };
    }

    void test('is the first viewthing on the map, with its model and frame', () => {
      const { serverHost } = createMapHost([{ classname: 'worldspawn' }, null, { classname: 'viewthing', modelindex: 7, frame: 3 }]);

      assert.deepEqual(serverHost.getViewthing(), { modelindex: 7, frame: 3 });
    });

    void test('is nothing on a map without one', () => {
      const { serverHost } = createMapHost([{ classname: 'worldspawn' }]);

      assert.equal(serverHost.getViewthing(), null);
    });

    void test('is nothing while no server runs', () => {
      const { serverHost } = createMapHost([{ classname: 'viewthing', modelindex: 1, frame: 0 }]);

      serverHost.sv.server.active = false;

      assert.equal(serverHost.getViewthing(), null);
    });

    void test('shows the frame it is told to', () => {
      const { serverHost, edicts } = createMapHost([{ classname: 'viewthing', modelindex: 1, frame: 0 }]);

      serverHost.setViewthingFrame(5);

      assert.equal(edicts[0].entity.frame, 5);
    });

    void test('setting a frame without a viewthing does nothing', () => {
      const { serverHost } = createMapHost([{ classname: 'worldspawn' }]);

      assert.doesNotThrow(() => { serverHost.setViewthingFrame(5); });
    });
  });

  void describe('status', () => {
    void test('prints through a console that needs to be called as a method', () => {
      // A console of a server in a worker is an object, its methods use `this`.
      class MethodConsole {
        lines = [];
        Print(text) { this.lines.push(text); }
        DPrint() {}
        PrintWarning() {}
        PrintError() {}
        PrintSuccess() {}
        StartCapturing() {}
        StopCapturing() { return ''; }
      }

      const con = new MethodConsole();
      const sv = createTestServer({
        con,
        net: /** @type {any} */ ({ hostname: { string: 'host' }, GetListenAddress: () => null, activeconnections: 0, time: 0 }),
      });
      const { serverHost } = createTestServerHost({ server: sv });

      sv.server.active = true;
      sv.server.mapname = 'e1m1';
      sv.server.edicts = [];
      sv.svs.maxclients = 0;
      sv.svs.clients = [];

      serverHost.status(/** @type {any} */ ({ client: null, forward: () => false }));

      assert.ok(con.lines.some((line) => line.startsWith('map     : e1m1')));
    });
  });
});
