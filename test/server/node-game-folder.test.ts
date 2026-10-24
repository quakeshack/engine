import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { NodeGameFolder } from '../../source/engine/server/NodeGameFolder.ts';

void describe('NodeGameFolder', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'node-game-folder-'));
    mkdirSync(join(root, 'data/id1/maps'), { recursive: true });
    writeFileSync(join(root, 'data/id1/maps/e1m1.bsp'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(root, 'secret.txt'), 'outside');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  void test('opens a file below the folder', async () => {
    const blob = await new NodeGameFolder(join(root, 'data')).open('id1/maps/e1m1.bsp');

    assert.deepEqual([...new Uint8Array(await blob!.arrayBuffer())], [1, 2, 3]);
  });

  void test('has no file where there is none, and none for a directory', async () => {
    const folder = new NodeGameFolder(join(root, 'data'));

    assert.equal(await folder.open('id1/maps/e1m2.bsp'), null);
    assert.equal(await folder.open('id1/maps'), null);
  });

  void test('opens nothing outside the folder', async () => {
    const folder = new NodeGameFolder(join(root, 'data'));

    assert.equal(await folder.open('../secret.txt'), null);
    assert.equal(await folder.open('id1/../../secret.txt'), null);
    assert.equal(await folder.open('id1\\..\\..\\secret.txt'), null);
    assert.equal(await folder.open(join(root, 'secret.txt')), null);
  });
});
