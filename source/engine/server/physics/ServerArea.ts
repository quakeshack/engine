import type { Hull, Node } from '../../common/model/BSP.ts';
import type { BaseEntity, ServerEdict } from '../Edict.ts';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { Octree } from '../../../shared/Octree.ts';
import { eventBus, getCommonRegistry } from '../../registry.ts';
import CollisionModelSource, { createRegistryCollisionModelSource } from '../../common/CollisionModelSource.ts';
import { BrushModel } from '../../common/Mod.ts';

interface BoxClipNode {
  planenum: number;
  children: number[];
}

interface BoxPlane {
  type: number;
  normal: Vector;
  dist: number;
}

interface BoxHull {
  clipnodes: BoxClipNode[];
  planes: BoxPlane[];
  firstclipnode: number;
  lastclipnode: number;
}

let { SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ SV } = getCommonRegistry());
});

/**
 * Manages spatial partitioning and entity linking for efficient collision detection.
 * Handles the area node BSP tree used for spatial queries.
 */
export class ServerArea {
  tree: Octree<ServerEdict> | null = null;
  box_clipnodes: BoxClipNode[] = [];
  box_planes: BoxPlane[] = [];
  box_hull: BoxHull | null = null;
  readonly _modelSource: CollisionModelSource;

  /**
   * @param modelSource Runtime model resolver.
   */
  constructor(modelSource: CollisionModelSource = createRegistryCollisionModelSource()) {
    this._modelSource = modelSource;
  }

  /**
   * Resolve a collision model by model index from either the active server or
   * the client precache populated during signon.
   * @param modelIndex Precached model index.
   * @returns Resolved model, if any.
   */
  _getModelByIndex(modelIndex: number): ReturnType<CollisionModelSource['getModelByIndex']> {
    return this._modelSource.getModelByIndex(modelIndex);
  }

  /**
   * Compute entity world bounds, expanding rotated BSP bounds into a world AABB.
   * @param ent Entity being linked.
   * @param absmin Output minimum bounds.
   * @param absmax Output maximum bounds.
   */
  _computeEntityBounds(ent: ServerEdict, absmin: Vector, absmax: Vector): void {
    const entity = ent.entity!;
    const origin = entity.origin;
    const mins = entity.mins;
    const maxs = entity.maxs;
    const model = this._getModelByIndex(entity.modelindex);

    if (entity.solid === Defs.solid.SOLID_BSP
      && model instanceof BrushModel
      && !entity.angles.isOrigin()) {
      const basis = entity.angles.toRotationMatrix();
      const forward = new Vector(basis[0], basis[1], basis[2]);
      const right = new Vector(basis[3], basis[4], basis[5]);
      const up = new Vector(basis[6], basis[7], basis[8]);

      const centerX = (mins[0] + maxs[0]) * 0.5;
      const centerY = (mins[1] + maxs[1]) * 0.5;
      const centerZ = (mins[2] + maxs[2]) * 0.5;
      const extentsX = (maxs[0] - mins[0]) * 0.5;
      const extentsY = (maxs[1] - mins[1]) * 0.5;
      const extentsZ = (maxs[2] - mins[2]) * 0.5;

      const worldCenter = origin.copy()
        .add(forward.copy().multiply(centerX))
        .add(right.copy().multiply(centerY))
        .add(up.copy().multiply(centerZ));

      const worldExtentX = Math.abs(forward[0]) * extentsX + Math.abs(right[0]) * extentsY + Math.abs(up[0]) * extentsZ;
      const worldExtentY = Math.abs(forward[1]) * extentsX + Math.abs(right[1]) * extentsY + Math.abs(up[1]) * extentsZ;
      const worldExtentZ = Math.abs(forward[2]) * extentsX + Math.abs(right[2]) * extentsY + Math.abs(up[2]) * extentsZ;

      absmin.setTo(
        worldCenter[0] - worldExtentX,
        worldCenter[1] - worldExtentY,
        worldCenter[2] - worldExtentZ,
      );
      absmax.setTo(
        worldCenter[0] + worldExtentX,
        worldCenter[1] + worldExtentY,
        worldCenter[2] + worldExtentZ,
      );
      return;
    }

    absmin.set(origin).add(mins);
    absmax.set(origin).add(maxs);
  }

  /**
   * Initializes the temporary hull data used for axis-aligned clipping.
   */
  initBoxHull(): void {
    this.box_clipnodes = [];
    this.box_planes = [];
    this.box_hull = {
      clipnodes: this.box_clipnodes,
      planes: this.box_planes,
      firstclipnode: 0,
      lastclipnode: 5,
    };

    for (let index = 0; index <= 5; index++) {
      const node: BoxClipNode = {
        planenum: index,
        children: [],
      };
      this.box_clipnodes[index] = node;
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
      };
      this.box_planes[index] = plane;
      plane.normal[index >> 1] = 1.0;
    }
  }

  /**
   * Resolves the hull that should be used when clipping against a given entity.
   * @param ent Edict to create a hull for.
   * @param mins Minimum extents of the moving object.
   * @param maxs Maximum extents of the moving object.
   * @param out_offset Receives the hull offset relative to entity origin.
   * @returns The hull structure used for collision tests.
   */
  hullForEntity(ent: ServerEdict, mins: Vector, maxs: Vector, out_offset: Vector): Hull | BoxHull {
    const entity = ent.entity!;
    const model = this._getModelByIndex(entity.modelindex);
    const origin = entity.origin;

    if (entity.solid !== Defs.solid.SOLID_BSP || !(model instanceof BrushModel)) { // CR: don’t ask
      const emaxs = entity.maxs;
      const emins = entity.mins;
      // FIXME: create a new hull for this instead of mutating the box hull planes (which could cause issues if multiple entities use it at the same time)
      this.box_planes[0].dist = emaxs[0] - mins[0];
      this.box_planes[1].dist = emins[0] - maxs[0];
      this.box_planes[2].dist = emaxs[1] - mins[1];
      this.box_planes[3].dist = emins[1] - maxs[1];
      this.box_planes[4].dist = emaxs[2] - mins[2];
      this.box_planes[5].dist = emins[2] - maxs[2];
      out_offset.set(origin);
      return this.box_hull!;
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

    out_offset.setTo(
      hull.clip_mins[0] - mins[0] + origin[0],
      hull.clip_mins[1] - mins[1] + origin[1],
      hull.clip_mins[2] - mins[2] + origin[2],
    );

    return hull;
  }

  /**
   * Recursively builds the area node BSP used for spatial queries.
   * @param mins Minimum bounds.
   * @param maxs Maximum bounds.
   */
  initOctree(mins: Vector, maxs: Vector): void {
    // center is the midpoint of mins/maxs
    const center = mins.copy().add(maxs).multiply(0.5);

    // compute the largest extent and make a cubic octree size that covers it
    const d = maxs.copy().subtract(mins);
    const maxDim = Math.max(d[0], d[1], d[2], 1.0);

    // add a small margin, round up to next integer, then to the next power-of-two
    const fullSize = Math.ceil(maxDim + 2.0);
    let pow2 = 1;

    while (pow2 < fullSize) {
      pow2 <<= 1;
    }

    const halfSize = pow2 / 2;

    this.tree = new Octree(center, halfSize, 16, 64);
  }

  /**
   * Removes an edict from any area lists it is currently linked to.
   * @param ent Edict to unlink.
   */
  unlinkEdict(ent: ServerEdict): void {
    if (ent.octreeNode) {
      ent.octreeNode.remove(ent);
      ent.octreeNode = null;
    }
  }

  /**
   * Iterates all trigger edicts that potentially overlap the provided entity.
   * @param ent Subject edict.
   */
  touchLinks(ent: ServerEdict): void {
    const tree = this.tree;
    const entity = ent.entity!;
    const gameAPI = SV.server.gameAPI as typeof SV.server.gameAPI & { time: number };

    console.assert(tree !== null, 'ServerArea tree must be initialized before touchLinks');

    const activeTree = tree!;

    const absmin = entity.absmin;
    const absmax = entity.absmax;

    for (const touch of activeTree.queryAABB(absmin, absmax)) {
      if (touch === ent) {
        continue;
      }

      const touchEntity = touch.entity!;
      if (!touchEntity.touch || touchEntity.solid !== Defs.solid.SOLID_TRIGGER) {
        continue;
      }

      const touchFn = touchEntity.touch as (this: BaseEntity, other: BaseEntity | null) => void;

      gameAPI.time = SV.server.time;
      touchFn.call(touchEntity, !ent.isFree() ? ent.entity : null);
    }
  }

  /**
   * Populates the leaf list for an entity by traversing the BSP tree.
   * @param ent Subject edict.
   * @param node Current BSP node.
   */
  findTouchedLeafs(ent: ServerEdict, node: Node): void {
    if (node.contents === Defs.content.CONTENT_SOLID) {
      return;
    }

    if (node.contents < 0) {
      if (ent.leafnums.length === 16) {
        return;
      }

      ent.leafnums[ent.leafnums.length] = node.num;
      return;
    }

    console.assert(ent.entity !== null);
    const entity = ent.entity! as BaseEntity;

    const sides = Vector.boxOnPlaneSide(entity.absmin, entity.absmax, node.plane!);

    if ((sides & 1) !== 0) {
      this.findTouchedLeafs(ent, node.children[0] as Node);
    }

    if ((sides & 2) !== 0) {
      this.findTouchedLeafs(ent, node.children[1] as Node);
    }
  }

  /**
   * Inserts an edict into the area lists and optionally processes trigger touches.
   * NOTE: absmin/absmax will be reset.
   * @param ent Edict to link.
   * @param touchTriggers Whether triggers should be evaluated.
   */
  linkEdict(ent: ServerEdict, touchTriggers = false): void {
    if (ent.equals(SV.server.edicts[0]) || ent.isFree()) {
      return;
    }

    console.assert(ent.entity !== null);
    const entity = ent.entity! as BaseEntity;

    SV.server.navigation.relinkEdict(ent);
    this.unlinkEdict(ent);

    const absmin = new Vector();
    const absmax = new Vector();

    this._computeEntityBounds(ent, absmin, absmax);

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK)) {
      absmin.add(new Vector(-1.0, -1.0, -1.0));
      absmax.add(new Vector(1.0, 1.0, 1.0));

      if ((entity.flags & Defs.flags.FL_ITEM) !== 0) { // TODO: should be a feature flag for the game
        absmin.add(new Vector(-14.0, -14.0, 1.0));
        absmax.add(new Vector(14.0, 14.0, -1.0));
      }
    }

    entity.absmin = entity.absmin.set(absmin);
    entity.absmax = entity.absmax.set(absmax);

    ent.leafnums = [];
    if (entity.modelindex !== 0) {
      this.findTouchedLeafs(ent, SV.server.worldmodel.nodes[0]);
    }

    if (entity.solid === Defs.solid.SOLID_NOT) {
      return;
    }

    const tree = this.tree;

    console.assert(tree !== null, 'ServerArea tree must be initialized before linkEdict');

    const activeTree = tree!;

    const node = activeTree.insert(ent);
    ent.octreeNode = node;

    if (entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP && touchTriggers) {
      this.touchLinks(ent);
    }
  }
}
