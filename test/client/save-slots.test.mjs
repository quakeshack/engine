import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { registry } from '../../source/engine/registry.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import SaveSlots from '../../source/engine/client/menu/SaveSlots.ts';
import { BackendUserStore, MemoryBackend } from '../../source/engine/common/UserStore.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';

/**
 * Installs a minimal `COM` registry stub (SaveSlots needs the game directory and the user store)
 * with an in-memory user store, isolated per test.
 * @param {(store: BackendUserStore) => Promise<void>} callback test callback
 * @returns {Promise<void>} resolves once the callback and the cleanup are done
 */
async function withMockSaveSlotsRegistry(callback) {
  const previousCOM = registry.COM;
  const store = new BackendUserStore(new MemoryBackend());

  registry.COM = { GetGamedir: () => 'id1', userStore: store };
  eventBus.publish('registry.frozen');

  try {
    await SaveSlots.refresh();
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

/**
 * Stores a save file the way `ClientHost.Savegame_f` does.
 * @param {BackendUserStore} store the user store
 * @param {number} index slot index
 * @param {object} gamestate save game metadata
 */
async function writeSlot(store, index, gamestate) {
  await store.write(`id1/s${index}.json`, new TextEncoder().encode(JSON.stringify(gamestate)));
}

void describe('SaveSlots.list', () => {
  void test('reports empty slots when nothing is saved', async () => {
    await withMockSaveSlotsRegistry(() => {
      const slots = SaveSlots.list(3);

      assert.deepEqual(slots, [
        { index: 0, label: 'Empty slot', mapname: null, hasData: false },
        { index: 1, label: 'Empty slot', mapname: null, hasData: false },
        { index: 2, label: 'Empty slot', mapname: null, hasData: false },
      ]);
    });
  });

  void test('prefers the comment over the map name for the label, but exposes mapname separately', async () => {
    await withMockSaveSlotsRegistry(async (store) => {
      await writeSlot(store, 0, { comment: 'Before the boss', mapname: 'e1m8' });
      await SaveSlots.refresh();

      const [slot] = SaveSlots.list(1);

      assert.deepEqual(slot, { index: 0, label: 'Before the boss', mapname: 'e1m8', hasData: true });
    });
  });

  void test('falls back to the map name when there is no comment', async () => {
    await withMockSaveSlotsRegistry(async (store) => {
      await writeSlot(store, 0, { mapname: 'e1m1' });
      await SaveSlots.refresh();

      const [slot] = SaveSlots.list(1);

      assert.equal(slot.label, 'e1m1');
      assert.equal(slot.mapname, 'e1m1');
    });
  });

  void test('does not see a save written after the snapshot until it is refreshed', async () => {
    await withMockSaveSlotsRegistry(async (store) => {
      await writeSlot(store, 0, { mapname: 'e1m1' });

      assert.equal(SaveSlots.list(1)[0].hasData, false);

      await SaveSlots.refresh();

      assert.equal(SaveSlots.list(1)[0].hasData, true);
    });
  });

  void test('shows a save that cannot be parsed as an empty slot', async () => {
    await withMockSaveSlotsRegistry(async (store) => {
      await store.write('id1/s0.json', new TextEncoder().encode('{not json'));
      await SaveSlots.refresh();

      assert.equal(SaveSlots.list(1)[0].hasData, false);
    });
  });
});

void describe('SaveSlots.delete', () => {
  void test('removes the slot data so a subsequent list reports it as empty', async () => {
    await withMockSaveSlotsRegistry(async (store) => {
      await writeSlot(store, 0, { mapname: 'e1m1' });
      await SaveSlots.refresh();

      SaveSlots.delete(0);

      assert.equal(SaveSlots.list(1)[0].hasData, false, 'the slot is empty right away');

      await new Promise((resolve) => { setImmediate(resolve); });

      assert.equal(await store.read('id1/s0.json'), null, 'and the file is gone');
    });
  });

  void test('deleting an already-empty slot is a safe no-op', async () => {
    await withMockSaveSlotsRegistry(() => {
      assert.doesNotThrow(() => SaveSlots.delete(0));
    });
  });
});
