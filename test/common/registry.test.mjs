import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { getClientRegistry, getCommonRegistry, registry } from '../../source/engine/registry.ts';

void describe('registry views', () => {
  void test('return the shared registry singleton', () => {
    assert.equal(getCommonRegistry(), registry);
    assert.equal(getClientRegistry(), registry);
  });
});
