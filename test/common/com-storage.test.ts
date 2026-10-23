import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type { BuildConfig } from '../../source/engine/build-config';
import COM from '../../source/engine/common/Com.ts';
import { BackendUserStore, MemoryBackend, type UserStore } from '../../source/engine/common/UserStore.ts';
import { GeneratedFileStore } from '../../source/engine/common/GeneratedFileStore.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';

/** The COM of the running test, replaced by `withStorage` before any test code runs. */
let com: COM;

/** What {@link withStorage} serves and sets up. */
interface StorageOptions {
  /** Content files by path, as bytes. */
  assets?: Record<string, number[]>;
  /** The user store; a memory store when left out, none when `null`. */
  userStore?: UserStore | null;
  /** The version of the loaded game. */
  gameVersion?: string | null;
  /** The build config the COM reads; what it leaves out is a production build without a game directory. */
  buildConfig?: Partial<BuildConfig>;
}

/**
 * Runs a callback with a COM that has fake storage and a game directory.
 * @param options what the fake storage serves
 * @param callback test callback
 * @returns resolves once the callback is done
 */
async function withStorage({ assets = {}, userStore, gameVersion = null, buildConfig }: StorageOptions = {}, callback: (context: { reads: string[], printed: string[], store: UserStore, generated: GeneratedFileStore, generatedBackend: MemoryBackend }) => Promise<void> | void): Promise<void> {
  const reads: string[] = [];
  const printed: string[] = [];
  const store: UserStore | null = userStore === undefined ? new BackendUserStore(new MemoryBackend()) : userStore;
  const generatedBackend = new MemoryBackend();
  const generated = new GeneratedFileStore(generatedBackend);

  com = new COM({
    con: { DPrint() {}, Print() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} },
    sys: { Print: (text: string) => { printed.push(text); }, FloatTime: () => 0 },
    buildConfig: () => buildConfig === undefined ? undefined : { mode: 'production', timestamp: 'T', commitHash: null, gameDir: null, baseDir: null, ...buildConfig },
    urls: () => ({ cdnURL: 'https://cdn.test/{gameDir}/{filename}' }),
  });
  com.searchpaths = [{ filename: 'id1', pack: [] }];
  com.gameVersion = gameVersion;
  com.userStore = store;
  com.generatedStore = generated;
  com.assetSource = {
    read(path: string) {
      reads.push(path);

      return Promise.resolve(assets[path] === undefined ? null : new Uint8Array(assets[path]).buffer);
    },
  };

  await callback({ reads, printed, store: store!, generated, generatedBackend });
}

/** The asset cache name, and with it the namespace of the generated files, of a build `abc123` running game version 1.0.0. */
const RUNNING = 'quakeshack/1.3.0+abc123/id1/1.0.0';

/** The build config of {@link RUNNING}. */
const RUNNING_BUILD: Partial<BuildConfig> = { commitHash: 'abc123', timestamp: 'T' };

void describe('COM storage', () => {
  void describe('LoadFile', () => {
    void test('reads content through the asset source, by game directory and lower-cased name', async () => {
      await withStorage({ assets: { 'id1/maps/e1m1.bsp': [7, 8] } }, async ({ reads }) => {
        const data = await com.LoadFile('MAPS/E1M1.BSP');

        assert.deepEqual([...new Uint8Array(data!)], [7, 8]);
        assert.deepEqual(reads, ['id1/maps/e1m1.bsp']);
      });
    });

    void test('prefers a file the engine wrote over content of the same name', async () => {
      await withStorage({ assets: { 'id1/config.cfg': [1] } }, async ({ store, reads }) => {
        await store.write('id1/config.cfg', new Uint8Array([2]));

        assert.deepEqual([...new Uint8Array((await com.LoadFile('config.cfg'))!)], [2]);
        assert.deepEqual(reads, [], 'the asset source is not even asked');
      });
    });

    void test('reports a file that exists nowhere as null', async () => {
      await withStorage({}, async ({ printed }) => {
        assert.equal(await com.LoadFile('nothing.lmp'), null);
        assert.ok(printed.some((line) => line.includes('can\'t find nothing.lmp')));
      });
    });

    void test('announces the start and the end of every load, found or not', async () => {
      await withStorage({ assets: { 'id1/a.lmp': [1] } }, async () => {
        const events: Array<[string, string]> = [];
        const unsubscribers = [
          eventBus.subscribe('com.fs.being', (name) => { events.push(['begin', name]); }),
          eventBus.subscribe('com.fs.end', (name) => { events.push(['end', name]); }),
        ];

        try {
          await com.LoadFile('a.lmp');
          await com.LoadFile('b.lmp');
        } finally {
          unsubscribers.forEach((unsubscribe) => { unsubscribe(); });
        }

        assert.deepEqual(events, [['begin', 'a.lmp'], ['end', 'a.lmp'], ['begin', 'b.lmp'], ['end', 'b.lmp']]);
      });
    });

    void test('still serves content when there is no user store', async () => {
      await withStorage({ assets: { 'id1/a.lmp': [3] }, userStore: null }, async () => {
        assert.deepEqual([...new Uint8Array((await com.LoadFile('a.lmp'))!)], [3]);
      });
    });

    void test('prefers a file generated by the running version over content of the same name', async () => {
      await withStorage({ assets: { 'id1/maps/e1m1.nav': [1] }, gameVersion: '1.0.0', buildConfig: RUNNING_BUILD }, async ({ generated, reads }) => {
        await generated.write(RUNNING, 'maps/e1m1.nav', new Uint8Array([2]));

        assert.deepEqual([...new Uint8Array((await com.LoadFile('maps/e1m1.nav'))!)], [2]);
        assert.deepEqual(reads, [], 'the asset source is not even asked');
      });
    });

    void test('ignores a file another version generated and serves the content', async () => {
      await withStorage({ assets: { 'id1/maps/e1m1.nav': [1] }, gameVersion: '1.0.0', buildConfig: RUNNING_BUILD }, async ({ generated }) => {
        await generated.write('quakeshack/1.2.0+old/id1/1.0.0', 'maps/e1m1.nav', new Uint8Array([2]));

        assert.deepEqual([...new Uint8Array((await com.LoadFile('maps/e1m1.nav'))!)], [1]);
      });
    });

    void test('prefers a user file over a generated one', async () => {
      await withStorage({ gameVersion: '1.0.0', buildConfig: RUNNING_BUILD }, async ({ store, generated }) => {
        await generated.write(RUNNING, 'a.lmp', new Uint8Array([2]));
        await store.write('id1/a.lmp', new Uint8Array([3]));

        assert.deepEqual([...new Uint8Array((await com.LoadFile('a.lmp'))!)], [3]);
      });
    });
  });

  void describe('WriteGeneratedFile', () => {
    void test('stores the file for the running version only, never among the user files', async () => {
      await withStorage({ gameVersion: '1.0.0', buildConfig: RUNNING_BUILD }, async ({ store, generatedBackend }) => {
        assert.equal(await com.WriteGeneratedFile('MAPS/E1M1.NAV', new Uint8Array([4, 5])), true);

        assert.deepEqual(await generatedBackend.keys(), [`${RUNNING}/maps/e1m1.nav`]);
        assert.equal(await store.read('id1/maps/e1m1.nav'), null);
        assert.deepEqual([...new Uint8Array((await com.LoadFile('maps/e1m1.nav'))!)], [4, 5]);
      });
    });

    void test('reports false when the store refuses the file', async () => {
      await withStorage({}, async ({ generatedBackend, printed }) => {
        generatedBackend.put = () => Promise.reject(new Error('quota exceeded'));

        const warn = mock.method(console, 'warn', () => {});

        try {
          assert.equal(await com.WriteGeneratedFile('maps/e1m1.nav', new Uint8Array([1])), false);
        } finally {
          warn.mock.restore();
        }

        assert.ok(printed.some((line) => line.includes('failed on maps/e1m1.nav')));
      });
    });
  });

  void describe('WriteTextFile and LoadTextFile', () => {
    void test('round-trip a text file, with the carriage returns stripped on the way back', async () => {
      await withStorage({}, async () => {
        assert.equal(await com.WriteTextFile('Config.CFG', 'a\r\nb\n'), true);
        assert.equal(await com.LoadTextFile('config.cfg'), 'a\nb\n');
      });
    });

    void test('keep files of different game directories apart', async () => {
      await withStorage({}, async () => {
        await com.WriteTextFile('config.cfg', 'id1');
        // eslint-disable-next-line require-atomic-updates
        com.searchpaths = [{ filename: 'hellwave', pack: [] }];

        assert.equal(await com.LoadTextFile('config.cfg'), null);
      });
    });

    void test('report false when the store refuses the file', async () => {
      const refusing: UserStore = { read: () => Promise.resolve(null), write: () => Promise.resolve(false), remove: () => Promise.resolve(true) };

      await withStorage({ userStore: refusing }, async ({ printed }) => {
        assert.equal(await com.WriteTextFile('config.cfg', 'x'), false);
        assert.ok(printed.some((line) => line.includes('failed on config.cfg')));
      });
    });

    void test('report false when there is no store at all', async () => {
      await withStorage({ userStore: null }, async () => {
        assert.equal(await com.WriteTextFile('config.cfg', 'x'), false);
      });
    });
  });

  void describe('WriteFile', () => {
    void test('stores exactly len bytes', async () => {
      await withStorage({}, async () => {
        assert.equal(await com.WriteFile('demo.dem', [1, 2, 3, 4, 5], 3), true);
        assert.deepEqual([...new Uint8Array((await com.LoadFile('demo.dem'))!)], [1, 2, 3]);
      });
    });
  });

  void describe('asset cache name', () => {
    void test('uses the commit of the build when there is one', async () => {
      await withStorage({ buildConfig: { commitHash: 'abc123', timestamp: 'T' } }, () => {
        assert.equal(com.GetEngineBuildVersion(), '1.3.0+abc123');
      });
    });

    void test('falls back to the build time, so local rebuilds never serve stale files', async () => {
      await withStorage({ buildConfig: { commitHash: null, timestamp: '2026-10-05T00:00:00.000Z' } }, () => {
        assert.equal(com.GetEngineBuildVersion(), '1.3.0@2026-10-05T00:00:00.000Z');
      });
    });

    void test('is in the boot namespace until the game version is set', async () => {
      await withStorage({ buildConfig: { commitHash: 'abc123', timestamp: 'T' } }, () => {
        assert.equal(com.GetAssetCacheName(), 'quakeshack/1.3.0+abc123/id1/boot');
      });
    });

    void test('follows the game version once it is set, and deletes the caches of other builds', async () => {
      const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
      const names = new Set([
        'quakeshack/1.2.1+old/id1/1.0.0',
        'quakeshack/1.3.0+abc123/id1/boot',
        'quakeshack/1.3.0+abc123/id1/0.9.0',
        'unrelated',
      ]);

      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: {
          keys: () => Promise.resolve([...names]),
          delete: (name: string) => Promise.resolve(names.delete(name)),
        },
      });

      try {
        await withStorage({ buildConfig: { commitHash: 'abc123', timestamp: 'T' } }, async () => {
          await com.SetGameVersion('1.0.0');

          assert.equal(com.GetAssetCacheName(), 'quakeshack/1.3.0+abc123/id1/1.0.0');
          assert.deepEqual([...names].sort(), ['quakeshack/1.3.0+abc123/id1/boot', 'unrelated']);
        });
      } finally {
        if (previousCaches === undefined) {
          Reflect.deleteProperty(globalThis, 'caches');
        } else {
          Object.defineProperty(globalThis, 'caches', previousCaches);
        }
      }
    });

    void test('remembers the game version even where there is no asset source to clean up', async () => {
      await withStorage({}, async () => {
        com.assetSource = null;

        await com.SetGameVersion('2.0.0');

        assert.equal(com.gameVersion, '2.0.0');
      });
    });

    void test('deletes the files other builds and versions generated, and leaves the user files alone', async () => {
      await withStorage({ buildConfig: RUNNING_BUILD }, async ({ store, generated, generatedBackend }) => {
        com.assetSource = null;
        await generated.write(RUNNING, 'maps/e1m1.nav', new Uint8Array([1]));
        await generated.write('quakeshack/1.2.0+old/id1/1.0.0', 'maps/e1m1.nav', new Uint8Array([1]));
        await generated.write('quakeshack/1.3.0+abc123/id1/0.9.0', 'maps/e1m2.nav', new Uint8Array([1]));
        await store.write('id1/config.cfg', new Uint8Array([1]));
        await store.write('id1/s0.json', new Uint8Array([1]));

        await com.SetGameVersion('1.0.0');

        assert.deepEqual(await generatedBackend.keys(), [`${RUNNING}/maps/e1m1.nav`]);
        assert.notEqual(await store.read('id1/config.cfg'), null);
        assert.notEqual(await store.read('id1/s0.json'), null);
      });
    });
  });
});
