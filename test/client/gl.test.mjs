import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resampleTexture8 } from '../../source/engine/client/GL.ts';

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
});
