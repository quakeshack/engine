import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import sampleBSpline from '../../source/shared/BSpline.ts';
import Vector from '../../source/shared/Vector.ts';

void describe('sampleBSpline', () => {
  void test('returns a shallow copy when there are fewer than four control points', () => {
    const points = [new Vector(0, 0, 0), new Vector(1, 1, 1), new Vector(2, 2, 2)];
    const sampled = sampleBSpline(points);

    assert.notStrictEqual(sampled, points);
    assert.deepEqual(sampled.map((point) => Array.from(point)), points.map((point) => Array.from(point)));
  });

  void test('samples a clamped cubic curve that starts and ends on the control endpoints', () => {
    const points = [
      new Vector(0, 0, 0),
      new Vector(10, 0, 0),
      new Vector(10, 10, 0),
      new Vector(20, 10, 0),
    ];

    const sampled = sampleBSpline(points, 5);

    assert.equal(sampled.length, 5);
    assert.deepEqual(Array.from(sampled[0]), Array.from(points[0]));
    assert.deepEqual(Array.from(sampled.at(-1)), Array.from(points.at(-1)));
    assert.ok(sampled.every((point) => point instanceof Vector));
  });
});
