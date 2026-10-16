import type { Hull } from '../model/BSP.ts';
import type { ServerEdict } from '../../server/Edict.ts';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import type { CollisionModelSource } from '../CollisionModelSource.ts';
import { BrushModel } from '../Mod.ts';

interface BoxClipNode {
  planenum: number;
  children: [number, number];
}

interface BoxPlane {
  type: number;
  normal: Vector;
  dist: number;
  signbits: Hull['planes'][number]['signbits'];
}

/** The hull of a box, which stands in for an entity that has no brush model. */
export interface BoxHull {
  clipnodes: BoxClipNode[];
  planes: BoxPlane[];
  clip_mins: Vector;
  clip_maxs: Vector;
  firstclipnode: number;
  lastclipnode: number;
}

/**
 * Finds the hull to clip against for an entity: a hull of its brush model, picked by the size of what moves, or a box
 * around the entity when it has none. Used by the server for its entities and by the client for the entities it
 * traces against, each with the models of its own realm.
 */
export class EntityHulls {
  readonly #modelSource: CollisionModelSource;
  readonly #boxClipnodes: BoxClipNode[] = [];
  readonly #boxPlanes: BoxPlane[] = [];
  readonly #boxHull: BoxHull;

  /**
   * @param modelSource - resolves the model of an entity in the realm that asks
   */
  constructor(modelSource: CollisionModelSource) {
    this.#modelSource = modelSource;
    this.#boxHull = {
      clipnodes: this.#boxClipnodes,
      planes: this.#boxPlanes,
      clip_mins: Vector.origin,
      clip_maxs: Vector.origin,
      firstclipnode: 0,
      lastclipnode: 5,
    };

    for (let index = 0; index <= 5; index++) {
      const node: BoxClipNode = {
        planenum: index,
        children: [0, 0],
      };
      this.#boxClipnodes[index] = node;
      node.children[index & 1] = Defs.content.CONTENT_EMPTY;
      if (index !== 5) {
        node.children[1 - (index & 1)] = index + 1;
      } else {
        node.children[1 - (index & 1)] = Defs.content.CONTENT_SOLID;
      }

      const plane: BoxPlane = {
        type: index >> 1,
        normal: new Vector(),
        dist: 0.0,
        signbits: 0,
      };
      this.#boxPlanes[index] = plane;
      plane.normal[index >> 1] = 1.0;
    }
  }

  /**
   * Resolves the hull that should be used when clipping against a given entity.
   * @param ent - edict to create a hull for
   * @param mins - minimum extents of the moving object
   * @param maxs - maximum extents of the moving object
   * @param outOffset - receives the hull offset relative to entity origin
   * @returns the hull structure used for collision tests
   */
  forEntity(ent: ServerEdict, mins: Vector, maxs: Vector, outOffset: Vector): Hull | BoxHull {
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
      // every caller synchronously finishes reading the returned hull (recursiveHullCheck walks
      // it to completion and copies out plane data before returning) before anything else can
      // call back in and mutate it again. If a future caller ever needs to hold onto a hull
      // across an async boundary or interleave two forEntity results, it must copy the
      // planes out first.
      this.#boxPlanes[0].dist = emaxs[0] - mins[0];
      this.#boxPlanes[1].dist = emins[0] - maxs[0];
      this.#boxPlanes[2].dist = emaxs[1] - mins[1];
      this.#boxPlanes[3].dist = emins[1] - maxs[1];
      this.#boxPlanes[4].dist = emaxs[2] - mins[2];
      this.#boxPlanes[5].dist = emins[2] - maxs[2];
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
      hull.clip_mins[0] - mins[0] + origin[0],
      hull.clip_mins[1] - mins[1] + origin[1],
      hull.clip_mins[2] - mins[2] + origin[2],
    );

    return hull;
  }
}
