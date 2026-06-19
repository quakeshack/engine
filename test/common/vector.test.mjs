import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector, { Quaternion } from '../../source/shared/Vector.ts';

/**
 * Computes wrapped angular delta in degrees.
 * @param {number} from
 * @param {number} to
 * @returns {number} Wrapped angular delta in [-180, 180).
 */
function shortestAngleDelta(from, to) {
  return ((to - from + 540.0) % 360.0) - 180.0;
}

void describe('Vector quaternion conversion', () => {
  void test('preserves engine angle ordering and degree units', () => {
    const sourceAngles = new Vector(30.0, 120.0, -45.0);

    const quaternion = sourceAngles.toQuaternion();
    const convertedAngles = Vector.fromQuaternion(quaternion);

    assert.ok(Math.abs(shortestAngleDelta(sourceAngles[0], convertedAngles[0])) < 0.001);
    assert.ok(Math.abs(shortestAngleDelta(sourceAngles[1], convertedAngles[1])) < 0.001);
    assert.ok(Math.abs(shortestAngleDelta(sourceAngles[2], convertedAngles[2])) < 0.001);
  });
});

void describe('Quaternion.normalize', () => {
  void test('normalizes in place and returns original length', () => {
    const quaternion = new Quaternion(2.0, 0.0, 0.0, 0.0);

    const originalLength = quaternion.normalize();

    assert.equal(originalLength, 2.0);
    assert.deepEqual([...quaternion], [1.0, 0.0, 0.0, 0.0]);
  });

  void test('sets identity quaternion when normalizing zero length', () => {
    const quaternion = new Quaternion(0.0, 0.0, 0.0, 0.0);

    const originalLength = quaternion.normalize();

    assert.equal(originalLength, 0.0);
    assert.deepEqual([...quaternion], [1.0, 0.0, 0.0, 0.0]);
  });
});

void describe('Quaternion.slerp', () => {
  void test('takes shortest rotational path across wrapped yaw', () => {
    const previous = new Vector(0.0, 350.0, 0.0);
    const current = new Vector(0.0, 10.0, 0.0);

    const q0 = Quaternion.fromVector(previous);
    const q1 = Quaternion.fromVector(current);
    const halfway = Vector.fromQuaternion(Quaternion.slerp(q0, q1, 0.5));

    const deltaYaw = shortestAngleDelta(previous[1], halfway[1]);
    assert.ok(Math.abs(deltaYaw - 10.0) < 0.001);
  });

  void test('converts wrapped yaw to the shortest interpolated Euler angles', () => {
    const previous = new Vector(0.0, 350.0, 0.0);
    const current = new Vector(0.0, 10.0, 0.0);
    const output = new Vector();

    const returned = Quaternion.slerpAngles(previous, current, 0.5, output);

    assert.strictEqual(returned, output);
    const deltaYaw = shortestAngleDelta(previous[1], output[1]);
    assert.ok(Math.abs(deltaYaw - 10.0) < 0.001);
  });
});

void describe('Quaternion.multiply', () => {
  void test('composing two 90-degree yaw rotations gives 180-degree yaw', () => {
    const q90 = Quaternion.fromVector(new Vector(0.0, 90.0, 0.0));
    const q180 = q90.copy().multiply(q90);
    const angles = Vector.fromQuaternion(q180);

    assert.ok(Math.abs(shortestAngleDelta(angles[1], 180.0)) < 0.001);
  });

  void test('identity composed with a rotation yields the same rotation', () => {
    const identity = new Quaternion(1.0, 0.0, 0.0, 0.0);
    const qRot = Quaternion.fromVector(new Vector(30.0, 60.0, 15.0));
    const composed = identity.copy().multiply(qRot);
    const original = Vector.fromQuaternion(qRot);
    const result = Vector.fromQuaternion(composed);

    assert.ok(Math.abs(shortestAngleDelta(original[0], result[0])) < 0.001);
    assert.ok(Math.abs(shortestAngleDelta(original[1], result[1])) < 0.001);
    assert.ok(Math.abs(shortestAngleDelta(original[2], result[2])) < 0.001);
  });

  void test('accumulated single-axis rotation stays equivalent to Euler addition', () => {
    // Simulate func_rotating: 72 deg/s yaw, 10 frames of 0.1 s each => 720 deg total.
    const dtDeg = 7.2; // degrees per frame (72 deg/s * 0.1 s)
    const qStep = Quaternion.fromVector(new Vector(0.0, dtDeg, 0.0));

    let q = new Quaternion();
    for (let i = 0; i < 100; i++) {
      q = q.multiply(qStep);
    }

    const result = Vector.fromQuaternion(q);
    // 100 * 7.2 = 720 deg => wraps to 0 mod 360. Expect near-zero yaw.
    assert.ok(Math.abs(shortestAngleDelta(result[1], 0.0)) < 0.01);
  });
});
