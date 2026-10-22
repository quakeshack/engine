import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DriverRegistry } from '../../source/engine/network/DriverRegistry.ts';
import { BaseDriver, QSocket } from '../../source/engine/network/NetworkDrivers.ts';

import { createTestNetwork } from '../support/fixtures.ts';

class FakeDriver extends BaseDriver {
  listenCalls: boolean[] = [];
  listenAddress: string | null = null;

  constructor(net = createTestNetwork()) {
    super('fake', net);
    this.initialized = true;
  }

  override Listen(shouldListen: boolean): void {
    this.listenCalls.push(shouldListen);
  }

  override GetListenAddress(): string | null {
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

    // Only the list of initialized drivers is asked for.
    net.driverRegistry = {
      getInitializedDrivers() {
        return [listeningDriver, skippedDriver];
      },
    } as unknown as DriverRegistry;

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

    // Only the list of initialized drivers is asked for.
    net.driverRegistry = {
      getInitializedDrivers() {
        return [firstDriver, secondDriver];
      },
    } as unknown as DriverRegistry;

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
