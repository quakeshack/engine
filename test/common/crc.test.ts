import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CRC16CCITT } from '../../source/engine/common/CRC.ts';

void describe('CRC16CCITT', () => {
  void test('matches the standard CRC-16-CCITT checksum for 123456789', () => {
    const input = new TextEncoder().encode('123456789');

    assert.equal(CRC16CCITT.Block(input), 0x29b1);
  });

  void test('returns the initial seed when hashing an empty block', () => {
    assert.equal(CRC16CCITT.Block(new Uint8Array(0)), 0xffff);
  });
});
