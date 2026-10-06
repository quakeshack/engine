import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BaseDriver, QSocket } from '../../source/engine/network/NetworkDrivers.ts';

import { createTestNetwork } from '../physics/fixtures.mjs';

class FakeDriver extends BaseDriver {
  constructor(net = createTestNetwork()) {
    super('fake', net);
    this.listenCalls = [];
    this.listenAddress = null;
    this.initialized = true;
  }

  Listen(shouldListen) {
    this.listenCalls.push(shouldListen);
  }

  GetListenAddress() {
    return this.listenAddress;
  }
}

void describe('NET', () => {
  void test('reuses disconnected socket slots', () => {
    const net = createTestNetwork();
    const driver = new FakeDriver(net);

    net.time = 123;
    net.activeSockets = [];

    const first = net.NewQSocket(driver);

    first.state = QSocket.STATE_DISCONNECTED;

    const second = net.NewQSocket(driver);

    assert.notEqual(second, first);
    assert.equal(net.activeSockets[0], second);
    assert.equal(net.activeSockets.length, 1);
    assert.equal(second.connecttime, 123);
  });

  void test('listens only on eligible initialized drivers', () => {
    const net = createTestNetwork();
    const listeningDriver = new FakeDriver(net);
    const skippedDriver = new FakeDriver(net);
    skippedDriver.ShouldListen = () => false;

    net.driverRegistry = {
      getInitializedDrivers() {
        return [listeningDriver, skippedDriver];
      },
    };

    net.Listen_f(1);

    assert.equal(net.listening, true);
    assert.deepEqual(listeningDriver.listenCalls, [true]);
    assert.deepEqual(skippedDriver.listenCalls, []);
  });

  void test('returns the first active listen address', () => {
    const net = createTestNetwork();
    const firstDriver = new FakeDriver(net);
    const secondDriver = new FakeDriver(net);
    secondDriver.listenAddress = 'ws://127.0.0.1:26000';

    net.driverRegistry = {
      getInitializedDrivers() {
        return [firstDriver, secondDriver];
      },
    };

    assert.equal(net.GetListenAddress(), 'ws://127.0.0.1:26000');
  });

  void test('keeps its sockets and clock apart from another network layer', () => {
    const first = createTestNetwork();
    const second = createTestNetwork();

    first.NewQSocket(new FakeDriver(first));

    assert.equal(first.activeSockets.length, 1);
    assert.equal(second.activeSockets.length, 0);
  });
});
