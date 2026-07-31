import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventBus, registry } from '../../source/engine/registry.ts';
import SaveSlots from '../../source/engine/client/menu/SaveSlots.ts';

/**
 * Installs a minimal `COM` registry stub (SaveSlots only needs `COM.gamedir`) plus an
 * in-memory `localStorage` stand-in, isolated per test.
 * @param {(storage: Map<string, string>) => void} callback test callback
 */
function withMockSaveSlotsRegistry(callback) {
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

void describe('SaveSlots.list', () => {
  void test('reports empty slots when nothing is saved', () => {
    withMockSaveSlotsRegistry(() => {
      const slots = SaveSlots.list(3);

      assert.deepEqual(slots, [
        { index: 0, label: 'Empty slot', mapname: null, hasData: false },
        { index: 1, label: 'Empty slot', mapname: null, hasData: false },
        { index: 2, label: 'Empty slot', mapname: null, hasData: false },
      ]);
    });
  });

  void test('prefers the comment over the map name for the label, but exposes mapname separately', () => {
    withMockSaveSlotsRegistry((storage) => {
      storage.set('Quake.id1/s0.json', JSON.stringify({ comment: 'Before the boss', mapname: 'e1m8' }));

      const [slot] = SaveSlots.list(1);

      assert.deepEqual(slot, { index: 0, label: 'Before the boss', mapname: 'e1m8', hasData: true });
    });
  });

  void test('falls back to the map name when there is no comment', () => {
    withMockSaveSlotsRegistry((storage) => {
      storage.set('Quake.id1/s0.json', JSON.stringify({ mapname: 'e1m1' }));

      const [slot] = SaveSlots.list(1);

      assert.equal(slot.label, 'e1m1');
      assert.equal(slot.mapname, 'e1m1');
    });
  });
});

void describe('SaveSlots.delete', () => {
  void test('removes the slot data so a subsequent list reports it as empty', () => {
    withMockSaveSlotsRegistry((storage) => {
      storage.set('Quake.id1/s0.json', JSON.stringify({ mapname: 'e1m1' }));

      SaveSlots.delete(0);

      assert.equal(storage.has('Quake.id1/s0.json'), false);
      assert.equal(SaveSlots.list(1)[0].hasData, false);
    });
  });

  void test('deleting an already-empty slot is a safe no-op', () => {
    withMockSaveSlotsRegistry(() => {
      assert.doesNotThrow(() => SaveSlots.delete(0));
    });
  });
});
