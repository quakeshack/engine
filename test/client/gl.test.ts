import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL, { resampleTexture8 } from '../../source/engine/client/GL.ts';

void describe('GL', () => {
  void test('resampleTexture8 downsamples with nearest-neighbor picks', () => {
    const source = new Uint8Array([
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 11, 12,
      13, 14, 15, 16,
    ]);

    const result = resampleTexture8(source, 4, 4, 2, 2);

    assert.deepEqual(Array.from(result), [1, 3, 9, 11]);
  });

  void describe('SnapPixelScale', () => {
    void test('leaves whole-pixel scales unchanged', () => {
      assert.equal(GL.SnapPixelScale(1), 1);
      assert.equal(GL.SnapPixelScale(2), 2);
      assert.equal(GL.SnapPixelScale(4), 4);
    });

    void test('rounds a fractional scale to the nearest whole pixel multiple', () => {
      // The exact case that produced moiré banding on nearest-filtered menu text: a 640x360
      // virtual viewport 'contain'-fit into a 960x600 window resolves to scale 1.5, which used
      // to be applied directly and beat against the conchars/header-font fine pixel detail.
      assert.equal(GL.SnapPixelScale(1.5), 2);
      assert.equal(GL.SnapPixelScale(2.4), 2);
      assert.equal(GL.SnapPixelScale(2.6), 3);
    });

    void test('never rounds below 1, even for a sub-1 scale', () => {
      assert.equal(GL.SnapPixelScale(0.4), 1);
    });
  });
});
