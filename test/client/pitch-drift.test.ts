import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import clientCvars from '../../source/engine/client/ClientCvars.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import PitchDrift from '../../source/engine/client/view/PitchDrift.ts';
import viewCvars from '../../source/engine/client/view/ViewCvars.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('PitchDrift', () => {
  let restores: Array<() => void> = [];
  const previousCentermove = viewCvars.centermove;
  const previousCenterspeed = viewCvars.centerspeed;

  beforeEach(() => {
    viewCvars.centermove = { value: 0.15 } as Cvar;
    viewCvars.centerspeed = { value: 500 } as Cvar;

    restores = [
      patchMembers(Host, { frametime: 0.1, noclip_anglehack: false }),
      patchMembers(clientCvars, { forwardspeed: { value: 200 } as Cvar }),
      patchMembers(clientStaticState, { demoplayback: false }),
      patchMembers(clientRuntimeState, {
        onground: true,
        nodrift: false,
        pitchvel: 0,
        driftmove: 0,
        laststop: -1,
        idealpitch: 0,
        time: 10,
      }),
    ];
    clientRuntimeState.viewangles.setTo(0, 0, 0);
    clientRuntimeState.cmd.forwardmove = 0;
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    viewCvars.centermove = previousCentermove;
    viewCvars.centerspeed = previousCenterspeed;
  });

  void describe('Start', () => {
    void test('starts at the centerspeed when drift was stopped', () => {
      clientRuntimeState.nodrift = true;
      clientRuntimeState.driftmove = 3;

      PitchDrift.Start();

      assert.equal(clientRuntimeState.pitchvel, 500);
      assert.equal(clientRuntimeState.nodrift, false);
      assert.equal(clientRuntimeState.driftmove, 0);
    });

    void test('does nothing in the same frame it was stopped, so a look key can win', () => {
      clientRuntimeState.nodrift = true;
      clientRuntimeState.laststop = 10;

      PitchDrift.Start();

      assert.equal(clientRuntimeState.pitchvel, 0);
      assert.equal(clientRuntimeState.nodrift, true);
    });

    void test('leaves a drift that is already running alone', () => {
      clientRuntimeState.pitchvel = 123;

      PitchDrift.Start();

      assert.equal(clientRuntimeState.pitchvel, 123);
    });
  });

  void describe('Stop', () => {
    void test('stops the drift and remembers when', () => {
      clientRuntimeState.pitchvel = 200;

      PitchDrift.Stop();

      assert.equal(clientRuntimeState.laststop, 10);
      assert.equal(clientRuntimeState.nodrift, true);
      assert.equal(clientRuntimeState.pitchvel, 0);
    });
  });

  void describe('Update', () => {
    void test('resets while noclipping, in the air or watching a demo', () => {
      clientRuntimeState.pitchvel = 50;
      clientRuntimeState.driftmove = 1;

      clientRuntimeState.onground = false;
      PitchDrift.Update();
      assert.equal(clientRuntimeState.pitchvel, 0);
      assert.equal(clientRuntimeState.driftmove, 0);

      clientRuntimeState.onground = true;
      clientRuntimeState.pitchvel = 50;
      Host.noclip_anglehack = true;
      PitchDrift.Update();
      assert.equal(clientRuntimeState.pitchvel, 0);

      Host.noclip_anglehack = false;
      clientRuntimeState.pitchvel = 50;
      restores.push(patchMembers(clientStaticState, { demoplayback: true }));
      PitchDrift.Update();
      assert.equal(clientRuntimeState.pitchvel, 0);
    });

    void test('waits for forward movement at full speed before it starts to center the view', () => {
      clientRuntimeState.nodrift = true;
      clientRuntimeState.cmd.forwardmove = 400;

      PitchDrift.Update();
      assertNear(clientRuntimeState.driftmove, 0.1);
      assert.equal(clientRuntimeState.nodrift, true);

      // 0.2 > v_centermove 0.15: the next frame starts the drift
      PitchDrift.Update();
      assert.equal(clientRuntimeState.nodrift, false);
      assert.equal(clientRuntimeState.pitchvel, 500);
    });

    void test('restarts the wait when the player slows down', () => {
      clientRuntimeState.nodrift = true;
      clientRuntimeState.driftmove = 0.1;
      clientRuntimeState.cmd.forwardmove = 100;

      PitchDrift.Update();

      assert.equal(clientRuntimeState.driftmove, 0);
    });

    void test('moves the pitch toward the ideal one at the drift speed, and speeds up', () => {
      clientRuntimeState.viewangles.setTo(30, 0, 0);
      clientRuntimeState.pitchvel = 10;

      PitchDrift.Update();

      // 0.1 s * 10 units per second, then the speed grows by 0.1 * 500
      assertNear(clientRuntimeState.viewangles[0], 29);
      assertNear(clientRuntimeState.pitchvel, 60);
    });

    void test('drifts up from below, and does not overshoot', () => {
      clientRuntimeState.viewangles.setTo(-0.5, 0, 0);
      clientRuntimeState.pitchvel = 100;

      PitchDrift.Update();

      // 0.1 * 100 = 10 would pass the ideal: it stops on it and the speed is reset
      assertNear(clientRuntimeState.viewangles[0], 0);
      assert.equal(clientRuntimeState.pitchvel, 0);
    });

    void test('rests when the view is already at the ideal pitch', () => {
      clientRuntimeState.pitchvel = 80;

      PitchDrift.Update();

      assert.equal(clientRuntimeState.pitchvel, 0);
    });
  });
});
