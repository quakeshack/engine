import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DriverRegistry } from '../../source/engine/network/DriverRegistry.ts';
import { BaseDriver } from '../../source/engine/network/NetworkDrivers.ts';

/**
 * @typedef {object} FakeDriverOptions
 * @property {boolean} [initialized] Whether the fake driver starts initialized.
 * @property {string[]} [handleHosts] Addresses the fake driver reports it can handle.
 */

class FakeDriver extends BaseDriver {
  /** @type {string[]} */
  handleHosts = [];
  initCalls = 0;
  shutdownCalls = 0;

  /**
   * @param {string} name
   * @param {FakeDriverOptions} [options]
   */
  constructor(name, options = {}) {
    super(name);
    const { initialized = false, handleHosts = [] } = options;
    this.initialized = initialized;
    this.handleHosts = handleHosts;
  }

  Init() {
    this.initCalls += 1;
    this.initialized = true;
    return true;
  }

  Shutdown() {
    this.shutdownCalls += 1;
    this.initialized = false;
  }

  /**
   * @param {string} host
   * @returns {boolean} True when the fake driver accepts the host string.
   */
  canHandle(host) {
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
