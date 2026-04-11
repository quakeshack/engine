import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import SCR from '../../source/engine/client/SCR.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

void describe('SCR.CenterPrint', () => {
  void test('publishes client.center-print after formatting the message', () => {
    const previousCL = registry.CL;
    const previousCenterString = SCR.centerstring;
    const previousCenterTimeOff = SCR.centertime_off;
    const previousCenterTimeStart = SCR.centertime_start;
    const previousCentertime = SCR.centertime;
    const receivedMessages = [];
    const unsubscribe = eventBus.subscribe('client.center-print', (message) => {
      receivedMessages.push(message);
    });

    registry.CL = {
      state: {
        time: 4,
      },
    };
    eventBus.publish('registry.frozen');
    SCR.centertime = { value: 2 };

    try {
      SCR.CenterPrint('The slipgate complex');

      assert.deepEqual(receivedMessages, ['The slipgate complex']);
      assert.deepEqual(SCR.centerstring, ['The slipgate complex']);
      assert.equal(SCR.centertime_off, 2);
      assert.equal(SCR.centertime_start, 4);
    } finally {
      unsubscribe();
      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
      SCR.centerstring = previousCenterString;
      SCR.centertime_off = previousCenterTimeOff;
      SCR.centertime_start = previousCenterTimeStart;
      SCR.centertime = previousCentertime;
    }
  });
});
