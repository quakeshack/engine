import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readWad3Texture, translateIndexToLuminanceRGBA, translateIndexToRGBA } from '../../source/engine/common/W.ts';

void describe('translateIndexToRGBA', () => {
  void test('treats palette index 240 as fullbright for legacy Quake textures', () => {
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

void describe('translateIndexToLuminanceRGBA', () => {
  void test('keeps only fullbright palette entries in the luminance texture', () => {
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

  void test('skips transparent indexed pixels even when their palette index is fullbright', () => {
    const palette = new Uint8Array(256 * 3);
    palette[255 * 3] = 70;
    palette[255 * 3 + 1] = 80;
    palette[255 * 3 + 2] = 90;

    const rgba = translateIndexToLuminanceRGBA(new Uint8Array([255]), 1, 1, palette, 255, 240);

    assert.deepEqual(Array.from(rgba), [0, 0, 0, 0]);
  });
});

void describe('readWad3Texture', () => {
  void test('applies transparent and fullbright rules from the miptex name markers', () => {
    const width = 8;
    const height = 8;
    const headerSize = 40;
    const mip0Size = width * height;
    const mip1Size = (width / 2) * (height / 2);
    const mip2Size = (width / 4) * (height / 4);
    const mip3Size = (width / 8) * (height / 8);
    const paletteOffset = headerSize + mip0Size + mip1Size + mip2Size + mip3Size + 2;
    const buffer = new ArrayBuffer(paletteOffset + 768);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    bytes.set(new TextEncoder().encode('{A~'), 0);
    view.setUint32(16, width, true);
    view.setUint32(20, height, true);
    view.setUint32(24, headerSize, true);
    view.setUint32(28, headerSize + mip0Size, true);
    view.setUint32(32, headerSize + mip0Size + mip1Size, true);
    view.setUint32(36, headerSize + mip0Size + mip1Size + mip2Size, true);

    bytes[headerSize] = 255;
    bytes[headerSize + 1] = 240;

    view.setUint16(headerSize + mip0Size + mip1Size + mip2Size + mip3Size, 256, true);

    bytes[paletteOffset + 240 * 3] = 10;
    bytes[paletteOffset + 240 * 3 + 1] = 20;
    bytes[paletteOffset + 240 * 3 + 2] = 30;

    const texture = readWad3Texture(buffer, 'fallback', 0);

    assert.equal(texture.name, '{A~');
    assert.equal(texture.width, 8);
    assert.equal(texture.height, 8);
    assert.deepEqual(Array.from(texture.data.slice(0, 8)), [
      0, 0, 0, 0,
      10, 20, 30, 0,
    ]);
  });
});
