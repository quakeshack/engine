import type Vector from '../../../shared/Vector.ts';
import type { content } from '../../../shared/Defs.ts';
import type { Trace } from '../Pmove.ts';

/**
 * Collision entity contract used by movement code.
 */
export interface PlayerCollisionEntity {
  /**
   * Whether this entity uses brush-based collision.
   */
  readonly usesBrushTracing: boolean;

  /**
   * Owning edict index when this collision entity maps back to game state.
   */
  readonly edictId: number | null;

  /**
   * Trace a player-sized move against this collision entity.
   */
  tracePlayerMove(start: Vector, end: Vector): Trace;

  /**
   * Check whether a player-sized box can occupy the given position.
   */
  testPlayerPosition(position: Vector): boolean;
}

/**
 * Collision world contract used by movement code.
 */
export interface PlayerCollisionWorld {
  /**
   * Sample static-world contents at a point.
   */
  staticWorldContents(point: Vector): content;

  /**
   * Trace a player-sized move against the static world only.
   */
  traceStaticWorldPlayerMove(start: Vector, end: Vector): Trace;

  /**
   * Check whether a player-sized box can occupy the given world-space position.
   */
  isValidPlayerPosition(position: Vector): boolean;

  /**
   * Trace a player-sized move against all world collision entities.
   */
  clipPlayerMove(start: Vector, end: Vector): Trace;
}
