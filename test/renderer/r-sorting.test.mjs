import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compareFogAndTurbulentItems } from '../../source/engine/client/R.mjs';

describe('compareFogAndTurbulentItems', () => {
  test('sorts farther items first', () => {
    const result = compareFogAndTurbulentItems(
      { dist: 64, kind: 0 },
      { dist: 128, kind: 1 },
    );

    assert(result > 0);
  });

  test('sorts fog before turbulent when their front depth ties', () => {
    const fog = { dist: 96, kind: 1 };
    const turbulent = { dist: 96, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareFogAndTurbulentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  test('treats near-equal distances as a tie for boundary-sharing fog and water', () => {
    const fog = { dist: 96.00005, kind: 1 };
    const turbulent = { dist: 96.0, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareFogAndTurbulentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });
});
