import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { STEPSIZE } from '../../common/Pmove.ts';
import type { CollisionTrace } from './ServerCollisionSupport.ts';

/**
 * The world as the ground check sees it: point traces and point contents. Monster movement probes the
 * live world (entities such as platforms included); the navigation builder probes the static world.
 */
export interface GroundProbe {
  /**
   * Traces a point-sized line, ignoring monsters.
   * @returns The trace.
   */
  traceLine(start: Vector, end: Vector): CollisionTrace;

  /**
   * Reads the contents at a point.
   * @returns The contents.
   */
  pointContents(point: Vector): Defs.content;
}

/**
 * QuakeC's `checkBottom`: whether a walking monster may stand where it is. Shared by monster movement and the
 * navigation builder, so the graph never offers a link the movement refuses to walk.
 */
export class GroundSupport {
  /**
   * Checks that a box standing at `origin` has floor under its middle and under all four bottom corners, none of
   * them more than a step below the middle. A box with every bottom corner over solid passes right away.
   * @param probe The world to probe.
   * @param origin Where the box stands.
   * @param mins The box's mins, relative to `origin`.
   * @param maxs The box's maxs, relative to `origin`.
   * @returns True when the box has ground beneath it.
   */
  static check(probe: GroundProbe, origin: Vector, mins: Vector, maxs: Vector): boolean {
    const bottom = origin[2] + mins[2];
    const minX = origin[0] + mins[0];
    const minY = origin[1] + mins[1];
    const maxX = origin[0] + maxs[0];
    const maxY = origin[1] + maxs[1];

    const allCornersSolid =
      probe.pointContents(new Vector(minX, minY, bottom - 1.0)) === Defs.content.CONTENT_SOLID
      && probe.pointContents(new Vector(minX, maxY, bottom - 1.0)) === Defs.content.CONTENT_SOLID
      && probe.pointContents(new Vector(maxX, minY, bottom - 1.0)) === Defs.content.CONTENT_SOLID
      && probe.pointContents(new Vector(maxX, maxY, bottom - 1.0)) === Defs.content.CONTENT_SOLID;

    if (allCornersSolid) {
      return true;
    }

    const start = new Vector(origin[0], origin[1], bottom + 1.0);
    const stop = new Vector(origin[0], origin[1], bottom + 1.0 - 2.0 * STEPSIZE);

    const middle = probe.traceLine(start, stop);

    if (middle.fraction === 1.0) {
      return false;
    }

    const middleFloor = middle.endpos[2];

    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start[0] = stop[0] = x !== 0 ? maxX : minX;
        start[1] = stop[1] = y !== 0 ? maxY : minY;

        const corner = probe.traceLine(start, stop);

        if (corner.fraction === 1.0 || middleFloor - corner.endpos[2] > STEPSIZE) {
          return false;
        }
      }
    }

    return true;
  }
}
