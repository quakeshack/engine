import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import W from '../../source/engine/common/W.ts';
import { WalTextureLoader } from '../../source/engine/common/model/WalTextureLoader.ts';

/**
 * Build a minimal, valid `.wal` buffer: an 8x8 base mip with a full 4-level
 * mip chain (8x8, 4x4, 2x2, 1x1), each level filled with a distinct byte
 * value so tests can tell mip levels apart.
 * @param {string} name texture name to embed in the header
 * @param {number[]} mipFillValues palette index used to fill each of the 4 mip levels
 * @returns {ArrayBuffer} a synthetic `.wal` file buffer
 */
function createWalBuffer(name = 'e1u1/test', mipFillValues = [1, 2, 3, 4]) {
  const width = 8;
  const height = 8;
  const mipSizes = [width * height, (width / 2) * (height / 2), (width / 4) * (height / 4), (width / 8) * (height / 8)];
  const headerSize = 100;
  const mipOffsets = [];
  let cursor = headerSize;
  for (const size of mipSizes) {
    mipOffsets.push(cursor);
    cursor += size;
  }

  const buffer = new ArrayBuffer(cursor);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const nameBytes = new TextEncoder().encode(name);
  bytes.set(nameBytes.subarray(0, 32), 0);

  view.setUint32(32, width, true);
  view.setUint32(36, height, true);

  for (let i = 0; i < 4; i++) {
    view.setUint32(40 + i * 4, mipOffsets[i], true);
  }

  for (let i = 0; i < 4; i++) {
    bytes.fill(mipFillValues[i], mipOffsets[i], mipOffsets[i] + mipSizes[i]);
  }

  return buffer;
}

/**
 * Temporarily install a known palette so decoded RGB values are verifiable,
 * then restore whatever palette was active before.
 * @param {(palette: Uint8Array) => void} callback test body, receives the installed palette
 */
function withKnownPalette(callback) {
  const originalPalette = W.d_8to24table_u8;
  const palette = new Uint8Array(768);

  // index 1 -> (10, 20, 30), index 2 -> (40, 50, 60), etc.
  for (let index = 1; index <= 4; index++) {
    palette[index * 3 + 0] = index * 10;
    palette[index * 3 + 1] = index * 10 + 10;
    palette[index * 3 + 2] = index * 10 + 20;
  }

  W.d_8to24table_u8 = palette;

  try {
    callback(palette);
  } finally {
    W.d_8to24table_u8 = originalPalette;
  }
}

void describe('WalTextureLoader.decode', () => {
  void test('decodes mip level 0 with correct dimensions and palette-resolved RGBA', () => {
    withKnownPalette(() => {
      const buffer = createWalBuffer('e1u1/test', [1, 2, 3, 4]);
      const texture = WalTextureLoader.decode(buffer, 'fallback-name');

      assert.ok(texture !== null);
      assert.equal(texture.name, 'e1u1/test');
      assert.equal(texture.width, 8);
      assert.equal(texture.height, 8);
      assert.equal(texture.data.length, 8 * 8 * 4);

      // every mip-0 texel is palette index 1 -> (10, 20, 30), fully opaque
      assert.deepEqual([...texture.data.subarray(0, 4)], [10, 20, 30, 255]);
      assert.deepEqual([...texture.data.subarray(4, 8)], [10, 20, 30, 255]);
    });
  });

  void test('decodes a higher mip level at the scaled-down resolution', () => {
    withKnownPalette(() => {
      const buffer = createWalBuffer('e1u1/test', [1, 2, 3, 4]);
      const texture = WalTextureLoader.decode(buffer, 'fallback-name', 2);

      assert.ok(texture !== null);
      assert.equal(texture.width, 2);
      assert.equal(texture.height, 2);
      // mip level 2 was filled with palette index 3 -> (30, 40, 50)
      assert.deepEqual([...texture.data.subarray(0, 4)], [30, 40, 50, 255]);
    });
  });

  void test('falls back to the given name when the embedded name is empty', () => {
    withKnownPalette(() => {
      const buffer = createWalBuffer('', [1, 1, 1, 1]);
      const texture = WalTextureLoader.decode(buffer, 'fallback-name');

      assert.ok(texture !== null);
      assert.equal(texture.name, 'fallback-name');
    });
  });

  void test('returns null for a buffer too small to hold a .wal header', () => {
    const texture = WalTextureLoader.decode(new ArrayBuffer(10), 'test');
    assert.equal(texture, null);
  });

  void test('returns null when width or height is zero', () => {
    const buffer = createWalBuffer('e1u1/test', [1, 1, 1, 1]);
    new DataView(buffer).setUint32(32, 0, true); // zero out width

    const texture = WalTextureLoader.decode(buffer, 'test');
    assert.equal(texture, null);
  });

  void test('returns null when the mip offset runs past the end of the buffer', () => {
    const buffer = createWalBuffer('e1u1/test', [1, 1, 1, 1]);
    // point mip level 0 at an offset that leaves no room for 8x8 pixel data
    new DataView(buffer).setUint32(40, buffer.byteLength - 1, true);

    const texture = WalTextureLoader.decode(buffer, 'test');
    assert.equal(texture, null);
  });
});
