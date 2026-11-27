/* eslint jsdoc/require-returns: "off" */

type VectorLike = ArrayLike<number>;

type RotationMatrix = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

type PlaneLike = {
  type: number;
  dist: number;
  signbits: number;
  normal: VectorLike;
};

/**
 * Directional vectors.
 */
export class DirectionalVectors {
  readonly forward: Vector;
  readonly right: Vector;
  readonly up: Vector;

  constructor(forward: Vector, right: Vector, up: Vector) {
    this.forward = forward;
    this.right = right;
    this.up = up;
    Object.freeze(this);
  }
}

/** Storage a quaternion helper can write into: a plain array or a typed array. */
type QuaternionStorage = number[] | Float32Array | Float64Array;

/**
 * Quaternion, stored as `[w, x, y, z]`.
 *
 * That layout is the engine-wide rule: every flat array that holds rotations (skeletal poses, tags, attachments) uses
 * it too, and a file format that stores another order (IQM: `x, y, z, w`) is reordered once, in its loader.
 *
 * The static `…Into` and `…At` helpers read and write quaternions inside flat arrays at an offset and never
 * allocate, so they are safe in per-joint, per-frame loops. The object methods (`slerp`, `multiply`, `normalize`)
 * delegate to them: there is one implementation of each.
 *
 * Two angle conventions meet here. `Vector.angleVectors()` and `Vector.toQuaternion()` use the view convention
 * (positive pitch looks down). `Vector.toRotationMatrix()`, which every model renderer uses, negates pitch, Quake's
 * model convention (positive pitch tilts a model's nose up). `fromModelAnglesInto` follows the model convention.
 */
export class Quaternion extends Array<number> {
  constructor(w = 1.0, x = 0.0, y = 0.0, z = 0.0) {
    super(4);
    console.assert(typeof w === 'number' && typeof x === 'number' && typeof y === 'number' && typeof z === 'number', 'not a number');
    console.assert(!Number.isNaN(w) && !Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z), 'NaN component');
    this[0] = w;
    this[1] = x;
    this[2] = y;
    this[3] = z;
  }

  /**
   * Creates Quaternion from Euler angles in degrees.
   * @param vector
   */
  static fromVector(vector: Vector): Quaternion {
    return vector.toQuaternion();
  }

  /**
   * Compares this Quaternion to the other quaternion.
   * @param other
   */
  equals(other: Quaternion): boolean {
    return this[0] === other[0] && this[1] === other[1] && this[2] === other[2] && this[3] === other[3];
  }

  /**
   * Compares this Quaternion’s component to x, y, z, w.
   * @param x
   * @param y
   * @param z
   * @param w
   */
  equalsTo(x: number, y: number, z: number, w: number): boolean {
    return this[0] === x && this[1] === y && this[2] === z && this[3] === w;
  }

  /**
   * Normalize this quaternion in place. Returns the original length.
   */
  normalize(): number {
    return Quaternion.normalizeAt(this, 0);
  }

  /**
   * Scales the quaternion stored at `offset` to unit length, in place. A zero-length quaternion becomes the identity.
   * @param quaternions Flat array holding the quaternion at `offset` (`w, x, y, z`).
   * @param offset Index of its `w`.
   * @returns The length before normalizing.
   */
  static normalizeAt(quaternions: QuaternionStorage, offset: number): number {
    const w = quaternions[offset];
    const x = quaternions[offset + 1];
    const y = quaternions[offset + 2];
    const z = quaternions[offset + 3];
    const length = Math.sqrt(w * w + x * x + y * y + z * z);

    if (length === 0.0) {
      quaternions[offset] = 1.0;
      quaternions[offset + 1] = 0.0;
      quaternions[offset + 2] = 0.0;
      quaternions[offset + 3] = 0.0;
      return 0.0;
    }

    const inverseLength = 1.0 / length;
    quaternions[offset] = w * inverseLength;
    quaternions[offset + 1] = x * inverseLength;
    quaternions[offset + 2] = y * inverseLength;
    quaternions[offset + 3] = z * inverseLength;
    return length;
  }

  /**
   * Spherical interpolation between two quaternions.
   * @param from
   * @param to
   * @param t interpolation factor in [0, 1]
   */
  static slerp(from: Quaternion, to: Quaternion, t: number): Quaternion {
    const q0 = new Quaternion(from[0], from[1], from[2], from[3]);
    const q1 = new Quaternion(to[0], to[1], to[2], to[3]);
    q0.normalize();
    q1.normalize();
    Quaternion.slerpInto(q0, 0, q0, 0, q1, 0, t);
    return q0;
  }

  /**
   * Spherical interpolation of the quaternions stored at `fromOffset` and `toOffset`, written to `outOffset`.
   *
   * Takes the shortest path (`q` and `-q` are the same rotation, so a negative dot product flips `to`) and falls
   * back to a normalized linear interpolation when the two are nearly equal. Both inputs must already be unit
   * length and are not normalized again; the result is unit length. `out` may be the same array and offset as
   * either input.
   * @param out Array receiving the result.
   * @param outOffset Index of the result's `w`.
   * @param from Array holding the start rotation.
   * @param fromOffset Index of its `w`.
   * @param to Array holding the end rotation.
   * @param toOffset Index of its `w`.
   * @param t Interpolation factor in [0, 1].
   */
  static slerpInto(
    out: QuaternionStorage, outOffset: number,
    from: ArrayLike<number>, fromOffset: number,
    to: ArrayLike<number>, toOffset: number,
    t: number,
  ): void {
    const w0 = from[fromOffset];
    const x0 = from[fromOffset + 1];
    const y0 = from[fromOffset + 2];
    const z0 = from[fromOffset + 3];
    let w1 = to[toOffset];
    let x1 = to[toOffset + 1];
    let y1 = to[toOffset + 2];
    let z1 = to[toOffset + 3];

    let dot = w0 * w1 + x0 * x1 + y0 * y1 + z0 * z1;

    if (dot < 0.0) {
      w1 = -w1;
      x1 = -x1;
      y1 = -y1;
      z1 = -z1;
      dot = -dot;
    }

    if (dot > 0.9995) {
      out[outOffset] = w0 + (w1 - w0) * t;
      out[outOffset + 1] = x0 + (x1 - x0) * t;
      out[outOffset + 2] = y0 + (y1 - y0) * t;
      out[outOffset + 3] = z0 + (z1 - z0) * t;
      Quaternion.normalizeAt(out, outOffset);
      return;
    }

    const clampedDot = Math.min(1.0, dot);
    const theta0 = Math.acos(clampedDot);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);
    const s0 = Math.cos(theta) - clampedDot * sinTheta / sinTheta0;
    const s1 = sinTheta / sinTheta0;

    out[outOffset] = w0 * s0 + w1 * s1;
    out[outOffset + 1] = x0 * s0 + x1 * s1;
    out[outOffset + 2] = y0 * s0 + y1 * s1;
    out[outOffset + 3] = z0 * s0 + z1 * s1;
  }

  /**
   * Spherical interpolation between two Euler angle vectors, keeping wrapped angles stable.
   * @param previous
   * @param current
   * @param t interpolation factor in [0, 1]
   * @param out optional destination vector for the interpolated angles
   * @returns interpolated angles degrees, wrapped to [0, 360)
   */
  static slerpAngles(previous: Vector, current: Vector, t: number, out: Vector = new Vector()): Vector {
    const interpolation = Math.min(1.0, Math.max(0.0, t));
    out.setQuaternion(Quaternion.slerp(Quaternion.fromVector(previous), Quaternion.fromVector(current), interpolation));
    for (let index = 0; index < 3; index++) {
      while (out[index] - previous[index] > 180.0) {
        out[index] -= 360.0;
      }
      while (out[index] - previous[index] < -180.0) {
        out[index] += 360.0;
      }
    }
    return out;
  }

  /**
   * Hamilton product: this = this * other (mutates in place).
   * Equivalent to applying `other`'s rotation before `this`'s rotation.
   * @param other
   */
  multiply(other: Quaternion): this {
    Quaternion.multiplyInto(this, 0, this, 0, other, 0);
    return this;
  }

  /**
   * Hamilton product of the quaternions stored at `leftOffset` and `rightOffset`, written to `outOffset`:
   * the rotation `right` applied first, then `left`. `out` may be the same array and offset as either input.
   * @param out Array receiving the product.
   * @param outOffset Index of the product's `w`.
   * @param left Array holding the left factor.
   * @param leftOffset Index of its `w`.
   * @param right Array holding the right factor.
   * @param rightOffset Index of its `w`.
   */
  static multiplyInto(
    out: QuaternionStorage, outOffset: number,
    left: ArrayLike<number>, leftOffset: number,
    right: ArrayLike<number>, rightOffset: number,
  ): void {
    const aw = left[leftOffset];
    const ax = left[leftOffset + 1];
    const ay = left[leftOffset + 2];
    const az = left[leftOffset + 3];
    const bw = right[rightOffset];
    const bx = right[rightOffset + 1];
    const by = right[rightOffset + 2];
    const bz = right[rightOffset + 3];
    out[outOffset] = aw * bw - ax * bx - ay * by - az * bz;
    out[outOffset + 1] = aw * bx + ax * bw + ay * bz - az * by;
    out[outOffset + 2] = aw * by - ax * bz + ay * bw + az * bx;
    out[outOffset + 3] = aw * bz + ax * by - ay * bx + az * bw;
  }

  /**
   * Writes the rotation of an entity's `angles` in the convention model renderers use: the quaternion whose matrix
   * is the transpose of `Vector.toRotationMatrix()` (that matrix holds the entity's axes as rows). Pitch is
   * negated against `Vector.toQuaternion()`.
   * @param out Array receiving the quaternion.
   * @param outOffset Index of its `w`.
   * @param angles Pitch, yaw, roll in degrees.
   */
  static fromModelAnglesInto(out: QuaternionStorage, outOffset: number, angles: ArrayLike<number>): void {
    Quaternion.#fromEulerInto(out, outOffset, -angles[0], angles[1], angles[2]);
  }

  /**
   * Writes the rotation of Euler angles in the view convention of `Vector.angleVectors()` (no pitch negation).
   * @param out Array receiving the quaternion.
   * @param outOffset Index of its `w`.
   * @param angles Pitch, yaw, roll in degrees.
   */
  static fromViewAnglesInto(out: QuaternionStorage, outOffset: number, angles: ArrayLike<number>): void {
    Quaternion.#fromEulerInto(out, outOffset, angles[0], angles[1], angles[2]);
  }

  /**
   * The angles of an entity, in the convention model renderers use, for a rotation: the inverse of
   * `fromModelAnglesInto`. This is where a rotation becomes Euler angles for game code, which works in angles: a game
   * that gives an entity these angles turns it the way the quaternion does. Pitch goes by `asin`, so it comes out in
   * -90 to 90 and a rotation that tilts further comes back as the equivalent yaw and roll.
   * @param out Array receiving pitch, yaw and roll in degrees.
   * @param outOffset Index of the pitch.
   * @param quaternion Array holding the rotation (`w, x, y, z`), unit length.
   * @param quaternionOffset Index of its `w`.
   */
  static toModelAnglesInto(out: QuaternionStorage, outOffset: number, quaternion: ArrayLike<number>, quaternionOffset: number): void {
    const w = quaternion[quaternionOffset];
    const x = quaternion[quaternionOffset + 1];
    const y = quaternion[quaternionOffset + 2];
    const z = quaternion[quaternionOffset + 3];
    const degrees = 180.0 / Math.PI;

    out[outOffset] = -Math.asin(Math.max(-1.0, Math.min(1.0, 2.0 * (w * y - z * x)))) * degrees;
    out[outOffset + 1] = Math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)) * degrees;
    out[outOffset + 2] = Math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y)) * degrees;
  }

  /**
   * The rotation of the upper left 3×3 of a 3×4 matrix, as written by `toMatrix3x4Into`. The three columns must be
   * orthonormal (a rotation with no scale and no shear); a matrix that is not one gets a rotation that is only as
   * good as its columns, so orthonormalize first (`SkeletalAnimation.sampleJointInto` does).
   * @param out Array receiving the quaternion (`w, x, y, z`), unit length.
   * @param outOffset Index of its `w`.
   * @param matrix Array holding the matrix, row major.
   * @param matrixOffset Index of its first number.
   */
  static fromMatrix3x4Into(out: QuaternionStorage, outOffset: number, matrix: ArrayLike<number>, matrixOffset: number): void {
    const m00 = matrix[matrixOffset];
    const m01 = matrix[matrixOffset + 1];
    const m02 = matrix[matrixOffset + 2];
    const m10 = matrix[matrixOffset + 4];
    const m11 = matrix[matrixOffset + 5];
    const m12 = matrix[matrixOffset + 6];
    const m20 = matrix[matrixOffset + 8];
    const m21 = matrix[matrixOffset + 9];
    const m22 = matrix[matrixOffset + 10];
    const trace = m00 + m11 + m22;

    // Take the largest of w, x, y, z as the pivot: dividing by a small one loses all precision near a half turn.
    if (trace > 0.0) {
      const scale = 0.5 / Math.sqrt(trace + 1.0);

      out[outOffset] = 0.25 / scale;
      out[outOffset + 1] = (m21 - m12) * scale;
      out[outOffset + 2] = (m02 - m20) * scale;
      out[outOffset + 3] = (m10 - m01) * scale;
    } else if (m00 > m11 && m00 > m22) {
      const scale = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);

      out[outOffset] = (m21 - m12) / scale;
      out[outOffset + 1] = 0.25 * scale;
      out[outOffset + 2] = (m01 + m10) / scale;
      out[outOffset + 3] = (m02 + m20) / scale;
    } else if (m11 > m22) {
      const scale = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);

      out[outOffset] = (m02 - m20) / scale;
      out[outOffset + 1] = (m01 + m10) / scale;
      out[outOffset + 2] = 0.25 * scale;
      out[outOffset + 3] = (m12 + m21) / scale;
    } else {
      const scale = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);

      out[outOffset] = (m10 - m01) / scale;
      out[outOffset + 1] = (m02 + m20) / scale;
      out[outOffset + 2] = (m12 + m21) / scale;
      out[outOffset + 3] = 0.25 * scale;
    }

    Quaternion.normalizeAt(out, outOffset);
  }

  /**
   * Euler angles in degrees to a quaternion, rotating about X (roll), then Y (pitch), then Z (yaw).
   * @param out Array receiving the quaternion.
   * @param outOffset Index of its `w`.
   * @param pitch Degrees.
   * @param yaw Degrees.
   * @param roll Degrees.
   */
  static #fromEulerInto(out: QuaternionStorage, outOffset: number, pitch: number, yaw: number, roll: number): void {
    const halfPitch = pitch * Math.PI / 360.0;
    const halfYaw = yaw * Math.PI / 360.0;
    const halfRoll = roll * Math.PI / 360.0;
    const sinRoll = Math.sin(halfRoll);
    const cosRoll = Math.cos(halfRoll);
    const sinPitch = Math.sin(halfPitch);
    const cosPitch = Math.cos(halfPitch);
    const sinYaw = Math.sin(halfYaw);
    const cosYaw = Math.cos(halfYaw);
    out[outOffset] = cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw;
    out[outOffset + 1] = sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw;
    out[outOffset + 2] = cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw;
    out[outOffset + 3] = cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw;
  }

  /**
   * Writes the transform `translation * rotation * scale` as a 3×4 matrix, row major: three rows of
   * `[column 0, column 1, column 2, translation]`, the bottom row `0, 0, 0, 1` implied. The scale applies along
   * the joint's own axes before the rotation, so it is non-uniform-safe. The rotation must be unit length.
   * The three inputs may sit in one array (a pose), which is why each has its own offset.
   * @param out Array receiving the 12 numbers.
   * @param outOffset Index of the first.
   * @param rotation Array holding the rotation (`w, x, y, z`).
   * @param rotationOffset Index of its `w`.
   * @param translation Array holding the translation (`x, y, z`).
   * @param translationOffset Index of its `x`.
   * @param scale Array holding the scale (`x, y, z`).
   * @param scaleOffset Index of its `x`.
   */
  static toMatrix3x4Into(
    out: QuaternionStorage, outOffset: number,
    rotation: ArrayLike<number>, rotationOffset: number,
    translation: ArrayLike<number>, translationOffset: number,
    scale: ArrayLike<number>, scaleOffset: number,
  ): void {
    const w = rotation[rotationOffset];
    const x = rotation[rotationOffset + 1];
    const y = rotation[rotationOffset + 2];
    const z = rotation[rotationOffset + 3];
    const scaleX = scale[scaleOffset];
    const scaleY = scale[scaleOffset + 1];
    const scaleZ = scale[scaleOffset + 2];

    out[outOffset] = (1.0 - 2.0 * (y * y + z * z)) * scaleX;
    out[outOffset + 1] = 2.0 * (x * y - w * z) * scaleY;
    out[outOffset + 2] = 2.0 * (x * z + w * y) * scaleZ;
    out[outOffset + 3] = translation[translationOffset];
    out[outOffset + 4] = 2.0 * (x * y + w * z) * scaleX;
    out[outOffset + 5] = (1.0 - 2.0 * (x * x + z * z)) * scaleY;
    out[outOffset + 6] = 2.0 * (y * z - w * x) * scaleZ;
    out[outOffset + 7] = translation[translationOffset + 1];
    out[outOffset + 8] = 2.0 * (x * z - w * y) * scaleX;
    out[outOffset + 9] = 2.0 * (y * z + w * x) * scaleY;
    out[outOffset + 10] = (1.0 - 2.0 * (x * x + y * y)) * scaleZ;
    out[outOffset + 11] = translation[translationOffset + 2];
  }

  /**
   * Writes a rotation as the nine numbers `Vector.toRotationMatrix()` gives an entity with the same turn: row major,
   * the rows are the entity's axes (forward, left, up). The model renderers upload this matrix as `uAngles`, so an
   * entity whose rotation is a quaternion (an attached one) draws through the same shader code as one with angles.
   * The rotation must be unit length.
   * @param out Array receiving the 9 numbers.
   * @param outOffset Index of the first.
   * @param rotation Array holding the rotation (`w, x, y, z`).
   * @param rotationOffset Index of its `w`.
   */
  static toModelRotationMatrixInto(out: QuaternionStorage, outOffset: number, rotation: ArrayLike<number>, rotationOffset: number): void {
    const w = rotation[rotationOffset];
    const x = rotation[rotationOffset + 1];
    const y = rotation[rotationOffset + 2];
    const z = rotation[rotationOffset + 3];

    out[outOffset] = 1.0 - 2.0 * (y * y + z * z);
    out[outOffset + 1] = 2.0 * (x * y + w * z);
    out[outOffset + 2] = 2.0 * (x * z - w * y);
    out[outOffset + 3] = 2.0 * (x * y - w * z);
    out[outOffset + 4] = 1.0 - 2.0 * (x * x + z * z);
    out[outOffset + 5] = 2.0 * (y * z + w * x);
    out[outOffset + 6] = 2.0 * (x * z + w * y);
    out[outOffset + 7] = 2.0 * (y * z - w * x);
    out[outOffset + 8] = 1.0 - 2.0 * (x * x + y * y);
  }

  /**
   * Create a copy of this quaternion.
   */
  copy(): Quaternion {
    return new Quaternion(this[0], this[1], this[2], this[3]);
  }

  /**
   * Freezes this Quaternion.
   */
  freeze(): this {
    Object.freeze(this);
    return this;
  }

  /**
   * Quake-style string representation of a Quaternion.
   */
  override toString(): string {
    return this.map((element) => element.toFixed(1)).join(' ');
  }
}

/**
 * 3D vector.
 * This is the most commonly used vector type in the engine, and is used for positions, directions, angles, etc.
 * It is different from Quake’s Vector macros (it doesn’t even has classes or functions most of the time),
 * almost all of which are now instance methods here.
 * While most methods are mutating, some return new Vectors for convenience.
 * Make sure to read the JSDoc carefully.
 */
export default class Vector extends Float32Array {
  static origin: Readonly<Vector> = (new Vector()).freeze();

  constructor(x = 0.0, y = 0.0, z = 0.0) {
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number', 'not a number');
    console.assert(!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z), 'NaN component');
    super(3);
    this[0] = x;
    this[1] = y;
    this[2] = z;
  }

  /**
   * Return a perpendicular direction to `this`.
   */
  perpendicular(): Vector {
    let pos = 0;
    let minElement = 1;

    for (let index = 0; index < 3; index++) {
      const absoluteValue = Math.abs(this[index]);
      if (absoluteValue < minElement) {
        pos = index;
        minElement = absoluteValue;
      }
    }

    const temp = new Vector();
    temp[pos] = 1.0;

    const invDenominator = 1.0 / (this[0] * this[0] + this[1] * this[1] + this[2] * this[2]);
    const dot = temp.dot(this) * invDenominator;
    const perpendicularVector = new Vector(
      temp[0] - dot * this[0] * invDenominator,
      temp[1] - dot * this[1] * invDenominator,
      temp[2] - dot * this[2] * invDenominator,
    );

    perpendicularVector.normalize();
    return perpendicularVector;
  }

  /**
   * Rotate a point around the direction `this`.
   * @param point
   * @param degrees
   */
  rotatePointAroundVector(point: Vector, degrees: number): Vector {
    const vectorRight = this.perpendicular();
    const up = vectorRight.cross(this);

    const matrix: RotationMatrix = [
      [vectorRight[0], up[0], this[0]],
      [vectorRight[1], up[1], this[1]],
      [vectorRight[2], up[2], this[2]],
    ];

    const inverseMatrix: RotationMatrix = [
      [matrix[0][0], matrix[1][0], matrix[2][0]],
      [matrix[0][1], matrix[1][1], matrix[2][1]],
      [matrix[0][2], matrix[1][2], matrix[2][2]],
    ];

    const radians = (degrees * Math.PI) / 180.0;
    const sine = Math.sin(radians);
    const cosine = Math.cos(radians);

    const zRotation: RotationMatrix = [
      [cosine, sine, 0.0],
      [-sine, cosine, 0.0],
      [0.0, 0.0, 1.0],
    ];

    const rotationMatrix = Vector.concatRotations(Vector.concatRotations(matrix, zRotation), inverseMatrix);

    const x = rotationMatrix[0][0] * point[0] + rotationMatrix[0][1] * point[1] + rotationMatrix[0][2] * point[2];
    const y = rotationMatrix[1][0] * point[0] + rotationMatrix[1][1] * point[1] + rotationMatrix[1][2] * point[2];
    const z = rotationMatrix[2][0] * point[0] + rotationMatrix[2][1] * point[1] + rotationMatrix[2][2] * point[2];
    return new Vector(x, y, z);
  }

  /**
   * Modulo an angle into [0, 360).
   * @param angle
   */
  static anglemod(angle: number): number {
    return ((angle % 360.0) + 360.0) % 360.0;
  }

  /**
   * Equivalent to the old Vec.BoxOnPlaneSide(emins, emaxs, p).
   * @param emins
   * @param emaxs
   * @param plane
   */
  static boxOnPlaneSide(emins: Vector, emaxs: Vector, plane: PlaneLike): number {
    if (plane.type <= 2) {
      if (plane.dist <= emins[plane.type]) {
        return 1;
      }
      if (plane.dist >= emaxs[plane.type]) {
        return 2;
      }
      return 3;
    }

    let dist1: number;
    let dist2: number;
    console.assert(plane.signbits >= 0 && plane.signbits < 8, 'signbits must be [0, 8)', plane.signbits);

    switch (plane.signbits) {
      case 0:
        dist1 = plane.normal[0] * emaxs[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emaxs[2];
        dist2 = plane.normal[0] * emins[0] + plane.normal[1] * emins[1] + plane.normal[2] * emins[2];
        break;
      case 1:
        dist1 = plane.normal[0] * emins[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emaxs[2];
        dist2 = plane.normal[0] * emaxs[0] + plane.normal[1] * emins[1] + plane.normal[2] * emins[2];
        break;
      case 2:
        dist1 = plane.normal[0] * emaxs[0] + plane.normal[1] * emins[1] + plane.normal[2] * emaxs[2];
        dist2 = plane.normal[0] * emins[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emins[2];
        break;
      case 3:
        dist1 = plane.normal[0] * emins[0] + plane.normal[1] * emins[1] + plane.normal[2] * emaxs[2];
        dist2 = plane.normal[0] * emaxs[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emins[2];
        break;
      case 4:
        dist1 = plane.normal[0] * emaxs[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emins[2];
        dist2 = plane.normal[0] * emins[0] + plane.normal[1] * emins[1] + plane.normal[2] * emaxs[2];
        break;
      case 5:
        dist1 = plane.normal[0] * emins[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emins[2];
        dist2 = plane.normal[0] * emaxs[0] + plane.normal[1] * emins[1] + plane.normal[2] * emaxs[2];
        break;
      case 6:
        dist1 = plane.normal[0] * emaxs[0] + plane.normal[1] * emins[1] + plane.normal[2] * emins[2];
        dist2 = plane.normal[0] * emins[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emaxs[2];
        break;
      case 7:
        dist1 = plane.normal[0] * emins[0] + plane.normal[1] * emins[1] + plane.normal[2] * emins[2];
        dist2 = plane.normal[0] * emaxs[0] + plane.normal[1] * emaxs[1] + plane.normal[2] * emaxs[2];
        break;
      default:
        return 0;
    }

    let sides = 0;
    if (dist1 >= plane.dist) {
      sides = 1;
    }
    if (dist2 < plane.dist) {
      sides += 2;
    }
    return sides;
  }

  /**
   * Returns an object containing forward, right, up as Vecs.
   */
  angleVectors(): DirectionalVectors {
    console.assert(Number.isFinite(this[0]) && Number.isFinite(this[1]) && Number.isFinite(this[2]), 'angles must be finite numbers');

    let angle = this[0] * Math.PI / 180.0;
    const sp = Math.sin(angle);
    const cp = Math.cos(angle);

    angle = this[1] * Math.PI / 180.0;
    const sy = Math.sin(angle);
    const cy = Math.cos(angle);

    angle = this[2] * Math.PI / 180.0;
    const sr = Math.sin(angle);
    const cr = Math.cos(angle);

    const forward = new Vector(cp * cy, cp * sy, -sp);
    const right = new Vector(
      cr * sy - sr * sp * cy,
      -sr * sp * sy - cr * cy,
      -sr * cp,
    );
    const up = new Vector(
      cr * sp * cy + sr * sy,
      cr * sp * sy - sr * cy,
      cr * cp,
    );

    return new DirectionalVectors(forward, right, up);
  }

  toYaw(): number {
    if (!this[0] && !this[1]) {
      return 0.0;
    }

    let yaw = Math.atan2(this[1], this[0]) * 180.0 / Math.PI;
    if (yaw < 0.0) {
      yaw += 360.0;
    }

    return yaw;
  }

  toPitch(): number {
    let pitch = Math.atan2(this[2], Math.hypot(this[0], this[1])) * 180.0 / Math.PI;
    if (pitch < 0.0) {
      pitch += 360.0;
    }

    return pitch;
  }

  /**
   * Convert this directional vector into pitch and yaw angles and returns them.
   */
  toAngles(): Vector {
    const angles = new Vector();

    if (this[0] === 0.0 && this[1] === 0.0) {
      angles[0] = this[2] > 0.0 ? 90.0 : 270.0;
      return angles;
    }

    angles.setTo(this.toPitch(), this.toYaw(), 0.0);
    return angles;
  }

  /**
   * Assumes this Vector is [pitch, yaw, roll] in degrees and generates a 3x3 rotation matrix in the model
   * convention: pitch is negated (positive pitch tilts a model's nose up), unlike `angleVectors()`.
   * The nine numbers are row major and the rows are the entity's axes (forward, left, up), so the matrix takes
   * world vectors into the entity's space and its transpose takes entity vectors into the world.
   * `Quaternion.fromModelAnglesInto` gives the same rotation as a quaternion.
   */
  toRotationMatrix(): number[] {
    let [pitch, yaw, roll] = this;
    console.assert(Number.isFinite(pitch), 'finite pitch');
    console.assert(Number.isFinite(yaw), 'finite yaw');
    console.assert(Number.isFinite(roll), 'finite roll');
    pitch *= Math.PI / -180.0;
    yaw *= Math.PI / 180.0;
    roll *= Math.PI / 180.0;
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const sr = Math.sin(roll);
    const cr = Math.cos(roll);
    return [
      cy * cp, sy * cp, -sp,
      -sy * cr + cy * sp * sr, cy * cr + sy * sp * sr, cp * sr,
      -sy * -sr + cy * sp * cr, cy * -sr + sy * sp * cr, cp * cr,
    ];
  }

  /**
   * Dot product of this and other.
   * @param other
   */
  dot(other: VectorLike): number {
    return this[0] * other[0] + this[1] * other[1] + this[2] * other[2];
  }

  /**
   * Create a copy of this vector.
   */
  copy(): Vector {
    return new Vector(this[0], this[1], this[2]);
  }

  /**
   * Add other to this vector (component-wise).
   * @param other
   */
  add(other: VectorLike): this {
    this[0] += other[0];
    this[1] += other[1];
    this[2] += other[2];
    return this;
  }

  /**
   * Subtract other from this vector (component-wise).
   * @param other
   */
  subtract(other: VectorLike): this {
    this[0] -= other[0];
    this[1] -= other[1];
    this[2] -= other[2];
    return this;
  }

  /**
   * Multiply factor into this vector.
   * @param factor
   */
  multiply(factor: number): this {
    console.assert(typeof factor === 'number', 'not a number');
    this[0] *= factor;
    this[1] *= factor;
    this[2] *= factor;
    return this;
  }

  /**
   * Check if other equals this vector.
   * @param other
   */
  equals(other: VectorLike): boolean {
    return this[0] === other[0] && this[1] === other[1] && this[2] === other[2];
  }

  /**
   * Check if [x, y, z] equals this vector.
   * @param x
   * @param y
   * @param z
   */
  equalsTo(x: number, y: number, z: number): boolean {
    return this[0] === x && this[1] === y && this[2] === z;
  }

  /**
   * Check if this vector is greater than other.
   * @param other
   */
  gt(other: VectorLike): boolean {
    return this[0] > other[0] && this[1] > other[1] && this[2] > other[2];
  }

  /**
   * Check if this vector is greater than or equal to other.
   * @param other
   */
  gte(other: VectorLike): boolean {
    return this[0] >= other[0] && this[1] >= other[1] && this[2] >= other[2];
  }

  /**
   * Check if this vector is less than other.
   * @param other
   */
  lt(other: VectorLike): boolean {
    return this[0] < other[0] && this[1] < other[1] && this[2] < other[2];
  }

  /**
   * Check if this vector is less than or equal to other.
   * @param other
   */
  lte(other: VectorLike): boolean {
    return this[0] <= other[0] && this[1] <= other[1] && this[2] <= other[2];
  }

  /**
   * Overwrite this vector with values from other.
   * @param other
   * @param offset
   */
  override set(other: VectorLike, offset = 0): this {
    console.assert(offset === 0, 'Vector.set only supports a zero offset');
    console.assert(!Number.isNaN(other[0]), 'NaN component');
    console.assert(!Number.isNaN(other[1]), 'NaN component');
    console.assert(!Number.isNaN(other[2]), 'NaN component');
    this[0] = other[0];
    this[1] = other[1];
    this[2] = other[2];
    return this;
  }

  /**
   * Sets this vector to [x, y, z].
   * @param x
   * @param y
   * @param z
   */
  setTo(x: number, y: number, z: number): this {
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number', 'not a number');
    console.assert(!Number.isNaN(x), 'NaN component');
    console.assert(!Number.isNaN(y), 'NaN component');
    console.assert(!Number.isNaN(z), 'NaN component');
    this[0] = x;
    this[1] = y;
    this[2] = z;
    return this;
  }

  /**
   * Clear this vector.
   */
  clear(): this {
    this[0] = 0.0;
    this[1] = 0.0;
    this[2] = 0.0;
    return this;
  }

  /**
   * Check if this vector is origin.
   */
  isOrigin(): boolean {
    return this[0] === 0.0 && this[1] === 0.0 && this[2] === 0.0;
  }

  /**
   * Check if this vector is infinite.
   */
  isInfinite(): boolean {
    return this[0] === Infinity || this[1] === Infinity || this[2] === Infinity ||
      this[0] === -Infinity || this[1] === -Infinity || this[2] === -Infinity;
  }

  /**
   * Cross product of this x other, returns a new Vector.
   * @param other
   */
  cross(other: VectorLike): Vector {
    return new Vector(
      this[1] * other[2] - this[2] * other[1],
      this[2] * other[0] - this[0] * other[2],
      this[0] * other[1] - this[1] * other[0],
    );
  }

  /**
   * Return the length (magnitude) of this vector.
   */
  len(): number {
    return Math.hypot(this[0], this[1], this[2]);
  }

  /**
   * Returns the average of the components of this vector.
   */
  average(): number {
    return (this[0] + this[1] + this[2]) / 3.0;
  }

  /**
   * Returns the greatest component of this vector.
   */
  greatest(): number {
    return Math.max(this[0], this[1], this[2]);
  }

  /**
   * Determines the distance from this to other.
   * @param other
   */
  distanceTo(other: VectorLike): number {
    const x = this[0] - other[0];
    const y = this[1] - other[1];
    const z = this[2] - other[2];
    return Math.hypot(x, y, z);
  }

  /**
   * Normalize this vector in place. Returns the original length.
   */
  normalize(): number {
    const length = this.len();
    if (length === 0.0) {
      this[0] = this[1] = this[2] = 0.0;
      return 0.0;
    }
    this[0] /= length;
    this[1] /= length;
    this[2] /= length;
    return length;
  }

  /**
   * Multiply two 3x3 rotation matrices.
   * @param matrixA
   * @param matrixB
   */
  static concatRotations(matrixA: RotationMatrix, matrixB: RotationMatrix): RotationMatrix {
    return [
      [
        matrixA[0][0] * matrixB[0][0] + matrixA[0][1] * matrixB[1][0] + matrixA[0][2] * matrixB[2][0],
        matrixA[0][0] * matrixB[0][1] + matrixA[0][1] * matrixB[1][1] + matrixA[0][2] * matrixB[2][1],
        matrixA[0][0] * matrixB[0][2] + matrixA[0][1] * matrixB[1][2] + matrixA[0][2] * matrixB[2][2],
      ],
      [
        matrixA[1][0] * matrixB[0][0] + matrixA[1][1] * matrixB[1][0] + matrixA[1][2] * matrixB[2][0],
        matrixA[1][0] * matrixB[0][1] + matrixA[1][1] * matrixB[1][1] + matrixA[1][2] * matrixB[2][1],
        matrixA[1][0] * matrixB[0][2] + matrixA[1][1] * matrixB[1][2] + matrixA[1][2] * matrixB[2][2],
      ],
      [
        matrixA[2][0] * matrixB[0][0] + matrixA[2][1] * matrixB[1][0] + matrixA[2][2] * matrixB[2][0],
        matrixA[2][0] * matrixB[0][1] + matrixA[2][1] * matrixB[1][1] + matrixA[2][2] * matrixB[2][1],
        matrixA[2][0] * matrixB[0][2] + matrixA[2][1] * matrixB[1][2] + matrixA[2][2] * matrixB[2][2],
      ],
    ];
  }

  /**
   * Set `this` from a quaternion, interpreting that quaternion as Euler angles.
   * @param quaternion
   */
  setQuaternion(quaternion: Quaternion): this {
    const [w, x, y, z] = quaternion;
    const yaw = Math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
    const pitch = Math.asin(Math.max(-1.0, Math.min(1.0, 2.0 * (w * y - z * x))));
    const roll = Math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));

    // Engine angles are [pitch, yaw, roll] in degrees.
    this[0] = pitch * 180.0 / Math.PI;
    this[1] = yaw * 180.0 / Math.PI;
    this[2] = roll * 180.0 / Math.PI;
    return this;
  }

  /**
   * Convert these Euler angles (this) into a quaternion [w, x, y, z], in the view convention of `angleVectors()`.
   * For the pitch convention of model renderers use `Quaternion.fromModelAnglesInto`.
   */
  toQuaternion(): Quaternion {
    const quaternion = new Quaternion();
    Quaternion.fromViewAnglesInto(quaternion, 0, this);
    return quaternion;
  }

  /**
   * Create a Vector from a quaternion, converting that quaternion to Euler angles.
   * @param quaternion
   */
  static fromQuaternion(quaternion: Quaternion): Vector {
    const vector = new Vector();
    vector.setQuaternion(quaternion);
    return vector;
  }

  /**
   * Freezes this Vector.
   */
  freeze(): Readonly<Vector> {
    return this;
  }

  /**
   * Quake-style string representation of a Vector.
   */
  override toString(): string {
    return this.map((element) => +element.toFixed(1)).join(' ');
  }
}
