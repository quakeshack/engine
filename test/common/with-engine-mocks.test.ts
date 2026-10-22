import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { engineMocks } from '../support/engineMocks.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

void describe('withEngineMocks', () => {
  void test('installs the mocks for the callback and puts back what was there before', () => {
    const before = { name: 'before' };

    engineMocks.Sys = before;

    try {
      const seen = withEngineMocks({ Sys: { name: 'mock' } }, () => engineMocks.Sys);

      assert.deepEqual(seen, { name: 'mock' });
      assert.equal(engineMocks.Sys, before);
    } finally {
      engineMocks.Sys = undefined;
    }
  });

  void test('puts the mocks back when the callback throws', () => {
    assert.throws(() => withEngineMocks({ Sys: { name: 'mock' } }, () => {
      throw new Error('boom');
    }), /boom/);
    assert.equal(engineMocks.Sys, undefined);
  });

  void test('keeps the mocks until a promise settles, and takes them away when it rejects', async () => {
    let during: unknown = null;

    await assert.rejects(withEngineMocks({ Sys: { name: 'mock' } }, async () => {
      await Promise.resolve();
      during = engineMocks.Sys;
      throw new Error('later');
    }), /later/);
    assert.deepEqual(during, { name: 'mock' });
    assert.equal(engineMocks.Sys, undefined);
  });

  void test('returns what the callback returns', () => {
    assert.equal(withEngineMocks({}, () => 42), 42);
  });
});
