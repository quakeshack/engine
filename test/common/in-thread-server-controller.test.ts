import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import InThreadServerController from '../../source/engine/server/InThreadServerController.ts';

import { createTestServer, createTestServerHost } from '../support/fixtures.ts';
import type Server from '../../source/engine/server/Server.ts';
import type ServerHost from '../../source/engine/server/ServerHost.ts';

/**
 * Builds a controller over a test server with the facts the controller mirrors.
 * @param [options] server facts
 * @returns the controller and what it controls
 */
function createController({ active = true, maxclients = 1, mapname = 'start', paused = false, changelevelIssued = false }: { active?: boolean; maxclients?: number; mapname?: string | null; paused?: boolean; changelevelIssued?: boolean } = {}): { controller: InThreadServerController, sv: Server, serverHost: ServerHost } {
  const sv = createTestServer();
  const { serverHost } = createTestServerHost({ server: sv });

  sv.server.active = active;
  // A server that has no map yet has no name for it.
  sv.server.mapname = mapname as string;
  sv.server.paused = paused;
  sv.svs.maxclients = maxclients;
  sv.svs.changelevelIssued = changelevelIssued;

  return { controller: new InThreadServerController(sv, serverHost), sv, serverHost };
}

void describe('InThreadServerController', () => {
  void describe('state', () => {
    void test('mirrors the facts of the running server', () => {
      const { controller } = createController({ maxclients: 4, mapname: 'dm3', paused: true });

      assert.deepEqual({ ...controller.state }, { active: true, maxclients: 4, mapname: 'dm3', paused: true });
    });

    void test('follows the server instead of copying it', () => {
      const { controller, sv } = createController({ active: false, mapname: null });

      assert.equal(controller.state.active, false);

      sv.server.active = true;
      sv.server.mapname = 'e1m1';

      assert.equal(controller.state.active, true);
      assert.equal(controller.state.mapname, 'e1m1');
    });
  });

  void describe('setSimulationAllowed', () => {
    void test('opens and closes the simulation gate of the server host', () => {
      const { controller, serverHost } = createController();

      controller.setSimulationAllowed(true);
      assert.equal(serverHost.simulationAllowed, true);

      controller.setSimulationAllowed(false);
      assert.equal(serverHost.simulationAllowed, false);
    });
  });

  void describe('runLocalFrame', () => {
    /**
     * Runs one local frame and reports whether the server host ran a frame.
     * @param options the server facts
     * @returns the frame times the host ran with, `null` when it did not run
     */
    function runFrame(options: Parameters<typeof createController>[0]): unknown[] | null {
      const { controller, serverHost } = createController(options);
      let ran = null;

      serverHost.Frame = (frametime, realtime) => {
        ran = [frametime, realtime];
      };

      controller.runLocalFrame(0.05, 99);

      return ran;
    }

    void test('gives an active server its turn with the frame times', () => {
      assert.deepEqual(runFrame({}), [0.05, 99]);
    });

    void test('leaves an inactive server alone', () => {
      assert.equal(runFrame({ active: false }), null);
    });

    void test('holds the server while a level change is pending', () => {
      assert.equal(runFrame({ changelevelIssued: true }), null);
    });
  });

  void describe('start, changelevel and stop', () => {
    void test('hand over to the server host', async () => {
      const { controller, serverHost } = createController();
      const calls: Array<[string, unknown]> = [];

      serverHost.StartMap = (mapname: string) => { calls.push(['StartMap', mapname]); return Promise.resolve(true); };
      serverHost.AnnounceChangelevel = (mapname: string) => { calls.push(['AnnounceChangelevel', mapname]); };
      serverHost.Changelevel = (mapname: string) => { calls.push(['Changelevel', mapname]); return Promise.resolve(false); };
      serverHost.ShutdownServer = (isCrash) => { calls.push(['ShutdownServer', isCrash]); };

      assert.equal(await controller.start('e1m1'), true);
      controller.announceChangelevel('e1m2');
      assert.equal(await controller.changelevel('e1m2'), false);
      controller.stop();
      controller.stop(true);

      assert.deepEqual(calls, [
        ['StartMap', 'e1m1'],
        ['AnnounceChangelevel', 'e1m2'],
        ['Changelevel', 'e1m2'],
        ['ShutdownServer', false],
        ['ShutdownServer', true],
      ]);
    });
  });
});
