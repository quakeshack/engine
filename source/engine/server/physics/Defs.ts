/**
 * Maximum step height an entity can climb automatically (in units).
 */
export const STEP_HEIGHT = 18.0;

/**
 * Water movement speed multiplier (reduces speed to 70% in water).
 */
export const WATER_SPEED_FACTOR = 0.7;

/**
 * Overbounce factor for wall/floor collisions.
 * Values > 1.0 make objects bounce slightly, < 1.0 absorb energy.
 */
export const BOUNCE_OVERBOUNCE = 1.0;

/**
 * Overbounce factor for stopping movement.
 */
export const STOP_OVERBOUNCE = 1.0;

/**
 * Maximum number of collision planes to slide against in flyMove.
 */
export const MAX_CLIP_PLANES = 5;

/**
 * Maximum number of bump iterations in flyMove.
 */
export const MAX_BUMP_COUNT = 4;

/**
 * Blocked flags for movement traces.
 */
export enum BlockedFlags {
  /** Movement not blocked. */
  NONE = 0,
  /** Blocked by floor. */
  FLOOR = 1,
  /** Blocked by wall/step. */
  WALL = 2,
  /** Blocked by floor and wall. */
  BOTH = 3,
}
