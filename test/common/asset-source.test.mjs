import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AssetCaches, CachedFetchAssetSource } from '../../source/engine/common/AssetSource.ts';

/** A Cache that keeps the bytes of what was put into it. */
class FakeCache {
  entries = new Map();
  failPut = false;

  async match(url) {
    const entry = this.entries.get(url);

    return entry === undefined ? undefined : new Response(entry.bytes.slice(0), { headers: entry.headers });
  }

  async put(url, response) {
    if (this.failPut) {
      throw new Error('quota exceeded');
    }

    this.entries.set(url, { bytes: await response.arrayBuffer(), headers: [...response.headers] });
  }
}

/** Cache Storage with named caches. */
class FakeCacheStorage {
  caches = new Map();
  opened = [];
  failOpen = false;

  async open(name) {
    if (this.failOpen) {
      throw new Error('Cache Storage is unavailable');
    }

    this.opened.push(name);

    if (!this.caches.has(name)) {
      this.caches.set(name, new FakeCache());
    }

    return this.caches.get(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async delete(name) {
    return this.caches.delete(name);
  }
}

/** Web Locks, serializing requests of the same name like the real ones do. */
class FakeLocks {
  #tails = new Map();

  async request(name, callback) {
    const previous = this.#tails.get(name) ?? Promise.resolve();
    const run = previous.then(async () => await callback());

    this.#tails.set(name, run.catch(() => {}));

    return await run;
  }
}

/**
 * Builds a source around a fake network, so tests can count and steer downloads.
 * @param {{ files?: Record<string, number[]>, locks?: boolean, cacheName?: () => string, delay?: number }} options what the fake network serves and which parts exist
 * @returns {{ source: CachedFetchAssetSource, caches: FakeCacheStorage, downloads: string[] }} the source and its fakes
 */
function createSource({ files = {}, locks = true, cacheName = () => 'quakeshack/test/id1/boot', delay = 0 } = {}) {
  const caches = new FakeCacheStorage();
  const downloads = [];
  const source = new CachedFetchAssetSource({
    fetch: async (url) => {
      downloads.push(url);

      if (delay > 0) {
        await new Promise((resolve) => { setTimeout(resolve, delay); });
      }

      if (url.includes('broken')) {
        throw new TypeError('network down');
      }

      const bytes = files[url];

      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes));
    },
    caches,
    locks: locks ? new FakeLocks() : null,
    resolveUrl: (path) => `https://cdn.test/${path}`,
    cacheName,
  });

  return { source, caches, downloads };
}

/**
 * Reads the bytes of an array buffer for comparisons.
 * @param {ArrayBuffer | null} buffer the buffer
 * @returns {number[] | null} its bytes
 */
function bytes(buffer) {
  return buffer === null ? null : [...new Uint8Array(buffer)];
}

void describe('CachedFetchAssetSource', () => {
  void test('downloads a file that is not cached yet and stores it', async () => {
    const { source, caches, downloads } = createSource({ files: { 'https://cdn.test/id1/gfx/pop.lmp': [1, 2, 3] } });

    assert.deepEqual(bytes(await source.read('id1/gfx/pop.lmp')), [1, 2, 3]);
    assert.deepEqual(downloads, ['https://cdn.test/id1/gfx/pop.lmp']);
    assert.ok(caches.caches.get('quakeshack/test/id1/boot').entries.has('https://cdn.test/id1/gfx/pop.lmp'));
  });

  void test('never touches the network for a file that is cached', async () => {
    const { source, downloads } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [9] } });

    await source.read('id1/a.lmp');
    await source.read('id1/a.lmp');
    await source.read('id1/a.lmp');

    assert.equal(downloads.length, 1);
  });

  void test('returns the same bytes from the cache as from the network', async () => {
    const { source } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [5, 6, 7, 8] } });

    const first = bytes(await source.read('id1/a.lmp'));
    const second = bytes(await source.read('id1/a.lmp'));

    assert.deepEqual(second, first);
  });

  void test('downloads a file only once when two readers ask for it at the same time', async () => {
    const { source, downloads } = createSource({ files: { 'https://cdn.test/id1/maps/e1m1.bsp': [1] }, delay: 10 });

    const [first, second] = await Promise.all([source.read('id1/maps/e1m1.bsp'), source.read('id1/maps/e1m1.bsp')]);

    assert.deepEqual(bytes(first), [1]);
    assert.deepEqual(bytes(second), [1]);
    assert.equal(downloads.length, 1, 'the second reader waited for the lock and then hit the cache');
  });

  void test('may download twice at the same time without Web Locks, which is only wasteful', async () => {
    const { source, downloads } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [1] }, locks: false, delay: 10 });

    await Promise.all([source.read('id1/a.lmp'), source.read('id1/a.lmp')]);

    assert.equal(downloads.length, 2);
  });

  void test('does not make readers of different files wait for each other', async () => {
    const { source, downloads } = createSource({
      files: { 'https://cdn.test/id1/a.lmp': [1], 'https://cdn.test/id1/b.lmp': [2] },
      delay: 10,
    });

    await Promise.all([source.read('id1/a.lmp'), source.read('id1/b.lmp')]);

    assert.equal(downloads.length, 2);
  });

  void test('reports a missing file as null and does not cache the miss', async () => {
    const { source, caches, downloads } = createSource();

    assert.equal(await source.read('id1/nothing.lmp'), null);
    assert.equal(await source.read('id1/nothing.lmp'), null);
    assert.equal(downloads.length, 2, 'a file that appears later is found');
    assert.equal(caches.caches.get('quakeshack/test/id1/boot').entries.size, 0);
  });

  void test('reports a failed download as null', async () => {
    const { source } = createSource();
    const warn = console.warn;

    console.warn = () => {};

    try {
      assert.equal(await source.read('id1/broken.lmp'), null);
    } finally {
      console.warn = warn;
    }
  });

  void test('still downloads when Cache Storage is unavailable', async () => {
    const { source, caches, downloads } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [4] } });
    const warn = console.warn;

    caches.failOpen = true;
    console.warn = () => {};

    try {
      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [4]);
      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [4]);
    } finally {
      console.warn = warn;
    }

    assert.equal(downloads.length, 2, 'without a cache every read downloads');
  });

  void test('still returns the file when it cannot be stored', async () => {
    const { source, caches } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [4] } });
    const warn = console.warn;

    (await caches.open('quakeshack/test/id1/boot')).failPut = true;
    console.warn = () => {};

    try {
      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [4]);
    } finally {
      console.warn = warn;
    }
  });

  void describe('revalidating', () => {
    /**
     * Builds a source that revalidates against a server whose file can change.
     * @param {{ etag: string, bytes: number[], reachable?: boolean, status?: number }} server the server state, changed by tests
     * @returns {{ source: CachedFetchAssetSource, requests: object[], caches: FakeCacheStorage }} the source and its fakes
     */
    function createRevalidatingSource(server) {
      const caches = new FakeCacheStorage();
      const requests = [];
      const source = new CachedFetchAssetSource({
        fetch: async (url, init) => {
          requests.push({ url, headers: init?.headers });

          if (server.reachable === false) {
            throw new TypeError('network down');
          }

          if (server.status !== undefined) {
            return new Response(null, { status: server.status });
          }

          if (init?.headers?.['If-None-Match'] === server.etag) {
            return new Response(null, { status: 304 });
          }

          return new Response(new Uint8Array(server.bytes), { headers: { ETag: server.etag } });
        },
        caches,
        locks: new FakeLocks(),
        resolveUrl: (path) => `https://cdn.test/${path}`,
        cacheName: () => 'quakeshack/dev/id1/boot',
        revalidate: true,
      });

      return { source, requests, caches };
    }

    void test('asks the server whether a cached file changed, and keeps it when it did not', async () => {
      const server = { etag: '"v1"', bytes: [1, 2] };
      const { source, requests } = createRevalidatingSource(server);

      await source.read('id1/a.lmp');

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [1, 2]);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1].headers, { 'If-None-Match': '"v1"' });
    });

    void test('downloads the file again when it changed, and caches the new version', async () => {
      const server = { etag: '"v1"', bytes: [1, 2] };
      const { source, requests } = createRevalidatingSource(server);

      await source.read('id1/a.lmp');
      server.etag = '"v2"';
      server.bytes = [3, 4, 5];

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [3, 4, 5]);

      server.reachable = false;

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [3, 4, 5], 'the new version is what is cached now');
      assert.equal(requests.length, 3);
    });

    void test('serves the cached file when the server cannot be reached', async () => {
      const server = { etag: '"v1"', bytes: [1, 2] };
      const { source } = createRevalidatingSource(server);

      await source.read('id1/a.lmp');
      server.reachable = false;

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [1, 2]);
    });

    void test('serves the cached file when the server answers with an error', async () => {
      const server = { etag: '"v1"', bytes: [1, 2] };
      const { source } = createRevalidatingSource(server);

      await source.read('id1/a.lmp');
      server.status = 503;

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [1, 2]);
    });

    void test('downloads again, without conditions, when the cached copy has no validators', async () => {
      const server = { etag: '"v1"', bytes: [1, 2] };
      const { source, caches, requests } = createRevalidatingSource(server);

      await (await caches.open('quakeshack/dev/id1/boot')).put('https://cdn.test/id1/a.lmp', new Response(new Uint8Array([9])));

      assert.deepEqual(bytes(await source.read('id1/a.lmp')), [1, 2]);
      assert.equal(requests[0].headers, undefined);
    });
  });

  void test('looks files up in the cache of the moment, so a new game version starts empty', async () => {
    let name = 'quakeshack/test/id1/boot';
    const { source, caches, downloads } = createSource({ files: { 'https://cdn.test/id1/a.lmp': [1] }, cacheName: () => name });

    await source.read('id1/a.lmp');
    name = 'quakeshack/test/id1/1.0.0';
    await source.read('id1/a.lmp');

    assert.equal(downloads.length, 2);
    assert.deepEqual(caches.opened, ['quakeshack/test/id1/boot', 'quakeshack/test/id1/1.0.0']);
  });
});

void describe('AssetCaches', () => {
  void describe('name', () => {
    void test('is made of engine version, game directory and game version', () => {
      assert.equal(AssetCaches.name('1.2.2+abc123', 'id1', '1.0.0'), 'quakeshack/1.2.2+abc123/id1/1.0.0');
    });

    void test('uses the boot namespace until the game version is known', () => {
      assert.equal(AssetCaches.name('1.2.2+abc123', 'id1', null), 'quakeshack/1.2.2+abc123/id1/boot');
    });
  });

  void describe('prune', () => {
    void test('deletes caches of other versions and keeps the running ones', async () => {
      const caches = new FakeCacheStorage();

      for (const name of ['quakeshack/1.2.1/id1/1.0.0', 'quakeshack/1.2.2/id1/1.0.0', 'quakeshack/1.2.2/id1/boot', 'quakeshack/1.2.2/id1/0.9.0']) {
        await caches.open(name);
      }

      const deleted = await AssetCaches.prune(caches, ['quakeshack/1.2.2/id1/1.0.0', 'quakeshack/1.2.2/id1/boot']);

      assert.deepEqual(deleted.sort(), ['quakeshack/1.2.1/id1/1.0.0', 'quakeshack/1.2.2/id1/0.9.0']);
      assert.deepEqual((await caches.keys()).sort(), ['quakeshack/1.2.2/id1/1.0.0', 'quakeshack/1.2.2/id1/boot']);
    });

    void test('leaves caches that do not belong to the engine alone', async () => {
      const caches = new FakeCacheStorage();

      await caches.open('workbox-precache-v2');
      await caches.open('some-other-app');

      assert.deepEqual(await AssetCaches.prune(caches, []), []);
      assert.equal((await caches.keys()).length, 2);
    });
  });
});
