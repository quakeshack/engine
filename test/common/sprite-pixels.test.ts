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

void describe('SpritePixels.keyColor', () => {
  void test('clears the pixels of the key color', () => {
    const rgba = new Uint8Array([0, 0, 0, 255, 10, 20, 30, 255, 0, 0, 0, 255]);

    SpritePixels.keyColor(rgba, [0, 0, 0], 0);

    assert.deepEqual([...rgba], [0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  void test('takes in colors within the tolerance of each channel', () => {
    const rgba = new Uint8Array([8, 8, 8, 255, 9, 0, 0, 255, 20, 0, 0, 255]);

    SpritePixels.keyColor(rgba, [0, 0, 0], 8);

    assert.deepEqual([...rgba], [0, 0, 0, 0, 9, 0, 0, 255, 20, 0, 0, 255]);
  });

  void test('compares a half transparent pixel by its color at full alpha', () => {
    // red at half alpha, premultiplied: stays red for a red key, is not black
    const rgba = new Uint8Array([128, 0, 0, 128, 0, 0, 0, 128]);

    SpritePixels.keyColor(rgba, [0, 0, 0], 0);

    assert.deepEqual([...rgba], [128, 0, 0, 128, 0, 0, 0, 0]);
  });

  void test('leaves pixels that are already transparent alone', () => {
    const rgba = new Uint8Array([0, 0, 0, 0]);

    SpritePixels.keyColor(rgba, [0, 0, 0], 0);

    assert.deepEqual([...rgba], [0, 0, 0, 0]);
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
