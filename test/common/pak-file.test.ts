import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CRC16CCITT } from '../../source/engine/common/CRC.ts';
import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { PakFile } from '../../source/engine/common/PakFile.ts';
import { createPak } from '../support/gameFolder.ts';

/**
 * Wraps bytes in a blob, as a browser `File` or Node's `fs.openAsBlob` would hand them over.
 * @param bytes The file's contents.
 * @returns The blob.
 */
function blobOf(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes]);
}

void describe('PakFile', () => {
  void describe('readDirectory', () => {
    void test('lists the files in archive order with their offsets and lengths, names in lower case', async () => {
      const pak = createPak({ 'MAPS/E1M1.bsp': [1, 2, 3], 'progs/player.mdl': [4] });

      const { entries } = await PakFile.readDirectory(blobOf(pak), 'pak0.pak');

      // The header takes the first 12 bytes, the files follow without gaps.
      assert.deepEqual(entries, [
        { name: 'maps/e1m1.bsp', filepos: 12, filelen: 3 },
        { name: 'progs/player.mdl', filepos: 15, filelen: 1 },
      ]);
    });

    void test('reports the CRC-16 of the raw directory, which id\'s shareware check compares', async () => {
      const pak = createPak({ 'a.lmp': [1] });
      const directory = pak.subarray(pak.length - PakFile.ENTRY_SIZE);

      const { checksum } = await PakFile.readDirectory(blobOf(pak), 'pak0.pak');

      assert.equal(checksum, CRC16CCITT.Block(directory));
    });

    void test('reads an archive without files', async () => {
      const { entries } = await PakFile.readDirectory(blobOf(createPak({})), 'pak0.pak');

      assert.deepEqual(entries, []);
    });

    void test('rejects a file that does not start with PACK', async () => {
      const pak = createPak({ 'a.lmp': [1] });

      pak[0] = 0x57; // 'W', as in WAD2

      await assert.rejects(PakFile.readDirectory(blobOf(pak), 'pak0.pak'), CorruptedResourceError);
    });

    void test('rejects a file shorter than the header', async () => {
      await assert.rejects(PakFile.readDirectory(blobOf(new Uint8Array([0x50, 0x41, 0x43, 0x4b])), 'pak0.pak'), CorruptedResourceError);
    });

    void test('rejects a directory that lies outside the file', async () => {
      const pak = createPak({ 'a.lmp': [1] });

      await assert.rejects(PakFile.readDirectory(blobOf(pak.slice(0, pak.length - 1)), 'pak0.pak'), CorruptedResourceError);
    });
  });

  void describe('readEntry', () => {
    void test('reads exactly the bytes of one file', async () => {
      const pak = blobOf(createPak({ 'a.lmp': [1, 2], 'b.lmp': [3, 4, 5] }));
      const { entries } = await PakFile.readDirectory(pak, 'pak0.pak');

      const data = await PakFile.readEntry(pak, entries[1], 'pak0.pak');

      assert.deepEqual([...new Uint8Array(data)], [3, 4, 5]);
    });

    void test('reads an empty file as an empty buffer', async () => {
      const pak = blobOf(createPak({ 'empty.cfg': [] }));
      const { entries } = await PakFile.readDirectory(pak, 'pak0.pak');

      assert.equal((await PakFile.readEntry(pak, entries[0], 'pak0.pak')).byteLength, 0);
    });

    void test('rejects an entry that reaches past the end of the file', async () => {
      const pak = blobOf(createPak({ 'a.lmp': [1] }));

      await assert.rejects(PakFile.readEntry(pak, { name: 'a.lmp', filepos: 12, filelen: 1000 }, 'pak0.pak'), CorruptedResourceError);
    });
  });
});
