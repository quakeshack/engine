import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { Octree } from '../../../shared/Octree.ts';
import { eventBus, registry } from '../../registry.mjs';
import CollisionModelSource, { createRegistryCollisionModelSource } from '../../common/CollisionModelSource.ts';
import { BrushModel } from '../../../engine/common/Mod.ts';

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

/**
 * Manages spatial partitioning and entity linking for efficient collision detection.
 * Handles the area node BSP tree used for spatial queries.
 */
export class ServerArea {
  /** @type {?Octree<import('../Edict.mjs').ServerEdict>} */
  tree = null;

  /**
   * @param {CollisionModelSource} [modelSource] runtime model resolver
   */
  constructor(modelSource = createRegistryCollisionModelSource()) {
    this._modelSource = modelSource;
  }

  /**
   * Resolve a collision model by model index from either the active server or
   * the client precache populated during signon.
   * @param {number} modelIndex precached model index
   * @returns {BrushModel|object|null} resolved model, if any
   */
  _getModelByIndex(modelIndex) {
    return this._modelSource.getModelByIndex(modelIndex);
  }

  /**
   * Compute entity world bounds, expanding rotated BSP bounds into a world AABB.
   * @param {import('../Edict.mjs').ServerEdict} ent entity being linked
   * @param {Vector} absmin output minimum bounds
   * @param {Vector} absmax output maximum bounds
   */
  _computeEntityBounds(ent, absmin, absmax) {
    const origin = ent.entity.origin;
    const mins = ent.entity.mins;
    const maxs = ent.entity.maxs;
    const model = this._getModelByIndex(ent.entity.modelindex);

    if (ent.entity.solid === Defs.solid.SOLID_BSP
      && model instanceof BrushModel
      && !ent.entity.angles.isOrigin()) {
      const basis = ent.entity.angles.toRotationMatrix();
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
  initBoxHull() {
    this.box_clipnodes = [];
    this.box_planes = [];
    this.box_hull = {
      clipnodes: this.box_clipnodes,
      planes: this.box_planes,
      firstclipnode: 0,
      lastclipnode: 5,
    };

    for (let i = 0; i <= 5; i++) {
      const node = {};
      this.box_clipnodes[i] = node;
      node.planenum = i;
      node.children = [];
      node.children[i & 1] = Defs.content.CONTENT_EMPTY;
      if (i !== 5) {
        node.children[1 - (i & 1)] = i + 1;
      } else {
        node.children[1 - (i & 1)] = Defs.content.CONTENT_SOLID;
      }

      const plane = {};
      this.box_planes[i] = plane;
      plane.type = i >> 1;
      plane.normal = new Vector();
      plane.normal[i >> 1] = 1.0;
      plane.dist = 0.0;
    }
  }

  /**
   * Resolves the hull that should be used when clipping against a given entity.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to create a hull for
   * @param {Vector} mins minimum extents of the moving object
   * @param {Vector} maxs maximum extents of the moving object
   * @param {Vector} out_offset receives the hull offset relative to entity origin
   * @returns {*} the hull structure used for collision tests
   */
  hullForEntity(ent, mins, maxs, out_offset) {
    const model = this._getModelByIndex(ent.entity.modelindex);
    const origin = ent.entity.origin;

    if (ent.entity.solid !== Defs.solid.SOLID_BSP || !(model instanceof BrushModel)) { // CR: don’t ask
      const emaxs = ent.entity.maxs;
      const emins = ent.entity.mins;
      // FIXME: create a new hull for this instead of mutating the box hull planes (which could cause issues if multiple entities use it at the same time)
      this.box_planes[0].dist = emaxs[0] - mins[0];
      this.box_planes[1].dist = emins[0] - maxs[0];
      this.box_planes[2].dist = emaxs[1] - mins[1];
      this.box_planes[3].dist = emins[1] - maxs[1];
      this.box_planes[4].dist = emaxs[2] - mins[2];
      this.box_planes[5].dist = emins[2] - maxs[2];
      out_offset.set(origin);
      return this.box_hull;
    }

    console.assert(ent.entity.movetype !== Defs.moveType.MOVETYPE_NONE,
      'requires SOLID_BSP with MOVETYPE_NONE, use MOVETYPE_PUSH instead');

    const size = maxs[0] - mins[0];
    let hull;
    if (size < 3.0) {
      hull = model.hulls[0];
    } else if (size <= 32.0) {
      hull = model.hulls[1];
    } else {
      hull = model.hulls[2];
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
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   */
  initOctree(mins, maxs) {
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

    this.tree = /** @type {Octree<import('../Edict.mjs').ServerEdict>} */ (new Octree(center, halfSize, 16, 64));
  }

  /**
   * Removes an edict from any area lists it is currently linked to.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to unlink
   */
  unlinkEdict(ent) {
    if (ent.octreeNode) {
      ent.octreeNode.remove(ent);
      ent.octreeNode = null;
    }
  }

  /**
   * Iterates all trigger edicts that potentially overlap the provided entity.
   * @param {import('../Edict.mjs').ServerEdict} ent subject edict
   */
  touchLinks(ent) {
    const absmin = ent.entity.absmin;
    const absmax = ent.entity.absmax;

    for (const touch of this.tree.queryAABB(absmin, absmax)) {
      if (touch === ent) {
        continue;
      }

      if (!touch.entity.touch || touch.entity.solid !== Defs.solid.SOLID_TRIGGER) {
        continue;
      }

      SV.server.gameAPI.time = SV.server.time;
      touch.entity.touch(!ent.isFree() ? ent.entity : null);
    }
  }

  /**
   * Populates the leaf list for an entity by traversing the BSP tree.
   * @param {import('../Edict.mjs').ServerEdict} ent subject edict
   * @param {*} node current BSP node
   */
  findTouchedLeafs(ent, node) {
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

    const entity = /** @type {import('../Edict.mjs').BaseEntity} */ (ent.entity);
    console.assert(entity !== null);

    const sides = Vector.boxOnPlaneSide(entity.absmin, entity.absmax, node.plane);

    if ((sides & 1) !== 0) {
      this.findTouchedLeafs(ent, node.children[0]);
    }

    if ((sides & 2) !== 0) {
      this.findTouchedLeafs(ent, node.children[1]);
    }
  }

  /**
   * Inserts an edict into the area lists and optionally processes trigger touches.
   * NOTE: absmin/absmax will be reset.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to link
   * @param {boolean} touchTriggers whether triggers should be evaluated
   */
  linkEdict(ent, touchTriggers = false) {
    if (ent.equals(SV.server.edicts[0]) || ent.isFree()) {
      return;
    }

    const entity = /** @type {import('../Edict.mjs').BaseEntity} */ (ent.entity);
    console.assert(entity !== null);

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

    const node = this.tree.insert(ent);
    ent.octreeNode = node;

    if (entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP && touchTriggers) {
      this.touchLinks(ent);
    }
  }
}
