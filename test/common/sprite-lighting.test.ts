import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteLighting } from '../../source/engine/common/model/sprite/SpriteLighting.ts';

void describe('SpriteLighting.combine', () => {
  void test('adds the dynamic lights to the light of the map', () => {
    assert.deepEqual(SpriteLighting.combine([0.25, 0.5, 0.125], [0.25, 0, 0.125], [0, 0, 0]), [0.5, 0.5, 0.25]);
  });

  void test('never gets brighter than the texture', () => {
    assert.deepEqual(SpriteLighting.combine([1, 0.75, 0.5], [2, 0.5, 0], [0, 0, 0]), [1, 1, 0.5]);
  });

  void test('is black without any light', () => {
    assert.deepEqual(SpriteLighting.combine([0, 0, 0], [0, 0, 0], [1, 1, 1]), [0, 0, 0]);
  });

  void test('fills the array it is given and gives it back', () => {
    const out: [number, number, number] = [9, 9, 9];

    assert.equal(SpriteLighting.combine([0.5, 0.5, 0.5], [0, 0, 0], out), out);
    assert.deepEqual(out, [0.5, 0.5, 0.5]);
  });

  void test('takes the vectors the entity lighting hands out', () => {
    assert.deepEqual(SpriteLighting.combine(new Float32Array([0.5, 0.25, 0]), new Float32Array([0, 0.25, 0.5]), [0, 0, 0]), [0.5, 0.5, 0.5]);
  });
});
