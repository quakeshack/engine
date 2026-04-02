import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PmoveConfiguration, PmoveQuake2Configuration } from '../../source/shared/Pmove.ts';

void describe('PmoveConfiguration', () => {
  void test('keeps the QuakeWorld-style defaults', () => {
    const config = new PmoveConfiguration();

    assert.equal(config.forwardProbe, 24);
    assert.equal(config.overbounce, 1.0);
    assert.equal(config.pitchDivisor, 0);
    assert.equal(config.edgeFriction, true);
  });

  void test('applies the Quake 2 overrides in the subclass', () => {
    const config = new PmoveQuake2Configuration();

    assert.equal(config.forwardProbe, 30);
    assert.equal(config.overbounce, 1.01);
    assert.equal(config.pitchDivisor, 3);
    assert.equal(config.edgeFriction, false);
    assert.equal(config.landingCooldown, true);
  });
});
