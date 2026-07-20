import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import { BaseDriver, LoopDriver, QSocket, WebRTCDriver } from '../../source/engine/network/NetworkDrivers.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

class RecordingDriver extends BaseDriver {
  calls = [];

  constructor() {
    super('recording');
    this.initialized = true;
  }

  GetMessage(qsocket) {
    this.calls.push(['GetMessage', qsocket]);
    return 7;
  }

  SendMessage(qsocket, data) {
    this.calls.push(['SendMessage', qsocket, data.cursize]);
    return 1;
  }

  SendUnreliableMessage(qsocket, data) {
    this.calls.push(['SendUnreliableMessage', qsocket, data.cursize]);
    return 1;
  }

  CanSendMessage(qsocket) {
    this.calls.push(['CanSendMessage', qsocket]);
    return true;
  }

  Close(qsocket) {
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
    const previousCon = registry.Con;
    const previousCOM = registry.COM;
    const previousNET = registry.NET;
    const previousSV = registry.SV;
    const previousSys = registry.Sys;
    const previousSockets = NET.activeSockets.slice();
    const previousTime = NET.time;
    const previousMessage = NET.message;

    registry.Con = { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {} };
    registry.COM = { game: 'id1' };
    registry.NET = NET;
    registry.SV = { server: { mapname: 'start' }, svs: { maxclients: 1 } };
    registry.Sys = { FloatTime() { return 1; } };
    eventBus.publish('registry.frozen');

    try {
      NET.activeSockets = [];
      NET.time = 1;
      NET.message = new SzBuffer(128, 'NET.message.test');

      const driver = new LoopDriver();
      const serverSock = driver.Connect('local');
      const clientSock = driver.CheckNewConnections();

      assert.ok(serverSock instanceof QSocket);
      assert.ok(clientSock instanceof QSocket);

      const payload = new SzBuffer(16, 'loop-message');
      payload.writeByte(99);

      assert.equal(serverSock.SendMessage(payload), 1);
      assert.equal(serverSock.CanSendMessage(), false);
      assert.equal(clientSock.GetMessage(), 1);
      assert.equal(new Uint8Array(NET.message.data)[0], 99);
      assert.equal(serverSock.CanSendMessage(), true);
      assert.equal(clientSock.transportState?.kind, 'loopback');
      assert.equal(clientSock.transportState?.peer, serverSock);
    } finally {
      registry.Con = previousCon;
      registry.COM = previousCOM;
      registry.NET = previousNET;
      registry.SV = previousSV;
      registry.Sys = previousSys;
      NET.activeSockets = previousSockets;
      NET.time = previousTime;
      NET.message = previousMessage;
      eventBus.publish('registry.frozen');
    }
  });
});

/**
 * Temporarily installs a `Con` stub plus `registry.urls`/`registry.isDedicatedServer` and a
 * `location` global (bare, not `window.location` -- matching how `NetworkDrivers.ts` reads it),
 * restoring everything afterward.
 * @param {{ location: { protocol: string, hostname: string }, urls?: { signalingURL?: string }, isDedicatedServer?: boolean }} overrides scenario overrides
 * @param {() => void} callback test callback
 */
function withSignalingScenario(overrides, callback) {
  const previousCon = registry.Con;
  const previousUrls = registry.urls;
  const previousIsDedicatedServer = registry.isDedicatedServer;
  const previousLocation = globalThis.location;

  registry.Con = { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {} };
  registry.urls = overrides.urls;
  registry.isDedicatedServer = overrides.isDedicatedServer ?? false;
  globalThis.location = overrides.location;
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.Con = previousCon;
    registry.urls = previousUrls;
    registry.isDedicatedServer = previousIsDedicatedServer;
    globalThis.location = previousLocation;
    eventBus.publish('registry.frozen');
  }
}

void describe('WebRTCDriver.Init', () => {
  void test('defaults to ws(s)://<hostname>:8787/signaling when no signaling URL is configured', () => {
    withSignalingScenario({ location: { protocol: 'https:', hostname: 'play.quakeshack.dev' } }, () => {
      const driver = new WebRTCDriver();

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
    }, () => {
      const driver = new WebRTCDriver();

      driver.Init();
      assert.equal(driver.signalingUrl, 'ws://localhost:8787/signaling');
    });
  });

  void test('always derives ws/wss from the current page, ignoring the configured URL\'s own scheme', () => {
    withSignalingScenario({
      location: { protocol: 'https:', hostname: 'localhost' },
      urls: { signalingURL: 'http://master.example.test' },
    }, () => {
      const driver = new WebRTCDriver();

      driver.Init();
      assert.equal(driver.signalingUrl, 'wss://master.example.test/signaling');
    });
  });

  void test('does nothing on a dedicated server', () => {
    withSignalingScenario({
      location: { protocol: 'http:', hostname: 'localhost' },
      isDedicatedServer: true,
    }, () => {
      const driver = new WebRTCDriver();

      assert.equal(driver.Init(), false);
      assert.equal(driver.initialized, false);
      assert.equal(driver.signalingUrl, null);
    });
  });
});
