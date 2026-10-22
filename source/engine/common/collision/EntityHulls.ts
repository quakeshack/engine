import type { ServerEdict } from '../../server/Edict.ts';
import type Vector from '../../../shared/Vector.ts';

import * as Defs from '../../../shared/Defs.ts';
import type { CollisionModelSource } from '../CollisionModelSource.ts';
import { BrushModel } from '../Mod.ts';
import { BoxHull, type Hull } from './Hull.ts';

/**
 * Finds the hull to clip against for an entity: a hull of its brush model, picked by the size of what moves, or a box
 * around the entity when it has none. Used by the server for its entities and by the client for the entities it
 * traces against, each with the models of its own realm.
 */
export class EntityHulls {
  readonly #modelSource: CollisionModelSource;
  readonly #boxHull = new BoxHull();

  /**
   * @param modelSource - resolves the model of an entity in the realm that asks
   */
  constructor(modelSource: CollisionModelSource) {
    this.#modelSource = modelSource;
  }

  /**
   * Resolves the hull that should be used when clipping against a given entity.
   * @param ent - edict to create a hull for
   * @param mins - minimum extents of the moving object
   * @param maxs - maximum extents of the moving object
   * @param outOffset - receives the hull offset relative to entity origin
   * @returns the hull structure used for collision tests
   */
  forEntity(ent: ServerEdict, mins: Vector, maxs: Vector, outOffset: Vector): Hull {
    const entity = ent.entity!;
    const model = this.#modelSource.getModelByIndex(entity.modelindex);
    const origin = entity.origin;

    if (entity.solid !== Defs.solid.SOLID_BSP || !(model instanceof BrushModel)) { // CR: don’t ask
      const emaxs = entity.maxs;
      const emins = entity.mins;
      // This mutates a single shared box hull/box planes pair rather than allocating a fresh hull
      // per call — a verbatim port of vanilla Quake's SV_HullForBox, which uses the same shared
      // static box_hull for the same reason: this path runs once per candidate entity for every
      // trace against a non-BSP entity, so avoiding an allocation here matters. It's safe because
      // every caller synchronously finishes reading the returned hull (the hull trace walks
      // it to completion and copies out plane data before returning) before anything else can
      // call back in and mutate it again. If a future caller ever needs to hold onto a hull
      // across an async boundary or interleave two forEntity results, it must copy the
      // planes out first.
      this.#boxHull.setBounds(
        emins[0] - maxs[0], emins[1] - maxs[1], emins[2] - maxs[2],
        emaxs[0] - mins[0], emaxs[1] - mins[1], emaxs[2] - mins[2],
      );
      outOffset.set(origin);
      return this.#boxHull;
    }

    console.assert(entity.movetype !== Defs.moveType.MOVETYPE_NONE,
      'requires SOLID_BSP with MOVETYPE_NONE, use MOVETYPE_PUSH instead');

    const size = maxs[0] - mins[0];
    let hull: Hull;
    if (size < 3.0) {
      hull = model.hulls[0]!;
    } else if (size <= 32.0) {
      hull = model.hulls[1]!;
    } else {
      hull = model.hulls[2]!;
    }

    outOffset.setTo(
      hull.clipMins[0] - mins[0] + origin[0],
      hull.clipMins[1] - mins[1] + origin[1],
      hull.clipMins[2] - mins[2] + origin[2],
    );

    return hull;
  }
}
