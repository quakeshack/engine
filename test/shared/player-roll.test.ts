import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { calcRoll } from '../../source/shared/PlayerRoll.ts';
import Vector from '../../source/shared/Vector.ts';

void describe('calcRoll', () => {
  const angles = new Vector();
  const { right } = angles.angleVectors();

  void test('scales with the velocity along the right vector', () => {
    assert.equal(calcRoll(angles, right.copy().multiply(100), 200, 2), 1);
    assert.equal(calcRoll(angles, right.copy().multiply(-400), 200, 2), -2);
  });

  void test('is capped at the roll angle', () => {
    assert.equal(calcRoll(angles, right.copy().multiply(1000), 200, 2), 2);
  });

  void test('does not roll for a player that moves along the view', () => {
    const { forward } = angles.angleVectors();

    assert.equal(calcRoll(angles, forward.copy().multiply(300), 200, 2), 0);
  });
});
