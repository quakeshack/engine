import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector, { Quaternion } from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';

/**
 * Computes wrapped angular delta in degrees.
 * @param from
 * @param to
 * @returns Wrapped angular delta in [-180, 180).
 */
function shortestAngleDelta(from: number, to: number): number {
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

/**
 * A unit quaternion for a turn about one axis.
 * @param axis 0 for X, 1 for Y, 2 for Z.
 * @param degrees The turn.
 * @returns `w, x, y, z`.
 */
function turnAbout(axis: number, degrees: number): number[] {
  const half = degrees * Math.PI / 360.0;
  const quaternion = [Math.cos(half), 0, 0, 0];
  quaternion[axis + 1] = Math.sin(half);
  return quaternion;
}

/**
 * The 3×4 matrix of a quaternion with no translation and no scale.
 * @param quaternion `w, x, y, z`.
 * @returns Twelve numbers, row major.
 */
function matrixOf(quaternion: ArrayLike<number>): Float32Array {
  const matrix = new Float32Array(12);
  Quaternion.toMatrix3x4Into(matrix, 0, quaternion, 0, [0, 0, 0], 0, [1, 1, 1], 0);
  return matrix;
}

void describe('Quaternion.slerpInto', () => {
  void test('turns halfway along the arc and reads and writes at the given offsets', () => {
    const from = [9, 9, ...turnAbout(2, 0), 9];
    const to = [9, 9, 9, ...turnAbout(2, 90)];
    const out = new Float32Array(10).fill(7);

    Quaternion.slerpInto(out, 3, from, 2, to, 3, 0.5);

    const expected = turnAbout(2, 45);
    expected.forEach((value, index) => { assertNear(out[3 + index], value, 1e-6); });
    // Nothing outside the four written numbers is touched.
    assert.deepEqual(Array.from(out.subarray(0, 3)), [7, 7, 7]);
    assert.deepEqual(Array.from(out.subarray(7)), [7, 7, 7]);
  });

  void test('takes the shortest path when the target is stored with the opposite sign', () => {
    // 10 and 30 degrees about Z, the second one written as -q (the same rotation). Without the flip the arc runs
    // the long way round and the middle is nowhere near 20 degrees.
    const from = turnAbout(2, 10);
    const to = turnAbout(2, 30).map((value) => -value);
    const out = new Float32Array(4);

    Quaternion.slerpInto(out, 0, from, 0, to, 0, 0.5);

    const expected = turnAbout(2, 20);
    expected.forEach((value, index) => { assertNear(out[index], value, 1e-6); });
  });

  void test('returns the end points at t = 0 and t = 1, as a unit quaternion', () => {
    const from = turnAbout(0, 40);
    const to = turnAbout(1, 120);
    const out = new Float32Array(4);

    Quaternion.slerpInto(out, 0, from, 0, to, 0, 0);
    from.forEach((value, index) => { assertNear(out[index], value, 1e-6); });

    Quaternion.slerpInto(out, 0, from, 0, to, 0, 1);
    to.forEach((value, index) => { assertNear(out[index], value, 1e-6); });
  });

  void test('stays unit length for nearly equal rotations, where it falls back to a linear blend', () => {
    const out = new Float64Array(4);

    Quaternion.slerpInto(out, 0, turnAbout(2, 30), 0, turnAbout(2, 30.01), 0, 0.5);

    assertNear(Math.hypot(out[0], out[1], out[2], out[3]), 1.0, 1e-12);
    assertNear(out[3], turnAbout(2, 30.005)[3], 1e-7);
  });

  void test('may write into one of its inputs', () => {
    const buffer = [...turnAbout(2, 0), ...turnAbout(2, 90)];

    Quaternion.slerpInto(buffer, 0, buffer, 0, buffer, 4, 0.5);

    turnAbout(2, 45).forEach((value, index) => { assertNear(buffer[index], value, 1e-12); });
  });
});

void describe('Quaternion.multiplyInto', () => {
  void test('applies the right factor first, which matters for rotations about different axes', () => {
    const left = turnAbout(0, 90);
    const right = turnAbout(2, 90);
    const product = new Float32Array(4);
    const reversed = new Float32Array(4);

    Quaternion.multiplyInto(product, 0, left, 0, right, 0);
    Quaternion.multiplyInto(reversed, 0, right, 0, left, 0);

    // The same composition done on matrices: left * right.
    const left3x3 = matrixOf(left);
    const right3x3 = matrixOf(right);
    const expected = new Float32Array(12);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        for (let k = 0; k < 3; k++) {
          expected[row * 4 + column] += left3x3[row * 4 + k] * right3x3[k * 4 + column];
        }
      }
    }
    const combined = matrixOf(product);
    for (let index = 0; index < 12; index++) {
      assertNear(combined[index], expected[index], 1e-6);
    }

    // A quarter turn about X after a quarter turn about Z is not a quarter turn about Z after one about X.
    const otherOrder = matrixOf(reversed);
    assert.ok(combined.some((value, index) => Math.abs(value - otherOrder[index]) > 0.5));
  });

  void test('may write into its left input without reading numbers it has already overwritten', () => {
    const left = [...turnAbout(0, 90)];
    const right = turnAbout(1, 90);
    const separate = new Float64Array(4);
    Quaternion.multiplyInto(separate, 0, left, 0, right, 0);

    Quaternion.multiplyInto(left, 0, left, 0, right, 0);

    separate.forEach((value, index) => { assertNear(left[index], value, 1e-12); });
  });

  void test('Quaternion.multiply gives the same product', () => {
    const left = new Quaternion(...turnAbout(0, 50) as [number, number, number, number]);
    const right = new Quaternion(...turnAbout(2, 70) as [number, number, number, number]);
    const product = new Float64Array(4);
    Quaternion.multiplyInto(product, 0, left, 0, right, 0);

    left.multiply(right);

    product.forEach((value, index) => { assertNear(left[index], value, 1e-12); });
  });
});

void describe('Quaternion.normalizeAt', () => {
  void test('scales the quaternion at the offset, returns the old length and leaves its neighbors alone', () => {
    const buffer = [5, 2, 0, 0, 0, 5];

    const length = Quaternion.normalizeAt(buffer, 1);

    assert.equal(length, 2);
    assert.deepEqual(buffer, [5, 1, 0, 0, 0, 5]);
  });

  void test('turns a zero quaternion into the identity', () => {
    const buffer = [0, 0, 0, 0];

    assert.equal(Quaternion.normalizeAt(buffer, 0), 0);
    assert.deepEqual(buffer, [1, 0, 0, 0]);
  });
});

void describe('Quaternion.toMatrix3x4Into', () => {
  void test('writes rotation columns scaled along the joint axes, then the translation', () => {
    const matrix = new Float32Array(14).fill(-1);

    // 90 degrees about Z takes X to Y and Y to -X. The scale (2, 3, 4) belongs to the joint's own axes, so it
    // stretches the columns, not the rows.
    Quaternion.toMatrix3x4Into(matrix, 1, turnAbout(2, 90), 0, [10, 20, 30], 0, [2, 3, 4], 0);

    const expected = [
      0, -3, 0, 10,
      2, 0, 0, 20,
      0, 0, 4, 30,
    ];
    expected.forEach((value, index) => { assertNear(matrix[1 + index], value, 1e-6); });
    assert.equal(matrix[0], -1);
    assert.equal(matrix[13], -1);
  });
});

void describe('model angle convention', () => {
  const samples: [number, number, number][] = [
    [0, 0, 0], [0, 90, 0], [30, 0, 0], [0, 0, 25], [30, 60, 15], [-45, 200, 70], [89, 10, -120], [-10, -170, 5],
  ];

  void test('fromModelAnglesInto is the rotation toRotationMatrix describes, for pitched, yawed and rolled angles', () => {
    // toRotationMatrix holds the entity's axes as rows, so it is the transpose of the quaternion's matrix.
    // Pitch is negated in it, Quake's model convention; the first draft of an attachment pass that used
    // toQuaternion() instead would tilt every attached model the wrong way.
    for (const angles of samples) {
      const rows = new Vector(...angles).toRotationMatrix();
      const quaternion = new Float64Array(4);
      Quaternion.fromModelAnglesInto(quaternion, 0, angles);

      const matrix = matrixOf(quaternion);

      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          assertNear(matrix[row * 4 + column], rows[column * 3 + row], 1e-6);
        }
      }
    }
  });

  void test('toQuaternion keeps the view convention of angleVectors, which differs for any pitch', () => {
    for (const angles of samples) {
      const { forward, right, up } = new Vector(...angles).angleVectors();
      const matrix = matrixOf(new Vector(...angles).toQuaternion());

      for (let row = 0; row < 3; row++) {
        assertNear(matrix[row * 4], forward[row], 1e-6);
        assertNear(matrix[row * 4 + 1], -right[row], 1e-6);
        assertNear(matrix[row * 4 + 2], up[row], 1e-6);
      }
    }

    const pitched = new Float64Array(4);
    Quaternion.fromModelAnglesInto(pitched, 0, [30, 0, 0]);
    assert.ok(Math.abs(pitched[2] - new Vector(30, 0, 0).toQuaternion()[2]) > 0.1);
  });
});

void describe('Quaternion.fromMatrix3x4Into', () => {
  /**
   * @param quaternion `w, x, y, z`.
   * @returns Its rotation, recovered through a matrix.
   */
  function throughMatrix(quaternion: ArrayLike<number>): Float64Array {
    const recovered = new Float64Array(4);

    Quaternion.fromMatrix3x4Into(recovered, 0, matrixOf(quaternion), 0);

    return recovered;
  }

  /**
   * @param a One quaternion.
   * @param b Another.
   * @returns How far they are as rotations: 0 for the same one, whichever sign they are written with.
   */
  function rotationDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
    return 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  }

  void test('gives back the rotation a matrix was made from, for turns about every axis and in between', () => {
    const turns: number[][] = [];

    for (const axis of [0, 1, 2]) {
      for (const degrees of [0, 30, 90, 150, -40, -170]) {
        turns.push(turnAbout(axis, degrees));
      }
    }

    turns.push(new Quaternion(0.5, 0.5, 0.5, 0.5), Array.from(new Vector(30, 60, 15).toQuaternion()), Array.from(new Vector(-45, 200, 70).toQuaternion()));

    for (const quaternion of turns) {
      assert.ok(rotationDistance(throughMatrix(quaternion), quaternion) < 1e-6, `rotation ${quaternion.join(', ')}`);
    }
  });

  void test('keeps its precision near a half turn, where the trace of the matrix is about -1', () => {
    // A conversion that always divides by the trace loses everything here; the largest component has to be the pivot.
    for (const axis of [0, 1, 2]) {
      for (const degrees of [179.9, 180, -179.9]) {
        const quaternion = turnAbout(axis, degrees);

        assert.ok(rotationDistance(throughMatrix(quaternion), quaternion) < 1e-6, `${degrees} degrees about axis ${axis}`);
      }
    }
  });

  void test('returns a unit quaternion', () => {
    const recovered = throughMatrix(Array.from(new Vector(10, 20, 30).toQuaternion()));

    assertNear(Math.hypot(recovered[0], recovered[1], recovered[2], recovered[3]), 1, 1e-12);
  });
});

void describe('Quaternion.toModelAnglesInto', () => {
  const inRange: [number, number, number][] = [[0, 0, 0], [30, 60, 15], [-45, 100, 70], [89, 10, -120], [-10, -170, 5], [0, 179, 0]];

  void test('is the inverse of fromModelAnglesInto, so a game that is given the angles turns an entity the way the quaternion does', () => {
    for (const angles of inRange) {
      const quaternion = new Float64Array(4);
      const recovered = new Float64Array(3);

      Quaternion.fromModelAnglesInto(quaternion, 0, angles);
      Quaternion.toModelAnglesInto(recovered, 0, quaternion, 0);

      angles.forEach((value, index) => { assertNear(recovered[index], value, 1e-6); });
    }
  });

  void test('gives angles with the same rotation matrix as toRotationMatrix, also past 90 degrees of pitch where the numbers differ', () => {
    // A pitch of 120 is the same turn as a pitch of 60 with the yaw and roll turned half way round.
    for (const angles of [...inRange, [120, 10, 20], [-100, 200, 300]]) {
      const quaternion = new Float64Array(4);
      const recovered = new Float64Array(3);

      Quaternion.fromModelAnglesInto(quaternion, 0, angles);
      Quaternion.toModelAnglesInto(recovered, 0, quaternion, 0);

      const wanted = new Vector(...angles).toRotationMatrix();
      const got = new Vector(...recovered).toRotationMatrix();

      wanted.forEach((value, index) => { assertNear(got[index], value, 1e-6); });
    }
  });

  void test('writes at the offset and leaves the numbers around it alone', () => {
    const out = [9, 9, 9, 9, 9];

    Quaternion.toModelAnglesInto(out, 1, [Math.cos(Math.PI / 4), 0, 0, Math.sin(Math.PI / 4)], 0);

    assert.equal(out[0], 9);
    assert.equal(out[4], 9);
    assertNear(out[2], 90, 1e-6);
  });
});
