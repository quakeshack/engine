import type Vector from './Vector.ts';

/**
 * Computes how far a player's view rolls while moving sideways.
 * @param angles View angles of the player.
 * @param velocity Velocity of the player.
 * @param rollspeed Sideways speed at which the roll reaches its maximum.
 * @param rollangle Maximum roll angle in degrees.
 * @returns The roll angle, signed by the direction of the sideways movement.
 */
export function calcRoll(angles: Vector, velocity: Vector, rollspeed: number, rollangle: number): number {
  const { right } = angles.angleVectors();
  let side = velocity[0] * right[0] + velocity[1] * right[1] + velocity[2] * right[2];
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  if (side < rollspeed) {
    return side * sign * rollangle / rollspeed;
  }

  return rollangle * sign;
}
