import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import NET from '../../source/engine/network/Network.ts';
import { BaseDriver, QSocket } from '../../source/engine/network/NetworkDrivers.ts';

class FakeDriver extends BaseDriver {
  constructor() {
    super('fake');
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
    const previousTime = NET.time;
    const previousSockets = NET.activeSockets.slice();
    const driver = new FakeDriver();

    try {
      NET.time = 123;
      NET.activeSockets = [];

      const first = NET.NewQSocket(driver);

      first.state = QSocket.STATE_DISCONNECTED;

      const second = NET.NewQSocket(driver);

      assert.notEqual(second, first);
      assert.equal(NET.activeSockets[0], second);
      assert.equal(NET.activeSockets.length, 1);
      assert.equal(second.connecttime, 123);
    } finally {
      NET.time = previousTime;
      NET.activeSockets = previousSockets;
    }
  });

  void test('listens only on eligible initialized drivers', () => {
    const previousListening = NET.listening;
    const previousDriverRegistry = NET.driverRegistry;
    const listeningDriver = new FakeDriver();
    const skippedDriver = new FakeDriver();
    skippedDriver.ShouldListen = () => false;

    NET.driverRegistry = {
      getInitializedDrivers() {
        return [listeningDriver, skippedDriver];
      },
    };

    try {
      NET.Listen_f(1);

      assert.equal(NET.listening, true);
      assert.deepEqual(listeningDriver.listenCalls, [true]);
      assert.deepEqual(skippedDriver.listenCalls, []);
    } finally {
      NET.listening = previousListening;
      NET.driverRegistry = previousDriverRegistry;
    }
  });

  void test('returns the first active listen address', () => {
    const previousDriverRegistry = NET.driverRegistry;
    const firstDriver = new FakeDriver();
    const secondDriver = new FakeDriver();
    secondDriver.listenAddress = 'ws://127.0.0.1:26000';

    NET.driverRegistry = {
      getInitializedDrivers() {
        return [firstDriver, secondDriver];
      },
    };

    try {
      assert.equal(NET.GetListenAddress(), 'ws://127.0.0.1:26000');
    } finally {
      NET.driverRegistry = previousDriverRegistry;
    }
  });
});
