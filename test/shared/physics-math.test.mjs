import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import PhysicsMath from '../../source/shared/PhysicsMath.ts';

import { assertNear } from '../physics/fixtures.mjs';

void describe('PhysicsMath', () => {
  void describe('clipVelocity', () => {
    void test('zeroes tiny residuals after clipping against an angled plane', () => {
      const out = new Vector();

      PhysicsMath.clipVelocity(
        new Vector(1, -1, 0.05),
        new Vector(0, 1, 0),
        out,
        1.0,
      );

      assertNear(out[0], 1.0, 1e-9);
      assert.equal(out[1], 0.0);
      assert.equal(out[2], 0.0);
    });
  });
});
