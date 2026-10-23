import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CRC32 } from '../../source/engine/common/CRC.ts';
import { SpritePixels } from '../../source/engine/common/model/sprite/SpritePixels.ts';

void describe('SpritePixels.premultiply', () => {
  void test('multiplies the color by the alpha and keeps the alpha', () => {
    const rgba = new Uint8Array([200, 100, 50, 51, 255, 255, 255, 255, 9, 9, 9, 0]);

    SpritePixels.premultiply(rgba);

    assert.deepEqual([...rgba], [40, 20, 10, 51, 255, 255, 255, 255, 0, 0, 0, 0]);
  });
});

void describe('SpritePixels.halve', () => {
  void test('averages blocks of 2x2', () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 100, 0, 0, 100, 0, 100, 0, 100, 0, 0, 100, 100]);

    const halved = SpritePixels.halve(rgba, 2, 2);

    assert.deepEqual([halved.width, halved.height, ...halved.rgba], [1, 1, 25, 25, 25, 75]);
  });

  void test('averages what exists at an odd edge', () => {
    const rgba = new Uint8Array([10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30]);

    const halved = SpritePixels.halve(rgba, 3, 1);

    assert.deepEqual([halved.width, halved.height], [2, 1]);
    assert.deepEqual([...halved.rgba], [15, 15, 15, 15, 30, 30, 30, 30]);
  });
});

void describe('CRC32', () => {
  void test('matches the standard check value', () => {
    assert.equal(CRC32.Block(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  void test('can be continued', () => {
    const bytes = new TextEncoder().encode('123456789');

    assert.equal(CRC32.Block(bytes.subarray(4), CRC32.Block(bytes.subarray(0, 4))), 0xcbf43926);
  });

  void test('of nothing is 0', () => {
    assert.equal(CRC32.Block(new Uint8Array(0)), 0);
  });
});
