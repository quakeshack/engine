import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTestNetwork } from '../support/fixtures.ts';
import { ABSENT, installGlobals } from '../support/globals.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import type { URLs } from '../../source/engine/build-config';
import { BaseDriver, LoopDriver, QSocket, WebRTCDriver } from '../../source/engine/network/NetworkDrivers.ts';

class RecordingDriver extends BaseDriver {
  calls: Array<[string, QSocket, number?]> = [];

  constructor(net = createTestNetwork()) {
    super('recording', net);
    this.initialized = true;
  }

  override GetMessage(qsocket: QSocket): number {
    this.calls.push(['GetMessage', qsocket]);
    return 7;
  }

  override SendMessage(qsocket: QSocket, data: SzBuffer): number {
    this.calls.push(['SendMessage', qsocket, data.cursize]);
    return 1;
  }

  override SendUnreliableMessage(qsocket: QSocket, data: SzBuffer): number {
    this.calls.push(['SendUnreliableMessage', qsocket, data.cursize]);
    return 1;
  }

  override CanSendMessage(qsocket: QSocket): boolean {
    this.calls.push(['CanSendMessage', qsocket]);
    return true;
  }

  override Close(qsocket: QSocket): void {
    this.calls.push(['Close', qsocket]);
    super.Close(qsocket);
  }
}

void describe('NetworkDrivers', () => {
  void test('QSocket delegates to its driver', () => {
    const driver = new RecordingDriver();
    const sock = new QSocket(driver, 5);
    const message = new SzBuffer(16, 'socket-delegation');

    sock.state = QSocket.STATE_CONNECTED;
    message.writeByte(42);

    assert.equal(sock.GetMessage(), 7);
    assert.equal(sock.SendMessage(message), 1);
    assert.equal(sock.SendUnreliableMessage(message), 1);
    assert.equal(sock.CanSendMessage(), true);

    sock.Close();

    assert.equal(sock.state, QSocket.STATE_DISCONNECTED);
    assert.deepEqual(driver.calls.map(([name]) => name), [
      'GetMessage',
      'SendMessage',
      'SendUnreliableMessage',
      'CanSendMessage',
      'Close',
    ]);
  });

  void test('LoopDriver round-trips a reliable local message', () => {
    const net = createTestNetwork();
    const driver = new LoopDriver(net);
    const serverSock = driver.Connect('local');
    const clientSock = driver.CheckNewConnections();

    assert.ok(serverSock instanceof QSocket);
    assert.ok(clientSock instanceof QSocket);

    const payload = new SzBuffer(16, 'loop-message');
    payload.writeByte(99);

    assert.equal(serverSock.SendMessage(payload), 1);
    assert.equal(serverSock.CanSendMessage(), false);
    assert.equal(clientSock.GetMessage(), 1);
    assert.equal(new Uint8Array(net.message.data)[0], 99);
    assert.equal(serverSock.CanSendMessage(), true);
    assert.equal(clientSock.transportState?.kind, 'loopback');
    assert.equal(clientSock.transportState?.peer, serverSock);
  });
});

/**
 * Installs a `location` global (bare, not `window.location` -- matching how `NetworkDrivers.ts`
 * reads it) and a `window` stub, builds a network layer for the scenario, and restores the globals afterward.
 * @param overrides scenario overrides
 * @param callback test callback
 */
function withSignalingScenario(overrides: { location: { protocol: string, hostname: string }, urls?: { signalingURL?: string }, dedicated?: boolean, window?: object }, callback: (net: NET) => void): void {
  const restore = installGlobals({
    location: overrides.location,
    window: overrides.window ?? { addEventListener() {}, removeEventListener() {} },
  });

  try {
    callback(createTestNetwork({ dedicated: overrides.dedicated ?? false, urls: overrides.urls as URLs | undefined }));
  } finally {
    restore();
  }
}

/**
 * Minimal `window` stub that records the single listener registered per event type (browser
 * `addEventListener` semantics for the same handler reference are irrelevant here -- the driver
 * only ever registers one 'pagehide' handler). Lets a test dispatch the event directly and
 * confirm `Shutdown()` removes the exact same reference `Init()` installed.
 * @returns Stub with `addEventListener`/`removeEventListener` plus test-only `dispatch`/`has`.
 */
function createWindowStub(): { addEventListener(type: string, handler: (event: unknown) => void): void; removeEventListener(type: string, handler: (event: unknown) => void): void; dispatch(type: string, event: unknown): void; has(type: string): boolean } {
  const listeners = new Map<string, (event: unknown) => void>();

  return {
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      if (listeners.get(type) === handler) {
        listeners.delete(type);
      }
    },
    dispatch(type: string, event: unknown) {
      listeners.get(type)?.(event);
    },
    has(type: string) {
      return listeners.has(type);
    },
  };
}

void describe('WebRTCDriver.Init', () => {
  void test('defaults to ws(s)://<hostname>:8787/signaling when no signaling URL is configured', () => {
    withSignalingScenario({ location: { protocol: 'https:', hostname: 'play.quakeshack.dev' } }, (net) => {
      const driver = new WebRTCDriver(net);

      assert.equal(driver.Init(), true);
      assert.equal(driver.signalingUrl, 'wss://play.quakeshack.dev:8787/signaling');
    });
  });

  void test('appends /signaling to a configured signaling origin instead of connecting to it verbatim', () => {
    // Regression test: the master server only accepts a WebRTC signaling connection on the
    // `/signaling` path (see quakeshack-master's `isWebSocketEndpoint`). Connecting to the bare
    // configured origin instead hits the root path, which falls through to the static-asset
    // handler and returns a plain 200 instead of upgrading the WebSocket.
    withSignalingScenario({
      location: { protocol: 'http:', hostname: 'localhost' },
      urls: { signalingURL: 'http://localhost:8787' },
    }, (net) => {
      const driver = new WebRTCDriver(net);

      driver.Init();
      assert.equal(driver.signalingUrl, 'ws://localhost:8787/signaling');
    });
  });

  void test('always derives ws/wss from the current page, ignoring the configured URL\'s own scheme', () => {
    withSignalingScenario({
      location: { protocol: 'https:', hostname: 'localhost' },
      urls: { signalingURL: 'http://master.example.test' },
    }, (net) => {
      const driver = new WebRTCDriver(net);

      driver.Init();
      assert.equal(driver.signalingUrl, 'wss://master.example.test/signaling');
    });
  });

  void test('does nothing on a dedicated server', () => {
    withSignalingScenario({
      location: { protocol: 'http:', hostname: 'localhost' },
      dedicated: true,
    }, (net) => {
      const driver = new WebRTCDriver(net);

      assert.equal(driver.Init(), false);
      assert.equal(driver.initialized, false);
      assert.equal(driver.signalingUrl, null);
    });
  });

  // Regression test: `DriverRegistry.shutdown()` calls `Shutdown()` on every registered driver,
  // including ones whose `Init()` bailed out early (see `getInitializedDrivers()` vs.
  // `shutdown()` in DriverRegistry.ts). On a dedicated server `Init()` never installs the
  // `pagehide` listener, so `Shutdown()` must not assume `window` exists either -- it doesn't in
  // Node.js, and this used to throw `ReferenceError: window is not defined` out of `quit`
  // (`nav_build_process 1` navmesh baking), which was misreported as a nav-save failure and left
  // the process hanging past its intended `exit(0)`.
  void test('Shutdown does not touch `window` on a dedicated server, where Init never ran', () => {
    // A dedicated server (Node.js) never has a `window` global.
    const restore = installGlobals({ location: { protocol: 'http:', hostname: 'localhost' }, window: ABSENT });

    try {
      const driver = new WebRTCDriver(createTestNetwork({ dedicated: true }));

      assert.equal(driver.Init(), false);
      assert.doesNotThrow(() => { driver.Shutdown(); });
    } finally {
      restore();
    }
  });
});

// Coverage for tearing down a hosted session when the tab actually closes, instead of leaving
// the master server to discover it via the stale-session sweep (see the master server's
// STALE_SESSION_THRESHOLD_MS / MAINTENANCE_INTERVAL_MS).
void describe('WebRTCDriver pagehide handling', () => {
  void test('stops hosting when the tab closes while a session is active', () => {
    const windowStub = createWindowStub();

    withSignalingScenario({ location: { protocol: 'http:', hostname: 'localhost' }, window: windowStub }, (net) => {
      const driver = new WebRTCDriver(net);
      driver.Init();
      driver.isHost = true;

      let listenCalledWith;
      driver.Listen = (listening) => { listenCalledWith = listening; };

      windowStub.dispatch('pagehide', { persisted: false });

      assert.equal(listenCalledWith, false);
    });
  });

  void test('does nothing when the tab was never hosting', () => {
    const windowStub = createWindowStub();

    withSignalingScenario({ location: { protocol: 'http:', hostname: 'localhost' }, window: windowStub }, (net) => {
      const driver = new WebRTCDriver(net);
      driver.Init();
      driver.isHost = false;

      let listenCalled = false;
      driver.Listen = () => { listenCalled = true; };

      windowStub.dispatch('pagehide', { persisted: false });

      assert.equal(listenCalled, false);
    });
  });

  void test('does not tear down the session when the page is entering the bfcache', () => {
    const windowStub = createWindowStub();

    withSignalingScenario({ location: { protocol: 'http:', hostname: 'localhost' }, window: windowStub }, (net) => {
      const driver = new WebRTCDriver(net);
      driver.Init();
      driver.isHost = true;

      let listenCalled = false;
      driver.Listen = () => { listenCalled = true; };

      windowStub.dispatch('pagehide', { persisted: true });

      assert.equal(listenCalled, false);
    });
  });

  void test('Shutdown removes the pagehide listener installed by Init', () => {
    const windowStub = createWindowStub();

    withSignalingScenario({ location: { protocol: 'http:', hostname: 'localhost' }, window: windowStub }, (net) => {
      const driver = new WebRTCDriver(net);
      driver.Init();

      assert.equal(windowStub.has('pagehide'), true);

      driver.Shutdown();

      assert.equal(windowStub.has('pagehide'), false);
    });
  });
});

// Coverage for plans/session-ping-latency.md Phase 2: the host side of an out-of-band
// (connectionless) peer connection, which must never allocate a QSocket/ServerClient and must
// enforce every cap locally, on values it tracks itself -- never trusting the remote peer's claims.

/**
 * Minimal mock `RTCDataChannel` -- open by default (tests don't need to model the
 * connecting -> open transition), records every sent buffer, and mirrors the real API's
 * idempotent `close()` (no repeated `onclose` firing) so a driver bug that double-closes doesn't
 * silently pass by relying on a too-forgiving mock.
 */
class MockRTCDataChannel {
  label: string;
  options: object;
  readyState = 'open';
  binaryType: string | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  sentMessages: ArrayBuffer[] = [];

  constructor(label: string, options: object = {}) {
    this.label = label;
    this.options = options;
  }

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') {
      throw new Error('MockRTCDataChannel: DataChannel is not open');
    }

    this.sentMessages.push(data);
  }

  close() {
    if (this.readyState === 'closed') {
      return;
    }

    this.readyState = 'closed';
    this.onclose?.();
  }
}

/** Minimal mock `RTCSessionDescription` -- Node has no WebRTC globals, so this must be installed too. */
class MockRTCSessionDescription {
  constructor(init: object) {
    Object.assign(this, init);
  }
}

/** Minimal mock `RTCIceCandidate` -- Node has no WebRTC globals, so this must be installed too. */
class MockRTCIceCandidate {
  constructor(init: object) {
    Object.assign(this, init);
  }
}

/**
 * Minimal mock `RTCPeerConnection`. `createOffer`/`setLocalDescription` resolve immediately with a
 * fake description -- tests that need to observe the resulting `offer` signaling message await
 * `flushMicrotasks()` first.
 */
class MockRTCPeerConnection {
  config: unknown;
  connectionState = 'new';
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: MockRTCDataChannel }) => void) | null = null;
  dataChannels: MockRTCDataChannel[] = [];
  closed = false;
  addedIceCandidates: unknown[] = [];

  constructor(config: unknown, registry_: MockRTCPeerConnection[]) {
    this.config = config;
    registry_.push(this);
  }

  createDataChannel(label: string, options: object): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label, options);
    this.dataChannels.push(channel);
    return channel;
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' });
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'mock-answer-sdp' });
  }

  setLocalDescription(description: unknown) {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: unknown) {
    this.addedIceCandidates.push(candidate);
    return Promise.resolve();
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.connectionState = 'closed';
  }
}

/** Minimal mock signaling `WebSocket`, always already-connecting (readyState 0) like a real one. */
class MockSignalingWebSocket {
  url: string;
  readyState = 0;
  sentMessages: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string, registry_: MockSignalingWebSocket[]) {
    this.url = url;
    registry_.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3; // matches the real WebSocket.CLOSED value
  }
}

/**
 * Waits for any pending microtask chain (e.g. the offer-creation `.then()` chain) to settle.
 * @returns Resolves once every currently-queued microtask has run.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Builds a raw `'oob'` channel frame matching `WebRTCDriver`'s wire format.
 * @param type One of `WebRTCDriver.OOB_PING`/`OOB_PONG`, or an arbitrary byte for a malformed-frame test.
 * @param sequence The frame's sequence number.
 * @param timestamp The frame's timestamp (ms).
 * @returns A 13-byte buffer in the real `[type][sequence][timestamp]` layout.
 */
function buildOobFrame(type: number, sequence: number, timestamp: number): ArrayBuffer {
  const buffer = new ArrayBuffer(WebRTCDriver.OOB_FRAME_LENGTH);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setUint32(1, sequence, true);
  view.setFloat64(5, timestamp, true);
  return buffer;
}

/**
 * Decodes a raw `'oob'` channel frame (the counterpart to {@link buildOobFrame}) for assertions.
 * @param buffer A 13-byte frame, e.g. one captured from a mock channel's `sentMessages`.
 * @returns The frame's `type`/`sequence`/`timestamp` fields.
 */
function decodeOobFrame(buffer: ArrayBuffer): { type: number; sequence: number; timestamp: number } {
  const view = new DataView(buffer);
  return {
    type: view.getUint8(0),
    sequence: view.getUint32(1, true),
    timestamp: view.getFloat64(5, true),
  };
}

/**
 * Simulates a signaling message arriving on the mock WebSocket, exactly like a real
 * `ws.onmessage` event.
 * @param ws The mock signaling WebSocket to deliver the message on.
 * @param message The signaling message payload.
 */
async function deliverSignalingMessage(ws: MockSignalingWebSocket, message: object): Promise<void> {
  await ws.onmessage!({ data: JSON.stringify(message) });
}

/**
 * Sets up a hosting `WebRTCDriver` with mocked globals/registry and hands the test a driver
 * that's already `isHost`/has a `sessionId`, ready to receive `peer-joined` messages -- bypassing
 * the full create-session/session-created handshake, which the OOB path never touches anyway.
 * @param callback
 */
async function withOobHostScenario(callback: (scenario: { driver: WebRTCDriver, ws: MockSignalingWebSocket, createdPeerConnections: MockRTCPeerConnection[] }) => Promise<void>) {
  const net = createTestNetwork();
  const createdWebSockets: MockSignalingWebSocket[] = [];
  const createdPeerConnections: MockRTCPeerConnection[] = [];
  const restoreGlobals = installGlobals({
    WebSocket: class extends MockSignalingWebSocket {
      constructor(url: string) {
        super(url, createdWebSockets);
      }
    },
    RTCPeerConnection: class extends MockRTCPeerConnection {
      constructor(config: unknown) {
        super(config, createdPeerConnections);
      }
    },
    RTCSessionDescription: MockRTCSessionDescription,
    RTCIceCandidate: MockRTCIceCandidate,
    location: { protocol: 'http:', hostname: 'localhost' },
    window: { addEventListener() {}, removeEventListener() {} },
  });


  let driver: WebRTCDriver | undefined;

  try {
    driver = new WebRTCDriver(net);
    driver.Init();
    driver.Connect('webrtc://host');

    // A real host only ever gets here (receiving peer-joined) once its own signaling connection
    // is fully open -- simulate that instead of driving the full create-session/session-created
    // handshake, which the OOB path under test never touches.
    const ws = createdWebSockets.at(-1)!;
    ws.readyState = 1;
    driver.isHost = true;
    driver.sessionId = 'lobby';

    await callback({ driver, ws, createdPeerConnections });
  } finally {
    // Every OOB connection carries a real (30s) idle-close setTimeout -- clear it directly rather
    // than leaving it to fire after the registry/globals below have already been restored, which
    // would throw reading `Con.DPrint` on a torn-down mock.
    for (const state of driver?.oobConnections.values() ?? []) {
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer);
      }
    }

    restoreGlobals();
  }
}

void describe('WebRTCDriver out-of-band (probe) connections', () => {
  void test('an isOob peer-joined never creates a QSocket, only an OOB connection', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true, peerCount: 1 });

      assert.equal(driver.newConnections.length, 0);
      assert.equal(driver.oobConnections.size, 1);
      assert.ok(driver.oobConnections.has('prober1'));
    });
  });

  void test('creates a single oob data channel as initiator and sends an offer', async () => {
    await withOobHostScenario(async ({ driver, ws, createdPeerConnections }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      assert.equal(peerConnection!.dataChannels.length, 1);
      assert.equal(peerConnection!.dataChannels[0].label, 'oob');
      assert.deepEqual(peerConnection!.dataChannels[0].options, { ordered: false, maxRetransmits: 0 });

      const offerMessage = ws.sentMessages.find((message) => message.type === 'offer');
      assert.ok(offerMessage);
      assert.equal(offerMessage.targetPeerId, 'prober1');
      assert.equal(driver.oobConnections.get('prober1')!.channel, peerConnection!.dataChannels[0]);
    });
  });

  void test('refuses an OOB peer beyond MAX_OOB_CONNECTIONS_PER_HOST without constructing a new peer connection', async () => {
    await withOobHostScenario(async ({ driver, ws, createdPeerConnections }) => {
      for (let i = 0; i < WebRTCDriver.MAX_OOB_CONNECTIONS_PER_HOST; i++) {
         
        await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: `prober${i}`, isOob: true });
      }

      assert.equal(driver.oobConnections.size, WebRTCDriver.MAX_OOB_CONNECTIONS_PER_HOST);
      const peerConnectionCountBefore = createdPeerConnections.length;

      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'one-too-many', isOob: true });

      assert.equal(driver.oobConnections.size, WebRTCDriver.MAX_OOB_CONNECTIONS_PER_HOST);
      assert.equal(driver.oobConnections.has('one-too-many'), false);
      assert.equal(createdPeerConnections.length, peerConnectionCountBefore);
    });
  });

  void test('echoes a valid ping as a pong carrying the same sequence and timestamp', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      // The driver holds the mock channel the scenario's RTCPeerConnection handed it.
      const channel = driver.oobConnections.get('prober1')!.channel as unknown as MockRTCDataChannel;
      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PING, 42, 12345.5) });

      assert.equal(channel.sentMessages.length, 1);
      const pong = decodeOobFrame(channel.sentMessages[0]);
      assert.equal(pong.type, WebRTCDriver.OOB_PONG);
      assert.equal(pong.sequence, 42);
      assert.equal(pong.timestamp, 12345.5);
    });
  });

  void test('drops a second ping arriving before MIN_PING_INTERVAL_MS', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      // The driver holds the mock channel the scenario's RTCPeerConnection handed it.
      const channel = driver.oobConnections.get('prober1')!.channel as unknown as MockRTCDataChannel;
      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PING, 1, 100) });
      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PING, 2, 200) }); // same tick -- must be dropped

      assert.equal(channel.sentMessages.length, 1);
      assert.equal(decodeOobFrame(channel.sentMessages[0]).sequence, 1);
    });
  });

  void test('drops malformed frames (wrong size or an unrecognized type) without throwing', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      // The driver holds the mock channel the scenario's RTCPeerConnection handed it.
      const channel = driver.oobConnections.get('prober1')!.channel as unknown as MockRTCDataChannel;

      assert.doesNotThrow(() => { channel.onmessage!({ data: new ArrayBuffer(5) }); });
      assert.doesNotThrow(() => { channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PONG, 1, 100) }); });
      assert.doesNotThrow(() => { channel.onmessage!({ data: buildOobFrame(99, 1, 100) }); });

      assert.equal(channel.sentMessages.length, 0);
    });
  });

  void test('closes any data channel the remote peer opens beyond the one oob channel', async () => {
    await withOobHostScenario(async ({ ws, createdPeerConnections }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      const rogueChannel = new MockRTCDataChannel('reliable', {});

      peerConnection!.ondatachannel!({ channel: rogueChannel });

      assert.equal(rogueChannel.readyState, 'closed');
    });
  });

  void test('resets the idle-close timer on every valid ping', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      const state = driver.oobConnections.get('prober1')!;
      const firstTimer = state!.idleTimer;

      (state.channel as unknown as MockRTCDataChannel).onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PING, 1, 100) });

      assert.notEqual(state!.idleTimer, firstTimer);
    });
  });

  void test('a peer-left signal closes the matching OOB connection, not any QSocket', async () => {
    await withOobHostScenario(async ({ driver, ws }) => {
      await deliverSignalingMessage(ws, { type: 'peer-joined', peerId: 'prober1', isOob: true });
      await flushMicrotasks();

      const peerConnection = driver.oobConnections.get('prober1')!.peerConnection as unknown as MockRTCPeerConnection;

      await deliverSignalingMessage(ws, { type: 'peer-left', peerId: 'prober1' });

      assert.equal(driver.oobConnections.has('prober1'), false);
      assert.equal(peerConnection.closed, true);
      assert.equal(driver.newConnections.length, 0);
    });
  });
});

// Coverage for plans/session-ping-latency.md Phase 3: the viewer/browsing side of an out-of-band
// ping probe. The viewer is always the *answerer* (the host is always the initiator, matching
// #OnPeerJoined's convention for a real peer), and each probed session gets its own dedicated
// /signaling connection -- never the driver's own `signalingWs` -- since the master server tracks
// exactly one (sessionId, peerId) pair per signaling socket.

/**
 * Sets up a `WebRTCDriver` with mocked globals/registry for viewer-side (browsing) scenarios --
 * lighter than `withOobHostScenario`, since probing never touches `isHost`/`sessionId`/the driver's
 * own `signalingWs` at all.
 * @param callback
 */
async function withOobViewerScenario(callback: (scenario: { driver: WebRTCDriver, createdWebSockets: MockSignalingWebSocket[], createdPeerConnections: MockRTCPeerConnection[] }) => Promise<void> | void) {
  const net = createTestNetwork();
  const createdWebSockets: MockSignalingWebSocket[] = [];
  const createdPeerConnections: MockRTCPeerConnection[] = [];
  const restoreGlobals = installGlobals({
    WebSocket: class extends MockSignalingWebSocket {
      constructor(url: string) {
        super(url, createdWebSockets);
      }
    },
    RTCPeerConnection: class extends MockRTCPeerConnection {
      constructor(config: unknown) {
        super(config, createdPeerConnections);
      }
    },
    RTCSessionDescription: MockRTCSessionDescription,
    RTCIceCandidate: MockRTCIceCandidate,
    location: { protocol: 'http:', hostname: 'localhost' },
    window: { addEventListener() {}, removeEventListener() {} },
  });

  let driver: WebRTCDriver | undefined;

  try {
    driver = new WebRTCDriver(net);
    driver.Init();

    await callback({ driver, createdWebSockets, createdPeerConnections });
  } finally {
    // Every still-running probe owns a real setInterval (PING_INTERVAL_MS) -- stop them through
    // the same public API a real caller would use, rather than reaching into private state.
    for (const sessionId of Array.from(driver?.viewerOobProbes.keys() ?? [])) {
      driver!.stopSessionPing(sessionId);
    }

    restoreGlobals();
  }
}

/**
 * Opens (and marks ready) the one signaling socket a `startSessionPing` call creates.
 * @param createdWebSockets All signaling sockets created so far in the current scenario.
 * @returns The just-opened socket.
 */
function openLatestSignalingSocket(createdWebSockets: MockSignalingWebSocket[]): MockSignalingWebSocket {
  const ws = createdWebSockets.at(-1)!;
  ws.readyState = 1;
  ws.onopen!();
  return ws;
}

void describe('WebRTCDriver viewer-side out-of-band ping probes', () => {
  void test('opens a dedicated signaling connection per probe and sends join-session with role oob', async () => {
    await withOobViewerScenario(({ driver, createdWebSockets }) => {
      driver.startSessionPing('lobby-a', () => {});

      const ws = openLatestSignalingSocket(createdWebSockets);

      assert.equal(ws.sentMessages.length, 1);
      assert.deepEqual(ws.sentMessages[0], { type: 'join-session', sessionId: 'lobby-a', role: 'oob' });
    });
  });

  void test('probing two sessions opens two independent signaling connections', async () => {
    await withOobViewerScenario(({ driver, createdWebSockets }) => {
      driver.startSessionPing('lobby-a', () => {});
      driver.startSessionPing('lobby-b', () => {});

      assert.equal(createdWebSockets.length, 2);
      assert.notEqual(createdWebSockets[0], createdWebSockets[1]);
    });
  });

  void test('does not open a second signaling connection for an already-probed session', async () => {
    await withOobViewerScenario(({ driver, createdWebSockets }) => {
      driver.startSessionPing('lobby-a', () => {});
      driver.startSessionPing('lobby-a', () => {});

      assert.equal(createdWebSockets.length, 1);
    });
  });

  void test('answers the host offer, wires only the oob channel, and closes any other channel', async () => {
    await withOobViewerScenario(async ({ driver, createdWebSockets, createdPeerConnections }) => {
      driver.startSessionPing('lobby-a', () => {});
      const ws = openLatestSignalingSocket(createdWebSockets);

      await deliverSignalingMessage(ws, {
        type: 'offer',
        fromPeerId: 'hostpeer',
        offer: { type: 'offer', sdp: 'host-offer-sdp' },
      });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      const answerMessage = ws.sentMessages.find((message) => message.type === 'answer');
      assert.ok(answerMessage);
      assert.equal(answerMessage.targetPeerId, 'hostpeer');

      const rogueChannel = new MockRTCDataChannel('reliable', {});
      peerConnection!.ondatachannel!({ channel: rogueChannel });
      assert.equal(rogueChannel.readyState, 'closed');

      const oobChannel = new MockRTCDataChannel('oob', { ordered: false, maxRetransmits: 0 });
      peerConnection!.ondatachannel!({ channel: oobChannel });
      oobChannel.onopen!();

      // #StartViewerOobPingLoop sends its first ping synchronously once the channel opens.
      assert.equal(oobChannel.sentMessages.length, 1);
      assert.equal(decodeOobFrame(oobChannel.sentMessages[0]).type, WebRTCDriver.OOB_PING);
    });
  });

  void test('smooths RTT with an exponential moving average and ignores a stale/mismatched pong', async () => {
    await withOobViewerScenario(async ({ driver, createdWebSockets, createdPeerConnections }) => {
      const pings: Array<number | null> = [];
      driver.startSessionPing('lobby-a', (rtt) => pings.push(rtt));
      const ws = openLatestSignalingSocket(createdWebSockets);

      await deliverSignalingMessage(ws, { type: 'offer', fromPeerId: 'hostpeer', offer: { type: 'offer', sdp: 'sdp' } });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      const channel = new MockRTCDataChannel('oob', {});
      peerConnection!.ondatachannel!({ channel });
      channel.onopen!();

      const firstPing = decodeOobFrame(channel.sentMessages[0]);
      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PONG, firstPing.sequence, Date.now() - 100) });

      assert.equal(pings.length, 1);
      assert.ok(Math.abs(pings[0]! - 100) < 10, `expected ~100ms, got ${pings[0]}`);

      // A duplicate pong for the same (now no-longer-pending) sequence is ignored.
      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PONG, firstPing.sequence, Date.now() - 9999) });
      assert.equal(pings.length, 1);

      // Simulate a second ping already in flight (without waiting for the real interval) and
      // confirm a pong for the OLD sequence is dropped while the CURRENT one is accepted and
      // folds into the EMA: smoothed = 100 + (200 - 100) * ALPHA(0.3) = 130.
      const state = driver.viewerOobProbes.get('lobby-a');
      state!.sequence = firstPing.sequence + 1;
      state!.pendingSequence = state!.sequence;

      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PONG, firstPing.sequence, Date.now() - 500) });
      assert.equal(pings.length, 1);

      channel.onmessage!({ data: buildOobFrame(WebRTCDriver.OOB_PONG, state!.sequence, Date.now() - 200) });
      assert.equal(pings.length, 2);
      assert.ok(Math.abs(pings[1]! - 130) < 10, `expected ~130ms, got ${pings[1]}`);
    });
  });

  void test('reports null once the peer connection fails', async () => {
    await withOobViewerScenario(async ({ driver, createdWebSockets, createdPeerConnections }) => {
      const pings: Array<number | null> = [];
      driver.startSessionPing('lobby-a', (rtt) => pings.push(rtt));
      const ws = openLatestSignalingSocket(createdWebSockets);

      await deliverSignalingMessage(ws, { type: 'offer', fromPeerId: 'hostpeer', offer: { type: 'offer', sdp: 'sdp' } });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      peerConnection!.connectionState = 'failed';
      peerConnection!.onconnectionstatechange!();

      assert.deepEqual(pings, [null]);
      assert.equal(driver.viewerOobProbes.has('lobby-a'), false);
    });
  });

  void test('stopSessionPing tears down the channel, peer connection, and signaling socket', async () => {
    await withOobViewerScenario(async ({ driver, createdWebSockets, createdPeerConnections }) => {
      driver.startSessionPing('lobby-a', () => {});
      const ws = openLatestSignalingSocket(createdWebSockets);

      await deliverSignalingMessage(ws, { type: 'offer', fromPeerId: 'hostpeer', offer: { type: 'offer', sdp: 'sdp' } });
      await flushMicrotasks();

      const peerConnection = createdPeerConnections.at(-1);
      const channel = new MockRTCDataChannel('oob', {});
      peerConnection!.ondatachannel!({ channel });
      channel.onopen!();

      driver.stopSessionPing('lobby-a');

      assert.equal(driver.viewerOobProbes.has('lobby-a'), false);
      assert.equal(channel.readyState, 'closed');
      assert.equal(peerConnection!.closed, true);
      assert.equal(ws.readyState, 3);
    });
  });

  void test('stopSessionPing is a no-op when no probe is running', async () => {
    await withOobViewerScenario(({ driver }) => {
      assert.doesNotThrow(() => { driver.stopSessionPing('never-started'); });
    });
  });
});
