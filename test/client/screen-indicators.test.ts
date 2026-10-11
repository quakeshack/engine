import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import Host from '../../source/engine/common/Host.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import Draw from '../../source/engine/client/Draw.ts';
import VID from '../../source/engine/client/VID.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import ScreenIndicators from '../../source/engine/client/screen/ScreenIndicators.ts';
import { patchMembers } from '../support/clientState.ts';

interface PicCall {
  readonly x: number;
  readonly y: number;
  readonly pic: unknown;
}

void describe('ScreenIndicators', () => {
  const previous = {
    net: ScreenIndicators.net,
    turtle: ScreenIndicators.turtle,
    showturtle: ScreenIndicators.showturtle,
  };
  let restores: Array<() => void> = [];
  let pics: PicCall[] = [];

  beforeEach(() => {
    pics = [];
    ScreenIndicators.net = 'net-pic' as never;
    ScreenIndicators.turtle = 'turtle-pic' as never;
    ScreenIndicators.showturtle = { value: 1 } as Cvar;

    restores = [
      patchMembers(Host, { realtime: 5, frametime: 0.016 }),
      patchMembers(VID, { width: 640, height: 480 }),
      patchMembers(clientStaticState, { state: clientConnectionState.connected, demoplayback: false }),
      patchMembers(clientRuntimeState, { last_received_message: 5, paused: false }),
    ];
    Camera.refdef.vrect.x = 3;
    Camera.refdef.vrect.y = 4;
    // a fast frame, so that no slow frames of an earlier test are counted
    ScreenIndicators.DrawTurtle();
    mock.method(Draw, 'Pic', (x: number, y: number, pic: unknown) => { pics.push({ x, y, pic }); });
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    Object.assign(ScreenIndicators, previous);
  });

  void describe('DrawNet', () => {
    void test('does not draw while disconnected, even though last_received_message is stale from boot', () => {
      // Regression test: last_received_message defaults to 0 and is only ever set once a message
      // actually arrives, so realtime - 0 exceeds the 0.3s threshold within a fraction of a second
      // after boot -- without the connection-state guard this drew a permanent false "bad ping"
      // indicator while never having connected at all.
      clientStaticState.state = clientConnectionState.disconnected;
      clientRuntimeState.last_received_message = 0;

      ScreenIndicators.DrawNet();

      assert.deepEqual(pics, []);
    });

    void test('does not draw while still connecting', () => {
      clientStaticState.state = clientConnectionState.connecting;
      clientRuntimeState.last_received_message = 0;

      ScreenIndicators.DrawNet();

      assert.deepEqual(pics, []);
    });

    void test('draws once connected and no message has arrived in over 0.3s', () => {
      clientRuntimeState.last_received_message = 4.5;

      ScreenIndicators.DrawNet();

      assert.deepEqual(pics, [{ x: 3, y: 4, pic: 'net-pic' }]);
    });

    void test('does not draw while connected and a message arrived recently', () => {
      clientRuntimeState.last_received_message = 4.9;

      ScreenIndicators.DrawNet();

      assert.deepEqual(pics, []);
    });

    void test('does not draw during demo playback even if connected and lagging', () => {
      restores.push(patchMembers(clientStaticState, { demoplayback: true }));
      clientRuntimeState.last_received_message = 1;

      ScreenIndicators.DrawNet();

      assert.deepEqual(pics, []);
    });
  });

  void describe('DrawTurtle', () => {
    void test('shows after three slow frames in a row, and not before', () => {
      Host.frametime = 0.2;

      ScreenIndicators.DrawTurtle();
      ScreenIndicators.DrawTurtle();
      assert.deepEqual(pics, []);

      ScreenIndicators.DrawTurtle();
      assert.deepEqual(pics, [{ x: 3, y: 4, pic: 'turtle-pic' }]);
    });

    void test('starts counting again after a fast frame', () => {
      Host.frametime = 0.2;
      ScreenIndicators.DrawTurtle();
      ScreenIndicators.DrawTurtle();

      Host.frametime = 0.016;
      ScreenIndicators.DrawTurtle();

      Host.frametime = 0.2;
      ScreenIndicators.DrawTurtle();
      ScreenIndicators.DrawTurtle();

      assert.deepEqual(pics, []);
    });

    void test('is off with showturtle at 0', () => {
      ScreenIndicators.showturtle = { value: 0 } as Cvar;
      Host.frametime = 0.5;

      for (let frame = 0; frame < 5; frame++) {
        ScreenIndicators.DrawTurtle();
      }

      assert.deepEqual(pics, []);
    });
  });

  void describe('Draw', () => {
    void test('draws the net and the turtle that apply, and not the pause sign, which is the game\'s', () => {
      clientRuntimeState.last_received_message = 1;
      clientRuntimeState.paused = true;
      Host.frametime = 0.2;

      ScreenIndicators.Draw();
      ScreenIndicators.Draw();
      ScreenIndicators.Draw();

      assert.deepEqual(pics.map((call) => call.pic), ['net-pic', 'net-pic', 'net-pic', 'turtle-pic']);
    });
  });
});
