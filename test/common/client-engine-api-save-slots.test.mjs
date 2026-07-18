import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs a minimal `COM` registry stub plus an in-memory `localStorage` stand-in.
 * @param {(storage: Map<string, string>) => void} callback test callback
 */
function withMockSaveSlotsApi(callback) {
  const previousCOM = registry.COM;
  const previousLocalStorage = globalThis.localStorage;
  const storage = new Map();

  registry.COM = { gamedir: [{ filename: 'id1' }] };
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };
  eventBus.publish('registry.frozen');

  try {
    callback(storage);
  } finally {
    registry.COM = previousCOM;
    globalThis.localStorage = previousLocalStorage;
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientEngineAPI.SaveSlots', () => {
  void test('List delegates to the SaveSlots service', () => {
    withMockSaveSlotsApi((storage) => {
      storage.set('Quake.id1/s0.json', JSON.stringify({ comment: 'Near the end' }));

      const slots = ClientEngineAPI.SaveSlots.List(2);

      assert.deepEqual(slots, [
        { index: 0, label: 'Near the end', mapname: null, hasData: true },
        { index: 1, label: 'Empty slot', mapname: null, hasData: false },
      ]);
    });
  });

  void test('Delete removes a slot\'s data', () => {
    withMockSaveSlotsApi((storage) => {
      storage.set('Quake.id1/s0.json', JSON.stringify({ mapname: 'e1m1' }));

      ClientEngineAPI.SaveSlots.Delete(0);

      assert.equal(storage.has('Quake.id1/s0.json'), false);
    });
  });
});
