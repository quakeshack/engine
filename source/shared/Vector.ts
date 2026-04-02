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

/**
 * Quaternion.
 */
export class Quaternion extends Array<number> {
  constructor(x = 0.0, y = 0.0, z = 0.0, w = 0.0) {
    super(4);
    console.assert(typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && typeof w === 'number', 'not a number');
    console.assert(!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z) && !Number.isNaN(w), 'NaN component');
    this[0] = x;
    this[1] = y;
    this[2] = z;
    this[3] = w;
  }

  /**
   * Creates Quaternion from Vector.
   * @param vector
   */
  fromVector(vector: Vector): Quaternion {
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
   * Freezes this Quaternion.
   */
  freeze(): Quaternion {
    Object.freeze(this);
    return this;
  }

  /**
   * Quake-style string representation of a Quaternion.
   */
  override toString(): string {
    return `${this.map((element) => element.toFixed(1)).join(' ')}`;
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
   * Assumes this Vector is [roll, pitch, yaw] and generates a 3x3 rotation matrix.
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
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const pitch = Math.asin(2 * (w * y - z * x));
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));

    this[0] = roll;
    this[1] = pitch;
    this[2] = yaw;
    return this;
  }

  /**
   * Convert these Euler angles (this) into a quaternion [w, x, y, z].
   */
  toQuaternion(): Quaternion {
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
    const w = cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw;
    const x = sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw;
    const y = cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw;
    const z = cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw;

    return new Quaternion(w, x, y, z);
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
    return `${this.map((element) => +element.toFixed(1)).join(' ')}`;
  }
}
