import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { shortestAngleDelta, smoothValue } from '../../source/shared/smoothing.ts';
import { assertNear } from '../support/assertions.ts';

void describe('smoothValue', () => {
  void test('leaves the value alone for a non-positive sharpness or time step', () => {
    assert.equal(smoothValue(10, 20, 0, 0.016), 10);
    assert.equal(smoothValue(10, 20, -5, 0.016), 10);
    assert.equal(smoothValue(10, 20, 20, 0), 10);
    assert.equal(smoothValue(10, 20, 20, -1), 10);
  });

  void test('moves monotonically toward the target without reaching it', () => {
    const step1 = smoothValue(0, 10, 20, 0.016);
    const step2 = smoothValue(step1, 10, 20, 0.016);

    assert.ok(step1 > 0);
    assert.ok(step2 > step1);
    assert.ok(step2 < 10);
  });

  void test('closes 1 - exp(-sharpness * dt) of the distance', () => {
    assertNear(smoothValue(0, 100, 10, 0.1), 100 * (1 - Math.exp(-1)), 1e-9);
  });

  void test('gives the same result for two half steps as for one whole step', () => {
    const whole = smoothValue(0, 10, 12, 0.2);
    const halves = smoothValue(smoothValue(0, 10, 12, 0.1), 10, 12, 0.1);

    assertNear(halves, whole, 1e-9);
  });

  void test('eases downward as well', () => {
    assert.ok(smoothValue(10, 0, 20, 0.016) < 10);
  });
});

void describe('shortestAngleDelta', () => {
  void test('follows the wrapped shortest path', () => {
    assert.equal(shortestAngleDelta(350, 10), 20);
    assert.equal(shortestAngleDelta(10, 350), -20);
  });

  void test('is a plain difference inside half a turn', () => {
    assert.equal(shortestAngleDelta(10, 100), 90);
    assert.equal(shortestAngleDelta(100, 10), -90);
    assert.equal(shortestAngleDelta(45, 45), 0);
  });

  void test('maps a half turn to -180 so the range is [-180, 180)', () => {
    assert.equal(shortestAngleDelta(0, 180), -180);
    assert.equal(shortestAngleDelta(180, 0), -180);
  });
});
