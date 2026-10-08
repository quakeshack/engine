import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import ServerRealm from '../../source/engine/server/ServerRealm.ts';
import { withMockEngine } from '../physics/fixtures.mjs';

/**
 * Builds a realm with a clock a test controls.
 * @returns {{ realm: ServerRealm, clock: { now: number }, crashes: unknown[], frames: Array<[number, number]> }} the realm and what it recorded
 */
function createRealm() {
  const clock = { now: 100 };
  const crashes = [];
  const frames = [];

  const realm = new ServerRealm({
    sys: { Print() {}, FloatTime: () => clock.now },
    con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} },
    engineVersion: '9.9.9+test',
    onCrash: (error) => crashes.push(error),
  });

  realm.InitLocal();
  realm.serverHost = /** @type {any} */ ({ Frame: (frametime, realtime) => frames.push([frametime, realtime]) });

  return { realm, clock, crashes, frames };
}

void describe('ServerRealm', () => {
  beforeEach(() => {
    Cvar.Shutdown();
    Cmd.Init();
  });

  afterEach(() => {
    Cvar.Shutdown();
  });

  void describe('InitLocal', () => {
    void test('registers the cvars the server code reads', () => {
      createRealm();

      for (const name of ['host_framerate', 'host_speeds', 'sys_ticrate', 'developer']) {
        assert.notEqual(Cvar.FindVar(name), null, name);
      }
    });

    void test('tells the version it was given', () => {
      assert.equal(createRealm().realm.version.string, '9.9.9+test');
    });
  });

  void describe('Frame', () => {
    void test('advances the world by the time since the last frame', async () => {
      const { realm, clock, frames } = createRealm();

      clock.now += 0.02;
      await realm.Frame();

      assert.equal(frames.length, 1);
      assert.ok(Math.abs(frames[0][0] - 0.02) < 1e-9);
      assert.equal(frames[0][1], clock.now);
    });

    void test('does not let a stall make the world jump', async () => {
      const { realm, clock, frames } = createRealm();

      clock.now += 5;
      await realm.Frame();

      assert.equal(frames[0][0], ServerRealm.MAX_FRAMETIME);
    });

    void test('never advances the world by less than the minimum', async () => {
      const { realm, frames } = createRealm();

      await realm.Frame();

      assert.equal(frames[0][0], ServerRealm.MIN_FRAMETIME);
    });

    void test('host_framerate fixes the time step', async () => {
      const { realm, clock, frames } = createRealm();

      realm.framerate.set(0.5);
      clock.now += 0.016;
      await realm.Frame();

      assert.equal(frames[0][0], 0.5);
    });

    void test('counts frames', async () => {
      const { realm } = createRealm();

      await realm.Frame();
      await realm.Frame();

      assert.equal(realm.framecount, 2);
    });

    void test('runs queued console commands before the server', async () => {
      const { realm } = createRealm();
      const order = [];

      Cmd.AddCommand('realm_test_command', () => { order.push('command'); });
      realm.serverHost = /** @type {any} */ ({ Frame: () => order.push('server') });
      Cmd.text += 'realm_test_command\n';

      // Executing commands tokenizes them with the static parser of COM.
      await withMockEngine({ COM: /** @type {any} */ (COM), Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, async () => {
        await realm.Frame();
      });

      assert.deepEqual(order, ['command', 'server']);
    });
  });

  void describe('scheduling', () => {
    void test('runs work scheduled for the next frame before the server, once', async () => {
      const { realm, frames } = createRealm();
      const order = [];

      realm.serverHost = /** @type {any} */ ({ Frame: () => order.push('server') });
      realm.ScheduleForNextFrame(() => { order.push('scheduled'); });

      await realm.Frame();
      await realm.Frame();

      assert.deepEqual(order, ['scheduled', 'server', 'server']);
      assert.equal(frames.length, 0);
    });

    void test('waits for scheduled work that is asynchronous', async () => {
      const { realm } = createRealm();
      const order = [];

      realm.serverHost = /** @type {any} */ ({ Frame: () => order.push('server') });
      realm.ScheduleForNextFrame(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('scheduled');
      });

      await realm.Frame();

      assert.deepEqual(order, ['scheduled', 'server']);
    });

    void test('runs work scheduled in the future once its time has come, not earlier', async () => {
      const { realm, clock } = createRealm();
      let runs = 0;

      realm.ScheduleInFuture('task', () => { runs++; }, 5);

      clock.now += 1;
      await realm.Frame();
      assert.equal(runs, 0);

      clock.now += 10;
      await realm.Frame();
      await realm.Frame();
      assert.equal(runs, 1);
    });

    void test('coalesces repeated requests for the same task', async () => {
      const { realm, clock } = createRealm();
      let runs = 0;

      realm.ScheduleInFuture('task', () => { runs++; }, 1);
      realm.ScheduleInFuture('task', () => { runs++; }, 1);

      clock.now += 2;
      await realm.Frame();

      assert.equal(runs, 1);
    });
  });

  void describe('HandleCrash', () => {
    void test('reports the failure to whoever owns the realm', () => {
      const { realm, crashes } = createRealm();
      const error = new Error('helper worker died');

      realm.HandleCrash(error);

      assert.deepEqual(crashes, [error]);
    });
  });

  void describe('noclip_anglehack', () => {
    void test('tells whoever shows the view when the server switches it', () => {
      const changes = [];
      const realm = new ServerRealm({
        sys: { Print() {}, FloatTime: () => 0 },
        con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} },
        engineVersion: 'test',
        onCrash() {},
        onNoclipAnglehack: (enabled) => changes.push(enabled),
      });

      realm.noclip_anglehack = true;
      realm.noclip_anglehack = false;

      assert.deepEqual(changes, [true, false]);
      assert.equal(realm.noclip_anglehack, false);
    });
  });
});
