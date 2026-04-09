import Vector from './Vector.ts';

/**
 * Uniform clamped knot vector in [0,1]
 * @param nCtrl nCtrl
 * @param degree degree
 * @returns knots
 */
function makeClampedUniformKnots(nCtrl: number, degree: number): number[] {
  const m = nCtrl + degree + 1;
  const knots = new Array<number>(m).fill(0);
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
 * @param u u
 * @param degree degree
 * @param knots knots
 * @returns span index
 */
function findSpan(u: number, degree: number, knots: number[]): number {
  const n = knots.length - degree - 2;

  if (u >= knots[n + 1]) {
    return n;
  }

  if (u <= knots[degree]) {
    return degree;
  }

  let low = degree;
  let high = n + 1;
  let mid = Math.floor((low + high) / 2);

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
 * @param u u
 * @param degree degree
 * @param knots knots
 * @param ctrl ctrl
 * @returns point on the curve
 */
function deBoor(u: number, degree: number, knots: number[], ctrl: Vector[]): Vector {
  const k = findSpan(u, degree, knots);
  const d: Vector[] = [];

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
 * @param points control points (path you want to smooth)
 * @param samples number of points to sample along the curve
 * @returns sampled points along the B-spline
 */
export default function sampleBSpline(points: Vector[], samples: number | null = null): Vector[] {
  if (points.length < 4) {
    return points.slice();
  }

  if (samples === null) {
    samples = points.length * 10;
  }

  const degree = 3;
  const knots = makeClampedUniformKnots(points.length, degree);
  const out: Vector[] = [];

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    out.push(deBoor(u, degree, knots, points));
  }

  return out;
}
