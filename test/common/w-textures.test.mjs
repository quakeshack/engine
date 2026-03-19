import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { translateIndexToLuminanceRGBA, translateIndexToRGBA } from '../../source/engine/common/W.mjs';

describe('translateIndexToRGBA', () => {
  test('treats palette index 240 as fullbright for legacy Quake textures', () => {
    const palette = new Uint8Array(256 * 3);
    palette[240 * 3] = 10;
    palette[240 * 3 + 1] = 20;
    palette[240 * 3 + 2] = 30;

    const rgba = translateIndexToRGBA(new Uint8Array([239, 240]), 2, 1, palette, null, 240);

    assert.deepEqual(Array.from(rgba), [
      0, 0, 0, 255,
      10, 20, 30, 0,
    ]);
  });
});

describe('translateIndexToLuminanceRGBA', () => {
  test('keeps only fullbright palette entries in the luminance texture', () => {
    const palette = new Uint8Array(256 * 3);
    palette[239 * 3] = 1;
    palette[239 * 3 + 1] = 2;
    palette[239 * 3 + 2] = 3;
    palette[240 * 3] = 10;
    palette[240 * 3 + 1] = 20;
    palette[240 * 3 + 2] = 30;
    palette[250 * 3] = 40;
    palette[250 * 3 + 1] = 50;
    palette[250 * 3 + 2] = 60;

    const rgba = translateIndexToLuminanceRGBA(new Uint8Array([239, 240, 250]), 3, 1, palette, null, 240);

    assert.deepEqual(Array.from(rgba), [
      0, 0, 0, 0,
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
  });

  test('skips transparent indexed pixels even when their palette index is fullbright', () => {
    const palette = new Uint8Array(256 * 3);
    palette[255 * 3] = 70;
    palette[255 * 3 + 1] = 80;
    palette[255 * 3 + 2] = 90;

    const rgba = translateIndexToLuminanceRGBA(new Uint8Array([255]), 1, 1, palette, 255, 240);

    assert.deepEqual(Array.from(rgba), [0, 0, 0, 0]);
  });
});
