import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientInput, { kbutton, kbuttons } from '../../source/engine/client/ClientInput.ts';
import '../support/consoleBridge.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Installs the client state, console and host that reading the input commands needs, for the duration of a callback.
 * @param callback The test callback.
 */
function withMockClientInputRegistry(callback: () => void): void {
  withEngineMocks({
    CL: {
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
    },
    Con: { Print() {}, DPrint() {} },
    Host: { frametime: 0.1 },
    NET: { SendUnreliableMessage() { return 0; } },
    V: { startPitchDrift() {} },
  }, callback);
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
