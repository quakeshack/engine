import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { ModelPrecacheList } from '../../source/engine/network/ModelPrecacheList.ts';
import { ModelPrecacheFlags } from '../../source/shared/ModelPrecacheFlags.ts';

/**
 * @returns The bytes written to a buffer.
 */
function bytesOf(message: SzBuffer): number[] {
  return [...new Uint8Array(message.data, 0, message.cursize)];
}

void describe('ModelPrecacheList', () => {
  void test('writes a flags byte after each name and a zero byte at the end, leaving out the unused first entry', () => {
    const message = new SzBuffer(256);

    ModelPrecacheList.write(message, ['', 'maps/start.bsp', 'gfx/flame.gif'], [0, 0, ModelPrecacheFlags.noSidecar]);

    assert.deepEqual(bytesOf(message), [
      ...[...'maps/start.bsp'].map((character) => character.charCodeAt(0)), 0, 0,
      ...[...'gfx/flame.gif'].map((character) => character.charCodeAt(0)), 0, 1,
      0,
    ]);
  });

  void test('an entry without a hint is sent with none', () => {
    const message = new SzBuffer(256);

    ModelPrecacheList.write(message, ['', 'a.mdl'], []);

    assert.deepEqual(bytesOf(message), [97, 46, 109, 100, 108, 0, 0, 0]);
  });

  void test('reads back what was written, indexed from 1', () => {
    const message = new SzBuffer(256);

    ModelPrecacheList.write(message, ['', 'maps/start.bsp', '*1', 'gfx/flame.gif'], [0, 0, 0, ModelPrecacheFlags.noSidecar]);
    message.readcount = 0;

    const { names, flags } = ModelPrecacheList.read(message);

    assert.deepEqual(names.slice(1), ['maps/start.bsp', '*1', 'gfx/flame.gif']);
    assert.equal(names[0], undefined);
    assert.equal(names.length, 4);
    assert.deepEqual(flags.slice(1), [0, 0, ModelPrecacheFlags.noSidecar]);
  });

  void test('stops at the empty name, what follows is for the caller', () => {
    const message = new SzBuffer(256);

    ModelPrecacheList.write(message, ['', 'a.mdl'], []);
    message.writeString('sound.wav');
    message.readcount = 0;

    ModelPrecacheList.read(message);

    assert.equal(message.readString(), 'sound.wav');
  });
});
