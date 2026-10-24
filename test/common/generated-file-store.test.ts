import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { GeneratedFileStore } from '../../source/engine/common/GeneratedFileStore.ts';
import { MemoryBackend } from '../../source/engine/common/UserStore.ts';

const CURRENT = 'quakeshack/1.3.0+abc123/id1/1.0.0';
const OLDER = 'quakeshack/1.2.0+old/id1/1.0.0';

/**
 * Silences the warnings of a store that is expected to fail.
 * @param callback test callback
 */
async function quietly(callback: () => Promise<void>): Promise<void> {
  const warn = mock.method(console, 'warn', () => {});

  try {
    await callback();
  } finally {
    warn.mock.restore();
  }
}

void describe('GeneratedFileStore', () => {
  void describe('read and write', () => {
    void test('returns what was written into the same namespace', async () => {
      const store = new GeneratedFileStore(new MemoryBackend());

      assert.equal(await store.write(CURRENT, 'maps/e1m1.nav', new Uint8Array([1, 2])), true);
      assert.deepEqual([...new Uint8Array((await store.read(CURRENT, 'maps/e1m1.nav'))!)], [1, 2]);
    });

    void test('does not see the files of another namespace', async () => {
      const store = new GeneratedFileStore(new MemoryBackend());

      await store.write(OLDER, 'maps/e1m1.nav', new Uint8Array([1]));

      assert.equal(await store.read(CURRENT, 'maps/e1m1.nav'), null);
    });

    void test('writes only the bytes of a view into a larger buffer', async () => {
      const store = new GeneratedFileStore(new MemoryBackend());

      await store.write(CURRENT, 'a', new Uint8Array(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2));

      assert.deepEqual([...new Uint8Array((await store.read(CURRENT, 'a'))!)], [1, 2]);
    });
  });

  void describe('prune', () => {
    void test('deletes the files of every other namespace and keeps the given one', async () => {
      const backend = new MemoryBackend();
      const store = new GeneratedFileStore(backend);

      await store.write(CURRENT, 'maps/e1m1.nav', new Uint8Array([1]));
      await store.write(OLDER, 'maps/e1m1.nav', new Uint8Array([1]));
      await store.write('quakeshack/1.3.0+abc123/id1/boot', 'maps/e1m2.nav', new Uint8Array([1]));
      // A namespace that only starts like the kept one is another namespace.
      await store.write(`${CURRENT}.1`, 'maps/e1m1.nav', new Uint8Array([1]));

      assert.equal(await store.prune(CURRENT), 3);
      assert.deepEqual(await backend.keys(), [`${CURRENT}/maps/e1m1.nav`]);
    });

    void test('reports nothing deleted instead of throwing when the database fails', async () => {
      const backend = new MemoryBackend();
      const store = new GeneratedFileStore(backend);

      backend.keys = () => Promise.reject(new Error('database closed'));

      await quietly(async () => {
        assert.equal(await store.prune(CURRENT), 0);
      });
    });
  });

  void describe('when the database fails', () => {
    void test('reports a failed write as false and a failed read as a missing file', async () => {
      const backend = new MemoryBackend();
      const store = new GeneratedFileStore(backend);

      backend.put = () => Promise.reject(new Error('quota exceeded'));
      backend.get = () => Promise.reject(new Error('database closed'));

      await quietly(async () => {
        assert.equal(await store.write(CURRENT, 'a', new Uint8Array([1])), false);
        assert.equal(await store.read(CURRENT, 'a'), null);
      });
    });
  });
});
