import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import V from '../../source/engine/client/V.ts';

void describe('V', () => {
  void test('CalcRoll scales with velocity along the right vector', () => {
    const originalRollspeed = V.rollspeed;
    const originalRollangle = V.rollangle;

    try {
      V.rollspeed = { value: 200 };
      V.rollangle = { value: 2 };

      const angles = new Vector();
      const { right } = angles.angleVectors();
      const halfSpeed = right.copy().multiply(100);
      const fullSpeed = right.copy().multiply(-400);

      assert.equal(V.CalcRoll(angles, halfSpeed), 1);
      assert.equal(V.CalcRoll(angles, fullSpeed), -2);
    } finally {
      V.rollspeed = originalRollspeed;
      V.rollangle = originalRollangle;
    }
  });
});
