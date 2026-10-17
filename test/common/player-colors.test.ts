import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import PlayerColors from '../../source/engine/common/PlayerColors.ts';

void describe('PlayerColors', () => {
  void describe('parse', () => {
    void test('uses one argument for both shirt and pants', () => {
      assert.deepEqual(PlayerColors.parse(['5']), { top: 5, bottom: 5 });
    });

    void test('takes shirt and pants from two arguments', () => {
      assert.deepEqual(PlayerColors.parse(['3', '9']), { top: 3, bottom: 9 });
    });

    void test('clamps the 14 and 15 palette rows to 13', () => {
      assert.deepEqual(PlayerColors.parse(['14', '15']), { top: 13, bottom: 13 });
    });

    void test('only looks at the low four bits', () => {
      // 17 & 15 === 1
      assert.deepEqual(PlayerColors.parse(['17', '18']), { top: 1, bottom: 2 });
    });
  });

  void describe('pack', () => {
    void test('puts the shirt into the high nibble and the pants into the low one', () => {
      assert.equal(PlayerColors.pack(3, 9), 0x39);
    });

    void test('round-trips with parse', () => {
      const { top, bottom } = PlayerColors.parse(['12', '4']);

      assert.equal(PlayerColors.pack(top, bottom), 0xC4);
    });
  });
});
