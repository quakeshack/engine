import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BackendUserStore, MemoryBackend } from '../../source/engine/common/UserStore.ts';

/** A localStorage stand-in. */
class FakeLocalStorage {
  entries = new Map();

  get length() {
    return this.entries.size;
  }

  key(index) {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key) {
    return this.entries.get(key) ?? null;
  }

  removeItem(key) {
    this.entries.delete(key);
  }
}

/** A backend that can be made to fail, and that remembers what it stored. */
class FlakyBackend extends MemoryBackend {
  failPuts = false;
  failGets = false;

  async get(key) {
    if (this.failGets) {
      throw new Error('database closed');
    }

    return await super.get(key);
  }

  async put(key, value) {
    if (this.failPuts) {
      throw new Error('quota exceeded');
    }

    await super.put(key, value);
  }
}

/**
 * Silences the warnings of a store that is expected to fail.
 * @param {() => Promise<void>} callback test callback
 */
async function quietly(callback) {
  const warn = console.warn;

  console.warn = () => {};

  try {
    await callback();
  } finally {
    console.warn = warn;
  }
}

/**
 * Reads a file of a store as text.
 * @param {BackendUserStore} store the store
 * @param {string} path the file
 * @returns {Promise<string | null>} the content
 */
async function readText(store, path) {
  const data = await store.read(path);

  return data === null ? null : new TextDecoder('iso-8859-1').decode(data);
}

void describe('BackendUserStore', () => {
  void describe('read and write', () => {
    void test('reports a file that was never written as null', async () => {
      const store = new BackendUserStore(new MemoryBackend());

      assert.equal(await store.read('id1/config.cfg'), null);
    });

    void test('returns what was written', async () => {
      const store = new BackendUserStore(new MemoryBackend());

      assert.equal(await store.write('id1/config.cfg', new Uint8Array([1, 2, 3])), true);
      assert.deepEqual([...new Uint8Array(await store.read('id1/config.cfg'))], [1, 2, 3]);
    });

    void test('replaces an existing file', async () => {
      const store = new BackendUserStore(new MemoryBackend());

      await store.write('id1/config.cfg', new Uint8Array([1]));
      await store.write('id1/config.cfg', new Uint8Array([2, 2]));

      assert.deepEqual([...new Uint8Array(await store.read('id1/config.cfg'))], [2, 2]);
    });

    void test('keeps its own copy, so later changes to the input do not change the file', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const input = new Uint8Array([1, 2, 3]);

      await store.write('id1/a', input);
      input[0] = 99;

      assert.deepEqual([...new Uint8Array(await store.read('id1/a'))], [1, 2, 3]);
    });

    void test('writes only the bytes of a view into a larger buffer', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const view = new Uint8Array(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);

      await store.write('id1/a', view);

      assert.deepEqual([...new Uint8Array(await store.read('id1/a'))], [1, 2, 3]);
    });

    void test('removes a file', async () => {
      const store = new BackendUserStore(new MemoryBackend());

      await store.write('id1/a', new Uint8Array([1]));

      assert.equal(await store.remove('id1/a'), true);
      assert.equal(await store.read('id1/a'), null);
    });

    void test('removing a file that does not exist is not an error', async () => {
      const store = new BackendUserStore(new MemoryBackend());

      assert.equal(await store.remove('id1/nothing'), true);
    });
  });

  void describe('when the database fails', () => {
    void test('reports a failed write as false instead of throwing', async () => {
      const backend = new FlakyBackend();
      const store = new BackendUserStore(backend);

      backend.failPuts = true;

      await quietly(async () => {
        assert.equal(await store.write('id1/a', new Uint8Array([1])), false);
      });
    });

    void test('reports a failed read as a missing file', async () => {
      const backend = new FlakyBackend();
      const store = new BackendUserStore(backend);

      await store.write('id1/a', new Uint8Array([1]));
      backend.failGets = true;

      await quietly(async () => {
        assert.equal(await store.read('id1/a'), null);
      });
    });
  });

  void describe('migrateFromLocalStorage', () => {
    void test('moves the legacy files and takes them out of localStorage', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const storage = new FakeLocalStorage();

      storage.entries.set('Quake.id1/config.cfg', 'bind w +forward\n');
      storage.entries.set('Quake.id1/s0.json', '{"mapname":"e1m1"}');

      assert.equal(await store.migrateFromLocalStorage(storage), 2);
      assert.equal(await readText(store, 'id1/config.cfg'), 'bind w +forward\n');
      assert.equal(await readText(store, 'id1/s0.json'), '{"mapname":"e1m1"}');
      assert.equal(storage.length, 0);
    });

    void test('leaves everything that is not a legacy file alone', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const storage = new FakeLocalStorage();

      storage.entries.set('theme', 'dark');
      storage.entries.set('Quake.id1/a', 'x');

      await store.migrateFromLocalStorage(storage);

      assert.deepEqual([...storage.entries.keys()], ['theme']);
      assert.equal(await store.read('theme'), null);
    });

    void test('maps every character to the byte the old loader returned for it', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const storage = new FakeLocalStorage();

      storage.entries.set('Quake.id1/demo.dem', 'aéÿ\u0000z');

      await store.migrateFromLocalStorage(storage);

      assert.deepEqual([...new Uint8Array(await store.read('id1/demo.dem'))], [0x61, 0xe9, 0xff, 0x00, 0x7a]);
    });

    void test('only ever runs once', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const storage = new FakeLocalStorage();

      storage.entries.set('Quake.id1/a', 'x');
      await store.migrateFromLocalStorage(storage);

      storage.entries.set('Quake.id1/b', 'y');

      assert.equal(await store.migrateFromLocalStorage(storage), 0);
      assert.equal(await store.read('id1/b'), null, 'a file that shows up later is not touched');
      assert.equal(storage.length, 1);
    });

    void test('marks itself as done even when there was nothing to move', async () => {
      const store = new BackendUserStore(new MemoryBackend());
      const storage = new FakeLocalStorage();

      assert.equal(await store.migrateFromLocalStorage(storage), 0);

      storage.entries.set('Quake.id1/a', 'x');

      assert.equal(await store.migrateFromLocalStorage(storage), 0);
    });

    void test('keeps what it could not store and finishes on the next start', async () => {
      const backend = new FlakyBackend();
      const store = new BackendUserStore(backend);
      const storage = new FakeLocalStorage();

      storage.entries.set('Quake.id1/a', 'aaa');
      storage.entries.set('Quake.id1/b', 'bbb');

      const originalPut = backend.put.bind(backend);
      let puts = 0;

      // The database accepts the first file and then runs full.
      backend.put = async (key, value) => {
        puts++;

        if (puts > 1) {
          throw new Error('quota exceeded');
        }

        await originalPut(key, value);
      };

      await quietly(async () => {
        assert.equal(await store.migrateFromLocalStorage(storage), 1);
      });

      assert.deepEqual([...storage.entries.keys()], ['Quake.id1/b'], 'the file that was not stored is still in localStorage');

      backend.put = originalPut;

      assert.equal(await store.migrateFromLocalStorage(storage), 1, 'the marker was not set, so the second start finishes the job');
      assert.equal(await readText(store, 'id1/b'), 'bbb');
      assert.equal(storage.length, 0);
    });
  });
});
