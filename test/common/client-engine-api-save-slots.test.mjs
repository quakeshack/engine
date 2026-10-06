import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import SaveSlots from '../../source/engine/client/menu/SaveSlots.ts';
import { BackendUserStore, MemoryBackend } from '../../source/engine/common/UserStore.ts';
import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';

/**
 * Installs a minimal `COM` registry stub with an in-memory user store.
 * @param {(store: BackendUserStore) => Promise<void>} callback test callback
 * @returns {Promise<void>} resolves once the callback and the cleanup are done
 */
async function withMockSaveSlotsApi(callback) {
  const previousCOM = registry.COM;
  const store = new BackendUserStore(new MemoryBackend());

  registry.COM = { GetGamedir: () => 'id1', userStore: store };
  eventBus.publish('registry.frozen');

  try {
    await callback(store);
  } finally {
    // Leave an empty snapshot behind for the next test.
    registry.COM = { GetGamedir: () => 'id1', userStore: null };
    eventBus.publish('registry.frozen');
    await SaveSlots.refresh();
    registry.COM = previousCOM;
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientEngineAPI.SaveSlots', () => {
  void test('List delegates to the SaveSlots service', async () => {
    await withMockSaveSlotsApi(async (store) => {
      await store.write('id1/s0.json', new TextEncoder().encode(JSON.stringify({ comment: 'Near the end' })));
      await SaveSlots.refresh();

      const slots = ClientEngineAPI.SaveSlots.List(2);

      assert.deepEqual(slots, [
        { index: 0, label: 'Near the end', mapname: null, hasData: true },
        { index: 1, label: 'Empty slot', mapname: null, hasData: false },
      ]);
    });
  });

  void test('Delete removes a slot\'s data', async () => {
    await withMockSaveSlotsApi(async (store) => {
      await store.write('id1/s0.json', new TextEncoder().encode(JSON.stringify({ mapname: 'e1m1' })));
      await SaveSlots.refresh();

      ClientEngineAPI.SaveSlots.Delete(0);
      await new Promise((resolve) => { setImmediate(resolve); });

      assert.equal(await store.read('id1/s0.json'), null);
    });
  });
});
