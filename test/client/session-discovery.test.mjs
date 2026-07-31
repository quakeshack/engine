import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventBus, registry } from '../../source/engine/registry.ts';
import SessionDiscovery from '../../source/engine/client/menu/SessionDiscovery.ts';

/**
 * A minimal `WebRTCDriver` test double for the ping-probe lifecycle (`startSessionPing`/
 * `stopSessionPing`). Records every call so tests can assert on it, and keeps each session's
 * `onPing` callback so a test can simulate a probe reporting a fresh RTT (or `null` for
 * unreachable) whenever it likes via `simulatePing`.
 */
class FakeWebRTCDriver {
  constructor() {
    this.startCalls = /** @type {string[]} */ ([]);
    this.stopCalls = /** @type {string[]} */ ([]);
    this.onPingCallbacks = /** @type {Map<string, (rtt: number | null) => void>} */ (new Map());
  }

  /**
   * @param {string} sessionId
   * @param {(rtt: number | null) => void} onPing
   */
  startSessionPing(sessionId, onPing) {
    this.startCalls.push(sessionId);
    this.onPingCallbacks.set(sessionId, onPing);
  }

  /** @param {string} sessionId */
  stopSessionPing(sessionId) {
    this.stopCalls.push(sessionId);
    this.onPingCallbacks.delete(sessionId);
  }

  /**
   * Simulates a probe reporting a fresh RTT (or `null` for unreachable) for a session.
   * @param {string} sessionId
   * @param {number | null} rtt
   */
  simulatePing(sessionId, rtt) {
    this.onPingCallbacks.get(sessionId)?.(rtt);
  }
}

/**
 * Installs the minimal `COM`/`urls`/`Con`/`NET` registry SessionDiscovery needs (`Con` silenced the
 * same way `network-drivers.test.mjs`'s `withSignalingScenario` does, since `subscribe()` logs
 * through it). `NET.driverRegistry.get('webrtc')` resolves to a fresh `FakeWebRTCDriver`, passed to
 * `callback` so tests can assert on/drive the ping-probe lifecycle.
 * @param {string} game active COM.game to simulate for the local client
 * @param {(webRTCDriver: FakeWebRTCDriver) => Promise<void>} callback async test callback
 * @param {{ urls?: { signalingURL?: string } }} [options] registry overrides, e.g. to simulate no signaling URL
 */
async function withMockDiscoveryRegistry(game, callback, options = {}) {
  const previousCOM = registry.COM;
  const previousUrls = registry.urls;
  const previousCon = registry.Con;
  const previousNET = registry.NET;

  const webRTCDriver = new FakeWebRTCDriver();

  registry.COM = { game };
  registry.urls = options.urls ?? { signalingURL: 'wss://master.example.test/signal' };
  registry.Con = { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {} };
  registry.NET = { driverRegistry: { get: (name) => (name === 'webrtc' ? webRTCDriver : null) } };
  eventBus.publish('registry.frozen');

  try {
    await callback(webRTCDriver);
  } finally {
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    registry.COM = previousCOM;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    registry.urls = previousUrls;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    registry.Con = previousCon;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    registry.NET = previousNET;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Temporarily replaces the global fetch with one that resolves to the given JSON body.
 * @param {object} jsonBody payload returned by response.json()
 * @param {() => Promise<void>} callback async test callback
 */
async function withMockFetch(jsonBody, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(jsonBody) });

  try {
    await callback();
  } finally {
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    globalThis.fetch = previousFetch;
  }
}

void describe('SessionDiscovery.listSessions', () => {
  void test('only returns sessions running the same game (mod) as this client', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockFetch({
        servers: [
          { sessionId: 'same-game', serverInfo: { hostname: 'Alice\'s Server', map: 'start', mod: 'hellwave', currentPlayers: 1, maxPlayers: 8, colo: 'sea', country: 'US' } },
          { sessionId: 'other-game', serverInfo: { map: 'e1m1', mod: 'id1', currentPlayers: 2, maxPlayers: 8 } },
          { sessionId: 'no-mod', serverInfo: { map: 'unknown', currentPlayers: 0, maxPlayers: 8 } },
        ],
      }, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, [
          { sessionId: 'same-game', hostname: 'Alice\'s Server', map: 'start', currentPlayers: 1, maxPlayers: 8, colo: 'sea', country: 'US', settings: {}, ping: null, pingUnreachable: false },
        ]);
      });
    });
  });

  void test('fills in defaults for missing serverInfo fields', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockFetch({
        servers: [{ sessionId: 'sparse', serverInfo: { mod: 'id1' } }],
      }, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, [
          { sessionId: 'sparse', hostname: 'UNNAMED', map: '?', currentPlayers: 0, maxPlayers: 0, colo: null, country: null, settings: {}, ping: null, pingUnreachable: false },
        ]);
      });
    });
  });

  void test('passes through the settings blob reported by the host', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockFetch({
        servers: [
          { sessionId: 'with-settings', serverInfo: { mod: 'hellwave', map: 'hw_doom', settings: { hw_rounds: '10', hw_round_current: '3' } } },
        ],
      }, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions[0].settings, { hw_rounds: '10', hw_round_current: '3' });
      });
    });
  });

  void test('returns an empty list when the response has no servers', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockFetch({}, async () => {
        const sessions = await SessionDiscovery.listSessions();

        assert.deepEqual(sessions, []);
      });
    });
  });

  void test('throws when no signaling URL is configured', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await assert.rejects(() => SessionDiscovery.listSessions(), /Signaling URL is unavailable/);
    }, { urls: {} });
  });
});

/**
 * A minimal `/browser` WebSocket test double. Tracks every constructed instance (there's no
 * shared one in this repo yet, see `test/common/network-drivers.test.mjs`, which only exercises
 * `WebRTCDriver.Init()`'s URL derivation and never opens a socket) so tests can reach in and
 * simulate server behavior.
 */
class FakeWebSocket {
  static instances = /** @type {FakeWebSocket[]} */ ([]);

  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sentMessages = /** @type {string[]} */ ([]);
    this.onopen = /** @type {(() => void) | null} */ (null);
    this.onmessage = /** @type {((event: { data: string }) => void) | null} */ (null);
    this.onerror = /** @type {((event: unknown) => void) | null} */ (null);
    this.onclose = /** @type {(() => void) | null} */ (null);
    FakeWebSocket.instances.push(this);
  }

  /** @param {string} data */
  send(data) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  /** Simulates the server accepting the connection. */
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  /** @param {object} payload JSON-serializable `/browser` push message */
  simulateMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Simulates the connection dropping (network hiccup, master server restart, etc). */
  simulateClose() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

/**
 * Installs `FakeWebSocket` as the global `WebSocket` constructor plus a bare `location` (matching
 * how `network-drivers.test.mjs`'s `withSignalingScenario` mocks it -- `SessionDiscovery` derives
 * the `/browser` scheme from `location.protocol`, the same rule `WebRTCDriver.Init()` uses for
 * `/signaling`), restoring both afterward.
 * @param {() => Promise<void> | void} callback test callback
 */
async function withMockWebSocket(callback) {
  const previousWebSocket = globalThis.WebSocket;
  const previousLocation = globalThis.location;

  FakeWebSocket.instances.length = 0;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: 'https:', hostname: 'master.example.test' };

  try {
    await callback();
  } finally {
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    globalThis.WebSocket = previousWebSocket;
    // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
    globalThis.location = previousLocation;
  }
}

void describe('SessionDiscovery.subscribe', () => {
  void test('opens exactly one /browser connection and delivers the initial server-list snapshot', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockWebSocket(() => {
        const received = [];
        const statuses = [];

        const unsubscribe = SessionDiscovery.subscribe(
          (sessions) => received.push(sessions),
          (status) => statuses.push(status),
        );

        assert.equal(FakeWebSocket.instances.length, 1);
        assert.equal(FakeWebSocket.instances[0].url, 'wss://master.example.test/browser');
        assert.deepEqual(statuses, ['connecting']);

        FakeWebSocket.instances[0].simulateOpen();
        assert.deepEqual(statuses, ['connecting', 'live']);

        FakeWebSocket.instances[0].simulateMessage({
          type: 'server-list',
          servers: [
            { sessionId: 'a', serverInfo: { hostname: 'Alice', map: 'start', mod: 'hellwave', currentPlayers: 1, maxPlayers: 8 } },
            { sessionId: 'b', serverInfo: { map: 'e1m1', mod: 'id1' } },
          ],
        });

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], [
          { sessionId: 'a', hostname: 'Alice', map: 'start', currentPlayers: 1, maxPlayers: 8, colo: null, country: null, settings: {}, ping: null, pingUnreachable: false },
        ]);

        unsubscribe();
      });
    });
  });

  void test('upserts and removes sessions from live server-added/server-updated/server-removed diffs', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockWebSocket(() => {
        const received = [];
        const unsubscribe = SessionDiscovery.subscribe((sessions) => received.push(sessions));
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();

        ws.simulateMessage({ type: 'server-list', servers: [] });
        assert.deepEqual(received.at(-1), []);

        ws.simulateMessage({
          type: 'server-added',
          server: { sessionId: 'x', serverInfo: { mod: 'id1', map: 'dm3', currentPlayers: 1, maxPlayers: 4 } },
        });
        assert.deepEqual(received.at(-1), [
          { sessionId: 'x', hostname: 'UNNAMED', map: 'dm3', currentPlayers: 1, maxPlayers: 4, colo: null, country: null, settings: {}, ping: null, pingUnreachable: false },
        ]);

        ws.simulateMessage({
          type: 'server-updated',
          server: { sessionId: 'x', serverInfo: { mod: 'id1', map: 'dm3', currentPlayers: 2, maxPlayers: 4 } },
        });
        assert.equal(received.at(-1)[0].currentPlayers, 2);

        ws.simulateMessage({ type: 'server-removed', sessionId: 'x' });
        assert.deepEqual(received.at(-1), []);

        unsubscribe();
      });
    });
  });

  void test('shares one connection across concurrent subscribers, closing it only once every subscriber has left', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockWebSocket(() => {
        const unsubscribeA = SessionDiscovery.subscribe(() => {});
        const unsubscribeB = SessionDiscovery.subscribe(() => {});

        assert.equal(FakeWebSocket.instances.length, 1);

        unsubscribeA();
        assert.equal(FakeWebSocket.instances[0].readyState, 0); // still open, second subscriber remains

        unsubscribeB();
        assert.equal(FakeWebSocket.instances[0].readyState, 3); // closed once the last subscriber leaves

        const unsubscribeC = SessionDiscovery.subscribe(() => {});
        assert.equal(FakeWebSocket.instances.length, 2); // a fresh connection opens for the next subscriber

        unsubscribeC();
      });
    });
  });

  void test('a subscriber joining an already-live channel gets the current snapshot immediately, without opening a second connection', async () => {
    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockWebSocket(() => {
        const unsubscribeA = SessionDiscovery.subscribe(() => {});
        FakeWebSocket.instances[0].simulateOpen();
        FakeWebSocket.instances[0].simulateMessage({
          type: 'server-list',
          servers: [{ sessionId: 'a', serverInfo: { mod: 'hellwave', map: 'hw_doom' } }],
        });

        const receivedB = [];
        const statusesB = [];
        const unsubscribeB = SessionDiscovery.subscribe(
          (sessions) => receivedB.push(sessions),
          (status) => statusesB.push(status),
        );

        assert.equal(FakeWebSocket.instances.length, 1);
        assert.deepEqual(statusesB, ['live']);
        assert.equal(receivedB.length, 1);
        assert.equal(receivedB[0][0].sessionId, 'a');

        unsubscribeA();
        unsubscribeB();
      });
    });
  });

  void test('reconnects after the channel drops, reporting "reconnecting" in between', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    await withMockDiscoveryRegistry('hellwave', async () => {
      await withMockWebSocket(() => {
        const statuses = [];
        const unsubscribe = SessionDiscovery.subscribe(() => {}, (status) => statuses.push(status));

        FakeWebSocket.instances[0].simulateOpen();
        FakeWebSocket.instances[0].simulateClose();

        assert.deepEqual(statuses, ['connecting', 'live', 'reconnecting']);
        assert.equal(FakeWebSocket.instances.length, 1);

        t.mock.timers.tick(5000);

        assert.equal(FakeWebSocket.instances.length, 2);

        unsubscribe();
      });
    });
  });

  void test('reports "unavailable" and never opens a socket when no signaling URL is configured', async () => {
    await withMockDiscoveryRegistry('id1', async () => {
      await withMockWebSocket(() => {
        const statuses = [];
        const unsubscribe = SessionDiscovery.subscribe(() => {}, (status) => statuses.push(status));

        assert.deepEqual(statuses, ['unavailable']);
        assert.equal(FakeWebSocket.instances.length, 0);

        unsubscribe(); // must be safely callable even though nothing was ever opened
      });
    }, { urls: {} });
  });
});

// Coverage for plans/session-ping-latency.md Phase 4: SessionDiscovery owns the ping-probe
// lifecycle for every live session (start on appearance, stop on removal/disconnect), and sorts by
// bracket rather than raw ms so a session only reorders when it crosses a bracket boundary.
void describe('SessionDiscovery ping probes', () => {
  void test('starts a ping probe when a session appears and reports ping updates through onSessions', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const received = [];
        const unsubscribe = SessionDiscovery.subscribe((sessions) => received.push(sessions));
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();

        ws.simulateMessage({
          type: 'server-list',
          servers: [{ sessionId: 'a', serverInfo: { mod: 'hellwave', map: 'start' } }],
        });

        assert.deepEqual(webRTCDriver.startCalls, ['a']);
        assert.equal(received.at(-1)[0].ping, null);
        assert.equal(received.at(-1)[0].pingUnreachable, false);

        webRTCDriver.simulatePing('a', 42);

        assert.equal(received.at(-1)[0].ping, 42);
        assert.equal(received.at(-1)[0].pingUnreachable, false);

        unsubscribe();
      });
    });
  });

  void test('never starts a probe for a session running a different game', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const unsubscribe = SessionDiscovery.subscribe(() => {});
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({ type: 'server-list', servers: [{ sessionId: 'other', serverInfo: { mod: 'id1' } }] });

        assert.deepEqual(webRTCDriver.startCalls, []);

        unsubscribe();
      });
    });
  });

  void test('stops the ping probe when a session is removed', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const unsubscribe = SessionDiscovery.subscribe(() => {});
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({ type: 'server-list', servers: [{ sessionId: 'a', serverInfo: { mod: 'hellwave' } }] });

        assert.deepEqual(webRTCDriver.startCalls, ['a']);

        ws.simulateMessage({ type: 'server-removed', sessionId: 'a' });

        assert.deepEqual(webRTCDriver.stopCalls, ['a']);

        unsubscribe();
      });
    });
  });

  void test('stops every running probe once the last subscriber unsubscribes', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const unsubscribe = SessionDiscovery.subscribe(() => {});
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({
          type: 'server-list',
          servers: [
            { sessionId: 'a', serverInfo: { mod: 'hellwave' } },
            { sessionId: 'b', serverInfo: { mod: 'hellwave' } },
          ],
        });

        assert.deepEqual(webRTCDriver.startCalls, ['a', 'b']);

        unsubscribe();

        assert.deepEqual(webRTCDriver.stopCalls.slice().sort(), ['a', 'b']);
      });
    });
  });

  void test('ignores a stale onPing callback from a probe that was already stopped', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const received = [];
        const unsubscribe = SessionDiscovery.subscribe((sessions) => received.push(sessions));
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({ type: 'server-list', servers: [{ sessionId: 'a', serverInfo: { mod: 'hellwave' } }] });

        const staleOnPing = webRTCDriver.onPingCallbacks.get('a');
        ws.simulateMessage({ type: 'server-removed', sessionId: 'a' });

        const notifyCountBeforeStalePing = received.length;
        staleOnPing(99); // arrives after the probe (and the session itself) was already removed

        assert.equal(received.length, notifyCountBeforeStalePing);

        unsubscribe();
      });
    });
  });

  void test('sorts sessions by ping bracket, not raw ping, and never reorders within a bracket', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const received = [];
        const unsubscribe = SessionDiscovery.subscribe((sessions) => received.push(sessions));
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({
          type: 'server-list',
          servers: [
            { sessionId: 'slow', serverInfo: { mod: 'hellwave' } },
            { sessionId: 'fast', serverInfo: { mod: 'hellwave' } },
            { sessionId: 'medium', serverInfo: { mod: 'hellwave' } },
          ],
        });

        webRTCDriver.simulatePing('slow', 400); // bracket 4 ("350ms+")
        webRTCDriver.simulatePing('fast', 20); // bracket 0 ("<60ms")
        webRTCDriver.simulatePing('medium', 90); // bracket 1 ("60-120ms")

        assert.deepEqual(received.at(-1).map((s) => s.sessionId), ['fast', 'medium', 'slow']);

        // A fluctuation that stays within the same bracket must not reorder anything.
        webRTCDriver.simulatePing('fast', 55); // still bracket 0
        assert.deepEqual(received.at(-1).map((s) => s.sessionId), ['fast', 'medium', 'slow']);

        unsubscribe();
      });
    });
  });

  void test('sorts "still probing" after every measured bracket, and "unreachable" last of all', async () => {
    await withMockDiscoveryRegistry('hellwave', async (webRTCDriver) => {
      await withMockWebSocket(() => {
        const received = [];
        const unsubscribe = SessionDiscovery.subscribe((sessions) => received.push(sessions));
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        ws.simulateMessage({
          type: 'server-list',
          servers: [
            { sessionId: 'measuring', serverInfo: { mod: 'hellwave' } },
            { sessionId: 'measured', serverInfo: { mod: 'hellwave' } },
            { sessionId: 'dead', serverInfo: { mod: 'hellwave' } },
          ],
        });

        webRTCDriver.simulatePing('measured', 30);
        webRTCDriver.simulatePing('dead', null);
        // 'measuring' never gets a ping at all -- stays in the "still probing" state.

        const bySessionId = Object.fromEntries(received.at(-1).map((s) => [s.sessionId, s]));

        assert.deepEqual(received.at(-1).map((s) => s.sessionId), ['measured', 'measuring', 'dead']);
        assert.equal(bySessionId.dead.pingUnreachable, true);
        assert.equal(bySessionId.measuring.ping, null);
        assert.equal(bySessionId.measuring.pingUnreachable, false);

        unsubscribe();
      });
    });
  });
});
