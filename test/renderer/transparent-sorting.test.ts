import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compareTransparentItems } from '../../source/engine/client/R.ts';

void describe('compareTransparentItems', () => {
  void test('sorts farther items first', () => {
    const result = compareTransparentItems(
      { dist: 64, kind: 0 },
      { dist: 128, kind: 1 },
    );

    assert(result > 0);
  });

  void test('sorts fog before turbulent when their front depth ties', () => {
    const fog = { dist: 96, kind: 1 };
    const turbulent = { dist: 96, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('treats near-equal distances as a tie for boundary-sharing fog and water', () => {
    const fog = { dist: 96.00005, kind: 1 };
    const turbulent = { dist: 96.0, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('uses deterministic tie ordering for sprite, decal, and particle kinds', () => {
    const sprite = { dist: 64.0, kind: 4 };
    const decal = { dist: 64.0, kind: 5 };
    const particle = { dist: 64.0, kind: 6 };
    const items = [particle, decal, sprite];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [sprite, decal, particle]);
  });
});
