/* global Vec, Sys */

// eslint-disable-next-line no-global-assign
Vec = {};

Vec.origin = [0.0, 0.0, 0.0];

Vec.Perpendicular = function(vector) {
  let pos = 0;
  let minelem = 1;
  if (Math.abs(vector[0]) < minelem) {
    pos = 0;
    minelem = Math.abs(vector[0]);
  }
  if (Math.abs(vector[1]) < minelem) {
    pos = 1;
    minelem = Math.abs(vector[1]);
  }
  if (Math.abs(vector[2]) < minelem) {
    pos = 2;
    minelem = Math.abs(vector[2]);
  }
  const tempvec = [0.0, 0.0, 0.0];
  tempvec[pos] = 1.0;
  const inv_denom = 1.0 / (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
  const d = (tempvec[0] * vector[0] + tempvec[1] * vector[1] + tempvec[2] * vector[2]) * inv_denom;
  const vector_dst = [
    tempvec[0] - d * vector[0] * inv_denom,
    tempvec[1] - d * vector[1] * inv_denom,
    tempvec[2] - d * vector[2] * inv_denom,
  ];
  Vec.Normalize(vector_dst);
  return vector_dst;
};

Vec.RotatePointAroundVector = function(vector_dir, vector_point, degrees) {
  const vector_r = Vec.Perpendicular(vector_dir);
  const up = Vec.CrossProduct(vector_r, vector_dir);
  const m = [
    [vector_r[0], up[0], vector_dir[0]],
    [vector_r[1], up[1], vector_dir[1]],
    [vector_r[2], up[2], vector_dir[2]],
  ];
  const im = [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
  const s = Math.sin(degrees * Math.PI / 180.0);
  const c = Math.cos(degrees * Math.PI / 180.0);
  const zrot = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  const matrix_rot = Vec.ConcatRotations(Vec.ConcatRotations(m, zrot), im);
  return [
    matrix_rot[0][0] * vector_point[0] + matrix_rot[0][1] * vector_point[1] + matrix_rot[0][2] * vector_point[2],
    matrix_rot[1][0] * vector_point[0] + matrix_rot[1][1] * vector_point[1] + matrix_rot[1][2] * vector_point[2],
    matrix_rot[2][0] * vector_point[0] + matrix_rot[2][1] * vector_point[1] + matrix_rot[2][2] * vector_point[2],
  ];
};

Vec.Anglemod = function(angle) {
  return (angle % 360.0 + 360.0) % 360.0;
};

Vec.BoxOnPlaneSide = function(emins, emaxs, p) {
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
      Sys.Error('Vec.BoxOnPlaneSide: Bad signbits');
  }
  let sides = 0;
  if (dist1 >= p.dist) {
    sides = 1;
  }
  if (dist2 < p.dist) {
    sides += 2;
  }
  return sides;
};

Vec.AngleVectors = function(angles, forward, right, up) {
  let angle;

  angle = angles[0] * Math.PI / 180.0;
  const sp = Math.sin(angle);
  const cp = Math.cos(angle);
  angle = angles[1] * Math.PI / 180.0;
  const sy = Math.sin(angle);
  const cy = Math.cos(angle);
  angle = angles[2] * Math.PI / 180.0;
  const sr = Math.sin(angle);
  const cr = Math.cos(angle);

  if (forward != null) {
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;
  }
  if (right != null) {
    right[0] = cr * sy - sr * sp * cy;
    right[1] = -sr * sp * sy - cr * cy;
    right[2] = -sr * cp;
  }
  if (up != null) {
    up[0] = cr * sp * cy + sr * sy;
    up[1] = cr * sp * sy - sr * cy;
    up[2] = cr * cp;
  }
};

Vec.DotProduct = function(vector_a, vector_b) {
  return vector_a[0] * vector_b[0] + vector_a[1] * vector_b[1] + vector_a[2] * vector_b[2];
};

Vec.Copy = function(vector_src, vector_dest) {
  vector_dest[0] = vector_src[0];
  vector_dest[1] = vector_src[1];
  vector_dest[2] = vector_src[2];
};

Vec.CrossProduct = function(vector_a, vector_b) {
  return [
    vector_a[1] * vector_b[2] - vector_a[2] * vector_b[1],
    vector_a[2] * vector_b[0] - vector_a[0] * vector_b[2],
    vector_a[0] * vector_b[1] - vector_a[1] * vector_b[0],
  ];
};

Vec.Length = function(vector) {
  return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
};

Vec.Normalize = function(vector) {
  const length = Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
  if (length === 0.0) {
    vector[0] = vector[1] = vector[2] = 0.0;
    return 0.0;
  }
  vector[0] /= length;
  vector[1] /= length;
  vector[2] /= length;
  return length;
};

Vec.ConcatRotations = function(matrix_a, matrix_b) {
  return [
    [
      matrix_a[0][0] * matrix_b[0][0] + matrix_a[0][1] * matrix_b[1][0] + matrix_a[0][2] * matrix_b[2][0],
      matrix_a[0][0] * matrix_b[0][1] + matrix_a[0][1] * matrix_b[1][1] + matrix_a[0][2] * matrix_b[2][1],
      matrix_a[0][0] * matrix_b[0][2] + matrix_a[0][1] * matrix_b[1][2] + matrix_a[0][2] * matrix_b[2][2],
    ],
    [
      matrix_a[1][0] * matrix_b[0][0] + matrix_a[1][1] * matrix_b[1][0] + matrix_a[1][2] * matrix_b[2][0],
      matrix_a[1][0] * matrix_b[0][1] + matrix_a[1][1] * matrix_b[1][1] + matrix_a[1][2] * matrix_b[2][1],
      matrix_a[1][0] * matrix_b[0][2] + matrix_a[1][1] * matrix_b[1][2] + matrix_a[1][2] * matrix_b[2][2],
    ],
    [
      matrix_a[2][0] * matrix_b[0][0] + matrix_a[2][1] * matrix_b[1][0] + matrix_a[2][2] * matrix_b[2][0],
      matrix_a[2][0] * matrix_b[0][1] + matrix_a[2][1] * matrix_b[1][1] + matrix_a[2][2] * matrix_b[2][1],
      matrix_a[2][0] * matrix_b[0][2] + matrix_a[2][1] * matrix_b[1][2] + matrix_a[2][2] * matrix_b[2][2],
    ],
  ];
};

Vec.SetQuaternion = function (vector, quaternion) {
  const [w, x, y, z] = quaternion;

  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y*y + z*z));
  const pitch = Math.asin(2 * (w * y - z * x));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x*x + y*y));

  vector[0] = roll;
  vector[1] = pitch;
  vector[2] = yaw;
};

Vec.FromQuaternion = function (quaternion) {
  const vector = [];

  Vec.SetQuaternion(vector, quaternion);

  return vector;
};

Vec.ToQuaternion = function (vector) {
  const [roll, pitch, yaw] = vector; // Euler angles: roll, pitch, yaw
  const quaternion = [];

  // Precompute sine and cosine of half angles
  const halfRoll = roll / 2;
  const halfPitch = pitch / 2;
  const halfYaw = yaw / 2;

  const sinRoll = Math.sin(halfRoll);
  const cosRoll = Math.cos(halfRoll);

  const sinPitch = Math.sin(halfPitch);
  const cosPitch = Math.cos(halfPitch);

  const sinYaw = Math.sin(halfYaw);
  const cosYaw = Math.cos(halfYaw);

  // Compute quaternion
  quaternion[0] = cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw; // w
  quaternion[1] = sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw; // x
  quaternion[2] = cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw; // y
  quaternion[3] = cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw; // z

  return quaternion;
};
