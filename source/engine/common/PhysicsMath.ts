import Vector from '../../shared/Vector.ts';

/**
 * Pure physics math shared between the server's authoritative simulation
 * (`ServerPhysics`) and the engine-driven physics of client-only entities (`ClientPhysics`). Neither
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
   * A `MOVETYPE_BOUNCE` entity that bounces up slower than this (units per second) off a
   * floor-like plane comes to rest.
   */
  static readonly BOUNCE_REST_SPEED = 60.0;

  /**
   * Epsilon value for velocity comparisons and clipping.
   * Values smaller than this are considered negligible.
   */
  static readonly VELOCITY_EPSILON = 0.1;

  /**
   * Decides whether a tossed entity that just hit a plane comes to rest on it: the plane has to be
   * floor-like, and a bouncing entity also has to have lost most of its upward speed. Call it with
   * the velocity already clipped against the plane.
   * @param normalZ Z component of the plane normal.
   * @param velocityZ Z component of the clipped velocity.
   * @param bounces True for `MOVETYPE_BOUNCE`, false for `MOVETYPE_TOSS`, which never bounces.
   * @returns True when the entity comes to rest.
   */
  static shouldComeToRest(normalZ: number, velocityZ: number, bounces: boolean): boolean {
    return normalZ > PhysicsMath.GROUND_ANGLE_THRESHOLD && (!bounces || velocityZ < PhysicsMath.BOUNCE_REST_SPEED);
  }

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
