import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DriverRegistry } from '../../source/engine/network/DriverRegistry.ts';
import { BaseDriver } from '../../source/engine/network/NetworkDrivers.ts';
import { createTestNetwork } from '../support/fixtures.ts';

/** Options of {@link FakeDriver}. */
interface FakeDriverOptions {
  /** Whether the fake driver starts initialized. */
  initialized?: boolean;
  /** Addresses the fake driver reports it can handle. */
  handleHosts?: string[];
}

class FakeDriver extends BaseDriver {
  handleHosts: string[] = [];
  initCalls = 0;
  shutdownCalls = 0;

  /**
   * @param name Name of the driver.
   * @param options What the fake driver starts with.
   */
  constructor(name: string, options: FakeDriverOptions = {}) {
    super(name, createTestNetwork());
    const { initialized = false, handleHosts = [] } = options;
    this.initialized = initialized;
    this.handleHosts = handleHosts;
  }

  override Init(): boolean {
    this.initCalls += 1;
    this.initialized = true;
    return true;
  }

  override Shutdown(): void {
    this.shutdownCalls += 1;
    this.initialized = false;
  }

  /**
   * @param host Address to connect to.
   * @returns True when the fake driver accepts the host string.
   */
  override canHandle(host: string): boolean {
    return this.handleHosts.includes(host);
  }
}

void describe('DriverRegistry', () => {
  void test('registers drivers by name and preserves order', () => {
    const registry = new DriverRegistry();
    const loop = new FakeDriver('loop');
    const websocket = new FakeDriver('websocket');

    registry.register('loop', loop);
    registry.register('websocket', websocket);

    assert.equal(registry.get('loop'), loop);
    assert.equal(registry.get('websocket'), websocket);
    assert.deepEqual(registry.orderedDrivers, [loop, websocket]);
  });

  void test('selects the first initialized driver that can handle an address', () => {
    const registry = new DriverRegistry();
    const uninitialized = new FakeDriver('websocket', { initialized: false, handleHosts: ['wss://quake.test'] });
    const initialized = new FakeDriver('webrtc', { initialized: true, handleHosts: ['wss://quake.test'] });

    registry.register('websocket', uninitialized);
    registry.register('webrtc', initialized);

    assert.equal(registry.getClientDriver('wss://quake.test'), initialized);
    assert.equal(registry.getClientDriver('local'), null);
  });

  void test('initializes and shuts down registered drivers', () => {
    const registry = new DriverRegistry();
    const loop = new FakeDriver('loop');
    const websocket = new FakeDriver('websocket');

    registry.register('loop', loop);
    registry.register('websocket', websocket);

    registry.initialize();

    assert.equal(loop.initCalls, 1);
    assert.equal(websocket.initCalls, 1);
    assert.deepEqual(registry.getInitializedDrivers(), [loop, websocket]);

    registry.shutdown();

    assert.equal(loop.shutdownCalls, 1);
    assert.equal(websocket.shutdownCalls, 1);
    assert.deepEqual(registry.getInitializedDrivers(), []);
  });
});
