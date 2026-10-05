import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import PhysicsMath from '../../source/engine/common/PhysicsMath.ts';

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

void describe('PhysicsMath.shouldComeToRest', () => {
  void test('a bounce comes to rest on a floor-like plane once it bounces up slower than the rest speed', () => {
    assert.equal(PhysicsMath.shouldComeToRest(1.0, 59.9, true), true);
    assert.equal(PhysicsMath.shouldComeToRest(1.0, 60.0, true), false);
    assert.equal(PhysicsMath.shouldComeToRest(1.0, 150, true), false);
  });

  void test('a toss comes to rest on a floor-like plane whatever its speed, since it never bounces', () => {
    assert.equal(PhysicsMath.shouldComeToRest(1.0, 300, false), true);
  });

  void test('nothing comes to rest on a steep plane', () => {
    // 0.7 is the ground angle threshold: strictly steeper than that is not a floor
    assert.equal(PhysicsMath.shouldComeToRest(0.7, 0, true), false);
    assert.equal(PhysicsMath.shouldComeToRest(0.0, 0, false), false);
    assert.equal(PhysicsMath.shouldComeToRest(0.71, 0, true), true);
  });
});

