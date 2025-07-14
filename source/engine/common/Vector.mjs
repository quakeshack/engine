
/**
 * Directional vectors.
 */
export class DirectionalVectors {
  /**
   * @param {Vector} forward forward direction
   * @param {Vector} right right direction
   * @param {Vector} up up direction
   */
  constructor(forward, right, up) {
    this.forward = forward;
    this.right = right;
    this.up = up;
    Object.freeze(this);
  }
};

/**
 * Quaternion.
 */
export class Quaternion extends Array {
  constructor(x = 0.0, y = 0.0, z = 0.0, w = 0.0) {
    super(4);
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && typeof w === 'number', 'not a number');
    this[0] = x;
    this[1] = y;
    this[2] = z;
    this[3] = w;
  }

  /**
   * Creates Quaternion from Vector.
   * @param {Vector} vector vector
   * @returns {Quaternion} the resulting quaternion
   */
  fromVector(vector) {
    return vector.toQuaternion();
  }

  /**
   * Compares this Quaternion to the other quaternion.
   * @param {Quaternion} other other quaternion
   * @returns {boolean} true, if equal
   */
  equals(other) {
    return this[0] === other[0] && this[1] === other[1] && this[2] === other[2] && this[3] === other[3];
  }

  /**
   * Compares this Quaternion’s component to x, y, z, w.
   * @param {number} x x
   * @param {number} y y
   * @param {number} z z
   * @param {number} w omega
   * @returns {boolean} true, if equal
   */
  equalsTo(x, y, z, w) {
    return this[0] === x && this[1] === y && this[2] === z && this[3] === w;
  }

  /**
   * Freezes this Quaternion.
   * @returns {Quaternion} this
   */
  freeze() {
    Object.freeze(this);
    return this;
  }

  /**
   * Quake-style string representation of a Quaternion
   * @returns {string} Quake-style string of this quaternion
   */
  toString() {
    return `${this.map((e) => e.toFixed(1)).join(' ')}`;
  }
};

export default class Vector extends Array {
  /** Vector origin constant */
  static origin = (new Vector()).freeze();

  /**
   * Construct a Vector (defaulting to [0.0, 0.0, 0.0]).
   * Extending Array allows Vector to be used much like a numeric array
   * but still benefit from instance methods here.
   * @param {number} x X
   * @param {number} y Y
   * @param {number} z Z
   */
  constructor(x = 0.0, y = 0.0, z = 0.0) {
    super(3);
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number', 'not a number');
    this[0] = x;
    this[1] = y;
    this[2] = z;
    return this;
  }

  /**
   * Return a perpendicular direction to `this`.
   * (Equivalent to the old Vec.Perpendicular.)
   * @returns {Vector} perpendicular vector
   */
  perpendicular() {
    let pos = 0;
    let minelem = 1;

    // Find whichever component is the smallest in absolute value:
    for (let i = 0; i < 3; i++) {
      const absVal = Math.abs(this[i]);
      if (absVal < minelem) {
        pos = i;
        minelem = absVal;
      }
    }

    // Construct a temporary vector with 1.0 in that dimension:
    const temp = new Vector();
    temp[pos] = 1.0;

    // Compute the projection and subtract it:
    const invDenom = 1.0 / (this[0] * this[0] + this[1] * this[1] + this[2] * this[2]);
    const d = temp.dot(this) * invDenom;
    const perpendicularVec = new Vector(
      temp[0] - d * this[0] * invDenom,
      temp[1] - d * this[1] * invDenom,
      temp[2] - d * this[2] * invDenom,
    );

    // Normalize the result and return:
    perpendicularVec.normalize();
    return perpendicularVec;
  }

  /**
   * Rotate a point around the direction `this`.
   * (Equivalent to the old Vec.RotatePointAroundVector(dir, point, degrees).)
   * @param {Vector} point point to rotate
   * @param {number} degrees angle
   * @returns {Vector} new point
   */
  rotatePointAroundVector(point, degrees) {
    const vectorR = this.perpendicular();
    const up = vectorR.cross(this);

    const m = [
      [vectorR[0], up[0], this[0]],
      [vectorR[1], up[1], this[1]],
      [vectorR[2], up[2], this[2]],
    ];

    const im = [
      [m[0][0], m[1][0], m[2][0]],
      [m[0][1], m[1][1], m[2][1]],
      [m[0][2], m[1][2], m[2][2]],
    ];

    const radians = (degrees * Math.PI) / 180.0;
    const s = Math.sin(radians);
    const c = Math.cos(radians);

    // Rotation about Z-axis by `degrees`:
    const zrot = [
      [c, s, 0.0],
      [-s, c, 0.0],
      [0.0, 0.0, 1.0],
    ];

    // Combine the rotations:
    const matrixRot = Vector.concatRotations(Vector.concatRotations(m, zrot), im);

    // Apply to point:
    const x = matrixRot[0][0] * point[0] + matrixRot[0][1] * point[1] + matrixRot[0][2] * point[2];
    const y = matrixRot[1][0] * point[0] + matrixRot[1][1] * point[1] + matrixRot[1][2] * point[2];
    const z = matrixRot[2][0] * point[0] + matrixRot[2][1] * point[1] + matrixRot[2][2] * point[2];
    return new Vector(x, y, z);
  }

  /**
   * Modulo an angle into [0, 360).
   * (Same as the old Vector.anglemod.)
   * @param {number} angle angle
   * @returns {number} angle in [0, 360)
   */
  static anglemod(angle) {
    return ((angle % 360.0) + 360.0) % 360.0;
  }

  /**
   * Equivalent to the old Vec.BoxOnPlaneSide(emins, emaxs, p).
   * Kept as a static because it does not revolve around a single vector.
   * @param {Vector} emins emins
   * @param {Vector} emaxs emaxs
   * @param {*} p plane
   * @returns {number|null} which side, null on error
   */
  static boxOnPlaneSide(emins, emaxs, p) {
    if (p.type <= 2) {
      if (p.dist <= emins[p.type]) {
        return 1;
      }
      if (p.dist >= emaxs[p.type]) {
        return 2;
      }
      return 3;
    }
    let dist1; let dist2;
    console.assert(p.signbits >= 0 && p.signbits < 8, 'signbits must be [0, 8)', p.signbits);
    switch (p.signbits) {
      case 0:
        dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
        dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
        break;
      case 1:
        dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
        dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
        break;
      case 2:
        dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
        dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
        break;
      case 3:
        dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
        dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
        break;
      case 4:
        dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
        dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
        break;
      case 5:
        dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
        dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
        break;
      case 6:
        dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
        dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
        break;
      case 7:
        dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
        dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
        break;
      default:
        return null;
    }
    let sides = 0;
    if (dist1 >= p.dist) {
      sides = 1;
    }
    if (dist2 < p.dist) {
      sides += 2;
    }
    return sides;
  }

  /**
   * Equivalent to the old Vec.AngleVectors(angles, forward, right, up),
   * but now it acts on `this` as the angles array.
   * Returns an object containing forward, right, up as Vecs.
   * @returns {DirectionalVectors} directional vectors
   */
  angleVectors() {
    const angles = this;
    let angle = angles[0] * Math.PI / 180.0;
    const sp = Math.sin(angle);
    const cp = Math.cos(angle);

    angle = angles[1] * Math.PI / 180.0;
    const sy = Math.sin(angle);
    const cy = Math.cos(angle);

    angle = angles[2] * Math.PI / 180.0;
    const sr = Math.sin(angle);
    const cr = Math.cos(angle);

    const forward = new Vector(
      cp * cy,
      cp * sy,
      -sp,
    );

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

  toYaw() {
    if (!this[0] && !this[1]) {
      return 0.0;
    }

    let yaw = (Math.atan2(this[1], this[0]) * 180.0 / Math.PI);

    if (yaw < 0.0) {
      yaw += 360.0;
    }

    return yaw;
  }

  toPitch() {
    let pitch = (Math.atan2(this[2], Math.sqrt(this[0] * this[0] + this[1] * this[1])) * 180.0 / Math.PI);

    if (pitch < 0.0) {
      pitch += 360.0;
    }

    return pitch;
  }

  /**
   * @returns {Vector} [pitch, yaw, 0]
   */
  toAngles() {
    const angles = new Vector();

    if (this[0] === 0.0 && this[1] === 0.0) {
      if (this[2] > 0.0) {
        angles[0] = 90.0;
      } else {
        angles[0] = 270.0;
      }

      return angles;
    }

    angles.setTo(this.toPitch(), this.toYaw(), 0.0);

    return angles;
  }

  /**
   * Dot product of this and other.
   * @param {Vector} other other vector
   * @returns {number} dot product of this and other
   */
  dot(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] * other[0] + this[1] * other[1] + this[2] * other[2];
  }

  /**
   * Create a copy of this vector.
   * (Equivalent to the old Vec.Copy, but now returns a fresh Vector.)
   * @returns {Vector} copy of this
   */
  copy() {
    return new Vector(this[0], this[1], this[2]);
  }

  /**
   * Add other to this vector (component-wise).
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {Vector} this
   */
  add(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    this[0] += other[0];
    this[1] += other[1];
    this[2] += other[2];
    return this;
  }

  /**
   * Subtract other from this vector (component-wise).
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {Vector} this
   */
  subtract(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    this[0] -= other[0];
    this[1] -= other[1];
    this[2] -= other[2];
    return this;
  }

  /**
   * Multiply factor to this vector.
   * @param {number} factor factor for multiplication
   * @returns {Vector} this
   */
  multiply(factor) {
    console.assert(typeof factor === 'number', 'not a number');
    this[0] *= factor;
    this[1] *= factor;
    this[2] *= factor;
    return this;
  }

  /**
   * Check if other equals this vector.
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {boolean} true, if all components are equal
   */
  equals(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] === other[0] && this[1] === other[1] && this[2] === other[2];
  }

  /**
   * Check if [x, y, z] equals this vector.
   * @param {number} x X
   * @param {number} y Y
   * @param {number} z Z
   * @returns {boolean} true, if all components are equal
   */
  equalsTo(x, y, z) {
    return this[0] === x && this[1] === y && this[2] === z;
  }

  /**
   * Check if this vector is greater than other.
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {boolean} true, if all components of this vector are greater than the other vector
   */
  gt(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] > other[0] && this[1] > other[1] && this[2] > other[2];
  }

  /**
   * Check if this vector is greater than or equal to other.
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {boolean} true, if all components of this vector are greater than or equal to the other vector
   */
  gte(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] >= other[0] && this[1] >= other[1] && this[2] >= other[2];
  }

  /**
   * Check if this vector is less than other.
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {boolean} true, if all components of this vector are less than the other vector
   */
  lt(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] < other[0] && this[1] < other[1] && this[2] < other[2];
  }

  /**
   * Check if this vector is less than or equal to other.
   * @param {Vector|Array} other other vector (or vector alike)
   * @returns {boolean} true, if all components of this vector are less than or equal to the other vector
   */
  lte(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return this[0] <= other[0] && this[1] <= other[1] && this[2] <= other[2];
  }

  /**
   * Overwrite this vector with values from other.
   * @param {Vector|Array} other other vector
   * @returns {Vector} this
   */
  set(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    this[0] = other[0];
    this[1] = other[1];
    this[2] = other[2];
    return this;
  }

  /**
   * Sets this vector to [x, y, z].
   * @param {number} x X
   * @param {number} y Y
   * @param {number} z Z
   * @returns {Vector} this
   */
  setTo(x, y, z) {
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number', 'not a number');
    this[0] = x;
    this[1] = y;
    this[2] = z;
    return this;
  }

  /**
   * Clear this vector.
   * @returns {Vector} this
   */
  clear() {
    this[0] = 0.0;
    this[1] = 0.0;
    this[2] = 0.0;
    return this;
  }

  /**
   * Check if this vector is origin.
   * @returns {boolean} true, if this is an origin vector
   */
  isOrigin() {
    return this[0] === 0.0 && this[1] === 0.0 && this[2] === 0.0;
  };

  /**
   * Cross product of this x other, returns a new Vector.
   * @param {Vector} other other vector
   * @returns {Vector} cross product of this and the other vector
   */
  cross(other) {
    console.assert(other instanceof Vector, 'not a Vector');
    return new Vector(
      this[1] * other[2] - this[2] * other[1],
      this[2] * other[0] - this[0] * other[2],
      this[0] * other[1] - this[1] * other[0],
    );
  }

  /**
   * Return the length (magnitude) of this vector.
   * (Not using len, because Array.prototype.length exists.)
   * @returns {number} the length of this vector
   */
  len() {
    return Math.sqrt(
      this[0] * this[0] +
      this[1] * this[1] +
      this[2] * this[2],
    );
  }

  /**
   * Determines the distance from this to other.
   * @param {Vector} other other vector
   * @returns {number} the distance between this and other
   */
  distanceTo(other) {
    const x = this[0] - other[0];
    const y = this[1] - other[1];
    const z = this[2] - other[2];
    return Math.sqrt(x * x + y * y + z * z);
  }

  /**
   * Normalize this vector in place. Returns the original length.
   * @returns {number} the original length of this vector
   */
  normalize() {
    const len = this.len();
    if (len === 0.0) {
      this[0] = this[1] = this[2] = 0.0;
      return 0.0;
    }
    this[0] /= len;
    this[1] /= len;
    this[2] /= len;
    return len;
  }

  /**
   * Multiply two 3×3 rotation matrices (used by rotatePointAroundVector).
   * This remains static because it’s operating on matrix arrays, not `this`.
   * @param {number[][]} matrixA A
   * @param {number[][]} matrixB B
   * @returns {number[][]} matrix
   */
  static concatRotations(matrixA, matrixB) {
    return [
      [
        matrixA[0][0] * matrixB[0][0] +
        matrixA[0][1] * matrixB[1][0] +
        matrixA[0][2] * matrixB[2][0],
        matrixA[0][0] * matrixB[0][1] +
        matrixA[0][1] * matrixB[1][1] +
        matrixA[0][2] * matrixB[2][1],
        matrixA[0][0] * matrixB[0][2] +
        matrixA[0][1] * matrixB[1][2] +
        matrixA[0][2] * matrixB[2][2],
      ],
      [
        matrixA[1][0] * matrixB[0][0] +
        matrixA[1][1] * matrixB[1][0] +
        matrixA[1][2] * matrixB[2][0],
        matrixA[1][0] * matrixB[0][1] +
        matrixA[1][1] * matrixB[1][1] +
        matrixA[1][2] * matrixB[2][1],
        matrixA[1][0] * matrixB[0][2] +
        matrixA[1][1] * matrixB[1][2] +
        matrixA[1][2] * matrixB[2][2],
      ],
      [
        matrixA[2][0] * matrixB[0][0] +
        matrixA[2][1] * matrixB[1][0] +
        matrixA[2][2] * matrixB[2][0],
        matrixA[2][0] * matrixB[0][1] +
        matrixA[2][1] * matrixB[1][1] +
        matrixA[2][2] * matrixB[2][1],
        matrixA[2][0] * matrixB[0][2] +
        matrixA[2][1] * matrixB[1][2] +
        matrixA[2][2] * matrixB[2][2],
      ],
    ];
  }

  /**
   * Set `this` from a quaternion, interpreting that quaternion as Euler angles.
   * (Equivalent to the old Vec.SetQuaternion, but we store to `this`.)
   * @param {Quaternion} quat quaternion
   * @returns {Vector} this
   */
  setQuaternion(quat) {
    const [w, x, y, z] = quat;

    // Derived via standard quaternion->Euler formula
    const yaw = Math.atan2(
      2 * (w * z + x * y),
      1 - 2 * (y * y + z * z),
    );
    const pitch = Math.asin(
      2 * (w * y - z * x),
    );
    const roll = Math.atan2(
      2 * (w * x + y * z),
      1 - 2 * (x * x + y * y),
    );

    // Store angles in this vector.  (Roll, Pitch, Yaw)
    this[0] = roll;
    this[1] = pitch;
    this[2] = yaw;
    return this;
  }

  /**
   * Convert these Euler angles (this) into a quaternion [w, x, y, z].
   * @returns {Quaternion} quaternion
   */
  toQuaternion() {
    // Expecting [roll, pitch, yaw] in `this`
    const [roll, pitch, yaw] = this;

    const halfRoll = roll / 2;
    const halfPitch = pitch / 2;
    const halfYaw = yaw / 2;

    const sinRoll = Math.sin(halfRoll);
    const cosRoll = Math.cos(halfRoll);

    const sinPitch = Math.sin(halfPitch);
    const cosPitch = Math.cos(halfPitch);

    const sinYaw = Math.sin(halfYaw);
    const cosYaw = Math.cos(halfYaw);

    // w, x, y, z
    const w = cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw;
    const x = sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw;
    const y = cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw;
    const z = cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw;

    return new Quaternion(w, x, y, z);
  }

  /**
   * Create a Vector from a quaternion, converting that quaternion to Euler angles.
   * @param {Quaternion} quat quaternion
   * @returns {Vector} rotation vector
   */
  static fromQuaternion(quat) {
    const v = new Vector();
    v.setQuaternion(quat);
    return v;
  }

  /**
   * Freezes this Vector.
   * @returns {Vector} this
   */
  freeze() {
    Object.freeze(this);
    return this;
  }

  /**
   * Quake-style string representation of a Vector
   * @returns {string} Quake-style string of this vector
   */
  toString() {
    return `${this.map((e) => e.toFixed(1)).join(' ')}`;
  }
};
