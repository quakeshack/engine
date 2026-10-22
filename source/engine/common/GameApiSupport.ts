import type { BaseEntity } from '../server/Edict.ts';
import type { ClientEdict } from '../client/ClientEntities.ts';
import type Vector from '../../shared/Vector.ts';

/** Which editions of the game data are in use. */
export enum GameFlavors {
  hipnotic = 'hipnotic',
  rogue = 'rogue',
  shareware = 'shareware',
}

/** The facts about the game data that decide a game's flavors, read when a game asks. */
export interface GameEdition {
  /** Whether the registered (non-shareware) data is in use. */
  readonly registered: boolean;
  /** Whether the hipnotic mission pack is loaded. */
  readonly hipnotic: boolean;
  /** Whether the rogue mission pack is loaded. */
  readonly rogue: boolean;
}

/**
 * Reads the edition of the game data from the file system that detected it.
 * @param com The file system, after it checked which game data it has.
 * @returns The edition in use right now.
 */
export function editionOf(com: { readonly registered: { readonly value: number | string | boolean } | null; readonly hipnotic: boolean; readonly rogue: boolean }): GameEdition {
  return { registered: com.registered?.value === 1, hipnotic: com.hipnotic, rogue: com.rogue };
}

/** The result of a trace as a game sees it. */
export interface GameTrace {
  readonly solid: {
    readonly all: boolean;
    readonly start: boolean;
  };
  readonly fraction: number;
  readonly plane: {
    readonly normal: Vector;
    readonly distance: number;
  };
  readonly contents: {
    readonly inOpen: boolean;
    readonly inWater: boolean;
  };
  readonly point: Vector;
  readonly entity: BaseEntity | ClientEdict | null;
}

/** The result of a trace as the engine's collision code produces it. */
export interface InternalTraceLike {
  readonly allsolid: boolean;
  readonly startsolid: boolean;
  readonly fraction: number;
  readonly plane: {
    readonly normal: Vector;
    readonly dist: number;
  };
  readonly inopen: boolean;
  readonly inwater: boolean;
  readonly endpos: Vector;
  readonly ent: {
    readonly entity: BaseEntity | ClientEdict;
  } | null;
}

/**
 * Convert an engine trace into the shape games get.
 * @param trace The trace the collision code produced.
 * @returns The trace as a game sees it.
 */
export function internalTraceToGameTrace(trace: InternalTraceLike): GameTrace {
  return {
    solid: {
      all: trace.allsolid,
      start: trace.startsolid,
    },
    fraction: trace.fraction,
    plane: {
      normal: trace.plane.normal,
      distance: trace.plane.dist,
    },
    contents: {
      inOpen: trace.inopen,
      inWater: trace.inwater,
    },
    point: trace.endpos,
    entity: trace.ent ? trace.ent.entity : null,
  };
}
