import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { PlayerColors } from '../../source/engine/client/renderer/models/PlayerColors.ts';
import W from '../../source/engine/common/W.ts';

/**
 * Packs a color the way the palette table holds it: red in the low byte.
 * @param red Red, 0 to 255.
 * @param green Green, 0 to 255.
 * @param blue Blue, 0 to 255.
 * @returns The packed color.
 */
function pack(red: number, green: number, blue: number): number {
  return red + (green << 8) + (blue << 16);
}

void describe('PlayerColors', () => {
  let previousTable: typeof W.d_8to24table;

  beforeEach(() => {
    previousTable = W.d_8to24table;
    W.d_8to24table = new Uint32Array(256);
    // Row 3 takes column 11 (index 59), row 7 column 11 (123), row 8 column 4 (132), row 12 column 4 (196).
    W.d_8to24table[59] = pack(1, 2, 3);
    W.d_8to24table[123] = pack(70, 71, 72);
    W.d_8to24table[132] = pack(80, 81, 82);
    W.d_8to24table[196] = pack(250, 128, 5);
  });

  afterEach(() => {
    W.d_8to24table = previousTable;
  });

  void test('the high nibble of the colors byte is the shirt and the low nibble the pants', () => {
    const shirt = new Float32Array(3);
    const pants = new Float32Array(3);

    PlayerColors.shirtInto(0x3c, shirt);
    PlayerColors.pantsInto(0x3c, pants);

    assert.deepEqual(Array.from(shirt), [1, 2, 3]);
    assert.deepEqual(Array.from(pants), [250, 128, 5]);

    // The same two rows with the nibbles swapped swap the colors, which a mix-up of shirt and pants would not.
    PlayerColors.shirtInto(0xc3, shirt);
    PlayerColors.pantsInto(0xc3, pants);

    assert.deepEqual(Array.from(shirt), [250, 128, 5]);
    assert.deepEqual(Array.from(pants), [1, 2, 3]);
  });

  void test('the palette column changes between row 7 and row 8, where the ramps turn around', () => {
    const color = new Float32Array(3);

    PlayerColors.pantsInto(0x07, color);
    assert.deepEqual(Array.from(color), [70, 71, 72]);

    PlayerColors.pantsInto(0x08, color);
    assert.deepEqual(Array.from(color), [80, 81, 82]);
  });

  void test('writes into a plain array as well, and only its first three entries', () => {
    const color = [9, 9, 9, 9];

    PlayerColors.shirtInto(0x30, color);

    assert.deepEqual(color, [1, 2, 3, 9]);
  });
});
