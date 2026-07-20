import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import SCR from '../../source/engine/client/SCR.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs minimal `CL`/`Con`/`Host` registry stubs for `SCR.SetUpToDrawConsole()`, plus a
 * fixed `SCR.conspeed` so the slide-speed math is deterministic.
 * @param {{ worldmodel: unknown, signon: number }} state
 * @param {() => void} callback test callback
 */
function withMockConsoleRegistry({ worldmodel, signon }, callback) {
  const previousCL = registry.CL;
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousConCurrent = SCR.con_current;
  const previousConspeed = SCR.conspeed;
  const con = { forcedup: false, isOpen: false };

  registry.CL = { state: { worldmodel }, cls: { signon } };
  registry.Con = con;
  registry.Host = { frametime: 0.1 };
  SCR.conspeed = { value: 300 };
  eventBus.publish('registry.frozen');

  try {
    callback(con);
  } finally {
    registry.CL = previousCL;
    registry.Con = previousCon;
    registry.Host = previousHost;
    SCR.con_current = previousConCurrent;
    SCR.conspeed = previousConspeed;
    eventBus.publish('registry.frozen');
  }
}

void describe('SCR.SetUpToDrawConsole', () => {
  void test('slides toward 0 when not open, even with no valid connected game (no full-screen pin)', () => {
    // Regression test: the console must never snap to a full-screen pin anymore. While
    // disconnected the main menu is always shown instead (see M.CloseMenu()), and the console
    // itself is never drawn in that state (see SCR.isConsolePassiveBackdrop), so there's no
    // reason for con_current to jump to a "full screen" value.
    withMockConsoleRegistry({ worldmodel: null, signon: 0 }, (con) => {
      con.isOpen = false;
      SCR.con_current = 100;

      SCR.SetUpToDrawConsole();

      assert.equal(con.forcedup, true);
      assert.ok(SCR.con_current < 100 && SCR.con_current >= 0, 'animates down toward 0, same as the connected case');
    });
  });

  void test('slides open toward the normal drawer height when forced up and actively toggled open', () => {
    withMockConsoleRegistry({ worldmodel: null, signon: 0 }, (con) => {
      con.isOpen = true;
      SCR.con_current = 0;

      SCR.SetUpToDrawConsole();

      assert.equal(con.forcedup, true);
      assert.ok(SCR.con_current > 0 && SCR.con_current <= 100);
    });
  });

  void test('slides open/closed at the normal drawer height with a valid connected game', () => {
    withMockConsoleRegistry({ worldmodel: {}, signon: 4 }, (con) => {
      con.isOpen = true;
      SCR.con_current = 0;

      SCR.SetUpToDrawConsole();

      assert.equal(con.forcedup, false);
      assert.ok(SCR.con_current > 0 && SCR.con_current <= 100);
    });
  });

  void test('slides closed when not toggled open and there is a valid connected game', () => {
    withMockConsoleRegistry({ worldmodel: {}, signon: 4 }, (con) => {
      con.isOpen = false;
      SCR.con_current = 100;

      SCR.SetUpToDrawConsole();

      assert.equal(con.forcedup, false);
      assert.ok(SCR.con_current < 100 && SCR.con_current >= 0);
    });
  });
});

void describe('SCR.isConsolePassiveBackdrop', () => {
  void test('true only when forced up and not actively toggled open', () => {
    withMockConsoleRegistry({ worldmodel: null, signon: 0 }, (con) => {
      SCR.SetUpToDrawConsole(); // sets Con.forcedup from the mocked CL state
      con.isOpen = false;

      assert.equal(SCR.isConsolePassiveBackdrop(), true);
    });
  });

  void test('false while actively open, even with no game connected', () => {
    withMockConsoleRegistry({ worldmodel: null, signon: 0 }, (con) => {
      SCR.SetUpToDrawConsole();
      con.isOpen = true;

      assert.equal(SCR.isConsolePassiveBackdrop(), false);
    });
  });

  void test('false while mid-close-animation with a valid connected game', () => {
    // Regression test: draw-order must keep the drawer on top of the menu for the entire
    // closing slide while connected, not just while Con.isOpen is still true.
    withMockConsoleRegistry({ worldmodel: {}, signon: 4 }, (con) => {
      SCR.SetUpToDrawConsole();
      con.isOpen = false; // just toggled closed, con_current is still animating down

      assert.equal(SCR.isConsolePassiveBackdrop(), false);
    });
  });
});

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

void describe('SCR.DrawNet', () => {
  /**
   * Installs `CL`/`Host`/`Draw`/`R` registry stubs for `SCR.DrawNet()`.
   * @param {{ state: number, demoplayback?: boolean, lastReceivedMessage?: number, realtime?: number }} options
   * @param {() => void} callback test callback
   * @returns {Array<{ x: number, y: number, pic: unknown }>} Calls made to the mocked `Draw.Pic`.
   */
  function withMockNetRegistry({ state, demoplayback = false, lastReceivedMessage = 0, realtime = 1 }, callback) {
    const previousCL = registry.CL;
    const previousHost = registry.Host;
    const previousDraw = registry.Draw;
    const previousR = registry.R;
    const previousNet = SCR.net;
    const picCalls = [];

    registry.CL = { cls: { state, demoplayback }, state: { last_received_message: lastReceivedMessage } };
    registry.Host = { realtime };
    registry.Draw = { Pic(x, y, pic) { picCalls.push({ x, y, pic }); } };
    registry.R = { refdef: { vrect: { x: 0, y: 0 } } };
    SCR.net = 'net-pic';
    eventBus.publish('registry.frozen');

    try {
      callback();
      return picCalls;
    } finally {
      registry.CL = previousCL;
      registry.Host = previousHost;
      registry.Draw = previousDraw;
      registry.R = previousR;
      SCR.net = previousNet;
      eventBus.publish('registry.frozen');
    }
  }

  void test('does not draw while disconnected, even though last_received_message is stale from boot', () => {
    // Regression test: last_received_message defaults to 0 and is only ever set once a message
    // actually arrives, so realtime - 0 exceeds the 0.3s threshold within a fraction of a second
    // after boot -- without the connection-state guard this drew a permanent false "bad ping"
    // indicator while never having connected at all.
    const picCalls = withMockNetRegistry({ state: clientConnectionState.disconnected, realtime: 5 }, () => {
      SCR.DrawNet();
    });

    assert.deepEqual(picCalls, []);
  });

  void test('does not draw while still connecting', () => {
    const picCalls = withMockNetRegistry({ state: clientConnectionState.connecting, realtime: 5 }, () => {
      SCR.DrawNet();
    });

    assert.deepEqual(picCalls, []);
  });

  void test('draws once connected and no message has arrived in over 0.3s', () => {
    const picCalls = withMockNetRegistry({ state: clientConnectionState.connected, lastReceivedMessage: 1, realtime: 1.5 }, () => {
      SCR.DrawNet();
    });

    assert.deepEqual(picCalls, [{ x: 0, y: 0, pic: 'net-pic' }]);
  });

  void test('does not draw while connected and a message arrived recently', () => {
    const picCalls = withMockNetRegistry({ state: clientConnectionState.connected, lastReceivedMessage: 1.4, realtime: 1.5 }, () => {
      SCR.DrawNet();
    });

    assert.deepEqual(picCalls, []);
  });

  void test('does not draw during demo playback even if connected and lagging', () => {
    const picCalls = withMockNetRegistry({ state: clientConnectionState.connected, demoplayback: true, lastReceivedMessage: 1, realtime: 5 }, () => {
      SCR.DrawNet();
    });

    assert.deepEqual(picCalls, []);
  });
});
