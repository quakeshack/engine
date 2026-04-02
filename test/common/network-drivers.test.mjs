import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import { BaseDriver, LoopDriver, QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';

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
