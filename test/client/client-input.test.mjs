import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientInput, { kbutton, kbuttons } from '../../source/engine/client/ClientInput.ts';
import '../support/consoleBridge.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { useHostOf } from '../support/host.ts';
import { engineMocks } from '../support/engineMocks.ts';

/**
 *
 * @param callback
 */
function withMockClientInputRegistry(callback) {
  const previousValues = {
    CL: engineMocks.CL,
    Con: engineMocks.Con,
    Host: engineMocks.Host,
    NET: engineMocks.NET,
    V: engineMocks.V,
  };

  engineMocks.CL = {
    cls: { signon: 4 },
    state: {
      cmd: {
        sidemove: 0,
        upmove: 0,
        forwardmove: 0,
        impulse: 0,
        angles: { set() {} },
        msec: 0,
      },
      viewangles: [0, 0, 0],
      time: 0,
    },
    anglespeedkey: { value: 1 },
    backspeed: { value: 200 },
    forwardspeed: { value: 200 },
    movespeedkey: { value: 1 },
    pitchspeed: { value: 1 },
    sidespeed: { value: 200 },
    upspeed: { value: 200 },
    yawspeed: { value: 1 },
  };

  const restoreClientState = useClientStateOf(engineMocks.CL);
  engineMocks.Con = { Print() {}, DPrint() {} };
  engineMocks.Host = { frametime: 0.1 };
  const restoreHost = useHostOf(engineMocks.Host);
  engineMocks.NET = { SendUnreliableMessage() { return 0; } };
  engineMocks.V = { startPitchDrift() {} };

  const restore = () => {
    engineMocks.CL = previousValues.CL;
    restoreClientState();
    engineMocks.Con = previousValues.Con;
    engineMocks.Host = previousValues.Host;
    restoreHost();
    engineMocks.NET = previousValues.NET;
    engineMocks.V = previousValues.V;
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('ClientInput', () => {
  void test('maps the jump key to a positive upmove for pmove', () => {
    withMockClientInputRegistry(() => {
      for (let index = 0; index < kbuttons.length; index++) {
        kbuttons[index] = { down: [0, 0], state: 0 };
      }

      kbuttons[kbutton.jump].state = 3;

      ClientInput.BaseMove();

      assert.equal(clientRuntimeState.cmd.upmove, 20);
    });
  });
});
