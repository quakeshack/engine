import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Q, { AsyncFunction, enumHelpers } from '../../source/shared/Q.ts';

void describe('Q', () => {
  void test('round-trips strings through byte buffers', () => {
    const bytes = new Uint8Array(Q.strmem('quake'));

    assert.equal(Q.memstr(bytes), 'quake');
  });

  void test('compares floats with epsilon tolerance', () => {
    assert.equal(Q.compareFloat(1.0, 1.0 + 1e-9), true);
    assert.equal(Q.compareFloat(1.0, 1.1), false);
  });

  void test('provides enum helper lookups', () => {
    const testEnum = Object.freeze({
      READY: 1,
      DONE: 2,
      ...enumHelpers,
    });

    assert.equal(testEnum.toKey(2), 'DONE');
    assert.equal(testEnum.fromKey('READY'), 1);
    assert.equal(testEnum.fromKey('MISSING'), null);
  });

  void test('exposes the async function constructor', () => {
    assert.equal(typeof AsyncFunction, 'function');
    const asyncFunction = new AsyncFunction('return 42;');

    assert.equal(asyncFunction.constructor, AsyncFunction);
  });
});
