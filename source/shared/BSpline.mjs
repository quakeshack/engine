import Vector from './Vector.ts';

/**
 * Uniform clamped knot vector in [0,1]
 * @param {number} nCtrl nCtrl
 * @param {number} degree degree
 * @returns {number[]} knots
 */
function makeClampedUniformKnots(nCtrl, degree) {
  const m = nCtrl + degree + 1;
  const knots = new Array(m).fill(0);
  const nInterior = m - 2 * (degree + 1);

  for (let i = 0; i < nInterior; i++) {
    knots[degree + 1 + i] = (i + 1) / (nInterior + 1);
  }

  for (let i = m - degree - 1; i < m; i++) {
    knots[i] = 1;
  }

  return knots;
}

/**
 * @param {number} u u
 * @param {number} degree degree
 * @param {number[]} knots knots
 * @returns {number} span index
 */
function findSpan(u, degree, knots) {
  const n = knots.length - degree - 2; // last control index

  if (u >= knots[n + 1]) {
    return n;
  }

  if (u <= knots[degree]) {
    return degree;
  }

  // binary search
  let low = degree, high = n + 1, mid = Math.floor((low + high) / 2);

  while (!(u >= knots[mid] && u < knots[mid + 1])) {
    if (u < knots[mid]) {
      high = mid;
    } else {
      low = mid;
    }

    mid = Math.floor((low + high) / 2);
  }

  return mid;
}

/**
 * De Boor evaluation at parameter u in [0,1]
 * @param {number} u u
 * @param {number} degree degree
 * @param {number[]} knots knots
 * @param {Vector[]} ctrl ctrl
 * @returns {Vector} point on the curve
 */
function deBoor(u, degree, knots, ctrl) {
  const k = findSpan(u, degree, knots);
  const d = [];

  // copy affected control points
  for (let j = 0; j <= degree; j++) {
    d[j] = ctrl[k - degree + j].copy();
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree + 1 - r] - knots[i];
      const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
      d[j] = d[j - 1].copy().multiply(1 - alpha).add(d[j].copy().multiply(alpha));
    }
  }

  return d[degree];
}

/**
 * Sample a cubic B-spline through given control points.
 * @param {Vector[]} points control points (path you want to smooth)
 * @param {number?} samples number of points to sample along the curve
 * @returns {Vector[]} sampled points along the B-spline
 */
export default function sampleBSpline(points, samples = null) {
  if (points.length < 4) {
    return points.slice(); // need at least 4 for cubic
  }

  if (samples === null) {
    samples = points.length * 10;
  }

  const degree = 3;
  const knots = makeClampedUniformKnots(points.length, degree);

  const out = [];

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1); // [0,1]
    out.push(deBoor(u, degree, knots, points));
  }

  return out;
}
