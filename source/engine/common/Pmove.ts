/*
 * Pmove: shared player movement code, designed to run identically on both
 * client (for prediction) and server (for authoritative simulation).
 *
 * Inspired by Quake 2’s pmove.c with structural elements from QuakeWorld.
 *
 * Original sources: pmove.c, pmovetst.c (Q2), pmove.c (Q1).
 */

/* eslint-disable jsdoc/require-returns */

import Vector, { DirectionalVectors } from '../../shared/Vector.ts';
import * as Protocol from '../network/Protocol.ts';
import { content, moveType } from '../../shared/Defs.ts';
import { BrushModel } from './Mod.ts';
import Cvar from './Cvar.ts';
import { PmoveConfiguration } from '../../shared/Pmove.ts';
import type { ClientEdict } from '../client/ClientEntities.ts';
import type { BaseEntity } from '../server/Edict.ts';
import { type Hull as BSPHull } from './model/BSP.ts';
import { BrushTrace } from './collision/BrushTrace.ts';
import { shouldUseHullTangentFallback } from './collision/BrushHullCompatibility.ts';
import { debugLogPositionMismatch, debugLogTraceMismatch, isAxialNormal } from './collision/BrushHullDiagnostics.ts';
import type { PlayerCollisionEntity, PlayerCollisionWorld } from './collision/CollisionContracts.ts';

export { BrushTrace };

export const DIST_EPSILON = 0.03125;
export const STOP_EPSILON = 0.1;
export const STEPSIZE = 18.0;

/** Minimum ground normal Z component - slopes steeper than ~45° are not walkable */
export const MIN_STEP_NORMAL = 0.7;

/** Maximum number of planes to clip against during slide moves */
export const MAX_CLIP_PLANES = 5;

/** Near-parallel planes from zero-progress brush re-clips are treated as duplicates */
export const ZERO_PROGRESS_DUPLICATE_DOT = 0.94;

/** Nearby walkable slope contact tolerance used by hull-tangent fallback gating. */
export const SLOPE_CONTACT_EPSILON = 1.0;

/**
 * Player movement flags (pmove-specific, separate from entity flags).
 * These travel with the player state and are used for prediction.
 */
export enum PMF {
  /** Player is ducked */
  DUCKED = (1 << 0),
  /** Player has jump button held (prevent re-jump) */
  JUMP_HELD = (1 << 1),
  /** Player is on the ground */
  ON_GROUND = (1 << 2),
  /** Timing: landing cooldown (prevents immediate re-jump after hard landing) */
  TIME_LAND = (1 << 3),
  /** Timing: water jump is active */
  TIME_WATERJUMP = (1 << 4),
  /** Timing: teleport freeze */
  TIME_TELEPORT = (1 << 5),
}

/**
 * Player movement types.
 */
export enum PM_TYPE {
  /** Normal movement */
  NORMAL = 0,
  /** Spectator - noclip flight */
  SPECTATOR = 1,
  /** Dead – reduced input, extra friction */
  DEAD = 2,
  /** Frozen – no movement at all */
  FREEZE = 3,
}

// ---------------------------------------------------------------------------
// MoveVars: shared physics tuning knobs
// ---------------------------------------------------------------------------

/**
 * Pmove variable defaults.
 *
 * Physics tuning knobs shared between client and server.
 */
export class MoveVars { // movevars_t
  /** World gravity strength. */
  gravity: number;
  /** Minimum speed preserved before friction stops the player. */
  stopspeed: number;
  /** Default maximum ground speed. */
  maxspeed: number;
  /** Maximum speed while in spectator flight. */
  spectatormaxspeed: number;
  /** Maximum speed while ducked. */
  duckspeed: number;
  /** Ground acceleration factor. */
  accelerate: number;
  /** Air acceleration factor. */
  airaccelerate: number;
  /** Water acceleration factor. */
  wateraccelerate: number;
  /** Ground friction multiplier. */
  friction: number;
  /** Water friction multiplier. */
  waterfriction: number;
  /** Base swimming speed. */
  waterspeed: number;
  /** Per-entity gravity scale. */
  entgravity: number;
  /** Extra friction applied near ledges. */
  edgefriction: number;

  constructor() {
    this.gravity = 800;
    this.stopspeed = 100;
    this.maxspeed = 320; // Q2: 300
    this.spectatormaxspeed = 500;
    this.duckspeed = 100;
    this.accelerate = 10;
    this.airaccelerate = 0.7;
    this.wateraccelerate = 10;
    this.friction = 6;
    this.waterfriction = 1;
    this.waterspeed = 400;
    this.entgravity = 1.0;
    this.edgefriction = 2;
  }
}

// ---------------------------------------------------------------------------
// Geometry primitives: Plane, Trace, ClipNode, Hull, BoxHull
// ---------------------------------------------------------------------------

export class Plane { // mplane_t
  /** Plane normal. */
  normal: Vector;
  /** Signed distance from the origin. */
  dist: number;
  /** Plane axis classification used by BSP tracing. */
  type: number;
  /** Cached sign bits for fast box-plane tests. */
  signBits: number;

  constructor() {
    this.normal = new Vector();
    this.dist = 0;
    this.type = 0;
    this.signBits = 0;
  }
}

export class Trace { // pmtrace_t
  /** Whether the entire trace volume stayed inside solid. */
  allsolid: boolean;
  /** Whether the start point began inside solid. */
  startsolid: boolean;
  /** Completed fraction of the attempted move. */
  fraction: number;
  /** Final position after clipping. */
  endpos: Vector;
  /** Impact plane for the first blocking hit. */
  plane: Plane;
  /** Physent index hit by the trace, or null when nothing was hit. */
  ent: number | null;
  /** Whether the trace entered open space. */
  inopen: boolean;
  /** Whether the trace entered water. */
  inwater: boolean;

  constructor() {
    this.allsolid = true;
    this.startsolid = false;
    this.fraction = 1.0;
    this.endpos = new Vector();
    this.plane = new Plane();
    this.ent = null;
    this.inopen = false;
    this.inwater = false;
  }

  /**
   * Sets this trace to the other trace.
   * @param other - source trace to copy from
   * @returns this trace after copying the values
   */
  set(other: Trace): this {
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
   * @returns duplicated trace state
   */
  copy(): Trace {
    const trace = new Trace();
    trace.set(this);
    return trace;
  }
}

export class ClipNode { // dclipnode_t
  /** Plane index used by this BSP clip node. */
  readonly planeNum: number;
  /** Child node indices or negative contents values. */
  readonly children: [number, number];

  constructor(planeNum = 0) {
    this.planeNum = planeNum;
    this.children = [0, 0];
  }
}

export class Hull { // hull_t
  /** Hull-space minimum bounds for this collision hull. */
  clipMins: Vector;
  /** Hull-space maximum bounds for this collision hull. */
  clipMaxs: Vector;
  /** First valid BSP clip node index. */
  firstClipNode: number;
  /** Last valid BSP clip node index. */
  lastClipNode: number;
  /** Optional mask restricting which clip nodes may be traversed. */
  allowedClipNodes: Uint8Array | null;
  /** BSP clip nodes used for hull traversal. */
  clipNodes: ClipNode[];
  /** Plane list referenced by the clip nodes. */
  planes: Plane[];

  constructor() {
    this.clipMins = new Vector();
    this.clipMaxs = new Vector();
    this.firstClipNode = 0;
    this.lastClipNode = 0;
    this.allowedClipNodes = null;
    this.clipNodes = [];
    this.planes = [];
  }

  /**
   * Clone collision data from a model hull into runtime Hull objects.
   * @param hull - source hull from model loading
   * @returns copied runtime hull
   */
  static fromModelHull(hull: BSPHull): Hull {
    const newHull = new Hull();
    newHull.clipMins = hull.clip_mins.copy();
    newHull.clipMaxs = hull.clip_maxs.copy();
    newHull.firstClipNode = hull.firstclipnode!;
    newHull.lastClipNode = hull.lastclipnode!;
    newHull.allowedClipNodes = hull.allowedClipNodes?.slice() ?? null;
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
   * @param point - point to classify in hull space
   * @param num - starting clip node index
   * @returns negative Quake contents value for the containing leaf
   */
  pointContents(point: Vector, num: number = this.firstClipNode): content {
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

  static readonly _midPool: Vector[] = Array.from({ length: 64 }, () => new Vector());

  /**
   * Check against hull.
   * @param p1f - starting fraction along the trace segment
   * @param p2f - ending fraction along the trace segment
   * @param p1 - start point in hull space
   * @param p2 - end point in hull space
   * @param trace - trace result being updated in place
   * @param num - current clip node index
   * @param depth - recursion depth for pooled midpoint scratch vectors
   * @returns true while traversal should continue, false after a blocking hit
   */
  check(p1f: number, p2f: number, p1: Vector, p2: Vector, trace: Trace, num: number = this.firstClipNode, depth: number = 0): boolean {
    // check for empty
    if (num < 0) {
      const contentNum = num as content;
      if (contentNum !== content.CONTENT_SOLID && contentNum !== content.CONTENT_SKY) {
        trace.allsolid = false;
        if (contentNum === content.CONTENT_EMPTY) {
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
    while (depth >= Hull._midPool.length) {
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
   * Configure the reusable box hull to match an entity bounding box.
   * @param mins - local minimum corner
   * @param maxs - local maximum corner
   * @returns this box hull for chaining
   */
  setSize(mins: Vector, maxs: Vector): this {
    console.assert(mins instanceof Vector, 'mins must be a Vector');
    console.assert(maxs instanceof Vector, 'maxs must be a Vector');

    // Even planes (0,2,4) use maxs; odd planes (1,3,5) use mins.
    // Matches Q1’s SV_HullForBox.
    for (let i = 0; i < 6; i++) {
      this.planes[i].dist = (i & 1) ? mins[i >> 1] : maxs[i >> 1];
    }

    return this;
  }
}

// ---------------------------------------------------------------------------
// PhysEnt: a physics entity stored in the Pmove world
// ---------------------------------------------------------------------------

export class PhysEnt implements PlayerCollisionEntity { // physent_t
  /** Legacy Q1 hulls used when brush tracing is unavailable. */
  hulls: Hull[];
  /** Entity origin in world space. */
  origin: Vector;
  /** Entity rotation used for transformed brush traces. */
  angles: Vector;
  /** Local bounding-box minimums for non-BSP entities. */
  mins: Vector;
  /** Local bounding-box maximums for non-BSP entities. */
  maxs: Vector;
  /** Owning edict index when this physent maps back to game state. */
  edictId: number | null;
  /** Shared world brush model used for Q2-style brush tracing. */
  brushWorldModel: BrushModel | null;
  /** BSP node root used when tracing against the world brush model. */
  brushHeadNode: number;
  /** Submodel brush range used for brute-force submodel tracing. */
  brushModel: BrushModel | null;
  readonly #pmoveRef: WeakRef<Pmove>;

  /**
   * @param pmove - parent pmove instance
   */
  constructor(pmove: Pmove) {
    this.hulls = [];
    this.origin = new Vector();
    this.angles = new Vector();
    this.mins = new Vector();
    this.maxs = new Vector();
    this.edictId = null;

    this.brushWorldModel = null;

    this.brushHeadNode = -1;

    this.brushModel = null;

    this.#pmoveRef = new WeakRef(pmove);
  }

  /** Parent Pmove instance. */
  get _pmove(): Pmove {
    const pmove = this.#pmoveRef.deref()!;
    console.assert(pmove !== undefined, 'physent parent Pmove was released');
    return pmove;
  }

  /**
   * Whether this entity uses brush-based collision (Q2-style).
   * When false, falls back to legacy hull-based collision (Q1-style).
   * @returns true when brush-based collision is available
   */
  get usesBrushTracing(): boolean {
    return this.brushWorldModel !== null && this.brushWorldModel.hasBrushData;
  }

  /**
   * Active brush collision model: submodels use their own brush range, world uses the world model.
   * @returns brush model to trace against
   */
  get brushCollisionModel(): BrushModel | null {
    return this.brushModel ?? this.brushWorldModel;
  }

  /**
   * Legacy hull comparisons are only meaningful for axis-aligned brush traces.
   * @returns true when brush-vs-hull debug comparisons are valid
   */
  get canCompareBrushAgainstHull(): boolean {
    return this.hulls.length > 0 && this.angles.isOrigin();
  }

  /**
   * Convert a point into this physent's legacy hull space.
   * @param point - point in world space
   * @param scratch - optional scratch vector to reuse
   * @returns point in local hull space
   */
  toHullSpace(point: Vector, scratch: Vector | null = null): Vector {
    const localPoint = scratch ?? point.copy();
    return localPoint.set(point).subtract(this.origin);
  }

  /**
   * Convert a point into the collision space expected by this physent.
   * Brush traces operate in world space; legacy hull traces use local space.
   * @param point - point in world space
   * @param scratch - optional scratch vector for hull conversion
   * @returns point in the active collision space
   */
  toCollisionSpace(point: Vector, scratch: Vector | null = null): Vector {
    if (this.usesBrushTracing) {
      return point;
    }

    return this.toHullSpace(point, scratch);
  }

  /**
   * Convert a point from this physent's collision space back to world space.
   * @param point - point in collision space
   * @param scratch - optional scratch vector for hull conversion
   * @returns point in world space
   */
  toWorldSpace(point: Vector, scratch: Vector | null = null): Vector {
    if (this.usesBrushTracing) {
      return point;
    }

    const worldPoint = scratch ?? point.copy();
    return worldPoint.set(point).add(this.origin);
  }

  readonly #hullMinsScratch = new Vector();
  readonly #hullMaxsScratch = new Vector();

  /**
   * Returns clipping hull for this entity (legacy Q1 hull-based path).
   * NOTE: This is not async/wait safe, since it will modify pmove’s boxHull in-place.
   * @returns hull used for legacy player traces
   */
  getClippingHull(): Hull {
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
   * @param start - world-space start position
   * @param end - world-space end position
   * @returns trace result for this physent
   */
  tracePlayerMove(start: Vector, end: Vector): Trace {
    const traceStart = this.toCollisionSpace(start);
    const traceEnd = this.toCollisionSpace(end);

    if (this.usesBrushTracing) {
      console.assert(this.brushCollisionModel !== null, 'brush tracing expected a valid collision model');

      const brushTrace = BrushTrace.transformedBoxTrace(
        this.brushCollisionModel!,
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
        const comparableContact = isAxialNormal(brushTrace.plane.normal, DIST_EPSILON)
          || isAxialNormal(hullTrace.plane.normal, DIST_EPSILON);

        if (brushBlocks !== hullBlocks && comparableContact) {
          debugLogTraceMismatch({
            edictId: this.edictId,
            model: this.brushModel,
            start,
            end,
            brushTrace,
            hullTrace,
            brushBlocks,
            hullBlocks,
            playerMins: Pmove.PLAYER_MINS,
            playerMaxs: Pmove.PLAYER_MAXS,
            distEpsilon: DIST_EPSILON,
          });
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
   * @param position - world-space position to test
   * @returns true when the position is valid and not in solid
   */
  testPlayerPosition(position: Vector): boolean {
    if (this.usesBrushTracing) {
      console.assert(this.brushCollisionModel !== null, 'brush tracing expected a valid collision model');

      const brushResult = BrushTrace.transformedTestPosition(
        this.brushCollisionModel!,
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

        if (brushResult && !hullResult && this.brushCollisionModel !== null
          && shouldUseHullTangentFallback({
            model: this.brushCollisionModel,
            position,
            hull,
            localPosition,
            playerMins: Pmove.PLAYER_MINS,
            playerMaxs: Pmove.PLAYER_MAXS,
            distEpsilon: DIST_EPSILON,
            minStepNormal: MIN_STEP_NORMAL,
            slopeContactEpsilon: SLOPE_CONTACT_EPSILON,
          })) {
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
          debugLogPositionMismatch({
            edictId: this.edictId,
            model: this.brushModel,
            position,
            brushResult,
            hullResult,
            playerMins: Pmove.PLAYER_MINS,
            playerMaxs: Pmove.PLAYER_MAXS,
            distEpsilon: DIST_EPSILON,
          });
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
}

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
  /** Frame time derived from the current user command. */
  frametime: number;
  /** Water depth from 0 to 3. */
  waterlevel: number;
  /** Current water contents value. */
  watertype: content;
  /** Ground physent index, or null while airborne. */
  onground: number | null;
  /** Player origin in world space. */
  origin: Vector;
  /** Player velocity in world units per second. */
  velocity: Vector;
  /** Resolved view angles used for movement. */
  angles: Vector;
  /** Current movement mode. */
  pmType: PM_TYPE;
  /** Player movement flags bitmask. */
  pmFlags: number;
  /** Timing counter for landing, teleport, and water-jump states. */
  pmTime: number;
  /** View height offset from the origin. */
  viewheight: number;
  /** Previous frame button state for edge-triggered input. */
  oldbuttons: number;
  /** Quake 1 water-jump timer compatibility field. */
  waterjumptime: number;
  /** Backwards-compatible spectator flag. */
  spectator: boolean;
  /** Backwards-compatible dead-player flag. */
  dead: boolean;
  /** Current input command being simulated. */
  cmd: Protocol.UserCmd;
  /** Physent indices touched during this frame. */
  touchindices: number[];
  /** Whether the player is on a ladder this frame. */
  _ladder: boolean;
  /** Cached angle vectors for the current view angles. */
  _angleVectors: DirectionalVectors | null;
  readonly #pmoveRef: WeakRef<Pmove>;

  /** Enables verbose movement debugging. */
  static get DEBUG(): boolean {
    return (Pmove.debug?.value ?? 0) !== 0;
  }

  /**
   * Resolves the PM_TYPE a player should simulate with, from its
   * authoritative entity state. Shared by server-authoritative movement and
   * the wire protocol writer so client-side prediction can be seeded with
   * the exact same movement type the server used, keeping the two in
   * lockstep (e.g. a noclip/spectating player must predict as SPECTATOR,
   * not fall under gravity and collide with walls it can actually fly
   * through server-side).
   * @param deadflag entity's deadflag value (0 = alive).
   * @param entityMovetype entity's current movetype.
   * @returns the PM_TYPE to simulate with.
   */
  static resolvePmType(deadflag: number, entityMovetype: moveType): PM_TYPE {
    if (deadflag > 0) {
      return PM_TYPE.DEAD;
    }
    if (entityMovetype === moveType.MOVETYPE_NOCLIP) {
      return PM_TYPE.SPECTATOR;
    }
    return PM_TYPE.NORMAL;
  }

  /**
   * @param pmove - pmove instance containing world collision state
   */
  constructor(pmove: Pmove) {
    // --- Public state (read/write by caller) ---

    this.frametime = 0;
    this.waterlevel = 0;
    this.watertype = 0;

    this.onground = null;

    this.origin = new Vector();
    this.velocity = new Vector();
    this.angles = new Vector();

    this.pmType = PM_TYPE.NORMAL;
    this.pmFlags = 0;
    this.pmTime = 0;

    this.viewheight = 22;

    this.oldbuttons = 0;
    this.waterjumptime = 0.0;
    this.spectator = false;
    this.dead = false;

    this.cmd = new Protocol.UserCmd();

    this.touchindices = [];

    // --- Private ---

    this._ladder = false;

    this._angleVectors = null;

    this.#pmoveRef = new WeakRef(pmove);
  }

  /** Parent Pmove instance. */
  get _pmove(): Pmove {
    const pmove = this.#pmoveRef.deref()!;
    console.assert(pmove !== undefined, 'PmovePlayer parent Pmove was released');
    return pmove;
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
      const moved = !this.origin.equals(_dbgOriginBefore!);
      const snapMoved = !this.origin.equals(_dbgBeforeSnap!);
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

    console.assert(this._angleVectors instanceof DirectionalVectors, 'angle vectors should be set by _clampAngles before checking special movement');

    // check for ladder
    const flatforward = new Vector(this._angleVectors!.forward[0], this._angleVectors!.forward[1], 0);
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
   * @param veloIn - input velocity
   * @param normal - surface normal
   * @param veloOut - output velocity, which may alias the input
   * @param overbounce - overbounce factor used by Quake movement
   */
  _clipVelocity(veloIn: Vector, normal: Vector, veloOut: Vector, overbounce: number) { // Q2: PM_ClipVelocity
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
   * @param wishdir - desired movement direction as a unit vector
   * @param wishspeed - desired movement speed
   * @param accel - acceleration factor to apply this frame
   */
  _accelerate(wishdir: Vector, wishspeed: number, accel: number) { // Q2: PM_Accelerate
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
   * @param wishdir - desired movement direction as a unit vector
   * @param wishspeed - uncapped desired movement speed
   * @param accel - acceleration factor to apply this frame
   */
  _airAccelerate(wishdir: Vector, wishspeed: number, accel: number) { // Q2: PM_AirAccelerate
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
  readonly #slidePrimalVelocity = new Vector();
  readonly #slideEnd = new Vector();
  readonly #slideClipVelocity = new Vector();
  readonly #slideWorkVelocity = new Vector();
  readonly #slideCreaseDir = new Vector();
  readonly #slidePlanes = Array.from({ length: MAX_CLIP_PLANES }, () => new Vector());

  /**
   * Brush bevels can report a second zero-progress hit whose normal only
   * differs slightly from the wall we already clipped against. Treat that as a
   * duplicate plane so we keep sliding instead of manufacturing a bogus crease.
   * FTEQW also skips true duplicate wall planes from brush seams outright.
   * @param normal - candidate collision plane normal
   * @param planeCount - number of existing slide planes
   * @param planes - accumulated slide plane normals
   * @param fraction - trace fraction for the candidate collision
   * @returns true when the candidate plane should be merged into an existing one
   */
  _isDuplicateSlidePlane(normal: Vector, planeCount: number, planes: Vector[], fraction: number): boolean {
    for (let i = 0; i < planeCount; i++) {
      const plane = planes[i];
      const dx = plane[0] - normal[0];
      const dy = plane[1] - normal[1];
      const dz = plane[2] - normal[2];

      // FTEQW-style seam duplicate check.
      if ((dx * dx + dy * dy + dz * dz) <= (0.01 * 0.01)) {
        return true;
      }

      // Keep the zero-progress near-parallel guard to avoid bogus crease
      // velocity when brush traces re-clip against the same wall bevel.
      if (fraction === 0.0 && normal.dot(plane) > ZERO_PROGRESS_DUPLICATE_DOT) {
        return true;
      }
    }

    return false;
  }

  /**
   * The basic solid body movement clip that slides along multiple planes.
   * This is the inner loop, it does NOT attempt step-up.
   */
  _slideMove(): boolean { // Q1: SV_FlyMove / Q2: PM_StepSlideMove_
    const _dbg = PmovePlayer.DEBUG;
    const _dbgStartOrigin = _dbg ? this.origin.copy() : null;
    const _dbgStartVelocity = _dbg ? this.velocity.copy() : null;
    const numbumps = 4;
    const primalVelocity = this.#slidePrimalVelocity.set(this.velocity);
    let numplanes = 0;
    const planes: Vector[] = this.#slidePlanes;
    let timeLeft = this.frametime;
    const end = this.#slideEnd;
    const clipVelocity = this.#slideClipVelocity;
    const workVelocity = this.#slideWorkVelocity;
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
        continue;
      }

      planes[numplanes].set(traceNormal);
      numplanes++;

      // FTEQW/Q2 style: clip velocity in-place while searching for a
      // candidate that satisfies all accumulated planes.
      workVelocity.set(this.velocity);
      let i, j;
      for (i = 0; i < numplanes; i++) {
        this._clipVelocity(workVelocity, planes[i], clipVelocity, this._pmove.configuration.overbounce);
        workVelocity.set(clipVelocity);

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
        if (dir.normalize() <= DIST_EPSILON) {
          this.velocity.clear();
          break;
        }

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
  readonly #stepStartOrigin = new Vector();
  readonly #stepStartVelocity = new Vector();
  readonly #stepDownOrigin = new Vector();
  readonly #stepDownVelocity = new Vector();
  readonly #stepUpOrigin = new Vector();
  readonly #stepStickTarget = new Vector();
  readonly #stepUp = new Vector();
  readonly #stepDown = new Vector();

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

    console.assert(this._angleVectors instanceof DirectionalVectors, 'angle vectors should be set by _clampAngles before air move');

    // Project forward/right onto the horizontal plane and renormalize.
    // This prevents looking up/down from reducing horizontal move speed.
    const forward = this._angleVectors!.forward.copy();
    const right = this._angleVectors!.right.copy();
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
    console.assert(this._angleVectors instanceof DirectionalVectors, 'angle vectors should be set by _clampAngles before water move');

    const forward = this._angleVectors!.forward;
    const right = this._angleVectors!.right;

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

    console.assert(this._angleVectors instanceof DirectionalVectors, 'angle vectors should be set by _clampAngles before fly move');
    const fwd = this._angleVectors!.forward.copy();
    const rgt = this._angleVectors!.right.copy();
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

  readonly #snapCandidate = new Vector();
  readonly #snapProbeTarget = new Vector();
  readonly #snapProbeDir = new Vector();
  readonly #snapBestCandidate = new Vector();

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

    let bestScore = -Infinity;
    let found = false;

    const probeDir = this.#snapProbeDir.clear();
    if (this.pmType !== PM_TYPE.SPECTATOR && this._angleVectors instanceof DirectionalVectors) {
      const forward = this._angleVectors.forward;
      const right = this._angleVectors.right;
      probeDir[0] = forward[0] * this.cmd.forwardmove + right[0] * this.cmd.sidemove;
      probeDir[1] = forward[1] * this.cmd.forwardmove + right[1] * this.cmd.sidemove;
    }
    probeDir[2] = 0;

    // After a corner dead-stop, velocity may already be zero; fall back to
    // current horizontal velocity only when there is no directional input.
    if (probeDir.normalize() <= STOP_EPSILON) {
      probeDir.set(this.velocity);
      probeDir[2] = 0;
    }

    const shouldProbeForward = this.pmType !== PM_TYPE.SPECTATOR && probeDir.normalize() > STOP_EPSILON;
    if (shouldProbeForward) {
      probeDir.multiply(4.0);
    }

    // For snapped positions, multiple jitter candidates may be valid but not
    // equally playable. Score each valid candidate by short forward progress
    // and keep the best one so we avoid selecting corner-tangent dead spots.
    const axisOffsets = [
      sign[0] === 0 ? [0, -0.125, 0.125] : [0, sign[0] * 0.125],
      sign[1] === 0 ? [0, -0.125, 0.125] : [0, sign[1] * 0.125],
      sign[2] === 0 ? [0, -0.125, 0.125] : [0, sign[2] * 0.125],
    ];

    for (let z = 0; z < axisOffsets[2].length; z++) {
      for (let x = 0; x < axisOffsets[0].length; x++) {
        for (let y = 0; y < axisOffsets[1].length; y++) {
          const candidate = this.#snapCandidate;
          candidate[0] = base[0] + axisOffsets[0][x];
          candidate[1] = base[1] + axisOffsets[1][y];
          candidate[2] = base[2] + axisOffsets[2][z];

          if (!this._pmove.isValidPlayerPosition(candidate)) {
            continue;
          }

          let score = 0;
          if (shouldProbeForward) {
            const probeTarget = this.#snapProbeTarget.set(candidate).add(probeDir);
            const probeTrace = this._pmove.clipPlayerMove(candidate, probeTarget);
            score = probeTrace.fraction;
          }

          if (!found || score > bestScore) {
            found = true;
            bestScore = score;
            this.#snapBestCandidate.set(candidate);

            if (!shouldProbeForward || score >= 1.0) {
              break;
            }
          }
        }
      }
    }

    if (found) {
      this.origin.set(this.#snapBestCandidate);
      return;
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
}

// ---------------------------------------------------------------------------
// Pmove: the world container (physents, collision infrastructure)
// ---------------------------------------------------------------------------

/**
 * PlayerMove class.
 * Holds the world (physents) and provides collision primitives.
 * Instantiate one per context (one for client prediction, one for server).
 */
export class Pmove implements PlayerCollisionWorld { // pmove_t
  static MAX_CLIP_PLANES = MAX_CLIP_PLANES;

  static readonly PLAYER_MINS = new Vector(-16.0, -16.0, -24.0);
  static readonly PLAYER_MAXS = new Vector(16.0, 16.0, 32.0);

  static readonly MAX_PHYSENTS = 32;

  static debug: Cvar | null = null;

  /** Runtime configuration shared by client and server movement. */
  configuration = new PmoveConfiguration();
  /** Physics entities, with index 0 reserved for the static world. */
  physents: PhysEnt[] = [];
  /** Reusable box hull for non-BSP entity collision. */
  boxHull = new BoxHull();
  /** Movement tuning variables shared by simulated players. */
  movevars = new MoveVars();

  static Init() {
    Pmove.debug = new Cvar('pm_debug', '0', Cvar.FLAG.NONE, 'pmove debug output');
  }

  static Shutdown() {
    Pmove.debug!.free();
    Pmove.debug = null;
  }

  /** Cache for cloned model hulls keyed by model name. */
  readonly #modelHullsCache = new Map<string, Hull[]>();

  /**
   * Normalize static-world contents values so current volumes behave like water.
   * @param contents - raw contents value from the collision backend
   * @returns normalized static-world contents value
   */
  _normalizeStaticWorldContents(contents: content): content {
    if ((contents <= content.CONTENT_CURRENT_0) && (contents >= content.CONTENT_CURRENT_DOWN)) {
      return content.CONTENT_WATER;
    }

    return contents;
  }

  /**
   * Sample brush-backed static-world contents without exposing BSP details to callers.
   * @param worldPhysEnt - world physent holding the active brush model
   * @param point - world-space position to sample
   * @returns static-world contents value
   */
  _pointContentsBrushStaticWorld(worldPhysEnt: PhysEnt, point: Vector): number {
    console.assert(worldPhysEnt.brushWorldModel instanceof BrushModel, 'world brush model');

    if (!BrushTrace.transformedTestPosition(
      worldPhysEnt.brushWorldModel!,
      point,
      Vector.origin,
      Vector.origin,
      Vector.origin,
      Vector.origin,
    )) {
      return content.CONTENT_SOLID;
    }

    return this._normalizeStaticWorldContents(worldPhysEnt.brushWorldModel!.getLeafForPoint(point).contents);
  }

  /**
   * Sample static-world contents using the active world collision backend.
   * This queries the world physent only; dynamic entities and BSP submodels are
   * not included here.
   * @param point - world-space position to sample
   * @returns static-world contents value
   */
  staticWorldContents(point: Vector): content {
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
   * @param point - world-space position to sample
   * @returns static-world contents value
   */
  worldContents(point: Vector): number {
    return this.staticWorldContents(point);
  }

  /**
   * Compatibility alias for staticWorldContents.
   * @param point - world-space position to sample
   * @returns static-world contents value
   */
  pointContents(point: Vector): number {
    return this.staticWorldContents(point);
  }

  /**
   * Normalize a player-move trace so startsolid results stop at the start point.
   * @param trace - trace to normalize in place
   * @param start - original trace start position
   * @param physEntIndex - physent index used for debug logging
   * @param physEnt - physent that produced the trace
   * @returns normalized trace
   */
  _finalizePlayerMoveTrace(trace: Trace, start: Vector, physEntIndex: number, physEnt: PhysEnt): Trace {
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
   * @param start - starting point
   * @param end - end point, usually start plus velocity times frame time
   * @returns trace against the world physent only
   */
  traceStaticWorldPlayerMove(start: Vector, end: Vector): Trace {
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

  readonly #validPosTestScratch = new Vector();

  /**
   * Check whether a player-sized box can occupy the given world-space position.
   * @param position - player origin to validate
   * @returns true when no physent blocks the position
   */
  isValidPlayerPosition(position: Vector): boolean {
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
   * @param start - starting point
   * @param end - end point, usually start plus velocity times frame time
   * @returns earliest blocking trace across all physents
   */
  clipPlayerMove(start: Vector, end: Vector): Trace {
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
   * @param model - world brush model to use as physent zero
   * @returns this pmove instance
   */
  setWorldmodel(model: BrushModel): this {
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
   * @returns this pmove instance
   */
  clearEntities(): this {
    this.physents.length = 1;
    return this;
  }

  /**
   * Adds an entity (client or server) to physents.
   * @param entity - entity state to mirror into the physent list
   * @param model - brush model to use for SOLID_BSP-style entities
   * @returns this pmove instance
   */
  addEntity(entity: BaseEntity | ClientEdict, model: BrushModel | null = null): this {
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
        pe.hulls = this.#modelHullsCache.get(model.name)!;
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

    if ('edictId' in entity && typeof entity.edictId === 'number') {
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
   * @returns fresh per-player movement state bound to this pmove world
   */
  newPlayerMove(): PmovePlayer {
    return new PmovePlayer(this);
  }
}
