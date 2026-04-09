import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatIP } from '../../source/engine/network/Misc.ts';

void describe('formatIP', () => {
  void test('formats ipv4 addresses without brackets', () => {
    assert.equal(formatIP('127.0.0.1', 26000), '127.0.0.1:26000');
  });

  void test('wraps ipv6 addresses in brackets', () => {
    assert.equal(formatIP('2001:db8::1', 26000), '[2001:db8::1]:26000');
  });
});
