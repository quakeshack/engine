import type { BrushModel, Hull } from '../common/model/BSP.ts';
import type { ClientEdict } from './ClientEntities.ts';
import type { ServerEdict } from '../server/Edict.ts';

import Vector from '../../shared/Vector.ts';
import * as Defs from '../../shared/Defs.ts';
import type CollisionModelSource from '../common/CollisionModelSource.ts';
import { BrushTrace, Trace as SharedTrace } from '../common/Pmove.ts';
import { CollisionPlane, CollisionTrace } from '../server/physics/ServerCollisionSupport.ts';
import { ServerArea } from '../server/physics/ServerArea.ts';
import { ServerCollision } from '../server/physics/ServerCollision.ts';
import {
  pointContents as legacyPointContents,
  recursiveHullCheck as legacyRecursiveHullCheck,
} from '../server/physics/ServerLegacyHullCollision.ts';

type LegacyHull = Hull & {
  readonly firstclipnode: number;
};

/** The server the entity collision code is written for, which a client stands in for. */
type CollisionOwner = ConstructorParameters<typeof ServerArea>[0];

/** A client entity as the narrow phase of entity collision sees it. */
export interface ClientCollisionTarget {
  readonly entity: ClientEdict;
  readonly num: number;
  equals(other: unknown): boolean;
}

/**
 * Static-world collision queries of the client, answered from the client's own copy of the world
 * model. Particles, dynamic lights, the chase camera and client-only entities trace through this
 * instead of reaching into the server, so they keep working on a pure remote client and will keep
 * working once the server lives in a worker and its world model is not reachable from here.
 *
 * It only knows the static world: there are no entities to hit, `CollisionTrace.ent` is always
 * `null`.
 */
export default class ClientCollision {
  readonly #modelSource: CollisionModelSource;

  #entityCollision: ServerCollision | null = null;

  constructor(modelSource: CollisionModelSource) {
    this.#modelSource = modelSource;
  }

  /**
   * Traces a moving box against one client entity. Uses the same narrow phase the server uses for its
   * entities, but needs neither a server nor its entity list.
   * @returns The trace against the entity; one that went all the way when the entity cannot be hit.
   */
  clipMoveToEntity(target: ClientCollisionTarget, start: Vector, mins: Vector, maxs: Vector, end: Vector): CollisionTrace {
    this.#entityCollision ??= this.#createEntityCollision();

    return this.#entityCollision.clipMoveToEntity(target as unknown as ServerEdict, start, mins, maxs, end);
  }

  /**
   * The narrow phase of the server's collision only asks its server for the world entity, the time
   * and a console for diagnostics, and its area for the box hull. A client has no server to give
   * those, so it brings stand-ins: no entities to be the world, and a box hull of its own.
   * @returns Entity collision that works without a server.
   */
  #createEntityCollision(): ServerCollision {
    const standIn = { server: { edicts: [], time: 0 }, con: { DPrint(): void {} } } as unknown as CollisionOwner & { area: ServerArea };
    const area = new ServerArea(standIn, this.#modelSource);

    area.initBoxHull();
    standIn.area = area;

    return new ServerCollision(standIn, this.#modelSource);
  }

  /**
   * Samples the contents of the static world at a point, with current volumes folded into water.
   * @returns The contents at the point, `CONTENT_EMPTY` when no world is loaded.
   */
  pointContents(point: Vector): Defs.content {
    const worldModel = this.#modelSource.getWorldModel();

    if (worldModel === null) {
      return Defs.content.CONTENT_EMPTY;
    }

    if (!worldModel.hasBrushData) {
      return ClientCollision.#normalizeContents(legacyPointContents(worldModel, point));
    }

    if (!BrushTrace.transformedTestPosition(worldModel, point, Vector.origin, Vector.origin)) {
      return Defs.content.CONTENT_SOLID;
    }

    return ClientCollision.#normalizeContents(worldModel.getLeafForPoint(point).contents);
  }

  /**
   * Traces a point-sized line against the static world.
   * @returns The trace; a trace that went the whole way with nothing hit when no world is loaded.
   */
  traceStaticWorldLine(start: Vector, end: Vector): CollisionTrace {
    const worldModel = this.#modelSource.getWorldModel();

    if (worldModel === null) {
      return CollisionTrace.empty(end);
    }

    if (worldModel.hasBrushData) {
      return ClientCollision.#fromBrushTrace(start.equals(end)
        ? ClientCollision.#testPosition(worldModel, start)
        : BrushTrace.transformedBoxTrace(worldModel, start, end, Vector.origin, Vector.origin));
    }

    // Legacy path for worlds that only carry clipnode hulls.
    const hull = worldModel.hulls[0] as LegacyHull;
    const trace = CollisionTrace.hullInitial(end);
    legacyRecursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, start, end, trace);
    return trace;
  }

  /**
   * Compatibility alias for traceStaticWorldLine.
   * @returns The trace through the static world line segment.
   */
  traceWorldLine(start: Vector, end: Vector): CollisionTrace {
    return this.traceStaticWorldLine(start, end);
  }

  /**
   * Zero-length traces must not go through the swept path, it reports false startsolid hits.
   * @returns A shared trace that is blocked only when the point is inside solid.
   */
  static #testPosition(worldModel: BrushModel, point: Vector): SharedTrace {
    const blocked = !BrushTrace.transformedTestPosition(worldModel, point, Vector.origin, Vector.origin);
    const trace = new SharedTrace();

    trace.allsolid = blocked;
    trace.startsolid = blocked;
    trace.fraction = blocked ? 0.0 : 1.0;
    trace.endpos.set(point);
    trace.plane.normal.clear();
    trace.plane.dist = 0.0;
    trace.inopen = false;
    trace.inwater = false;

    return trace;
  }

  static #fromBrushTrace(brushTrace: SharedTrace): CollisionTrace {
    const trace = new CollisionTrace(brushTrace.endpos.copy(), {
      fraction: brushTrace.fraction,
      allsolid: brushTrace.allsolid,
      startsolid: brushTrace.startsolid,
      plane: CollisionPlane.fromPlane(brushTrace.plane),
      inopen: brushTrace.inopen,
      inwater: brushTrace.inwater,
    });

    if (trace.allsolid) {
      trace.startsolid = true;
    }

    return trace;
  }

  static #normalizeContents(contents: Defs.content): Defs.content {
    if (contents <= Defs.content.CONTENT_CURRENT_0 && contents >= Defs.content.CONTENT_CURRENT_DOWN) {
      return Defs.content.CONTENT_WATER;
    }

    return contents;
  }
}
