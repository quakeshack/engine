import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventBus, registry } from '../../source/engine/registry.ts';
import ClientInput, { kbutton, kbuttons } from '../../source/engine/client/ClientInput.ts';

function withMockClientInputRegistry(callback) {
  const previousValues = {
    CL: registry.CL,
    Con: registry.Con,
    Host: registry.Host,
    NET: registry.NET,
    V: registry.V,
  };

  registry.CL = {
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
  registry.Con = { Print() {}, DPrint() {} };
  registry.Host = { frametime: 0.1 };
  registry.NET = { SendUnreliableMessage() { return 0; } };
  registry.V = { startPitchDrift() {} };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousValues.CL;
    registry.Con = previousValues.Con;
    registry.Host = previousValues.Host;
    registry.NET = previousValues.NET;
    registry.V = previousValues.V;
    eventBus.publish('registry.frozen');
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

      assert.equal(registry.CL.state.cmd.upmove, 20);
    });
  });
});
