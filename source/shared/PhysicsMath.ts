import Vector from './Vector.ts';

/**
 * Pure physics math shared between the server's authoritative simulation
 * (`ServerPhysics`) and client-only cosmetic physics (`ClientEntityPhysics`). Neither
 * function here touches an entity/edict -- only `Vector`s in, `Vector`s out -- so both
 * sides import the same implementation instead of the client reimplementing (and
 * eventually drifting from) the server's bounce formula.
 */
export default class PhysicsMath {
  /**
   * Minimum ground angle normal (Z component) to be considered "on ground".
   * Normal vectors with Z >= this value are walkable slopes.
   */
  static readonly GROUND_ANGLE_THRESHOLD = 0.7;

  /**
   * Epsilon value for velocity comparisons and clipping.
   * Values smaller than this are considered negligible.
   */
  static readonly VELOCITY_EPSILON = 0.1;

  /**
   * Clips the velocity vector against a collision plane.
   */
  static clipVelocity(vec: Vector, normal: Vector, out: Vector, overbounce: number): void {
    const backoff = vec.dot(normal) * overbounce;

    out[0] = vec[0] - normal[0] * backoff;
    if ((out[0] > -PhysicsMath.VELOCITY_EPSILON) && (out[0] < PhysicsMath.VELOCITY_EPSILON)) {
      out[0] = 0.0;
    }

    out[1] = vec[1] - normal[1] * backoff;
    if ((out[1] > -PhysicsMath.VELOCITY_EPSILON) && (out[1] < PhysicsMath.VELOCITY_EPSILON)) {
      out[1] = 0.0;
    }

    out[2] = vec[2] - normal[2] * backoff;
    if ((out[2] > -PhysicsMath.VELOCITY_EPSILON) && (out[2] < PhysicsMath.VELOCITY_EPSILON)) {
      out[2] = 0.0;
    }
  }
}
