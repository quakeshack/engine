import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import ClientInput, { kbutton, kbuttons } from '../../source/engine/client/ClientInput.ts';
import '../support/consoleBridge.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { useHostOf } from '../support/host.ts';
import { facades } from '../support/facades.ts';
import { pageServices } from '../support/pageServices.ts';

/**
 *
 * @param callback
 */
function withMockClientInputRegistry(callback) {
  const previousValues = {
    CL: registry.CL,
    Con: registry.Con,
    Host: registry.Host,
    NET: pageServices.NET,
    V: facades.V,
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

  const restoreClientState = useClientStateOf(registry.CL);
  registry.Con = { Print() {}, DPrint() {} };
  registry.Host = { frametime: 0.1 };
  const restoreHost = useHostOf(registry.Host);
  pageServices.NET = { SendUnreliableMessage() { return 0; } };
  facades.V = { startPitchDrift() {} };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousValues.CL;
    restoreClientState();
    registry.Con = previousValues.Con;
    registry.Host = previousValues.Host;
    restoreHost();
    pageServices.NET = previousValues.NET;
    facades.V = previousValues.V;
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

      assert.equal(clientRuntimeState.cmd.upmove, 20);
    });
  });
});
