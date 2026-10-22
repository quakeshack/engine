import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClientEngineApi } from '../support/clientEngineApi.ts';
import SaveSlots from '../../source/engine/client/menu/SaveSlots.ts';
import { BackendUserStore, MemoryBackend } from '../../source/engine/common/UserStore.ts';
import { engineMocks } from '../support/engineMocks.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

const engineApi = createClientEngineApi();

/**
 * Installs a minimal `COM` registry stub with an in-memory user store.
 * @param callback test callback
 * @returns resolves once the callback and the cleanup are done
 */
async function withMockSaveSlotsApi(callback: (store: BackendUserStore) => Promise<void>): Promise<void> {
  const store = new BackendUserStore(new MemoryBackend());

  await withEngineMocks({ COM: { GetGamedir: () => 'id1', userStore: store } }, async () => {
    try {
      await callback(store);
    } finally {
      // Leave an empty snapshot behind for the next test.
      engineMocks.COM = { GetGamedir: () => 'id1', userStore: null };
      await SaveSlots.refresh();
    }
  });
}

void describe('ClientEngineAPI.SaveSlots', () => {
  void test('List delegates to the SaveSlots service', async () => {
    await withMockSaveSlotsApi(async (store) => {
      await store.write('id1/s0.json', new TextEncoder().encode(JSON.stringify({ comment: 'Near the end' })));
      await SaveSlots.refresh();

      const slots = engineApi.SaveSlots.List(2);

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

      engineApi.SaveSlots.Delete(0);
      await new Promise((resolve) => { setImmediate(resolve); });

      assert.equal(await store.read('id1/s0.json'), null);
    });
  });
});
