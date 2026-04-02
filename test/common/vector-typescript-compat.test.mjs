import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import VectorFromMjs, { DirectionalVectors as DirectionalVectorsFromMjs, Quaternion as QuaternionFromMjs } from '../../source/shared/Vector.mjs';
import VectorFromTs, { DirectionalVectors as DirectionalVectorsFromTs, Quaternion as QuaternionFromTs } from '../../source/shared/Vector.ts';

void describe('shared Vector TypeScript migration', () => {
  void test('keeps the .mjs compatibility facade wired to the .ts implementation', () => {
    assert.strictEqual(VectorFromMjs, VectorFromTs);
    assert.strictEqual(DirectionalVectorsFromMjs, DirectionalVectorsFromTs);
    assert.strictEqual(QuaternionFromMjs, QuaternionFromTs);
    assert.strictEqual(VectorFromMjs.origin, VectorFromTs.origin);

    const vector = new VectorFromMjs(1, 2, 3);
    assert.equal(vector.toString(), '1 2 3');
    assert.deepEqual(Array.from(vector.copy()), [1, 2, 3]);
  });
});
