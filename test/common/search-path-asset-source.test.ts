import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SearchPath } from '../../source/engine/common/Com.ts';
import { SearchPathAssetSource } from '../../source/engine/common/SearchPathAssetSource.ts';
import { createPak, MemoryGameFolder } from '../support/gameFolder.ts';

/**
 * Builds a source over a folder and adds the game directories to its search path, as `COM.AddGameDirectory` does.
 * @param folder The game folder.
 * @param directories The game directories, base game first.
 * @returns The source and its search paths.
 */
async function sourceOver(folder: MemoryGameFolder, directories: string[]): Promise<{ source: SearchPathAssetSource; searchpaths: SearchPath[] }> {
  const searchpaths: SearchPath[] = [];
  const source = new SearchPathAssetSource(folder, () => searchpaths);

  for (const directory of directories) {
    searchpaths.push((await source.loadGameDirectory(directory)).search);
  }

  return { source, searchpaths };
}

/**
 * Reads a file and returns its bytes as an array, for comparing.
 * @param source The source to read from.
 * @param path The path, `<game directory>/<file>`.
 * @returns The bytes, `null` when the file was not found.
 */
async function bytesOf(source: SearchPathAssetSource, path: string): Promise<number[] | null> {
  const data = await source.read(path);

  return data === null ? null : [...new Uint8Array(data)];
}

void describe('SearchPathAssetSource', () => {
  void describe('loadGameDirectory', () => {
    void test('opens pak0, pak1, ... up to the first one missing', async () => {
      const folder = new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'a.lmp': [1] }),
        'id1/pak1.pak': createPak({ 'b.lmp': [2], 'c.lmp': [3] }),
        'id1/pak3.pak': createPak({ 'd.lmp': [4] }),
      });
      const source = new SearchPathAssetSource(folder, () => []);

      const { search, paks } = await source.loadGameDirectory('id1');

      assert.equal(search.filename, 'id1');
      assert.deepEqual(search.pack.map((entries) => entries.map((entry) => entry.name)), [['a.lmp'], ['b.lmp', 'c.lmp']]);
      assert.deepEqual(paks.map(({ path, directory }) => [path, directory.entries.length]), [['id1/pak0.pak', 1], ['id1/pak1.pak', 2]]);
      assert.deepEqual(folder.opened, ['id1/pak0.pak', 'id1/pak1.pak', 'id1/pak2.pak']);
    });

    void test('finds the paks of the game folder itself for the empty game directory', async () => {
      const source = new SearchPathAssetSource(new MemoryGameFolder({ 'pak0.pak': createPak({ 'a.lmp': [1] }) }), () => []);

      const { paks } = await source.loadGameDirectory('');

      assert.deepEqual(paks.map(({ path }) => path), ['pak0.pak']);
    });
  });

  void describe('read', () => {
    void test('prefers a mod\'s file over the base game\'s', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/progs/player.mdl': [1],
        'hellwave/progs/player.mdl': [2],
      }), ['id1', 'hellwave']);

      assert.deepEqual(await bytesOf(source, 'hellwave/progs/player.mdl'), [2]);
    });

    void test('falls back to the base game for a file the mod does not have', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'gfx/palette.lmp': [7] }),
      }), ['id1', 'hellwave']);

      assert.deepEqual(await bytesOf(source, 'hellwave/gfx/palette.lmp'), [7]);
    });

    void test('prefers a pak over a loose file of the same game directory', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'maps/e1m1.bsp': [1] }),
        'id1/maps/e1m1.bsp': [2],
      }), ['id1']);

      assert.deepEqual(await bytesOf(source, 'id1/maps/e1m1.bsp'), [1]);
    });

    void test('prefers a higher-numbered pak over a lower one', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'maps/start.bsp': [1] }),
        'id1/pak1.pak': createPak({ 'maps/start.bsp': [2] }),
      }), ['id1']);

      assert.deepEqual(await bytesOf(source, 'id1/maps/start.bsp'), [2]);
    });

    void test('prefers a mod\'s loose file over a pak of the base game', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'maps/start.bsp': [1] }),
        'hellwave/maps/start.bsp': [2],
      }), ['id1', 'hellwave']);

      assert.deepEqual(await bytesOf(source, 'hellwave/maps/start.bsp'), [2]);
    });

    void test('does not see the game directories added after the one the path names', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({
        'id1/a.lmp': [1],
        'hellwave/a.lmp': [2],
        'hellwave/b.lmp': [3],
      }), ['id1', 'hellwave']);

      assert.deepEqual(await bytesOf(source, 'id1/a.lmp'), [1]);
      assert.equal(await source.read('id1/b.lmp'), null);
    });

    void test('finds nothing for a game directory that is not on the search path', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({ 'rogue/a.lmp': [1] }), ['id1']);

      assert.equal(await source.read('rogue/a.lmp'), null);
    });

    void test('reports a file that exists nowhere as null', async () => {
      const { source } = await sourceOver(new MemoryGameFolder({ 'id1/pak0.pak': createPak({ 'a.lmp': [1] }) }), ['id1']);

      assert.equal(await source.read('id1/missing.lmp'), null);
    });

    void test('passes over a pak that broke since its directory was read', async () => {
      const folder = new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'a.lmp': [1, 2, 3] }),
        'id1/a.lmp': [9],
      });
      const { source } = await sourceOver(folder, ['id1']);

      folder.files.set('id1/pak0.pak', new Uint8Array(4));

      assert.deepEqual(await bytesOf(source, 'id1/a.lmp'), [9]);
    });

    void test('reads through search paths that arrived as a copy, as a worker gets them', async () => {
      const folder = new MemoryGameFolder({
        'id1/pak0.pak': createPak({ 'a.lmp': [1] }),
        'hellwave/b.lmp': [2],
      });
      const { searchpaths } = await sourceOver(folder, ['id1', 'hellwave']);
      const copied = structuredClone(searchpaths);
      const workerSource = new SearchPathAssetSource(folder, () => copied);

      assert.deepEqual(await bytesOf(workerSource, 'hellwave/a.lmp'), [1]);
      assert.deepEqual(await bytesOf(workerSource, 'hellwave/b.lmp'), [2]);
    });
  });
});
