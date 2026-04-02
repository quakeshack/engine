/*
 * Pmove: shared player movement code, designed to run identically on both
 * client (for prediction) and server (for authoritative simulation).
 *
 * Inspired by Quake 2’s pmove.c with structural elements from QuakeWorld.
 *
 * Original sources: pmove.c, pmovetst.c (Q2), pmove.c (Q1).
 */

import Vector from '../../shared/Vector.ts';
import * as Protocol from '../network/Protocol.mjs';
import { content } from '../../shared/Defs.ts';
import { BrushModel } from './Mod.mjs';
import Cvar from './Cvar.mjs';
import { PmoveConfiguration } from '../../shared/Pmove.mjs';

/** @typedef {import('../../shared/Vector.ts').DirectionalVectors} DirectionalVectors */
/** @typedef {{ normal: Vector, type: number }} BrushTracePlaneLike */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIST_EPSILON = 0.03125;
export const STOP_EPSILON = 0.1;
export const STEPSIZE = 18.0;

/** Minimum ground normal Z component - slopes steeper than ~45° are not walkable */
export const MIN_STEP_NORMAL = 0.7;

/** Maximum number of planes to clip against during slide moves */
export const MAX_CLIP_PLANES = 5;

/** Near-parallel planes from zero-progress brush re-clips are treated as duplicates */
export const ZERO_PROGRESS_DUPLICATE_DOT = 0.985;

/**
 * Player movement flags (pmove-specific, separate from entity flags).
 * These travel with the player state and are used for prediction.
 * @readonly
 * @enum {number}
 */
export const PMF = Object.freeze({
  /** Player is ducked */
  DUCKED: (1 << 0),
  /** Player has jump button held (prevent re-jump) */
  JUMP_HELD: (1 << 1),
  /** Player is on the ground */
  ON_GROUND: (1 << 2),
  /** Timing: landing cooldown (prevents immediate re-jump after hard landing) */
  TIME_LAND: (1 << 3),
  /** Timing: water jump is active */
  TIME_WATERJUMP: (1 << 4),
  /** Timing: teleport freeze */
  TIME_TELEPORT: (1 << 5),
});

/**
 * Player movement types.
 * @readonly
 * @enum {number}
 */
export const PM_TYPE = Object.freeze({
  /** Normal movement */
  NORMAL: 0,
  /** Spectator - noclip flight */
  SPECTATOR: 1,
  /** Dead – reduced input, extra friction */
  DEAD: 2,
  /** Frozen – no movement at all */
  FREEZE: 3,
});

// ---------------------------------------------------------------------------
// MoveVars: shared physics tuning knobs
// ---------------------------------------------------------------------------

/**
 * Pmove variable defaults.
 *
 * Physics tuning knobs shared between client and server.
 */
export class MoveVars { // movevars_t
  constructor() {
    /** @type {number} world gravity (units/sec²) */
    this.gravity = 800;
    /** @type {number} speed below which friction acts at full strength */
    this.stopspeed = 100;
    /** @type {number} maximum walking speed */
    this.maxspeed = 320; // Q2: 300
    /** @type {number} maximum spectator speed */
    this.spectatormaxspeed = 500;
    /** @type {number} duck speed cap */
    this.duckspeed = 100;
    /** @type {number} ground acceleration factor */
    this.accelerate = 10;
    /** @type {number} air acceleration factor */
    this.airaccelerate = 0.7;
    /** @type {number} water acceleration factor */
    this.wateraccelerate = 10;
    /** @type {number} ground friction factor */
    this.friction = 6;
    /** @type {number} water friction factor */
    this.waterfriction = 1;
    /** @type {number} maximum water speed */
    this.waterspeed = 400;
    /** @type {number} per-entity gravity multiplier (1.0 = normal) */
    this.entgravity = 1.0;
    /** @type {number} edge friction multiplier */
    this.edgefriction = 2;
  }
};

// ---------------------------------------------------------------------------
// Geometry primitives: Plane, Trace, ClipNode, Hull, BoxHull
// ---------------------------------------------------------------------------

export class Plane { // mplane_t
  constructor() {
    this.normal = new Vector();
    this.dist = 0;
    /** @type {number} for texture axis selection and fast side tests */
    this.type = 0;
    /** @type {number} signx + signy<<1 + signz<<1 */
    this.signBits = 0;
  }
};

export class Trace { // pmtrace_t
  constructor() {
    /** if true, plane is not valid */
    this.allsolid = true;
    /** if true, the initial point was in a solid area */
    this.startsolid = false;
    /** moving along the vector completed, 1.0 = didn’t hit anything */
    this.fraction = 1.0;
    /** final position */
    this.endpos = new Vector();
    /** surface normal at impact */
    this.plane = new Plane();
    /** @type {?number} edict number the surface is on, if applicable */
    this.ent = null;
    /** true if the surface is in a open area */
    this.inopen = false;
    /** true if the surface is in water */
    this.inwater = false;
  }

  /**
   * Sets this trace to the other trace.
   * @param {Trace} other other trace
   * @returns {Trace} this
   */
  set(other) {
    console.assert(other instanceof Trace, 'other must be a Trace');

    this.allsolid = other.allsolid;
    this.startsolid = other.startsolid;
    this.fraction = other.fraction;
    this.endpos.set(other.endpos);
    this.plane.normal.set(other.plane.normal);
    this.plane.dist = other.plane.dist;
    this.ent = other.ent;
    this.inopen = other.inopen;
    this.inwater = other.inwater;

    return this;
  }

  /**
   * Creates a copy.
   * @returns {Trace} copy of this trace
   */
  copy() {
    const trace = new Trace();
    trace.set(this);
    return trace;
  }
};

export class ClipNode { // dclipnode_t
  constructor(planeNum = 0) {
    this.planeNum = planeNum;
    this.children = [0, 0];
  }
};

export class Hull { // hull_t
  constructor() {
    this.clipMins = new Vector();
    this.clipMaxs = new Vector();
    this.firstClipNode = 0;
    this.lastClipNode = 0;
    /** @type {Uint8Array|null} */
    this.allowedClipNodes = null;
    /** @type {ClipNode[]} */
    this.clipNodes = [];
    /** @type {Plane[]} */
    this.planes = [];
  }

  static fromModelHull(hull) {
    const newHull = new Hull();
    newHull.clipMins = hull.clip_mins.copy();
    newHull.clipMaxs = hull.clip_maxs.copy();
    newHull.firstClipNode = hull.firstclipnode;
    newHull.lastClipNode = hull.lastclipnode;
    newHull.allowedClipNodes = hull.allowedClipNodes ?? null;
    newHull.clipNodes = hull.clipnodes.map((clipnode) => {
      const node = new ClipNode(clipnode.planenum);
      node.children[0] = clipnode.children[0];
      node.children[1] = clipnode.children[1];
      return node;
    });
    newHull.planes = hull.planes.map((plane) => {
      const newPlane = new Plane();
      newPlane.normal = plane.normal.copy();
      newPlane.dist = plane.dist;
      newPlane.type = plane.type;
      newPlane.signBits = plane.signbits;
      return newPlane;
    });

    return newHull;
  }

  /**
   * Determine if a point is inside the hull and if so, return the content type.
   * @param {Vector} point point to test
   * @param {number} num clip node to start
   * @returns {number} content type
   */
  pointContents(point, num = this.firstClipNode) {
    // as long as num is a valid node, keep going down the tree
    while (num >= 0) {
      if (this.allowedClipNodes !== null && this.allowedClipNodes[num] !== 1) {
        return content.CONTENT_EMPTY;
      }

      console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid hull node', num);

      console.assert(!!this.clipNodes[num], 'valid hull node', num);
      const node = this.clipNodes[num];

      console.assert(!!this.planes[node.planeNum], 'valid hull plane', node.planeNum);
      const plane = this.planes[node.planeNum];

      let d = 0;

      if (plane.type < 3) {
        d = point[plane.type] - plane.dist;
      } else {
        d = plane.normal.dot(point) - plane.dist;
      }

      // Q1: d < 0 → children[1], else children[0].
      // Must match hull.check’s `t1 >= 0 && t2 >= 0 → children[0]`
      // so that pointContents and check agree on boundary classification.
      num = node.children[d < 0 ? 1 : 0];
    }

    return num;
  }

  /** @type {Vector[]} */
  static _midPool = Array.from({ length: 64 }, () => new Vector());

  /**
   * Check against hull.
   * @param {number} p1f fraction at p1 (usually 0.0)
   * @param {number} p2f fraction at p2 (usually 1.0)
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {Trace} trace object to store trace results
   * @param {number} num starting clipnode number (typically hull.firstclipnode)
   * @param {number} depth recursion depth
   * @returns {boolean} true means going down, false means going up
   */
  check(p1f, p2f, p1, p2, trace, num = this.firstClipNode, depth = 0) {
    // check for empty
    if (num < 0) {
      if (num !== content.CONTENT_SOLID && num !== content.CONTENT_SKY) {
        trace.allsolid = false;
        if (num === content.CONTENT_EMPTY) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true; // going down the tree
    }

    if (this.allowedClipNodes !== null && this.allowedClipNodes[num] !== 1) {
      trace.allsolid = false;
      trace.inopen = true;
      return true;
    }

    console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid node number', num);

    // find the point distances
    const node = this.clipNodes[num];
    const plane = this.planes[node.planeNum];
    const t1 = (plane.type < 3 ? p1[plane.type] : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
    const t2 = (plane.type < 3 ? p2[plane.type] : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

    // checking children on side 1
    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[0], depth + 1);
    }

    // checking children on side 2
    if (t1 < 0.0 && t2 < 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[1], depth + 1);
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2))); // epsilon value of 0.03125 = 1/32
    let midf = p1f + (p2f - p1f) * frac;
    if (depth >= Hull._midPool.length) {
      Hull._midPool.push(new Vector());
    }
    const mid = Hull._midPool[depth];
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    const side = t1 < 0.0 ? 1 : 0;

    // move up to the node
    if (!this.check(p1f, midf, p1, mid, trace, node.children[side], depth + 1)) {
      return false;
    }

    // go past the node
    const pointContents = this.pointContents(mid, node.children[1 - side]);
    if (pointContents !== content.CONTENT_SOLID && pointContents !== content.CONTENT_SKY) {
      return this.check(midf, p2f, mid, p2, trace, node.children[1 - side], depth + 1);
    }

    // never got out of the solid area
    if (trace.allsolid) {
      return false;
    }

    // the other side of the node is solid, this is the impact point
    if (side === 0) {
      trace.plane.normal.set(plane.normal);
      trace.plane.dist = plane.dist;
    } else {
      trace.plane.normal.set(plane.normal).multiply(-1);
      trace.plane.dist = -plane.dist;
    }

    while ([content.CONTENT_SOLID, content.CONTENT_SKY].includes(this.pointContents(mid))) {
      // shouldn’t really happen, but does occasionally
      frac -= 0.1;
      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos.set(mid);
        console.warn('fraction < 0.0', frac, trace);
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid[0] = p1[0] + frac * (p2[0] - p1[0]);
      mid[1] = p1[1] + frac * (p2[1] - p1[1]);
      mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    }

    trace.fraction = midf;
    trace.endpos.set(mid);

    return false;
  }
};

// ---------------------------------------------------------------------------
// BoxHull: AABB → BSP conversion for non-BSP entity collision
// ---------------------------------------------------------------------------

/**
 * Set up the planes and clipnodes so that the six floats of a bounding box
 * can just be stored out and get a proper hull_t structure.
 * To keep everything totally uniform, bounding boxes are turned into small
 * BSP trees instead of being compared directly.
 * Use setSize() to set the box size.
 */
export class BoxHull extends Hull {
  constructor() {
    super();

    this.clipNodes = [
      new ClipNode(0),
      new ClipNode(1),
      new ClipNode(2),
      new ClipNode(3),
      new ClipNode(4),
      new ClipNode(5),
    ];

    this.firstClipNode = 0;
    this.lastClipNode = 5;

    this.planes = [
      new Plane(), // 0
      new Plane(), // 1
      new Plane(), // 2
      new Plane(), // 3
      new Plane(), // 4
      new Plane(), // 5
    ];

    for (let i = 0; i < 6; i++) {
      const side = i & 1;

      this.clipNodes[i].children[side] = content.CONTENT_EMPTY;
      this.clipNodes[i].children[side ^ 1] = i !== 5 ? i + 1 : content.CONTENT_SOLID;

      this.planes[i].type = i >> 1;
      // Axis-aligned unit normal, matches Q1: box_planes[i].normal[i>>1] = 1
      const normal = new Vector(0, 0, 0);
      normal[i >> 1] = 1;
      this.planes[i].normal = normal;
    }
  }

  /**
   * @param {Vector} mins mins
   * @param {Vector} maxs maxs
   * @returns {BoxHull} this
   */
  setSize(mins, maxs) {
    console.assert(mins instanceof Vector, 'mins must be a Vector');
    console.assert(maxs instanceof Vector, 'maxs must be a Vector');

    // Even planes (0,2,4) use maxs; odd planes (1,3,5) use mins.
    // Matches Q1’s SV_HullForBox.
    for (let i = 0; i < 6; i++) {
      this.planes[i].dist = (i & 1) ? mins[i >> 1] : maxs[i >> 1];
    }

    return this;
  }
};

// ---------------------------------------------------------------------------
// BrushTrace: Q2-style brush-based collision tracing
//
// Used when the BSP has brush/brushside/leafbrush data (Q2 maps, or Q1 maps
// with BSPX BRUSHLIST extension). This replaces Q1’s hull-based traces and
// gives exact collision against the actual brush geometry rather than
// pre-expanded clipnode trees.
//
// Architecture: traverse the BSP node tree (with extents offset for the
// player box). At each leaf, test every brush in that leaf via
// clipBoxToBrush. This is the standard Quake 2 approach from cmodel.c.
// ---------------------------------------------------------------------------

/**
 * Q2-style brush-based collision tracing.
 *
 * Provides exact collision against brush geometry, replacing the Q1 hull-based
 * traces for maps that include brush data.
 */
export class BrushTrace {
  /** @type {number} monotonically increasing counter to avoid testing the same brush twice */
  static _checkCount = 0;

  /**
   * Test whether two axis-aligned bounding boxes overlap.
   * @param {Vector} mins1 first box minimum
   * @param {Vector} maxs1 first box maximum
   * @param {Vector} mins2 second box minimum
   * @param {Vector} maxs2 second box maximum
   * @returns {boolean} true when the boxes overlap or touch
   */
  static _boundsOverlap(mins1, maxs1, mins2, maxs2) {
    return mins1[0] <= maxs2[0] && mins1[1] <= maxs2[1] && mins1[2] <= maxs2[2]
      && maxs1[0] >= mins2[0] && maxs1[1] >= mins2[1] && maxs1[2] >= mins2[2];
  }

  /**
   * Compute the swept world-space bounds of a point or box move.
   * @param {Vector} start trace start
   * @param {Vector} end trace end
   * @param {Vector} mins box mins
   * @param {Vector} maxs box maxs
   * @returns {{mins: Vector, maxs: Vector}} swept bounds
   */
  static _computeSweepBounds(start, end, mins, maxs) {
    return {
      mins: new Vector(
        Math.min(start[0] + mins[0], end[0] + mins[0]),
        Math.min(start[1] + mins[1], end[1] + mins[1]),
        Math.min(start[2] + mins[2], end[2] + mins[2]),
      ),
      maxs: new Vector(
        Math.max(start[0] + maxs[0], end[0] + maxs[0]),
        Math.max(start[1] + maxs[1], end[1] + maxs[1]),
        Math.max(start[2] + maxs[2], end[2] + maxs[2]),
      ),
    };
  }

  /**
   * Compute the world-space bounds of a point or box at a fixed position.
   * @param {Vector} position position to test
   * @param {Vector} mins box mins
   * @param {Vector} maxs box maxs
   * @returns {{mins: Vector, maxs: Vector}} world-space bounds
   */
  static _computePositionBounds(position, mins, maxs) {
    return {
      mins: new Vector(position[0] + mins[0], position[1] + mins[1], position[2] + mins[2]),
      maxs: new Vector(position[0] + maxs[0], position[1] + maxs[1], position[2] + maxs[2]),
    };
  }

  /**
   * Check whether a brush AABB can possibly overlap the current swept move.
   * @param {BrushTraceContext} ctx trace context
   * @param {import('./model/BSP.mjs').Brush} brush brush candidate
   * @returns {boolean} true when the brush could affect the move
   */
  static _brushMayAffectTrace(ctx, brush) {
    if (brush.mins === null || brush.mins === undefined || brush.maxs === null || brush.maxs === undefined) {
      return true;
    }

    return BrushTrace._boundsOverlap(ctx.sweepMins, ctx.sweepMaxs, brush.mins, brush.maxs);
  }

  /**
   * Check whether a brush AABB can possibly overlap the current position test.
   * @param {import('./model/BSP.mjs').Brush} brush brush candidate
   * @param {Vector} boundsMins position-test bounds minimum
   * @param {Vector} boundsMaxs position-test bounds maximum
   * @returns {boolean} true when the brush could affect the test
   */
  static _brushMayAffectPosition(brush, boundsMins, boundsMaxs) {
    if (brush.mins === null || brush.mins === undefined || brush.maxs === null || brush.maxs === undefined) {
      return true;
    }

    return BrushTrace._boundsOverlap(boundsMins, boundsMaxs, brush.mins, brush.maxs);
  }

  /**
   * Estimate the earliest global trace fraction where a swept point/box can
   * enter a node's bounds. Used only for pruning; false negatives are avoided
   * by falling back when bounds are missing.
   * @param {BrushTraceContext} ctx trace context
   * @param {import('./model/BSP.mjs').Node} node BSP node or leaf
   * @returns {number} earliest possible entry fraction, or Infinity when unreachable
   */
  static _estimateNodeEntryFraction(ctx, node) {
    if (node.mins === null || node.mins === undefined || node.maxs === null || node.maxs === undefined) {
      return 0;
    }

    let enter = 0;
    let leave = 1;

    for (let axis = 0; axis < 3; axis++) {
      const expandedMin = node.mins[axis] - ctx.extents[axis];
      const expandedMax = node.maxs[axis] + ctx.extents[axis];
      const start = ctx.start[axis];
      const delta = ctx.totalMove[axis];

      if (Math.abs(delta) <= Number.EPSILON) {
        if (start < expandedMin || start > expandedMax) {
          return Infinity;
        }
        continue;
      }

      let axisEnter = (expandedMin - start) / delta;
      let axisLeave = (expandedMax - start) / delta;

      if (axisEnter > axisLeave) {
        const temp = axisEnter;
        axisEnter = axisLeave;
        axisLeave = temp;
      }

      enter = Math.max(enter, axisEnter);
      leave = Math.min(leave, axisLeave);

      if (enter > leave) {
        return Infinity;
      }
    }

    return Math.max(0, enter);
  }

  /**
   * Check whether a node can still affect the current trace.
   * @param {BrushTraceContext} ctx trace context
   * @param {import('./model/BSP.mjs').Node} node BSP node or leaf
   * @returns {boolean} true when traversal should continue into the node
   */
  static _nodeMayAffectTrace(ctx, node) {
    if (node.mins === null || node.mins === undefined || node.maxs === null || node.maxs === undefined) {
      return true;
    }

    if (!BrushTrace._boundsOverlap(ctx.sweepMins, ctx.sweepMaxs, node.mins, node.maxs)) {
      return false;
    }

    return BrushTrace._estimateNodeEntryFraction(ctx, node) <= ctx.trace.fraction;
  }

  /**
   * Nearly simultaneous non-axial planes should win over axial bevels.
   * Walkable ramps need this to avoid horizontal climb stalls, and corner
   * slides need it so a real diagonal face can beat an inferred axial wall
   * from the same brush when both land within epsilon.
   * @param {BrushTracePlaneLike|null} currentPlane currently selected clip plane
   * @param {number} currentFraction currently selected enter fraction
   * @param {BrushTracePlaneLike} candidatePlane newly intersected plane
   * @param {number} candidateFraction newly intersected enter fraction
   * @param {number} fractionEpsilon move-distance-scaled tie threshold
   * @returns {boolean} true when the candidate plane should replace the current one
   */
  static _shouldPreferClipPlane(currentPlane, currentFraction, candidatePlane, candidateFraction, fractionEpsilon) {
    if (currentPlane === null) {
      return true;
    }

    if (candidateFraction > currentFraction + fractionEpsilon) {
      return true;
    }

    if (Math.abs(candidateFraction - currentFraction) > fractionEpsilon) {
      return false;
    }

    const candidateIsNonAxial = candidatePlane.type >= 3;
    const currentIsAxialWall = currentPlane.type < 3 && Math.abs(currentPlane.normal[2]) <= DIST_EPSILON;

    return candidateIsNonAxial && currentIsAxialWall;
  }

  /**
   * Earlier trace hits win globally, but nearly simultaneous hits can still
   * benefit from plane preference. This lets a real non-axial face replace an
   * exact-tangent axial wall from another brush in the same leaf.
   * @param {BrushTracePlaneLike|null} currentPlane currently selected trace plane
   * @param {number} currentFraction currently selected trace fraction
   * @param {BrushTracePlaneLike} candidatePlane newly intersected trace plane
   * @param {number} candidateFraction newly intersected trace fraction
   * @param {number} fractionEpsilon move-distance-scaled tie threshold
   * @returns {boolean} true when the candidate trace hit should replace the current hit
   */
  static _shouldPreferTraceHit(currentPlane, currentFraction, candidatePlane, candidateFraction, fractionEpsilon) {
    if (currentPlane === null) {
      return true;
    }

    if (candidateFraction < currentFraction - fractionEpsilon) {
      return true;
    }

    if (candidateFraction > currentFraction + fractionEpsilon) {
      return false;
    }

    const candidateIsNonAxial = candidatePlane.type >= 3;
    const currentIsAxialWall = currentPlane.type < 3 && Math.abs(currentPlane.normal[2]) <= DIST_EPSILON;
    const candidateIsWalkableSlope = candidateIsNonAxial && candidatePlane.normal[2] >= MIN_STEP_NORMAL;

    return candidateIsWalkableSlope || (candidateIsNonAxial && currentIsAxialWall);
  }

  /**
   * Resolve the head node for world-model BSP traversal.
   * @param {BrushModel} model - brush model to inspect
   * @returns {number} clipnode index used as the trace root
   */
  static _getHeadNode(model) {
    return model.hulls[0]?.firstclipnode ?? 0;
  }

  /**
   * Dispatch a brush trace against either a submodel brush range or a world BSP.
   * @param {BrushModel} model - world model or submodel owning the brush data
   * @param {Vector} start - local-space trace start
   * @param {Vector} end - local-space trace end
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @returns {Trace} trace result
   */
  static _traceModel(model, start, end, mins, maxs) {
    return model.submodel
      ? BrushTrace.boxTraceModel(model, start, end, mins, maxs)
      : BrushTrace.boxTrace(model, BrushTrace._getHeadNode(model), start, end, mins, maxs);
  }

  /**
   * Dispatch a position test against either a submodel brush range or a world BSP.
   * @param {BrushModel} model - world model or submodel owning the brush data
   * @param {Vector} position - local-space position to test
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @returns {boolean} true if position is valid (not in solid)
   */
  static _testModelPosition(model, position, mins, maxs) {
    return model.submodel
      ? BrushTrace.testPositionModel(model, position, mins, maxs)
      : BrushTrace.testPosition(model, BrushTrace._getHeadNode(model), position, mins, maxs);
  }

  /**
   * Resolve the entity transform used by shared brush collision helpers.
   * @param {Vector} origin - entity origin
   * @param {Vector} angles - entity angles
   * @returns {{origin: Vector, basis: number[]|null}|null} transform context, or null when identity
   */
  static _getTransformContext(origin, angles) {
    const basis = angles.isOrigin() ? null : angles.toRotationMatrix();

    if (basis === null && origin.isOrigin()) {
      return null;
    }

    return { origin, basis };
  }

  /**
   * Convert a world-space point into local model space for an entity transform.
   * @param {Vector} point - world-space point
   * @param {{origin: Vector, basis: number[]|null}|null} transform - entity transform context
   * @returns {Vector} transformed local-space point
   */
  static _toLocalPoint(point, transform) {
    if (transform === null) {
      return point;
    }

    if (transform.basis !== null) {
      return BrushTrace._transformPointToLocal(point, transform.origin, transform.basis);
    }

    return point.copy().subtract(transform.origin);
  }

  /**
   * Trace a box against a brush model with entity transform applied.
   * Equivalent to Quake 2's transformed box trace helpers.
   * @param {BrushModel} model - world model or submodel owning the brush data
   * @param {Vector} start - world-space trace start
   * @param {Vector} end - world-space trace end
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @param {Vector} origin - entity origin
   * @param {Vector} angles - entity angles
   * @returns {Trace} world-space trace result
   */
  static transformedBoxTrace(model, start, end, mins, maxs, origin = Vector.origin, angles = Vector.origin) {
    const transform = BrushTrace._getTransformContext(origin, angles);

    if (transform === null) {
      return BrushTrace._traceModel(model, start, end, mins, maxs);
    }

    const localStart = BrushTrace._toLocalPoint(start, transform);
    const localEnd = BrushTrace._toLocalPoint(end, transform);
    const localTrace = BrushTrace._traceModel(model, localStart, localEnd, mins, maxs);

    return BrushTrace._transformTraceToWorld(localTrace, transform);
  }

  /**
   * Test if a box at the given world-space position overlaps a brush model
   * after applying entity translation and rotation.
   * Equivalent to Quake 2's transformed position test helpers.
   * @param {BrushModel} model - world model or submodel owning the brush data
   * @param {Vector} position - world-space position to test
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @param {Vector} origin - entity origin
   * @param {Vector} angles - entity angles
   * @returns {boolean} true if position is valid (not in solid)
   */
  static transformedTestPosition(model, position, mins, maxs, origin = Vector.origin, angles = Vector.origin) {
    const transform = BrushTrace._getTransformContext(origin, angles);

    if (transform === null) {
      return BrushTrace._testModelPosition(model, position, mins, maxs);
    }

    const localPosition = BrushTrace._toLocalPoint(position, transform);

    return BrushTrace._testModelPosition(model, localPosition, mins, maxs);
  }

  /**
   * Trace a box from start to end through the BSP tree, testing individual brushes.
   * Equivalent to Q2’s CM_BoxTrace.
   * @param {BrushModel} worldModel - world model owning the BSP data
   * @param {number} headNode - BSP node index to start traversal from
   * @param {Vector} start - start position
   * @param {Vector} end - end position
   * @param {Vector} mins - box mins (typically PLAYER_MINS)
   * @param {Vector} maxs - box maxs (typically PLAYER_MAXS)
   * @returns {Trace} trace result
   */
  static boxTrace(worldModel, headNode, start, end, mins, maxs) {
    const trace = new Trace();

    // Brush traces must derive allsolid from brush overlap, not from the
    // legacy BSP leaf contents encountered during traversal. A tangent
    // fraction-0 clip can happen in a solid-side leaf without the player box
    // being embedded in brush geometry.
    trace.allsolid = false;

    console.assert(!Number.isNaN(start[0]) && !Number.isNaN(start[1]) && !Number.isNaN(start[2]), 'NaN start');
    console.assert(!Number.isNaN(end[0]) && !Number.isNaN(end[1]) && !Number.isNaN(end[2]), 'NaN end');

    if (!worldModel.nodes || worldModel.nodes.length === 0) {
      trace.allsolid = false;
      trace.endpos.set(end);
      return trace;
    }

    const isPoint = (mins[0] === 0 && mins[1] === 0 && mins[2] === 0
                  && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0);
    const extents = isPoint ? new Vector() : new Vector(
      -mins[0] > maxs[0] ? -mins[0] : maxs[0],
      -mins[1] > maxs[1] ? -mins[1] : maxs[1],
      -mins[2] > maxs[2] ? -mins[2] : maxs[2],
    );

    const checkCount = ++BrushTrace._checkCount;

    const totalMove = end.copy().subtract(start);
    const sweepBounds = BrushTrace._computeSweepBounds(start, end, mins, maxs);

    /** @type {BrushTraceContext} */
    const ctx = {
      worldModel,
      trace,
      mins,
      maxs,
      isPoint,
      extents,
      start,
      end,
      totalMove,
      sweepMins: sweepBounds.mins,
      sweepMaxs: sweepBounds.maxs,
      checkCount,
    };

    const rootNode = worldModel.nodes[headNode];

    if (!rootNode) {
      trace.allsolid = false;
      trace.endpos.set(end);
      return trace;
    }

    BrushTrace._recursiveHullCheck(ctx, rootNode, 0, 1, start, end);

    if (trace.fraction === 1.0) {
      trace.endpos.set(end);
    } else {
      console.assert(!Number.isNaN(trace.fraction), 'NaN fraction');

      for (let i = 0; i < 3; i++) {
        console.assert(!Number.isNaN(start[i]), 'NaN start');
        console.assert(!Number.isNaN(end[i]), 'NaN end');

        trace.endpos[i] = start[i] + trace.fraction * (end[i] - start[i]);
      }
    }

    return trace;
  }

  /**
   * Test if a player-sized box at the given position overlaps any solid brush.
   * Equivalent to Q2’s CM_BoxTrace position-test special case.
   * @param {BrushModel} worldModel - world model owning the BSP data
   * @param {number} headNode - BSP node index to start traversal from
   * @param {Vector} position - position to test
   * @param {Vector} mins - box mins (typically PLAYER_MINS)
   * @param {Vector} maxs - box maxs (typically PLAYER_MAXS)
   * @returns {boolean} true if position is valid (not stuck in solid)
   */
  static testPosition(worldModel, headNode, position, mins, maxs) {
    if (!worldModel.nodes || worldModel.nodes.length === 0) {
      return true;
    }

    const checkCount = ++BrushTrace._checkCount;

    const isPoint = (mins[0] === 0 && mins[1] === 0 && mins[2] === 0
                  && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0);
    const extents = isPoint ? new Vector() : new Vector(
      -mins[0] > maxs[0] ? -mins[0] : maxs[0],
      -mins[1] > maxs[1] ? -mins[1] : maxs[1],
      -mins[2] > maxs[2] ? -mins[2] : maxs[2],
    );

    const rootNode = worldModel.nodes[headNode];
    if (!rootNode) {
      return true;
    }

    // Walk the BSP tree recursively, expanding by box extents at each
    // splitting plane so we visit ALL leaves the player box overlaps.
    // The old code only walked to a single leaf using the center point,
    // which missed brushes in adjacent leaves that the box extends into.
    const positionBounds = BrushTrace._computePositionBounds(position, mins, maxs);

    return !BrushTrace._testPositionRecursive(
      worldModel, rootNode, position, mins, maxs, positionBounds.mins, positionBounds.maxs, extents, isPoint, checkCount,
    );
  }

  /**
   * Recursively walk the BSP tree for position testing, expanding by box
   * extents to visit all leaves the player box overlaps.
   * @param {BrushModel} worldModel - world model
   * @param {import('./model/BSP.mjs').Node} node - current node
   * @param {Vector} position - test position
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @param {Vector} boundsMins - world-space test bounds minimum
   * @param {Vector} boundsMaxs - world-space test bounds maximum
   * @param {Vector} extents - absolute half-extents
   * @param {boolean} isPoint - true if point trace
   * @param {number} checkCount - dedup counter
   * @returns {boolean} true if solid overlap found
   */
  static _testPositionRecursive(worldModel, node, position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount) {
    if (node.mins !== null && node.mins !== undefined && node.maxs !== null && node.maxs !== undefined
      && !BrushTrace._boundsOverlap(boundsMins, boundsMaxs, node.mins, node.maxs)) {
      return false;
    }

    // Leaf node: test all brushes in this leaf
    if (node.contents < 0) {
      return BrushTrace._testLeafSolid(worldModel, node, position, mins, maxs, boundsMins, boundsMaxs, checkCount);
    }

    // Internal node: test which side(s) of the splitting plane the box is on
    const plane = node.plane;
    let d, offset;

    if (plane.type < 3) {
      d = position[plane.type] - plane.dist;
      offset = extents[plane.type];
    } else {
      d = plane.normal.dot(position) - plane.dist;
      if (isPoint) {
        offset = 0;
      } else {
        offset = Math.abs(extents[0] * plane.normal[0])
               + Math.abs(extents[1] * plane.normal[1])
               + Math.abs(extents[2] * plane.normal[2]);
      }
    }

    // Entirely on front side
    if (d >= offset) {
      return BrushTrace._testPositionRecursive(
        worldModel, node.children[0], position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
      );
    }

    // Entirely on back side
    if (d < -offset) {
      return BrushTrace._testPositionRecursive(
        worldModel, node.children[1], position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
      );
    }

    // Box straddles the plane: test both sides
    if (BrushTrace._testPositionRecursive(
      worldModel, node.children[0], position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
    )) {
      return true;
    }

    return BrushTrace._testPositionRecursive(
      worldModel, node.children[1], position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
    );
  }

  /**
   * Trace a box from start to end against a submodel's brush range (brute-force).
   * Unlike boxTrace which walks the BSP tree, this tests every brush in the
   * submodel's range directly. Used for submodel entities (doors, plats, etc.)
   * whose brushes are NOT inserted into the world BSP leaf-brush index.
   * @param {BrushModel} model - submodel with brush data (shared arrays from world)
   * @param {Vector} start - start position (local to entity)
   * @param {Vector} end - end position (local to entity)
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @returns {Trace} trace result
   */
  static boxTraceModel(model, start, end, mins, maxs) {
    const trace = new Trace();

    // Brute-force path: no BSP tree walk, so no leaf visits to clear allsolid.
    // Default Trace has allsolid=true; we must clear it here so that traces
    // that miss all brushes correctly report "not in solid" instead of falsely
    // blocking all movement. _clipBoxToBrush will set allsolid=true if the
    // trace is genuinely embedded inside a brush.
    trace.allsolid = false;

    if (!model.brushes || model.numBrushes === 0) {
      trace.endpos.set(end);
      return trace;
    }

    const isPoint = (mins[0] === 0 && mins[1] === 0 && mins[2] === 0
                  && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0);
    const extents = isPoint ? new Vector() : new Vector(
      -mins[0] > maxs[0] ? -mins[0] : maxs[0],
      -mins[1] > maxs[1] ? -mins[1] : maxs[1],
      -mins[2] > maxs[2] ? -mins[2] : maxs[2],
    );

    const checkCount = ++BrushTrace._checkCount;

    const totalMove = end.copy().subtract(start);
    const sweepBounds = BrushTrace._computeSweepBounds(start, end, mins, maxs);

    /** @type {BrushTraceContext} */
    const ctx = {
      worldModel: model,
      trace,
      mins,
      maxs,
      isPoint,
      extents,
      start,
      end,
      totalMove,
      sweepMins: sweepBounds.mins,
      sweepMaxs: sweepBounds.maxs,
      checkCount,
    };

    const brushes = model.brushes;
    const lastBrush = model.firstBrush + model.numBrushes;

    for (let i = model.firstBrush; i < lastBrush; i++) {
      const brush = brushes[i];

      if (!brush || brush.numsides === 0) {
        continue;
      }

      // Only collide with solid/clip brushes
      if ((brush.contents !== content.CONTENT_SOLID && brush.contents !== content.CONTENT_SKY)
        && (brush.contents !== content.CONTENT_CLIP || isPoint)) {
        continue;
      }

      if (!BrushTrace._brushMayAffectTrace(ctx, brush)) {
        continue;
      }

      BrushTrace._clipBoxToBrush(ctx, brush);

      if (trace.fraction === 0) {
        break;
      }
    }

    if (trace.fraction === 1.0) {
      trace.endpos.set(end);
    } else {
      console.assert(!Number.isNaN(trace.fraction), 'NaN fraction');

      for (let i = 0; i < 3; i++) {
        console.assert(!Number.isNaN(start[i]), 'NaN start');
        console.assert(!Number.isNaN(end[i]), 'NaN end');
        trace.endpos[i] = start[i] + trace.fraction * (end[i] - start[i]);
      }
    }

    return trace;
  }

  /**
   * Test if a player-sized box at position overlaps any solid brush in
   * a submodel's brush range (brute-force). Used for submodel entities
   * whose brushes are NOT in the BSP leaf-brush index.
   * @param {BrushModel} model - submodel with brush data
   * @param {Vector} position - position to test (local to entity)
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @returns {boolean} true if position is valid (not in solid)
   */
  static testPositionModel(model, position, mins, maxs) {
    if (!model.brushes || model.numBrushes === 0) {
      return true;
    }

    const isPoint = (mins[0] === 0 && mins[1] === 0 && mins[2] === 0
                  && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0);
    const positionBounds = BrushTrace._computePositionBounds(position, mins, maxs);

    const brushes = model.brushes;
    const lastBrush = model.firstBrush + model.numBrushes;

    for (let i = model.firstBrush; i < lastBrush; i++) {
      const brush = brushes[i];

      if (!brush || brush.numsides === 0) {
        continue;
      }

      if (brush.contents !== content.CONTENT_SOLID && brush.contents !== content.CONTENT_SKY
        && (brush.contents !== content.CONTENT_CLIP || isPoint)) {
        continue;
      }

      if (!BrushTrace._brushMayAffectPosition(brush, positionBounds.mins, positionBounds.maxs)) {
        continue;
      }

      if (BrushTrace._testBoxInBrush(model, brush, position, mins, maxs)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Test if a player-sized box overlaps any solid brush in a leaf.
   * @param {BrushModel} worldModel - world model
   * @param {import('./model/BSP.mjs').Node} leaf - leaf node
   * @param {Vector} position - position to test
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @param {Vector} boundsMins - world-space test bounds minimum
   * @param {Vector} boundsMaxs - world-space test bounds maximum
   * @param {number} checkCount - dedup counter
   * @returns {boolean} true if solid overlap found
   */
  static _testLeafSolid(worldModel, leaf, position, mins, maxs, boundsMins, boundsMaxs, checkCount) {
    const brushes = worldModel.brushes;
    const leafbrushes = worldModel.leafbrushes;

    if (!brushes || !leafbrushes) {
      return false;
    }

    const isPoint = (mins[0] === 0 && mins[1] === 0 && mins[2] === 0
                  && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0);

    for (let k = 0; k < leaf.numleafbrushes; k++) {
      const brushNum = leafbrushes[leaf.firstleafbrush + k];
      const brush = brushes[brushNum];

      if (!brush || brush.numsides === 0) {
        continue;
      }

      if (brush._brushTraceCheck === checkCount) {
        continue;
      }
      brush._brushTraceCheck = checkCount;

      // CONTENT_CLIP blocks entities with size (non-zero mins/maxs)
      if (brush.contents !== content.CONTENT_SOLID && brush.contents !== content.CONTENT_SKY
        && (brush.contents !== content.CONTENT_CLIP || isPoint)) {
        continue;
      }

      if (!BrushTrace._brushMayAffectPosition(brush, boundsMins, boundsMaxs)) {
        continue;
      }

      if (BrushTrace._testBoxInBrush(worldModel, brush, position, mins, maxs)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Test if a box at origin is inside a brush. Equivalent to Q2’s CM_TestBoxInBrush.
   * @param {BrushModel} worldModel - world model
   * @param {import('./model/BSP.mjs').Brush} brush - brush to test
   * @param {Vector} position - box center position
   * @param {Vector} mins - box mins
   * @param {Vector} maxs - box maxs
   * @returns {boolean} true if the box is inside the brush
   */
  static _testBoxInBrush(worldModel, brush, position, mins, maxs) {
    const brushsides = worldModel.brushsides;
    const planes = worldModel.planes;

    for (let i = 0; i < brush.numsides; i++) {
      const side = brushsides[brush.firstside + i];
      const plane = planes[side.planenum];

      // Push the plane out for box extents (Minkowski expansion)
      let dist = plane.dist;
      for (let j = 0; j < 3; j++) {
        dist -= (plane.normal[j] < 0 ? maxs[j] : mins[j]) * plane.normal[j];
      }

      const d1 = plane.normal.dot(position) - dist;

      if (plane.type >= 3) {
        if (d1 >= -DIST_EPSILON) {
          return false;
        }
        continue;
      }

      // Exact face contact, plus tiny sub-epsilon overlap from snapped player
      // origins, must remain walkable. Treating these as inside turns riders
      // on rising brush movers into false blockers.
      if (d1 >= -DIST_EPSILON) {
        return false;
      }
    }

    // Inside all brush planes
    return true;
  }

  /** @type {Vector[]} */
  static _midPool = Array.from({ length: 96 }, () => new Vector());
  /** @type {Vector[]} */
  static _mid2Pool = Array.from({ length: 96 }, () => new Vector());

  /**
   * Recursively traverse the BSP node tree, expanding by trace extents.
   * At leaf nodes, test all brushes. Equivalent to Q2’s CM_RecursiveHullCheck.
   * @param {BrushTraceContext} ctx - trace context
   * @param {import('./model/BSP.mjs').Node} node - current BSP node (or leaf)
   * @param {number} p1f - fraction at p1
   * @param {number} p2f - fraction at p2
   * @param {Vector} p1 - start of segment
   * @param {Vector} p2 - end of segment
   * @param {number} depth - recursion depth
   */
  static _recursiveHullCheck(ctx, node, p1f, p2f, p1, p2, depth = 0) {
    if (!BrushTrace._nodeMayAffectTrace(ctx, node)) {
      return;
    }

    if (ctx.trace.fraction <= p1f) {
      return; // already hit something nearer
    }

    // Leaf node: test brushes
    if (node.contents < 0) {
      BrushTrace._traceToLeaf(ctx, node);
      return;
    }

    // Internal node: find the point distances to the splitting plane
    const plane = node.plane;
    let t1, t2, offset;

    if (plane.type < 3) {
      t1 = p1[plane.type] - plane.dist;
      t2 = p2[plane.type] - plane.dist;
      offset = ctx.extents[plane.type];
    } else {
      t1 = plane.normal.dot(p1) - plane.dist;
      t2 = plane.normal.dot(p2) - plane.dist;
      if (ctx.isPoint) {
        offset = 0;
      } else {
        offset = Math.abs(ctx.extents[0] * plane.normal[0])
               + Math.abs(ctx.extents[1] * plane.normal[1])
               + Math.abs(ctx.extents[2] * plane.normal[2]);
      }
    }

    // Both on front side
    if (t1 >= offset && t2 >= offset) {
      BrushTrace._recursiveHullCheck(ctx, node.children[0], p1f, p2f, p1, p2, depth + 1);
      return;
    }

    // Both on back side
    if (t1 < -offset && t2 < -offset) {
      BrushTrace._recursiveHullCheck(ctx, node.children[1], p1f, p2f, p1, p2, depth + 1);
      return;
    }

    // The trace crosses the plane. Compute entry and exit fractions.
    let frac, frac2;
    let side;
    const idist = 1.0 / (t1 - t2);

    if (t1 < t2) {
      side = 1;
      frac = Math.min(1.0, Math.max(0.0, (t1 - offset + DIST_EPSILON) * idist));
      frac2 = Math.min(1.0, Math.max(0.0, (t1 + offset + DIST_EPSILON) * idist));
    } else if (t1 > t2) {
      side = 0;
      frac = Math.min(1.0, Math.max(0.0, (t1 + offset + DIST_EPSILON) * idist));
      frac2 = Math.min(1.0, Math.max(0.0, (t1 - offset - DIST_EPSILON) * idist));
    } else {
      side = 0;
      frac = 1;
      frac2 = 0;
    }

    while (depth >= BrushTrace._midPool.length) {
      BrushTrace._midPool.push(new Vector());
      BrushTrace._mid2Pool.push(new Vector());
    }

    console.assert(depth !== 128, 'hull check went quite deep');
    console.assert(depth < 256, 'hull check went really deep');

    // Move up to the node
    const midf = p1f + (p2f - p1f) * frac;
    const mid = BrushTrace._midPool[depth];
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);

    BrushTrace._recursiveHullCheck(ctx, node.children[side], p1f, midf, p1, mid, depth + 1);

    // Go past the node
    const midf2 = p1f + (p2f - p1f) * frac2;
    const mid2 = BrushTrace._mid2Pool[depth];
    mid2[0] = p1[0] + frac2 * (p2[0] - p1[0]);
    mid2[1] = p1[1] + frac2 * (p2[1] - p1[1]);
    mid2[2] = p1[2] + frac2 * (p2[2] - p1[2]);

    BrushTrace._recursiveHullCheck(ctx, node.children[side ^ 1], midf2, p2f, mid2, p2, depth + 1);
  }

  /**
   * Test all brushes in a leaf against the current trace.
   * Equivalent to Q2’s CM_TraceToLeaf.
   * @param {BrushTraceContext} ctx - trace context
   * @param {import('./model/BSP.mjs').Node} leaf - leaf node
   */
  static _traceToLeaf(ctx, leaf) {
    // Q1 content classification for trace flags
    if (leaf.contents !== content.CONTENT_SOLID && leaf.contents !== content.CONTENT_SKY) {
      ctx.trace.allsolid = false;
      if (leaf.contents === content.CONTENT_EMPTY) {
        ctx.trace.inopen = true;
      } else if (leaf.contents <= content.CONTENT_WATER) {
        ctx.trace.inwater = true;
      }
    }

    const brushes = ctx.worldModel.brushes;
    const leafbrushes = ctx.worldModel.leafbrushes;

    if (!brushes || !leafbrushes) {
      return;
    }

    for (let k = 0; k < leaf.numleafbrushes; k++) {
      const brushNum = leafbrushes[leaf.firstleafbrush + k];
      const brush = brushes[brushNum];

      if (!brush || brush.numsides === 0) {
        continue;
      }

      // Skip already-tested brushes (same brush can appear in multiple leaves)
      if (brush._brushTraceCheck === ctx.checkCount) {
        continue;
      }
      brush._brushTraceCheck = ctx.checkCount;

      // Only collide with solid/clip brushes for movement traces.
      // CONTENT_CLIP blocks entities with size but not point traces.
      if (brush.contents !== content.CONTENT_SOLID
        && brush.contents !== content.CONTENT_SKY
        && (brush.contents !== content.CONTENT_CLIP || ctx.isPoint)) {
        continue;
      }

      if (!BrushTrace._brushMayAffectTrace(ctx, brush)) {
        continue;
      }

      BrushTrace._clipBoxToBrush(ctx, brush);
    }
  }

  /**
   * Clip the trace against a single brush’s planes.
   * Equivalent to Q2’s CM_ClipBoxToBrush.
   * @param {BrushTraceContext} ctx - trace context
   * @param {import('./model/BSP.mjs').Brush} brush - brush to clip against
   */
  static _clipBoxToBrush(ctx, brush) {
    const brushsides = ctx.worldModel.brushsides;
    const planes = ctx.worldModel.planes;
    const moveDeltaX = ctx.end[0] - ctx.start[0];
    const moveDeltaY = ctx.end[1] - ctx.start[1];
    const moveDeltaZ = ctx.end[2] - ctx.start[2];
    const moveDistance = Math.sqrt(moveDeltaX * moveDeltaX + moveDeltaY * moveDeltaY + moveDeltaZ * moveDeltaZ);
    const fractionEpsilon = moveDistance > DIST_EPSILON ? DIST_EPSILON / moveDistance : 1.0;

    let enterfrac = -1;
    let leavefrac = 1;
    /** @type {import('./model/BaseModel.mjs').Plane|null} */
    let clipplane = null;
    /** @type {import('./model/BaseModel.mjs').Plane|null} */
    let tangentAxialPlane = null;
    let tangentAxialMovesDeeper = false;

    let getout = false;
    let startout = false;

    for (let i = 0; i < brush.numsides; i++) {
      const side = brushsides[brush.firstside + i];
      const plane = planes[side.planenum];

      // Compute distance adjusted for box extents (Minkowski expansion)
      let dist;
      if (!ctx.isPoint) {
        // Push the plane out appropriately for mins/maxs
        let ofs0 = 0, ofs1 = 0, ofs2 = 0;
        if (plane.normal[0] < 0) { ofs0 = ctx.maxs[0]; } else { ofs0 = ctx.mins[0]; }
        if (plane.normal[1] < 0) { ofs1 = ctx.maxs[1]; } else { ofs1 = ctx.mins[1]; }
        if (plane.normal[2] < 0) { ofs2 = ctx.maxs[2]; } else { ofs2 = ctx.mins[2]; }
        dist = plane.dist - (ofs0 * plane.normal[0] + ofs1 * plane.normal[1] + ofs2 * plane.normal[2]);
      } else {
        dist = plane.dist;
      }

      const d1 = plane.normal.dot(ctx.start) - dist;
      const d2 = plane.normal.dot(ctx.end) - dist;

      const nonAxialContact = plane.type >= 3;
      const axialTangentStart = !nonAxialContact && d1 < 0 && d1 >= -DIST_EPSILON;
      const nearStart = nonAxialContact && Math.abs(d1) <= DIST_EPSILON;
      const nearEnd = nonAxialContact && Math.abs(d2) <= DIST_EPSILON;

      if (d2 >= 0 || nearEnd) {
        getout = true;
      }

      if (d1 >= 0 || nearStart) {
        startout = true;
      }

      if (axialTangentStart) {
        tangentAxialPlane = plane;
        tangentAxialMovesDeeper ||= d2 < -DIST_EPSILON;
      }

      // If completely in front of face, no intersection with this brush
      if (d1 >= 0 && d2 >= d1) {
        return;
      }

      // Starting tangent to a non-axial plane and moving deeper into the brush
      // should produce an immediate clip plane, not a startsolid classification.
      if (nearStart && d2 < -DIST_EPSILON) {
        if (enterfrac < 0) {
          enterfrac = 0;
          clipplane = plane;
        }
        continue;
      }

      // Exact face contact must remain a walkable contact. Treat only
      // strictly negative distances as being behind the expanded face so
      // resting floor traces do not flip into startsolid/allsolid.
      if (d1 < 0 && d2 < 0) {
        continue;
      }

      // Crosses face
      if (d1 > d2) {
        // Enter
        const f = (d1 - DIST_EPSILON) / (d1 - d2);
        if (BrushTrace._shouldPreferClipPlane(clipplane, enterfrac, plane, f, fractionEpsilon)) {
          enterfrac = f;
          clipplane = plane;
        }
      } else {
        // Leave
        const f = (d1 + DIST_EPSILON) / (d1 - d2);
        if (f < leavefrac) {
          leavefrac = f;
        }
      }
    }

    if (!startout && tangentAxialPlane !== null) {
      if (!tangentAxialMovesDeeper) {
        return;
      }

      startout = true;
      if (enterfrac < 0 || clipplane === null) {
        enterfrac = 0;
        clipplane = tangentAxialPlane;
      }
    }

    if (!startout) {
      // Original point was inside brush
      ctx.trace.startsolid = true;
      if (!getout) {
        ctx.trace.allsolid = true;
        ctx.trace.fraction = 0;
      }
      return;
    }

    if (enterfrac < leavefrac) {
      const currentPlane = ctx.trace.fraction < 1.0 ? ctx.trace.plane : null;
      if (enterfrac > -1 && BrushTrace._shouldPreferTraceHit(currentPlane, ctx.trace.fraction, clipplane, enterfrac, fractionEpsilon)) {
        if (enterfrac < 0) {
          enterfrac = 0;
        }
        ctx.trace.fraction = enterfrac;
        ctx.trace.plane.normal.set(clipplane.normal);
        ctx.trace.plane.dist = clipplane.dist;
      }
    }
  }

  /**
   * Convert a world-space point into local model space using the inverse of a
   * rigid transform represented by origin plus orthonormal basis rows.
   * @param {Vector} point - world-space point
   * @param {Vector} origin - transform origin
   * @param {number[]} basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns {Vector} point in local space
   */
  static _transformPointToLocal(point, origin, basis) {
    const delta = point.copy().subtract(origin);
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return new Vector(
      delta.dot(forward),
      delta.dot(right),
      delta.dot(up),
    );
  }

  /**
   * Convert a local-space point into world space using origin plus basis rows.
   * @param {Vector} point - local-space point
   * @param {Vector} origin - transform origin
   * @param {number[]} basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns {Vector} point in world space
   */
  static _transformPointToWorld(point, origin, basis) {
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return origin.copy()
      .add(forward.multiply(point[0]))
      .add(right.multiply(point[1]))
      .add(up.multiply(point[2]));
  }

  /**
   * Rotate a local-space plane normal into world space.
   * @param {Vector} normal - local-space normal
   * @param {number[]} basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns {Vector} world-space normal
   */
  static _transformNormalToWorld(normal, basis) {
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return forward.multiply(normal[0])
      .add(right.multiply(normal[1]))
      .add(up.multiply(normal[2]));
  }

  /**
   * Convert a local-space trace result back into world space.
   * @param {Trace} localTrace - local-space trace result
   * @param {{origin: Vector, basis: number[]|null}|null} transform - entity transform context
   * @returns {Trace} world-space trace result
   */
  static _transformTraceToWorld(localTrace, transform) {
    if (transform === null) {
      return localTrace;
    }

    const trace = localTrace.copy();

    if (transform.basis !== null) {
      trace.endpos = BrushTrace._transformPointToWorld(localTrace.endpos, transform.origin, transform.basis);
      trace.plane.normal = BrushTrace._transformNormalToWorld(localTrace.plane.normal, transform.basis);
      trace.plane.dist = localTrace.plane.dist + trace.plane.normal.dot(transform.origin);
    } else {
      trace.endpos.add(transform.origin);
      trace.plane.dist += trace.plane.normal.dot(transform.origin);
    }

    return trace;
  }
}

/**
 * @typedef {object} BrushTraceContext
 * @property {BrushModel} worldModel - world model with BSP data
 * @property {Trace} trace - trace result being accumulated
 * @property {Vector} mins - player box mins
 * @property {Vector} maxs - player box maxs
 * @property {boolean} isPoint - true if mins/maxs are zero (point trace)
 * @property {Vector} extents - absolute half-extents of the player box
 * @property {Vector} start - trace start position
 * @property {Vector} end - trace end position
 * @property {Vector} totalMove - end minus start
 * @property {Vector} sweepMins - swept move bounding box minimum
 * @property {Vector} sweepMaxs - swept move bounding box maximum
 * @property {number} checkCount - dedup counter for brush testing
 */

// ---------------------------------------------------------------------------
// PhysEnt: a physics entity stored in the Pmove world
// ---------------------------------------------------------------------------

export class PhysEnt { // physent_t
  /**
   * @param {Pmove} pmove parent pmove instance
   */
  constructor(pmove) {
    /** only for bsp models (legacy Q1 hull-based collision) @type {Hull[]} */
    this.hulls = [];
    /** origin */
    this.origin = new Vector();
    /** angles for transformed brush collision */
    this.angles = new Vector();
    /** only for non-bsp models */
    this.mins = new Vector();
    /** only for non-bsp models */
    this.maxs = new Vector();
    /** actual edict index, used to map back to edicts @type {?number} */
    this.edictId = null;

    /**
     * Reference to the world model for brush-based collision.
     * The world model owns nodes, leafs, planes, brushes, brushsides, leafbrushes.
     * Submodels reference the same world model (shared BSP tree).
     * @type {BrushModel|null}
     */
    this.brushWorldModel = null;

    /**
     * BSP node index for brush collision traversal root.
     * For the world entity this is the world headnode.
     * Not used for submodel entities (they use brute-force brush testing).
     * @type {number}
     */
    this.brushHeadNode = -1;

    /**
     * Submodel reference for brute-force brush collision.
     * Set for submodel entities (doors, plats, etc.) whose brushes are
     * NOT in the BSP leaf-brush index. When set, tracing iterates this
     * model's firstBrush..firstBrush+numBrushes directly.
     * Null for the world entity (which uses BSP tree walk via brushHeadNode).
     * @type {BrushModel|null}
     */
    this.brushModel = null;

    /** @type {WeakRef<Pmove>} @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove} pmove @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  /**
   * Whether this entity uses brush-based collision (Q2-style).
   * When false, falls back to legacy hull-based collision (Q1-style).
   * @returns {boolean} true if brush-based collision is available
   */
  get usesBrushTracing() {
    return this.brushWorldModel !== null && this.brushWorldModel.hasBrushData;
  }

  /**
   * Active brush collision model: submodels use their own brush range, world uses the world model.
   * @returns {BrushModel} brush model to trace against
   */
  get brushCollisionModel() {
    return this.brushModel ?? this.brushWorldModel;
  }

  /**
   * Emit nearby blocking brushes around a debug position when brush and hull comparisons disagree.
   * @param {Vector} position world-space position to inspect
   * @param {string} label debug label for the sampled position
   */
  _debugLogNearbyBlockingBrushes(position, label) {
    const model = this.brushCollisionModel;
    const brushes = model?.brushes;
    const planes = model?.planes;
    const brushsides = model?.brushsides;

    if (!model || !brushes || !planes || !brushsides) {
      return;
    }

    const firstBrush = model.firstBrush ?? 0;
    const lastBrush = firstBrush + (model.numBrushes ?? brushes.length);
    /** @type {{ index: number, contents: number, numsides: number, nearestPlaneDistance: number, touchingPlanes: number, mins: Vector, maxs: Vector, sideSummaries: string[] }[]} */
    const candidates = [];

    for (let brushIndex = firstBrush; brushIndex < lastBrush; brushIndex++) {
      const brush = brushes[brushIndex];
      if (!brush || brush.numsides === 0) {
        continue;
      }
      if (brush.contents !== content.CONTENT_SOLID
        && brush.contents !== content.CONTENT_SKY
        && brush.contents !== content.CONTENT_CLIP) {
        continue;
      }

      const expandedMinX = brush.mins[0] - Pmove.PLAYER_MAXS[0] - DIST_EPSILON;
      const expandedMinY = brush.mins[1] - Pmove.PLAYER_MAXS[1] - DIST_EPSILON;
      const expandedMinZ = brush.mins[2] - Pmove.PLAYER_MAXS[2] - DIST_EPSILON;
      const expandedMaxX = brush.maxs[0] - Pmove.PLAYER_MINS[0] + DIST_EPSILON;
      const expandedMaxY = brush.maxs[1] - Pmove.PLAYER_MINS[1] + DIST_EPSILON;
      const expandedMaxZ = brush.maxs[2] - Pmove.PLAYER_MINS[2] + DIST_EPSILON;

      if (position[0] < expandedMinX || position[0] > expandedMaxX
        || position[1] < expandedMinY || position[1] > expandedMaxY
        || position[2] < expandedMinZ || position[2] > expandedMaxZ) {
        continue;
      }

      let nearestPlaneDistance = Number.POSITIVE_INFINITY;
      let touchingPlanes = 0;
      /** @type {{ distance: number, summary: string }[]} */
      const sideSummaries = [];

      for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
        const side = brushsides[brush.firstside + sideIndex];
        const plane = planes[side.planenum];
        let dist = plane.dist;

        for (let axis = 0; axis < 3; axis++) {
          dist -= (plane.normal[axis] < 0 ? Pmove.PLAYER_MAXS[axis] : Pmove.PLAYER_MINS[axis]) * plane.normal[axis];
        }

        const planeDistance = plane.normal.dot(position) - dist;
        nearestPlaneDistance = Math.min(nearestPlaneDistance, Math.abs(planeDistance));
        if (Math.abs(planeDistance) <= DIST_EPSILON) {
          touchingPlanes += 1;
        }

        sideSummaries.push({
          distance: Math.abs(planeDistance),
          summary: `side=${sideIndex} normal=(${plane.normal[0].toFixed(3)},${plane.normal[1].toFixed(3)},${plane.normal[2].toFixed(3)}) planeDist=${plane.dist.toFixed(3)} adjusted=${dist.toFixed(3)} delta=${planeDistance.toFixed(5)}`,
        });
      }

      sideSummaries.sort((left, right) => left.distance - right.distance);

      candidates.push({
        index: brushIndex,
        contents: brush.contents,
        numsides: brush.numsides,
        nearestPlaneDistance,
        touchingPlanes,
        mins: brush.mins,
        maxs: brush.maxs,
        sideSummaries: sideSummaries.slice(0, 4).map((entry) => entry.summary),
      });
    }

    candidates.sort((left, right) => left.nearestPlaneDistance - right.nearestPlaneDistance);

    if (candidates.length === 0) {
      console.warn(`  ${label}: no nearby solid/clip brushes in expanded bounds`);
      return;
    }

    for (const candidate of candidates.slice(0, 8)) {
      console.warn(
        `  ${label}: brush[${candidate.index}] contents=${candidate.contents}`,
        `numsides=${candidate.numsides}`,
        `nearestPlaneDistance=${candidate.nearestPlaneDistance.toFixed(5)}`,
        `touchingPlanes=${candidate.touchingPlanes}`,
        `mins=${candidate.mins} maxs=${candidate.maxs}`,
      );
      for (const sideSummary of candidate.sideSummaries) {
        console.warn(`    ${sideSummary}`);
      }
    }
  }

  /**
   * Detect positions that are only considered valid by brush tracing because
   * they sit exactly tangent to an axial wall plane. Legacy BSP hull point
   * contents treats that pose as solid, which causes the tiny separating nudge
   * seen in hull-backed maps before movement begins.
   * @param {Vector} position world-space position to inspect
   * @returns {boolean} true when the position would become solid if axial wall tangency counted as overlap
   */
  _brushPositionNeedsHullTangentFallback(position) {
    const model = this.brushCollisionModel;
    const brushes = model?.brushes;
    const planes = model?.planes;
    const brushsides = model?.brushsides;

    if (!model || !brushes || !planes || !brushsides) {
      return false;
    }

    const firstBrush = model.firstBrush ?? 0;
    const lastBrush = firstBrush + (model.numBrushes ?? brushes.length);

    for (let brushIndex = firstBrush; brushIndex < lastBrush; brushIndex++) {
      const brush = brushes[brushIndex];

      if (!brush || brush.numsides === 0) {
        continue;
      }
      if (brush.contents !== content.CONTENT_SOLID
        && brush.contents !== content.CONTENT_SKY
        && brush.contents !== content.CONTENT_CLIP) {
        continue;
      }

      const expandedMinX = brush.mins[0] - Pmove.PLAYER_MAXS[0] - DIST_EPSILON;
      const expandedMinY = brush.mins[1] - Pmove.PLAYER_MAXS[1] - DIST_EPSILON;
      const expandedMinZ = brush.mins[2] - Pmove.PLAYER_MAXS[2] - DIST_EPSILON;
      const expandedMaxX = brush.maxs[0] - Pmove.PLAYER_MINS[0] + DIST_EPSILON;
      const expandedMaxY = brush.maxs[1] - Pmove.PLAYER_MINS[1] + DIST_EPSILON;
      const expandedMaxZ = brush.maxs[2] - Pmove.PLAYER_MINS[2] + DIST_EPSILON;

      if (position[0] < expandedMinX || position[0] > expandedMaxX
        || position[1] < expandedMinY || position[1] > expandedMaxY
        || position[2] < expandedMinZ || position[2] > expandedMaxZ) {
        continue;
      }

      let touchingAxialWall = false;
      let inside = true;

      for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
        const side = brushsides[brush.firstside + sideIndex];
        const plane = planes[side.planenum];
        let dist = plane.dist;

        for (let axis = 0; axis < 3; axis++) {
          dist -= (plane.normal[axis] < 0 ? Pmove.PLAYER_MAXS[axis] : Pmove.PLAYER_MINS[axis]) * plane.normal[axis];
        }

        const planeDistance = plane.normal.dot(position) - dist;
        const axialWall = plane.type < 3 && Math.abs(plane.normal[2]) <= DIST_EPSILON;

        if (axialWall && Math.abs(planeDistance) <= DIST_EPSILON) {
          touchingAxialWall = true;
          continue;
        }

        if (plane.type >= 3) {
          if (planeDistance >= -DIST_EPSILON) {
            inside = false;
            break;
          }
          continue;
        }

        if (planeDistance >= 0) {
          inside = false;
          break;
        }
      }

      if (inside && touchingAxialWall) {
        return true;
      }
    }

    return false;
  }

  /**
   * Legacy hull comparisons are only meaningful for axis-aligned brush traces.
   * @returns {boolean} true if brush-vs-hull debug comparison is valid
   */
  get canCompareBrushAgainstHull() {
    return this.hulls.length > 0 && this.angles.isOrigin();
  }

  /**
   * Legacy hull comparisons are only meaningful for axial contact planes.
   * @param {Vector} normal candidate contact normal
   * @returns {boolean} true when the normal is axis-aligned
   */
  static _isAxialNormal(normal) {
    const ax = Math.abs(normal[0]);
    const ay = Math.abs(normal[1]);
    const az = Math.abs(normal[2]);

    return (Math.abs(ax - 1.0) <= DIST_EPSILON && ay <= DIST_EPSILON && az <= DIST_EPSILON)
      || (ax <= DIST_EPSILON && Math.abs(ay - 1.0) <= DIST_EPSILON && az <= DIST_EPSILON)
      || (ax <= DIST_EPSILON && ay <= DIST_EPSILON && Math.abs(az - 1.0) <= DIST_EPSILON);
  }

  /**
   * Convert a point into this physent's legacy hull space.
   * @param {Vector} point point in world space
   * @param {Vector|null} scratch scratch vector to reuse, or null to allocate
   * @returns {Vector} point in local hull space
   */
  toHullSpace(point, scratch = null) {
    const localPoint = scratch ?? point.copy();
    return localPoint.set(point).subtract(this.origin);
  }

  /**
   * Convert a point into the collision space expected by this physent.
   * Brush traces operate in world space; legacy hull traces use local space.
   * @param {Vector} point point in world space
   * @param {Vector|null} scratch scratch vector to reuse for hull traces
   * @returns {Vector} point in the collision space expected by the active path
   */
  toCollisionSpace(point, scratch = null) {
    if (this.usesBrushTracing) {
      return point;
    }

    return this.toHullSpace(point, scratch);
  }

  /**
   * Convert a point from this physent's collision space back to world space.
   * @param {Vector} point point in collision space
   * @param {Vector|null} scratch scratch vector to reuse for hull traces
   * @returns {Vector} point in world space
   */
  toWorldSpace(point, scratch = null) {
    if (this.usesBrushTracing) {
      return point;
    }

    const worldPoint = scratch ?? point.copy();
    return worldPoint.set(point).add(this.origin);
  }

  #hullMinsScratch = new Vector();
  #hullMaxsScratch = new Vector();

  /**
   * Returns clipping hull for this entity (legacy Q1 hull-based path).
   * NOTE: This is not async/wait safe, since it will modify pmove’s boxHull in-place.
   * @returns {Hull} hull
   */
  getClippingHull() {
    if (this.hulls.length > 0) {
      return this.hulls[1]; // player hull
    }

    const mins = this.#hullMinsScratch.set(this.mins).subtract(Pmove.PLAYER_MAXS);
    const maxs = this.#hullMaxsScratch.set(this.maxs).subtract(Pmove.PLAYER_MINS);

    return this._pmove.boxHull.setSize(mins, maxs);
  }

  /**
   * Trace a player-sized box from start to end using the appropriate collision method.
   * For brush-based entities, uses Q2-style brush tracing.
   * For hull-based entities, uses Q1-style hull tracing.
   * @param {Vector} start world-space start position
   * @param {Vector} end world-space end position
   * @returns {Trace} trace result
   */
  tracePlayerMove(start, end) {
    const traceStart = this.toCollisionSpace(start);
    const traceEnd = this.toCollisionSpace(end);

    if (this.usesBrushTracing) {
      const brushTrace = BrushTrace.transformedBoxTrace(
        this.brushCollisionModel,
        traceStart,
        traceEnd,
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
        this.origin,
        this.angles,
      );

      // DEBUG: compare brush result with hull result when pm_debug is on
      if (PmovePlayer.DEBUG && this.canCompareBrushAgainstHull) {
        const hull = this.getClippingHull();
        const hullTrace = new Trace();
        const startLocal = this.toHullSpace(start);
        const endLocal = this.toHullSpace(end);
        hullTrace.endpos.set(endLocal);
        hull.check(0.0, 1.0, startLocal, endLocal, hullTrace);

        const brushBlocks = brushTrace.fraction < 1.0 || brushTrace.startsolid || brushTrace.allsolid;
        const hullBlocks = hullTrace.fraction < 1.0 || hullTrace.startsolid || hullTrace.allsolid;
        const comparableContact = PhysEnt._isAxialNormal(brushTrace.plane.normal)
          || PhysEnt._isAxialNormal(hullTrace.plane.normal);

        if (brushBlocks !== hullBlocks && comparableContact) {
          const model = this.brushModel;
          console.warn(
            `[Pmove MISMATCH] edictId=${this.edictId} model=${model?.name ?? 'world'}`,
            `\n  brush: frac=${brushTrace.fraction.toFixed(4)} startsolid=${brushTrace.startsolid} allsolid=${brushTrace.allsolid}`,
            `\n  hull:  frac=${hullTrace.fraction.toFixed(4)} startsolid=${hullTrace.startsolid} allsolid=${hullTrace.allsolid}`,
            `\n  start=${start} end=${end}`,
            model ? `\n  brushRange: first=${model.firstBrush} num=${model.numBrushes}` : '',
          );

          if (!brushBlocks && hullBlocks) {
            this._debugLogNearbyBlockingBrushes(start, 'start-nearby');
            this._debugLogNearbyBlockingBrushes(end, 'end-nearby');
          }

          if (brushBlocks && !hullBlocks && model) {
            // Brush blocks but hull doesn't — log which specific brush is the culprit
            const brushes = model.brushes;
            const last = model.firstBrush + model.numBrushes;
            for (let bi = model.firstBrush; bi < last; bi++) {
              const brush = brushes[bi];

              if (!brush || brush.numsides === 0) {
                continue;
              }

              console.warn(
                `  brush[${bi}]: contents=${brush.contents} sides=${brush.numsides}`,
                `mins=${brush.mins} maxs=${brush.maxs}`,
              );
            }
          }
        }
      }

      return brushTrace;
    }

    // Legacy hull-based trace
    const hull = this.getClippingHull();
    const trace = new Trace();
    trace.endpos.set(traceEnd);
    hull.check(0.0, 1.0, traceStart, traceEnd, trace);
    trace.endpos = this.toWorldSpace(trace.endpos, trace.endpos);
    return trace;
  }

  /**
   * Test if a player-sized box at position is inside solid.
   * @param {Vector} position world-space position to test
   * @returns {boolean} true if position is valid (not in solid)
   */
  testPlayerPosition(position) {
    if (this.usesBrushTracing) {
      const brushResult = BrushTrace.transformedTestPosition(
        this.brushCollisionModel,
        position,
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
        this.origin,
        this.angles,
      );

      let hullResult = true;
      let usedHullTangentFallback = false;

      if (this.canCompareBrushAgainstHull) {
        const hull = this.getClippingHull();
        const localPosition = this.toHullSpace(position);

        const pointContents = hull.pointContents(localPosition);

        hullResult = pointContents !== content.CONTENT_SOLID && pointContents !== content.CONTENT_SKY;

        if (brushResult && !hullResult && this._brushPositionNeedsHullTangentFallback(position)) {
          usedHullTangentFallback = true;
        }
      }

      if (usedHullTangentFallback) {
        if (PmovePlayer.DEBUG) {
          console.warn(
            `[Pmove POS HULL TANGENT FALLBACK] edictId=${this.edictId} model=${this.brushModel?.name ?? 'world'}`,
            '\n  using hull-style invalid position for exact axial wall tangency',
            `\n  position=${position}`,
          );
        }
        return false;
      }

      // DEBUG: compare with hull result when pm_debug is on
      if (PmovePlayer.DEBUG && this.canCompareBrushAgainstHull) {
        if (brushResult !== hullResult) {
          const model = this.brushModel;
          console.warn(
            `[Pmove POS MISMATCH] edictId=${this.edictId} model=${model?.name ?? 'world'}`,
            `\n  brush says ${brushResult ? 'VALID' : 'IN SOLID'}`,
            `\n  hull  says ${hullResult ? 'VALID' : 'IN SOLID'}`,
            `\n  position=${position}`,
            model ? `\n  brushRange: first=${model.firstBrush} num=${model.numBrushes}` : '',
          );

          if (brushResult && !hullResult) {
            this._debugLogNearbyBlockingBrushes(position, 'position-nearby');
          }

          if (!brushResult && hullResult && model) {
            // Brush says solid, hull says valid — log culprit brush
            const brushes = model.brushes;
            const planes = model.planes;
            const brushsides = model.brushsides;
            const last = model.firstBrush + model.numBrushes;
            for (let bi = model.firstBrush; bi < last; bi++) {
              const brush = brushes[bi];
              if (!brush || brush.numsides === 0) {
                continue;
              }
              if (brush.contents !== content.CONTENT_SOLID
                && brush.contents !== content.CONTENT_SKY
                && brush.contents !== content.CONTENT_CLIP) {
                continue;
              }
              // Minkowski test inline
              let inside = true;
              for (let si = 0; si < brush.numsides; si++) {
                const side = brushsides[brush.firstside + si];
                const plane = planes[side.planenum];
                let dist = plane.dist;
                for (let j = 0; j < 3; j++) {
                  dist -= (plane.normal[j] < 0 ? Pmove.PLAYER_MAXS[j] : Pmove.PLAYER_MINS[j]) * plane.normal[j];
                }
                const d1 = plane.normal.dot(position) - dist;
                if (d1 > 0) {
                  inside = false;
                  break;
                }
              }
              if (inside) {
                console.warn(
                  `  CULPRIT brush[${bi}]: contents=${brush.contents} sides=${brush.numsides}`,
                  `mins=${brush.mins} maxs=${brush.maxs}`,
                );
              }
            }
          }
        }
      }

      return brushResult;
    }

    // Legacy hull-based point test
    const hull = this.getClippingHull();
    const pointContents = hull.pointContents(this.toHullSpace(position));
    return pointContents !== content.CONTENT_SOLID && pointContents !== content.CONTENT_SKY;
  }

  // CR: we can add getClippingHullCrouch() for BSP30 hulls here later
};

// ---------------------------------------------------------------------------
// PmovePlayer: the core player movement simulation
//
// Follows Q2’s Pmove() structure:
//   1. ClampAngles          – resolve view angles from cmd + deltas
//   2. CheckDuck            – set player bounds based on stance
//   3. SnapPosition (init)  – nudge into valid position
//   4. CatagorizePosition   – determine ground entity, water level
//   5. CheckSpecialMovement – ladders, water jumps
//   6. Drop timing counter  – pm_time for land/waterjump/teleport
//   7. Movement dispatch    – jump, friction, then air/water/fly
//   8. CatagorizePosition   – final ground + water check
//   9. SnapPosition         – quantize for network
//
// This class is designed to be called identically from both client
// (for prediction) and server (for authoritative movement). It reads
// input from `cmd` and `pmFlags`/`pmTime`, and writes output to
// `origin`, `velocity`, `pmFlags`, etc.
// ---------------------------------------------------------------------------

/**
 * Player movement simulation.
 *
 * Can be called by both server and client. All state lives on this object,
 * the caller is responsible for copying state in before `move()` and reading
 * it back after.
 */
export class PmovePlayer { // pmove_t (player state only)
  /** @type {boolean} enables verbose movement debugging */
  static get DEBUG() {
    return (Pmove.debug?.value ?? 0) !== 0;
  }

  /**
   * @param {Pmove} pmove pmove instance (world + physents)
   */
  constructor(pmove) {
    // --- Public state (read/write by caller) ---

    /** @type {number} computed from cmd.msec */
    this.frametime = 0;
    /** @type {number} 0-3 water depth */
    this.waterlevel = 0;
    /** @type {number} content type of water */
    this.watertype = 0;

    /** @type {?number} ground edict number; null if airborne */
    this.onground = null;

    /** @type {Vector} player position (full float precision) */
    this.origin = new Vector();
    /** @type {Vector} player velocity (full float precision) */
    this.velocity = new Vector();
    /** @type {Vector} resolved view angles */
    this.angles = new Vector();

    /** @type {number} movement type (PM_TYPE enum) */
    this.pmType = PM_TYPE.NORMAL;
    /** @type {number} PM flag bitmask (PMF enum) */
    this.pmFlags = 0;
    /** @type {number} timing counter for special states (in msec/8 units) */
    this.pmTime = 0;

    /** @type {number} view height offset from origin */
    this.viewheight = 22;

    /** @type {number} remembered old buttons for edge detection */
    this.oldbuttons = 0;
    /** @type {number} Q1 compat, waterjump time remaining */
    this.waterjumptime = 0.0;
    /** @type {boolean} backwards compat flag */
    this.spectator = false;
    /** @type {boolean} backwards compat flag */
    this.dead = false;

    /** @type {Protocol.UserCmd} input command */
    this.cmd = new Protocol.UserCmd();

    /** @type {number[]} list of touched edict numbers */
    this.touchindices = [];

    // --- Private ---

    /** @type {boolean} whether we are on a ladder this frame */
    this._ladder = false;

    /** @type {DirectionalVectors} cached angle vectors @private */
    this._angleVectors = null;

    /** @type {WeakRef<Pmove>} @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove} parent Pmove instance @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  // =========================================================================
  // Public entry point
  // =========================================================================

  /**
   * Execute one frame of player movement.
   * Caller must set origin, velocity, angles, cmd, pmFlags, pmTime, pmType etc.
   * before calling, and read them back after.
   */
  move() { // Q2: Pmove()
    console.assert(this.cmd instanceof Protocol.UserCmd, 'valid cmd');

    // derive frametime
    this.frametime = this.cmd.msec / 1000.0;
    this.touchindices.length = 0;

    const _dbg = PmovePlayer.DEBUG;
    const _dbgOriginBefore = _dbg ? this.origin.copy() : null;

    // resolve view angles
    this._clampAngles();

    // handle backwards-compat flags
    if (this.spectator) {
      this.pmType = PM_TYPE.SPECTATOR;
    }
    if (this.dead) {
      this.pmType = PM_TYPE.DEAD;
    }

    // spectator
    if (this.pmType === PM_TYPE.SPECTATOR) {
      this.onground = null;
      this.pmFlags &= ~PMF.ON_GROUND;
      this._flyMove();
      this._snapPosition();
      return;
    }

    // dead players have no input
    if (this.pmType >= PM_TYPE.DEAD) {
      this.cmd.forwardmove = 0;
      this.cmd.sidemove = 0;
      this.cmd.upmove = 0;
    }

    // frozen, no movement at all
    if (this.pmType === PM_TYPE.FREEZE) {
      return;
    }

    // set mins/maxs/viewheight (duck check)
    this._checkDuck();

    // nudge into valid position
    this._nudgePosition();

    // determine ground entity, water type, and water level
    this._categorizePosition();

    // dead movement (extra friction, nothing else)
    if (this.pmType === PM_TYPE.DEAD) {
      this._deadMove();
    }

    // check for ladders and water jumps
    this._checkSpecialMovement();

    // drop timing counter
    if (this.pmTime) {
      let msec = this.cmd.msec >> 3;
      if (!msec) {
        msec = 1;
      }
      if (msec >= this.pmTime) {
        this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
        this.pmTime = 0;
      } else {
        this.pmTime -= msec;
      }
    }

    // movement dispatch
    if (this.pmFlags & PMF.TIME_TELEPORT) {
      // teleport pause, no movement
    } else if (this.pmFlags & PMF.TIME_WATERJUMP) {
      // waterjump: no control, but gravity applies
      this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
      if (this.velocity[2] < 0) {
        this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
        this.pmTime = 0;
      }
      this._stepSlideMove();
    } else {
      this._checkJump();
      this._friction();

      if (this.waterlevel >= 2) {
        this._waterMove();
      } else {
        // Q2 divides pitch by 3 for ground angle vectors; Q1 does not scale
        const divisor = this._pmove.configuration.pitchDivisor;

        if (divisor) {
          const pitchedAngles = this.angles.copy();
          let pitch = pitchedAngles[0];
          if (pitch > 180) {
            pitch -= 360;
          }
          pitchedAngles[0] = pitch / divisor;
          this._angleVectors = pitchedAngles.angleVectors();
        }

        this._airMove();
      }
    }

    // final ground + water classification
    this._categorizePosition();

    const _dbgBeforeSnap = _dbg ? this.origin.copy() : null;

    // quantize position for network
    this._snapPosition();

    if (_dbg) {
      const moved = !this.origin.equals(_dbgOriginBefore);
      const snapMoved = !this.origin.equals(_dbgBeforeSnap);
      if (moved) {
        console.log(`[Pmove] frame: origin ${_dbgOriginBefore} -> ${_dbgBeforeSnap} -> snap ${this.origin} vel=${this.velocity} onground=${this.onground} flags=${this.pmFlags}${snapMoved ? ' (SNAP MOVED)' : ''}`);
      }
    }
  }

  // =========================================================================
  // Angle resolution
  // =========================================================================

  /** Resolve view angles from command input. */
  _clampAngles() { // Q2: PM_ClampAngles
    // take angles directly from command
    this.angles.set(this.cmd.angles);

    // clamp pitch
    if (this.angles[0] > 89 && this.angles[0] < 180) {
      this.angles[0] = 89;
    } else if (this.angles[0] < 271 && this.angles[0] >= 180) {
      this.angles[0] = 271;
    }

    this._angleVectors = this.angles.angleVectors();
  }

  // =========================================================================
  // Duck handling
  // =========================================================================

  /** Sets viewheight based on duck state. */
  _checkDuck() { // Q2: PM_CheckDuck
    if (this.pmType === PM_TYPE.DEAD) {
      this.pmFlags |= PMF.DUCKED;
    } else if (this.cmd.upmove < 0 && (this.pmFlags & PMF.ON_GROUND)) {
      // duck requested while on ground
      this.pmFlags |= PMF.DUCKED;
    } else if (this.pmFlags & PMF.DUCKED) {
      // try to stand up
      if (this._pmove.isValidPlayerPosition(this.origin)) {
        this.pmFlags &= ~PMF.DUCKED;
      }
    }

    if (this.pmFlags & PMF.DUCKED) {
      this.viewheight = -2; // TODO: config
    } else {
      this.viewheight = 22; // TODO: config
    }
  }

  // =========================================================================
  // Position categorization
  // =========================================================================

  /** Determine ground entity, water type and water level. */
  _categorizePosition() { // Q2: PM_CatagorizePosition
    // --- Ground check ---
    const point = this.origin.copy();
    point[2] -= this._pmove.configuration.groundCheckDepth;
    const _dbg = PmovePlayer.DEBUG;
    const hadGroundContact = this.onground !== null;

    if (this.velocity[2] > 180 && !hadGroundContact) {
      // moving up fast enough, not on ground
      if (_dbg) {
        console.log(`[_categorizePosition] skip ground trace: vz=${this.velocity[2].toFixed(3)} priorGround=${hadGroundContact}`);
      }
      this.pmFlags &= ~PMF.ON_GROUND;
      this.onground = null;
    } else {
      if (_dbg && this.velocity[2] > 180 && hadGroundContact) {
        console.log(`[_categorizePosition] preserve ground trace: vz=${this.velocity[2].toFixed(3)} priorGround=${hadGroundContact}`);
      }
      const trace = this._pmove.clipPlayerMove(this.origin, point);

      if (!trace.ent && trace.ent !== 0) {
        // didn’t hit anything
        this.onground = null;
        this.pmFlags &= ~PMF.ON_GROUND;
      } else if (trace.plane.normal[2] < MIN_STEP_NORMAL && !trace.startsolid) {
        // too steep
        this.onground = null;
        this.pmFlags &= ~PMF.ON_GROUND;
      } else {
        this.onground = trace.ent;

        // hitting solid ground ends a waterjump
        if (this.pmFlags & PMF.TIME_WATERJUMP) {
          this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
          this.pmTime = 0;
        }

        if (!(this.pmFlags & PMF.ON_GROUND)) {
          // just hit the ground
          this.pmFlags |= PMF.ON_GROUND;

          // Q2: apply landing cooldown preventing immediate re-jump
          if (this._pmove.configuration.landingCooldown && this.velocity[2] < -200) {
            this.pmFlags |= PMF.TIME_LAND;
            if (this.velocity[2] < -400) {
              this.pmTime = 25;
            } else {
              this.pmTime = 18;
            }
          }
        }
      }

      // record touch
      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }
    }

    // --- Water level check ---
    this.waterlevel = 0;
    this.watertype = content.CONTENT_EMPTY;

    point[0] = this.origin[0];
    point[1] = this.origin[1];
    point[2] = this.origin[2] + Pmove.PLAYER_MINS[2] + 1.0;

    let contents = this._pmove.staticWorldContents(point);

    if (contents <= content.CONTENT_WATER) {
      this.watertype = contents;
      this.waterlevel = 1;

      // half-way point
      point[2] = this.origin[2] + (Pmove.PLAYER_MINS[2] + Pmove.PLAYER_MAXS[2]) / 2.0;
      contents = this._pmove.staticWorldContents(point);

      if (contents <= content.CONTENT_WATER) {
        this.waterlevel = 2;

        // eye level
        point[2] = this.origin[2] + this.viewheight;
        contents = this._pmove.staticWorldContents(point);

        if (contents <= content.CONTENT_WATER) {
          this.waterlevel = 3;
        }
      }
    }
  }

  // =========================================================================
  // Special movement checks (ladders, water jump)
  // =========================================================================

  /** Check for ladder / water jump opportunities. */
  _checkSpecialMovement() { // Q2: PM_CheckSpecialMovement
    if (this.pmFlags & PMF.TIME_WATERJUMP) {
      return;
    }

    this._ladder = false;

    // check for ladder
    const flatforward = new Vector(this._angleVectors.forward[0], this._angleVectors.forward[1], 0);
    flatforward.normalize();

    const spot = this.origin.copy().add(flatforward);
    let trace = this._pmove.clipPlayerMove(this.origin, spot);

    if (trace.fraction < 1) {
      // Q2 checks trace.contents & CONTENTS_LADDER, we use content type
      const ladderPoint = trace.endpos.copy().add(flatforward.copy().multiply(0.5));
      const ladderContents = this._pmove.staticWorldContents(ladderPoint);
      // In Q1 BSP, there is no CONTENTS_LADDER. Ladder detection should
      // be implemented via trigger_ladder entities or texture flags.
      // For now this is a placeholder, ladder support requires map support.
      // TODO: Enable this via entities.
      void ladderContents;
    }

    // check for water jump
    if (this.waterlevel !== 2) {
      return;
    }

    // don’t try to hop out while sinking fast (Q1)
    if (this.velocity[2] < -180) {
      return;
    }

    // probe forward for a solid wall, then check for empty space above it.
    const wjspot = this.origin.copy().add(flatforward.copy().multiply(this._pmove.configuration.forwardProbe));
    wjspot[2] += this._pmove.configuration.wallcheckZ;

    let cont = this._pmove.staticWorldContents(wjspot);
    if (cont !== content.CONTENT_SOLID && cont !== content.CONTENT_SKY) {
      return;
    }

    wjspot[2] += this._pmove.configuration.emptycheckZ;
    cont = this._pmove.staticWorldContents(wjspot);
    if (cont !== content.CONTENT_EMPTY) {
      return;
    }

    // jump out of water
    this.velocity.set(flatforward).multiply(50);
    this.velocity[2] = this._pmove.configuration.waterExitVelocity;

    this.pmFlags |= PMF.TIME_WATERJUMP;
    this.pmTime = 255;
  }

  // =========================================================================
  // Jump
  // =========================================================================

  /** Check and execute jump. */
  _checkJump() { // Q2: PM_CheckJump
    // Q2: landing cooldown prevents immediate re-jump after hard landing
    if (this._pmove.configuration.landingCooldown && (this.pmFlags & PMF.TIME_LAND)) {
      return;
    }

    if (this.cmd.upmove < 10) {
      // not holding jump
      this.pmFlags &= ~PMF.JUMP_HELD;
      return;
    }

    // must wait for jump button release
    if (this.pmFlags & PMF.JUMP_HELD) {
      return;
    }

    if (this.pmType === PM_TYPE.DEAD) {
      return;
    }

    // swimming, not jumping
    if (this.waterlevel >= 2) {
      this.onground = null;

      // Q2: prevent swimming jump when sinking fast
      if (this._pmove.configuration.swimJumpGuard && this.velocity[2] <= -300) {
        return;
      }

      switch (this.watertype) {
        case content.CONTENT_WATER:
          this.velocity[2] = 100;
          break;
        case content.CONTENT_SLIME:
          this.velocity[2] = 80;
          break;
        default:
          this.velocity[2] = 50;
      }
      return;
    }

    // not on ground, no effect
    if (this.onground === null) {
      return;
    }

    this.pmFlags |= PMF.JUMP_HELD;

    this.onground = null;
    this.pmFlags &= ~PMF.ON_GROUND;
    this.velocity[2] += 270;

    // Q2: clamp to minimum jump velocity
    if (this._pmove.configuration.jumpMinClamp && this.velocity[2] < 270) {
      this.velocity[2] = 270;
    }
  }

  // =========================================================================
  // Dead movement
  // =========================================================================

  /** Extra friction when dead, no player input. */
  _deadMove() { // Q2: PM_DeadMove
    if (this.onground === null) {
      return;
    }

    let forward = this.velocity.len();
    forward -= 20;

    if (forward <= 0) {
      this.velocity.clear();
    } else {
      this.velocity.normalize();
      this.velocity.multiply(forward);
    }
  }

  // =========================================================================
  // Friction
  // =========================================================================

  /** Apply ground and water friction. */
  _friction() { // Q2: PM_Friction
    const vel = this.velocity;
    const speed = Math.hypot(vel[0], vel[1], vel[2]);

    if (speed < 1) {
      vel[0] = 0;
      vel[1] = 0;
      return;
    }

    let drop = 0;

    // Water friction and ground friction are mutually exclusive (Q1 behavior).
    // When waist-deep or deeper, only water friction applies.
    if (this.waterlevel >= 2 && !this._ladder) {
      drop += speed * this._pmove.movevars.waterfriction * this.waterlevel * this.frametime;
    } else if ((this.onground !== null && !this._ladder) || this._ladder) {
      // ground friction
      let friction = this._pmove.movevars.friction;

      // Q1: if the leading edge is over a dropoff, increase friction
      if (this._pmove.configuration.edgeFriction && this.onground !== null) {
        const start = new Vector(
          this.origin[0] + vel[0] / speed * 16,
          this.origin[1] + vel[1] / speed * 16,
          this.origin[2] + Pmove.PLAYER_MINS[2],
        );
        const stop = new Vector(start[0], start[1], start[2] - 34);
        const edgeTrace = this._pmove.clipPlayerMove(start, stop);
        if (edgeTrace.fraction === 1.0) {
          friction *= this._pmove.movevars.edgefriction;
        }
      }

      const control = speed < this._pmove.movevars.stopspeed ? this._pmove.movevars.stopspeed : speed;
      drop += control * friction * this.frametime;
    }

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) {
      newspeed = 0;
    }
    newspeed /= speed;

    vel[0] *= newspeed;
    vel[1] *= newspeed;
    vel[2] *= newspeed;
  }

  // =========================================================================
  // Velocity clipping
  // =========================================================================

  /**
   * Slide off of the impacting surface.
   * @param {Vector} veloIn input velocity
   * @param {Vector} normal surface normal
   * @param {Vector} veloOut output velocity (may alias veloIn)
   * @param {number} overbounce overbounce factor (Q1: 1.0, Q2: 1.01)
   */
  _clipVelocity(veloIn, normal, veloOut, overbounce) { // Q2: PM_ClipVelocity
    const backoff = veloIn.dot(normal) * overbounce;

    for (let i = 0; i < 3; i++) {
      const change = normal[i] * backoff;
      veloOut[i] = veloIn[i] - change;
      if (veloOut[i] > -STOP_EPSILON && veloOut[i] < STOP_EPSILON) {
        veloOut[i] = 0;
      }
    }
  }

  // =========================================================================
  // Acceleration
  // =========================================================================

  /**
   * Ground/water acceleration.
   * @param {Vector} wishdir desired direction (unit vector)
   * @param {number} wishspeed desired speed
   * @param {number} accel acceleration factor
   */
  _accelerate(wishdir, wishspeed, accel) { // Q2: PM_Accelerate
    const currentspeed = this.velocity.dot(wishdir);
    let addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    let accelspeed = accel * this.frametime * wishspeed;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];
  }

  /**
   * Air acceleration, preserves the Q1/Q2 air-strafe mechanic.
   * wishspeed is capped at 30 for the addspeed check, but the uncapped
   * value is used for accelspeed. This allows bunny-hopping.
   * @param {Vector} wishdir desired direction (unit vector)
   * @param {number} wishspeed desired speed (uncapped)
   * @param {number} accel acceleration factor
   */
  _airAccelerate(wishdir, wishspeed, accel) { // Q2: PM_AirAccelerate
    let wishspd = wishspeed;
    if (wishspd > 30) {
      wishspd = 30;
    }

    const currentspeed = this.velocity.dot(wishdir);
    let addspeed = wishspd - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    // NOTE: uses original wishspeed, not the capped wishspd
    let accelspeed = accel * wishspeed * this.frametime;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];
  }

  // =========================================================================
  // Core slide move (Q2: PM_StepSlideMove_ – inner loop)
  // =========================================================================

  // --- Scratch Vectors for _slideMove ---
  #slideOriginalVelocity = new Vector();
  #slidePrimalVelocity = new Vector();
  #slideEnd = new Vector();
  #slideClipVelocity = new Vector();
  #slideCreaseDir = new Vector();
  #slidePlanes = Array.from({ length: MAX_CLIP_PLANES }, () => new Vector());

  /**
   * Brush bevels can report a second zero-progress hit whose normal only
   * differs slightly from the wall we already clipped against. Treat that as a
   * duplicate plane so we keep sliding instead of manufacturing a bogus crease.
   * @param {Vector} normal candidate collision plane normal
   * @param {number} planeCount number of existing clip planes
   * @param {Vector[]} planes existing clip planes
   * @param {number} fraction trace fraction for the candidate hit
   * @returns {boolean} true when the candidate plane should be collapsed into an existing one
   */
  _isDuplicateSlidePlane(normal, planeCount, planes, fraction) {
    const duplicateDot = fraction === 0.0 ? ZERO_PROGRESS_DUPLICATE_DOT : 0.99;

    for (let i = 0; i < planeCount; i++) {
      if (normal.dot(planes[i]) > duplicateDot) {
        return true;
      }
    }

    return false;
  }

  /**
   * The basic solid body movement clip that slides along multiple planes.
   * This is the inner loop, it does NOT attempt step-up.
   * @returns {boolean} True when movement hit a blocking plane and required clipping.
   */
  _slideMove() { // Q1: SV_FlyMove / Q2: PM_StepSlideMove_
    const _dbg = PmovePlayer.DEBUG;
    const _dbgStartOrigin = _dbg ? this.origin.copy() : null;
    const _dbgStartVelocity = _dbg ? this.velocity.copy() : null;
    const numbumps = 4;
    const primalVelocity = this.#slidePrimalVelocity.set(this.velocity);
    // Q1-style: snapshot velocity at the last point of actual movement.
    // The clip loop always clips from this stable reference, not from an
    // already-clipped result. This avoids precision drift when re-clipping
    // against the same BSP hull plane with the 1.01 overbounce factor.
    const originalVelocity = this.#slideOriginalVelocity.set(this.velocity);
    let numplanes = 0;
    /** @type {Vector[]} */
    const planes = this.#slidePlanes;
    let timeLeft = this.frametime;
    const end = this.#slideEnd;
    const clipVelocity = this.#slideClipVelocity;
    let blocked = false;

    for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
      end.set(this.velocity).multiply(timeLeft).add(this.origin);

      const trace = this._pmove.clipPlayerMove(this.origin, end);

      if (trace.allsolid) {
        blocked = true;
        // trapped in solid, still record the touch so impact() fires
        if (trace.ent !== null) {
          this.touchindices.push(trace.ent);
        }
        if (_dbg) {
          console.warn(`[_slideMove] ALLSOLID at bump ${bumpcount}, origin=${this.origin}, end=${end}`);
        }
        this.velocity[2] = 0;
        return true;
      }

      if (trace.fraction > 0) {
        // actually moved some distance
        this.origin.set(trace.endpos);
        originalVelocity.set(this.velocity);
        numplanes = 0;
      }

      if (trace.fraction === 1) {
        break; // moved the entire distance
      }

      blocked = true;

      if (_dbg) {
        console.log(`[_slideMove] bump ${bumpcount}: frac=${trace.fraction.toFixed(4)} normal=(${trace.plane.normal[0].toFixed(3)},${trace.plane.normal[1].toFixed(3)},${trace.plane.normal[2].toFixed(3)}) ent=${trace.ent} origin=${this.origin} vel=${this.velocity}`);
      }

      // save entity for contact
      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }

      timeLeft -= timeLeft * trace.fraction;

      // slide along this plane
      if (numplanes >= MAX_CLIP_PLANES) {
        this.velocity.clear();
        break;
      }

      // Q1 hull traces can return near-identical normals for the same
      // surface when the player origin is very close to a BSP plane.
      // Without this guard, two near-duplicate normals cause the crease
      // cross-product to be ~zero, zeroing velocity and sticking the
      // player. This check is standard in Q1 source ports (QS, FTEQW).
      const traceNormal = trace.plane.normal;
      if (this._isDuplicateSlidePlane(traceNormal, numplanes, planes, trace.fraction)) {
        // Nudge velocity away from the surface to help the next trace
        this.velocity[0] += traceNormal[0];
        this.velocity[1] += traceNormal[1];
        this.velocity[2] += traceNormal[2];
        continue;
      }

      planes[numplanes].set(traceNormal);
      numplanes++;

      // Clip originalVelocity (Q1-style) so each plane attempt starts
      // from the same stable base. Q2 clips the current velocity in-place,
      // but Q1’s BSP hull traces need the original reference to avoid
      // precision drift from re-clipping with the overbounce factor.
      let i, j;
      for (i = 0; i < numplanes; i++) {
        this._clipVelocity(originalVelocity, planes[i], clipVelocity, this._pmove.configuration.overbounce);

        for (j = 0; j < numplanes; j++) {
          if (j !== i) {
            if (clipVelocity.dot(planes[j]) < 0) {
              break; // not ok
            }
          }
        }
        if (j === numplanes) {
          break; // found a velocity that works with all planes
        }
      }

      if (i !== numplanes) {
        // go along this plane
        this.velocity.set(clipVelocity);
        if (_dbg) {
          console.log(`[_slideMove]   clipped vel=${this.velocity}`);
        }
      } else {
        // go along the crease
        if (numplanes !== 2) {
          if (_dbg) {
            console.log(`[_slideMove]   CLEAR vel: numplanes=${numplanes}`);
          }
          this.velocity.clear();
          break;
        }

        const dir = this.#slideCreaseDir.set(planes[0]).cross(planes[1]);
        const d = dir.dot(this.velocity);
        this.velocity.set(dir).multiply(d);
        if (_dbg) {
          console.log(`[_slideMove]   crease vel=${this.velocity}`);
        }
      }

      // if velocity is against the original velocity, stop dead
      // to avoid tiny oscillations in sloping corners
      if (primalVelocity.dot(this.velocity) <= 0) {
        if (_dbg) {
          console.log('[_slideMove]   DEAD STOP: vel against primal');
        }
        this.velocity.clear();
        break;
      }
    }

    if (_dbg) {
      console.log(`[_slideMove] done: origin ${_dbgStartOrigin} -> ${this.origin}, vel ${_dbgStartVelocity} -> ${this.velocity}`);
    }

    if (this.pmTime) {
      this.velocity.set(primalVelocity);
    }

    return blocked;
  }

  // =========================================================================
  // Step + slide move (Q2: PM_StepSlideMove – outer wrapper)
  // =========================================================================

  // --- Scratch Vectors for _stepSlideMove ---
  #stepStartOrigin = new Vector();
  #stepStartVelocity = new Vector();
  #stepDownOrigin = new Vector();
  #stepDownVelocity = new Vector();
  #stepUpOrigin = new Vector();
  #stepStickTarget = new Vector();
  #stepUp = new Vector();
  #stepDown = new Vector();

  /**
   * Each intersection will try to step over the obstruction instead of
   * sliding along it. This calls _slideMove twice: once without step-up,
   * once with step-up, and picks whichever went farther horizontally.
   */
  _stepSlideMove() { // Q2: PM_StepSlideMove
    const startOrigin = this.#stepStartOrigin.set(this.origin);
    const startVelocity = this.#stepStartVelocity.set(this.velocity);
    const wasOnGround = this.onground !== null;

    // try sliding at current height first
    const blocked = this._slideMove();

    // Only do the sticky ground snap when the initial slide moved cleanly.
    // If the move was blocked, keep evaluating the normal step-up retry
    // instead of short-circuiting on slope contact.
    if (!blocked && wasOnGround) {
      const stickTarget = this.#stepStickTarget.set(this.origin);
      stickTarget[2] -= STEPSIZE;
      const stickTrace = this._pmove.clipPlayerMove(this.origin, stickTarget);
      if (!stickTrace.allsolid && stickTrace.fraction < 1.0
          && stickTrace.plane.normal[2] >= MIN_STEP_NORMAL
          && stickTrace.plane.normal[2] < 1.0 // slope, not flat stair surface
      ) {
        if (stickTrace.endpos[2] < this.origin[2] - DIST_EPSILON) {
          this.origin.set(stickTrace.endpos);
        }
        if (stickTrace.ent !== null) {
          this.touchindices.push(stickTrace.ent);
        }
      }

      return;
    }

    const downOrigin = this.#stepDownOrigin.set(this.origin);
    const downVelocity = this.#stepDownVelocity.set(this.velocity);

    // try stepping up
    // Trace the actual upward movement rather than point-testing at the
    // full STEPSIZE height. In hallways with a low ceiling, the position
    // at startOrigin + STEPSIZE may be in solid even though the player
    // has enough room to step up onto the next stair step. Tracing the
    // upward movement lets us use however far we can actually reach —
    // partial step-ups still clear shorter stairs.
    const up = this.#stepUp.set(startOrigin);
    up[2] += STEPSIZE;

    const upTrace = this._pmove.clipPlayerMove(startOrigin, up);
    if (upTrace.allsolid) {
      return; // cannot step up at all (starting position is in solid)
    }
    // Use however far up we could actually move
    up.set(upTrace.endpos);

    // Record touches from step-up check (e.g. ceiling)
    if (upTrace.ent !== null) {
      this.touchindices.push(upTrace.ent);
    }

    // try sliding above
    this.origin.set(up);
    this.velocity.set(startVelocity);

    this._slideMove();

    // Push down after step-up slide.
    // Descending slope stutter is handled by the slope descent fix above
    // (first-path snap with normal[2] < 1.0 guard), so the step-up path
    // uses the standard STEPSIZE-below-origin range. The previous extended
    // range (startOrigin[2] - STEPSIZE) caused instant snapping on stairs
    // by tracing 2×STEPSIZE (36 units) down, finding the next step below.
    //
    // Floor limit: when a ceiling forced a partial step-up, the step-down
    // must not go below startOrigin. Without this, a partial step-up of N
    // followed by a full STEPSIZE step-down could descend (STEPSIZE - N)
    // units below the starting position, potentially snapping to a lower
    // step or a pit. With the full STEPSIZE step-up this floor is a no-op
    // since STEPSIZE - STEPSIZE = 0.
    const down = this.#stepDown.set(this.origin);
    down[2] -= STEPSIZE;
    const stepDownFloor = startOrigin[2] - DIST_EPSILON;
    if (down[2] < stepDownFloor) {
      down[2] = stepDownFloor;
    }

    const downStepTrace = this._pmove.clipPlayerMove(this.origin, down);
    if (!downStepTrace.allsolid) {
      this.origin.set(downStepTrace.endpos);
    }
    // Record touches from step-down trace (ground entities, buttons at feet level)
    if (downStepTrace.ent !== null) {
      this.touchindices.push(downStepTrace.ent);
    }

    const upOrigin = this.#stepUpOrigin.set(this.origin);

    // decide which one went farther (2D distance)
    const downDist =
      (downOrigin[0] - startOrigin[0]) * (downOrigin[0] - startOrigin[0]) +
      (downOrigin[1] - startOrigin[1]) * (downOrigin[1] - startOrigin[1]);
    const upDist =
      (upOrigin[0] - startOrigin[0]) * (upOrigin[0] - startOrigin[0]) +
      (upOrigin[1] - startOrigin[1]) * (upOrigin[1] - startOrigin[1]);

    if (downDist > upDist || downStepTrace.plane.normal[2] < MIN_STEP_NORMAL) {
      this.origin.set(downOrigin);
      this.velocity.set(downVelocity);
      return;
    }

    // special case: if we were walking along a plane, copy the Z velocity
    this.velocity[2] = downVelocity[2];
  }

  // =========================================================================
  // Movement modes
  // =========================================================================

  /** Air and ground movement dispatch. */
  _airMove() { // Q2: PM_AirMove
    const fmove = this.cmd.forwardmove;
    const smove = this.cmd.sidemove;

    // Project forward/right onto the horizontal plane and renormalize.
    // This prevents looking up/down from reducing horizontal move speed.
    const forward = this._angleVectors.forward.copy();
    const right = this._angleVectors.right.copy();
    forward[2] = 0;
    right[2] = 0;
    forward.normalize();
    right.normalize();

    const wishvel = new Vector(
      forward[0] * fmove + right[0] * smove,
      forward[1] * fmove + right[1] * smove,
      0,
    );

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    // clamp to server defined max speed
    const maxspeed = (this.pmFlags & PMF.DUCKED) ? this._pmove.movevars.duckspeed : this._pmove.movevars.maxspeed;

    if (wishspeed > maxspeed) {
      wishvel.multiply(maxspeed / wishspeed);
      wishspeed = maxspeed;
    }

    if (this._ladder) {
      // on ladder
      this._accelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);

      if (!wishvel[2]) {
        if (this.velocity[2] > 0) {
          this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
          if (this.velocity[2] < 0) {
            this.velocity[2] = 0;
          }
        } else {
          this.velocity[2] += this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
          if (this.velocity[2] > 0) {
            this.velocity[2] = 0;
          }
        }
      }

      this._stepSlideMove();
    } else if (this.onground !== null) {
      // walking on ground
      this.velocity[2] = 0;
      this._accelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);

      // apply gravity, handle negative gravity fields
      if (this._pmove.movevars.gravity > 0) {
        this.velocity[2] = 0;
      } else {
        this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
      }

      if (!this.velocity[0] && !this.velocity[1]) {
        return;
      }

      this._stepSlideMove();
    } else {
      // in air, little effect on velocity
      // Q2: falls back to regular accelerate when airaccelerate is 0
      // Q1: always uses airAccelerate
      if (!this._pmove.configuration.airAccelFallback || this._pmove.movevars.airaccelerate) {
        this._airAccelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);
      } else {
        this._accelerate(wishdir, wishspeed, 1);
      }

      // add gravity
      this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;

      this._stepSlideMove();
    }
  }

  /** Water movement. */
  _waterMove() { // Q2: PM_WaterMove / QW: PM_WaterMove
    const forward = this._angleVectors.forward;
    const right = this._angleVectors.right;

    const wishvel = new Vector(
      forward[0] * this.cmd.forwardmove + right[0] * this.cmd.sidemove,
      forward[1] * this.cmd.forwardmove + right[1] * this.cmd.sidemove,
      forward[2] * this.cmd.forwardmove + right[2] * this.cmd.sidemove,
    );

    if (!this.cmd.forwardmove && !this.cmd.sidemove && !this.cmd.upmove) {
      wishvel[2] -= 60; // drift towards bottom
    } else {
      wishvel[2] += this.cmd.upmove;
    }

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    if (wishspeed > this._pmove.movevars.maxspeed) {
      wishvel.multiply(this._pmove.movevars.maxspeed / wishspeed);
      wishspeed = this._pmove.movevars.maxspeed;
    }

    wishspeed *= this._pmove.configuration.waterspeedMultiplier;

    this._accelerate(wishdir, wishspeed, this._pmove.movevars.wateraccelerate);

    // QW-style water step-up: compute the intended destination, then trace
    // from STEPSIZE+1 above it straight down. If the trace succeeds the
    // player “steps up” onto a ledge or slope, allowing them to climb out
    // of the water at low edges. Only fall back to slideMove on failure.
    const dest = new Vector(
      this.origin[0] + this.frametime * this.velocity[0],
      this.origin[1] + this.frametime * this.velocity[1],
      this.origin[2] + this.frametime * this.velocity[2],
    );
    const start = dest.copy();
    start[2] += STEPSIZE + 1;

    const trace = this._pmove.clipPlayerMove(start, dest);

    if (!trace.startsolid && !trace.allsolid) {
      // walked up the step
      this.origin.set(trace.endpos);

      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }

      return;
    }

    // step-up failed - fall back to regular slide movement
    this._slideMove();
  }

  /**
   * Fly/spectator movement - noclip with friction.
   * Can be called by spectators or noclip modes.
   */
  _flyMove() { // Q2: PM_FlyMove
    this.viewheight = 22; // TODO: config

    // friction
    const speed = this.velocity.len();
    if (speed < 1) {
      this.velocity.clear();
    } else {
      const friction = this._pmove.movevars.friction * 1.5;
      const control = speed < this._pmove.movevars.stopspeed ? this._pmove.movevars.stopspeed : speed;
      const drop = control * friction * this.frametime;

      let newspeed = speed - drop;
      if (newspeed < 0) {
        newspeed = 0;
      }
      newspeed /= speed;

      this.velocity[0] *= newspeed;
      this.velocity[1] *= newspeed;
      this.velocity[2] *= newspeed;
    }

    // accelerate
    const fmove = this.cmd.forwardmove;
    const smove = this.cmd.sidemove;

    const fwd = this._angleVectors.forward.copy();
    const rgt = this._angleVectors.right.copy();
    fwd.normalize();
    rgt.normalize();

    const wishvel = new Vector(
      fwd[0] * fmove + rgt[0] * smove,
      fwd[1] * fmove + rgt[1] * smove,
      fwd[2] * fmove + rgt[2] * smove,
    );
    wishvel[2] += this.cmd.upmove;

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    if (wishspeed > this._pmove.movevars.spectatormaxspeed) {
      wishvel.multiply(this._pmove.movevars.spectatormaxspeed / wishspeed);
      wishspeed = this._pmove.movevars.spectatormaxspeed;
    }

    const currentspeed = this.velocity.dot(wishdir);
    const addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    let accelspeed = this._pmove.movevars.accelerate * this.frametime * wishspeed;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];

    // move
    this.origin[0] += this.frametime * this.velocity[0];
    this.origin[1] += this.frametime * this.velocity[1];
    this.origin[2] += this.frametime * this.velocity[2];
  }

  // =========================================================================
  // Position snapping / nudging
  // =========================================================================

  /**
   * Quantize position to 1/8 unit precision for network transmission
   * and nudge into a valid position.
   */
  _snapPosition() { // Q2: PM_SnapPosition
    // snap velocity to 1/8 unit precision (see SzBuffer)
    for (let i = 0; i < 3; i++) {
      this.velocity[i] = Math.round(this.velocity[i] * 8.0) / 8.0;
    }

    // Compute snap direction signs BEFORE rounding origin, so we know
    // which way to jitter when the snapped position lands in solid.
    const sign = [0, 0, 0];
    const base = new Vector();
    for (let i = 0; i < 3; i++) {
      const snapped = Math.round(this.origin[i] * 8.0);
      base[i] = snapped * 0.125;
      if (base[i] === this.origin[i]) {
        sign[i] = 0;
      } else if (this.origin[i] > base[i]) {
        sign[i] = 1;
      } else {
        sign[i] = -1;
      }
    }

    // try all jitter combinations (closest first)
    const jitterbits = [0, 4, 1, 2, 3, 5, 6, 7];
    for (let j = 0; j < 8; j++) {
      const bits = jitterbits[j];
      for (let i = 0; i < 3; i++) {
        this.origin[i] = base[i] + ((bits & (1 << i)) ? sign[i] * 0.125 : 0);
      }
      if (this._pmove.isValidPlayerPosition(this.origin)) {
        return;
      }
    }

    // couldn’t find a valid position - stay at snapped base
    if (PmovePlayer.DEBUG) {
      console.warn(`[_snapPosition] FAILED to find valid pos, stuck at base=${base}`);
    }
    this.origin.set(base);
  }

  /**
   * If pmove.origin is in a solid position,
   * try nudging slightly on all axes to
   * allow for the cut precision of the net coordinates.
   */
  _nudgePosition() { // Q2: PM_InitialSnapPosition / QW: NudgePosition
    const offsets = [0, -1, 1];
    const base = this.origin.copy();

    for (let z = 0; z < 3; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          this.origin[0] = base[0] + offsets[x] * 0.125;
          this.origin[1] = base[1] + offsets[y] * 0.125;
          this.origin[2] = base[2] + offsets[z] * 0.125;

          if (this._pmove.isValidPlayerPosition(this.origin)) {
            return;
          }
        }
      }
    }

    if (PmovePlayer.DEBUG) {
      console.warn(`[_nudgePosition] FAILED to find valid pos from base=${base}`);
    }
    this.origin.set(base);
  }
};

// ---------------------------------------------------------------------------
// Pmove: the world container (physents, collision infrastructure)
// ---------------------------------------------------------------------------

/**
 * PlayerMove class.
 * Holds the world (physents) and provides collision primitives.
 * Instantiate one per context (one for client prediction, one for server).
 */
export class Pmove { // pmove_t
  /** @deprecated import DIST_EPSILON instead */
  static DIST_EPSILON = DIST_EPSILON;
  /** @deprecated import STOP_EPSILON instead */
  static STOP_EPSILON = STOP_EPSILON;
  /** @deprecated import STEPSIZE instead */
  static STEPSIZE = STEPSIZE;

  static MAX_CLIP_PLANES = MAX_CLIP_PLANES;

  static PLAYER_MINS = new Vector(-16.0, -16.0, -24.0);
  static PLAYER_MAXS = new Vector(16.0, 16.0, 32.0);

  static MAX_PHYSENTS = 32;

  /** @type {Cvar} */
  static debug = null;

  static Init() {
    Pmove.debug = new Cvar('pm_debug', '0', Cvar.FLAG.NONE, 'pmove debug output');
  }

  static Shutdown() {
    Pmove.debug.free();
    Pmove.debug = null;
  }

  /** @type {PmoveConfiguration} parameters for certain checks */
  configuration = new PmoveConfiguration();

  /** @type {PhysEnt[]} 0 - world */
  physents = [];
  boxHull = new BoxHull();
  movevars = new MoveVars();

  /** @type {Map<string, Hull[]>} cache for pm hulls from mod hulls */
  #modelHullsCache = new Map();

  /**
   * Normalize static-world contents values so current volumes behave like water.
   * @param {number} contents raw contents value
   * @returns {number} normalized static-world contents value
   */
  _normalizeStaticWorldContents(contents) {
    if ((contents <= content.CONTENT_CURRENT_0) && (contents >= content.CONTENT_CURRENT_DOWN)) {
      return content.CONTENT_WATER;
    }

    return contents;
  }

  /**
   * Sample brush-backed static-world contents without exposing BSP details to callers.
   * @param {PhysEnt} worldPhysEnt world physent
   * @param {Vector} point position to sample
   * @returns {number} static-world contents value
   */
  _pointContentsBrushStaticWorld(worldPhysEnt, point) {
    console.assert(worldPhysEnt.brushWorldModel instanceof BrushModel, 'world brush model');

    if (!BrushTrace.transformedTestPosition(
      worldPhysEnt.brushWorldModel,
      point,
      Vector.origin,
      Vector.origin,
      Vector.origin,
      Vector.origin,
    )) {
      return content.CONTENT_SOLID;
    }

    return this._normalizeStaticWorldContents(worldPhysEnt.brushWorldModel.getLeafForPoint(point).contents);
  }

  /**
   * Sample static-world contents using the active world collision backend.
   * This queries the world physent only; dynamic entities and BSP submodels are
   * not included here.
   * @param {Vector} point position to sample
   * @returns {number} static-world contents value
   */
  staticWorldContents(point) {
    console.assert(this.physents[0] instanceof PhysEnt, 'world physent');

    const worldPhysEnt = this.physents[0];

    if (worldPhysEnt.brushWorldModel !== null) {
      return this._pointContentsBrushStaticWorld(worldPhysEnt, point);
    }

    const hull = worldPhysEnt.hulls[0]; // world
    console.assert(hull instanceof Hull, 'world hull');

    return this._normalizeStaticWorldContents(hull.pointContents(point));
  }

  /**
   * Compatibility alias for staticWorldContents.
   * @param {Vector} point position to sample
   * @returns {number} static-world contents value
   */
  worldContents(point) {
    return this.staticWorldContents(point);
  }

  /**
   * Compatibility alias for staticWorldContents.
   * @param {Vector} point position to sample
   * @returns {number} static-world contents value
   */
  pointContents(point) {
    return this.staticWorldContents(point);
  }

  /**
   * Normalize a player-move trace so startsolid results stop at the start point.
   * @param {Trace} trace trace to normalize
   * @param {Vector} start trace start position
   * @param {number} physEntIndex physent index for debug logging
   * @param {PhysEnt} physEnt physent that produced the trace
   * @returns {Trace} normalized trace
   */
  _finalizePlayerMoveTrace(trace, start, physEntIndex, physEnt) {
    if (trace.allsolid) {
      trace.startsolid = true;
    }

    if (trace.startsolid) {
      trace.fraction = 0.0;
      trace.endpos.set(start);
      if (PmovePlayer.DEBUG) {
        console.warn(`[clipPlayerMove] startsolid at physent ${physEntIndex} (edictId=${physEnt.edictId}), mode=${physEnt.usesBrushTracing ? 'brush' : 'hull'}`);
      }
    }

    return trace;
  }

  /**
   * Trace a player-sized move against the static world only.
   * Dynamic entities and BSP submodels owned by separate physents are not
   * included here.
   * @param {Vector} start starting point
   * @param {Vector} end end point (e.g. start + velocity * frametime)
   * @returns {Trace} trace object against the world physent only
   */
  traceStaticWorldPlayerMove(start, end) {
    console.assert(!Number.isNaN(start[0]) && !Number.isNaN(start[1]) && !Number.isNaN(start[2]), 'NaN start');
    console.assert(!Number.isNaN(end[0]) && !Number.isNaN(end[1]) && !Number.isNaN(end[2]), 'NaN end');
    console.assert(this.physents[0] instanceof PhysEnt, 'world physent');

    const worldPhysEnt = this.physents[0];
    const trace = worldPhysEnt.tracePlayerMove(start, end);

    console.assert(!Number.isNaN(trace.endpos[0]), 'NaN x');
    console.assert(!Number.isNaN(trace.endpos[1]), 'NaN y');
    console.assert(!Number.isNaN(trace.endpos[2]), 'NaN z');

    return this._finalizePlayerMoveTrace(trace, start, 0, worldPhysEnt);
  }

  #validPosTestScratch = new Vector();

  /**
   * @param {Vector} position player’s origin
   * @returns {boolean} Returns false if the given player position is not valid (in solid)
   */
  isValidPlayerPosition(position) {
    for (let i = 0; i < this.physents.length; i++) {
      const pe = this.physents[i];

      if (!pe.testPlayerPosition(position)) {
        if (PmovePlayer.DEBUG) {
          const test = pe.toCollisionSpace(position, this.#validPosTestScratch);
          console.warn(
            `[isValidPlayerPosition] BLOCKED by physent[${i}]`,
            `edictId=${pe.edictId}`,
            `mode=${pe.usesBrushTracing ? 'brush' : 'hull'}`,
            `model=${pe.brushModel?.name ?? 'world'}`,
            `pe.origin=${pe.origin}`,
            `testPos=${test}`,
            `worldPos=${position}`,
          );
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Attempts to move the player from start to end.
   * @param {Vector} start starting point
   * @param {Vector} end end point (e.g. start + velocity * frametime)
   * @returns {Trace} trace object
   */
  clipPlayerMove(start, end) {
    console.assert(!Number.isNaN(start[0]) && !Number.isNaN(start[1]) && !Number.isNaN(start[2]), 'NaN start');
    console.assert(!Number.isNaN(end[0]) && !Number.isNaN(end[1]) && !Number.isNaN(end[2]), 'NaN end');

    const totalTrace = new Trace();
    let sawStartsolid = false;
    let aggregateAllsolid = true;

    totalTrace.endpos.set(end);

    for (let i = 0; i < this.physents.length; i++) {
      const pe = this.physents[i];

      console.assert(!Number.isNaN(pe.origin[0]), 'NaN origin x');
      console.assert(!Number.isNaN(pe.origin[1]), 'NaN origin y');
      console.assert(!Number.isNaN(pe.origin[2]), 'NaN origin z');

      const trace = pe.tracePlayerMove(start, end);

      console.assert(!Number.isNaN(trace.endpos[0]), 'NaN x');
      console.assert(!Number.isNaN(trace.endpos[1]), 'NaN y');
      console.assert(!Number.isNaN(trace.endpos[2]), 'NaN z');

      this._finalizePlayerMoveTrace(trace, start, i, pe);

      sawStartsolid ||= trace.startsolid;
      aggregateAllsolid &&= trace.allsolid;

      // did we clip the move?
      if (trace.fraction < totalTrace.fraction) {
        totalTrace.set(trace);
        totalTrace.ent = i;
      }
    }

    totalTrace.startsolid = sawStartsolid;
    totalTrace.allsolid = sawStartsolid && aggregateAllsolid;

    if (totalTrace.startsolid) {
      totalTrace.fraction = 0.0;
      totalTrace.endpos.set(start);
    }

    console.assert(!Number.isNaN(totalTrace.endpos[0]), 'NaN x');
    console.assert(!Number.isNaN(totalTrace.endpos[1]), 'NaN y');
    console.assert(!Number.isNaN(totalTrace.endpos[2]), 'NaN z');

    return totalTrace;
  }

  /**
   * Sets worldmodel.
   * This will automatically reset all physents.
   * @param {BrushModel} model worldmodel
   * @returns {Pmove} this
   */
  setWorldmodel(model) {
    console.assert(model instanceof BrushModel, 'model');

    this.physents.length = 0;
    this.#modelHullsCache.clear();

    const pe = new PhysEnt(this);

    // Always set up hulls (hull0 needed for staticWorldContents fallback regardless of mode)
    for (const modelHull of model.hulls) {
      pe.hulls.push(Hull.fromModelHull(modelHull));
    }

    // Enable brush-based collision when the map has brush data
    if (model.hasBrushData) {
      pe.brushWorldModel = model;
      pe.brushHeadNode = model.hulls[0]?.firstclipnode ?? 0;
    }

    this.physents.push(pe);

    return this;
  }

  /**
   * Clears all entities.
   * @returns {Pmove} this
   */
  clearEntities() {
    this.physents.length = 1;
    return this;
  }

  /**
   * Adds an entity (client or server) to physents.
   * @param {import('../server/Edict.mjs').BaseEntity|import('../client/ClientEntities.mjs').ClientEdict} entity actual entity
   * @param {BrushModel|null} model model must be provided when entity is SOLID_BSP
   * @returns {Pmove} this
   */
  addEntity(entity, model = null) {
    const pe = new PhysEnt(this);

    console.assert(model === null || model instanceof BrushModel, 'no model or brush model required');
    console.assert(entity.origin instanceof Vector, 'valid entity origin', entity.origin);

    pe.origin.set(entity.origin);

    if ('angles' in entity && entity.angles instanceof Vector) {
      pe.angles.set(entity.angles);
    }

    if (model !== null) {
      // Check if the world model has brush data and this entity should use it
      const worldPe = this.physents[0];
      const worldHasBrushData = worldPe?.brushWorldModel?.hasBrushData;

      if (worldHasBrushData && model.numBrushes > 0) {
        // Brush-based collision: submodels use brute-force brush testing.
        // Their brushes are NOT in the BSP leaf-brush index (only world
        // brushes are), so we iterate the submodel's brush range directly.
        pe.brushWorldModel = worldPe.brushWorldModel;
        pe.brushModel = model;
      }

      // Always set up hull data as fallback (and for hull0 pointContents)
      if (this.#modelHullsCache.has(model.name)) {
        pe.hulls = this.#modelHullsCache.get(model.name);
      } else {
        for (const modelHull of model.hulls) {
          pe.hulls.push(Hull.fromModelHull(modelHull));
        }
        this.#modelHullsCache.set(model.name, pe.hulls);
      }
    } else {
      console.assert(entity.mins instanceof Vector, 'valid entity mins', entity.mins);
      console.assert(entity.maxs instanceof Vector, 'valid entity maxs', entity.maxs);

      pe.mins.set(entity.mins);
      pe.maxs.set(entity.maxs);

      // do not create hulls here, getClippingHull() applies it at trace time
      // For non-BSP entities, hull-based collision is always used (BoxHull)
    }

    if ('edictId' in entity) {
      pe.edictId = entity.edictId;
    }

    if ('num' in entity && entity.num > 0) {
      pe.edictId = entity.num;
    }

    this.physents.push(pe);

    return this;
  }

  /**
   * Returns a new player move engine.
   * @returns {PmovePlayer} player move engine
   */
  newPlayerMove() {
    return new PmovePlayer(this);
  }
};
