import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveSkyBloomEmissiveScale } from '../../source/engine/client/renderer/Sky.ts';

describe('resolveSkyBloomEmissiveScale', () => {
  test('clamps invalid values to zero', () => {
    assert.equal(resolveSkyBloomEmissiveScale(-1), 0.0);
    assert.equal(resolveSkyBloomEmissiveScale(0), 0.0);
    assert.equal(resolveSkyBloomEmissiveScale(Number.NaN), 0.0);
  });

  test('preserves positive sky bloom strengths', () => {
    assert.equal(resolveSkyBloomEmissiveScale(0.2), 0.2);
    assert.equal(resolveSkyBloomEmissiveScale(0.75), 0.75);
  });
});
