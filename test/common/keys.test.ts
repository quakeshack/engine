import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';

void describe('K', () => {
  void test('keeps the expected keyboard and mouse bindings', () => {
    assert.equal(K.ENTER, 13);
    assert.equal(K.ESCAPE, 27);
    assert.equal(K.MOUSE1, 200);
    assert.equal(K.MWHEELDOWN, 240);
  });
});
