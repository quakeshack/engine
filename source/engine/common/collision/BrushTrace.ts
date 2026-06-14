import Vector from '../../../shared/Vector.ts';
import { content } from '../../../shared/Defs.ts';
import { BrushModel } from '../Mod.ts';
import { DIST_EPSILON, MIN_STEP_NORMAL, Trace } from '../Pmove.ts';
import { Node, type Brush } from '../model/BSP.ts';

/* eslint-disable jsdoc/require-returns */

type BrushTraceTransform = { readonly origin: Vector; readonly basis: number[] | null } | null;

interface BrushTracePlane {
  readonly normal: Vector;
  readonly dist: number;
  readonly type: number;
}

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
  static _checkCount: number = 0;

  /**
   * Prefer non-axial candidate planes over axial wall planes when enter
   * fractions are nearly identical.
   */
  static _preferCandidatePlane(currentPlane: BrushTracePlane | null, currentEnter: number, candidatePlane: BrushTracePlane, candidateEnter: number, epsilon: number): boolean {
    if (currentPlane === null) {
      return true;
    }

    if (candidateEnter > currentEnter + epsilon) {
      return true;
    }

    if (Math.abs(candidateEnter - currentEnter) > epsilon) {
      return false;
    }

    const currentAxialWall = currentPlane.type < 3 && Math.abs(currentPlane.normal[2]) <= DIST_EPSILON;
    const candidateWalkableSlope = candidatePlane.type >= 3 && candidatePlane.normal[2] >= MIN_STEP_NORMAL;

    if (candidateWalkableSlope && currentAxialWall) {
      return true;
    }

    const candidateAxialWall = candidatePlane.type < 3 && Math.abs(candidatePlane.normal[2]) <= DIST_EPSILON;
    const currentNonWalkableNonAxial = currentPlane.type >= 3 && currentPlane.normal[2] < MIN_STEP_NORMAL;

    if (candidateAxialWall && currentNonWalkableNonAxial) {
      return true;
    }

    return false;
  }

  /**
   * Resolve near-equal global hit ties between candidate planes.
   */
  static _preferEquivalentHitPlane(currentPlane: BrushTracePlane, candidatePlane: BrushTracePlane): boolean {
    const currentAxialWall = currentPlane.type < 3 && Math.abs(currentPlane.normal[2]) <= DIST_EPSILON;
    const candidateAxialWall = candidatePlane.type < 3 && Math.abs(candidatePlane.normal[2]) <= DIST_EPSILON;
    const currentWalkableSlope = currentPlane.type >= 3 && currentPlane.normal[2] >= MIN_STEP_NORMAL;
    const candidateWalkableSlope = candidatePlane.type >= 3 && candidatePlane.normal[2] >= MIN_STEP_NORMAL;

    if (candidateWalkableSlope && currentAxialWall) {
      return true;
    }

    if (candidateAxialWall && !currentWalkableSlope && currentPlane.type >= 3) {
      return true;
    }

    return false;
  }

  /**
   * Test whether two axis-aligned bounding boxes overlap.
   */
  static _boundsOverlap(mins1: Vector, maxs1: Vector, mins2: Vector, maxs2: Vector): boolean {
    return mins1[0] <= maxs2[0] && mins1[1] <= maxs2[1] && mins1[2] <= maxs2[2]
      && maxs1[0] >= mins2[0] && maxs1[1] >= mins2[1] && maxs1[2] >= mins2[2];
  }

  /**
   * Compute the swept world-space bounds of a point or box move.
   */
  static _computeSweepBounds(start: Vector, end: Vector, mins: Vector, maxs: Vector): { mins: Vector; maxs: Vector } {
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
   */
  static _computePositionBounds(position: Vector, mins: Vector, maxs: Vector): { mins: Vector; maxs: Vector } {
    return {
      mins: new Vector(position[0] + mins[0], position[1] + mins[1], position[2] + mins[2]),
      maxs: new Vector(position[0] + maxs[0], position[1] + maxs[1], position[2] + maxs[2]),
    };
  }

  /**
   * Check whether a brush AABB can possibly overlap the current swept move.
   */
  static _brushMayAffectTrace(ctx: BrushTraceContext, brush: Brush): boolean {
    if (brush.mins === null || brush.mins === undefined || brush.maxs === null || brush.maxs === undefined) {
      return true;
    }

    return BrushTrace._boundsOverlap(ctx.sweepMins, ctx.sweepMaxs, brush.mins, brush.maxs);
  }

  /**
   * Check whether a brush AABB can possibly overlap the current position test.
   */
  static _brushMayAffectPosition(brush: Brush, boundsMins: Vector, boundsMaxs: Vector): boolean {
    if (brush.mins === null || brush.mins === undefined || brush.maxs === null || brush.maxs === undefined) {
      return true;
    }

    return BrushTrace._boundsOverlap(boundsMins, boundsMaxs, brush.mins, brush.maxs);
  }

  /**
   * Estimate the earliest global trace fraction where a swept point/box can
   * enter a node's bounds. Used only for pruning; false negatives are avoided
   * by falling back when bounds are missing.
   */
  static _estimateNodeEntryFraction(ctx: BrushTraceContext, node: Node): number {
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
   */
  static _nodeMayAffectTrace(ctx: BrushTraceContext, node: Node): boolean {
    if (node.mins === null || node.mins === undefined || node.maxs === null || node.maxs === undefined) {
      return true;
    }

    if (!BrushTrace._boundsOverlap(ctx.sweepMins, ctx.sweepMaxs, node.mins, node.maxs)) {
      return false;
    }

    return BrushTrace._estimateNodeEntryFraction(ctx, node) <= ctx.trace.fraction;
  }

  /**
   * Resolve the head node for world-model BSP traversal.
   */
  static _getHeadNode(model: BrushModel): number {
    return model.hulls[0]?.firstclipnode ?? 0;
  }

  /**
   * Dispatch a brush trace against either a submodel brush range or a world BSP.
   * @param model - model to trace against
   * @param start - world-space start point
   * @param end - world-space end point
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @returns trace result in model space or world space as appropriate
   */
  static _traceModel(model: BrushModel, start: Vector, end: Vector, mins: Vector, maxs: Vector): Trace {
    return model.submodel
      ? BrushTrace.boxTraceModel(model, start, end, mins, maxs)
      : BrushTrace.boxTrace(model, BrushTrace._getHeadNode(model), start, end, mins, maxs);
  }

  /**
   * Dispatch a position test against either a submodel brush range or a world BSP.
   * @param model - model to test against
   * @param position - world-space position to test
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @returns true when the position does not overlap solid brush geometry
   */
  static _testModelPosition(model: BrushModel, position: Vector, mins: Vector, maxs: Vector): boolean {
    return model.submodel
      ? BrushTrace.testPositionModel(model, position, mins, maxs)
      : BrushTrace.testPosition(model, BrushTrace._getHeadNode(model), position, mins, maxs);
  }

  /**
   * Resolve the entity transform used by shared brush collision helpers.
   * @param origin - entity origin in world space
   * @param angles - entity rotation angles
   * @returns cached transform data, or null when no transform is needed
   */
  static _getTransformContext(origin: Vector, angles: Vector): BrushTraceTransform {
    const basis = angles.isOrigin() ? null : angles.toRotationMatrix();

    if (basis === null && origin.isOrigin()) {
      return null;
    }

    return { origin, basis };
  }

  /**
   * Convert a world-space point into local model space for an entity transform.
   * @param point - point in world space
   * @param transform - entity transform context
   * @returns point in local model space
   */
  static _toLocalPoint(point: Vector, transform: BrushTraceTransform): Vector {
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
   * @param model - brush model to trace against
   * @param start - world-space start point
   * @param end - world-space end point
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @param origin - entity origin applied before tracing
   * @param angles - entity rotation applied before tracing
   * @returns world-space trace result
   */
  static transformedBoxTrace(model: BrushModel, start: Vector, end: Vector, mins: Vector, maxs: Vector, origin: Vector = Vector.origin, angles: Vector = Vector.origin): Trace {
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
   * @param model - brush model to test against
   * @param position - world-space position to test
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @param origin - entity origin applied before testing
   * @param angles - entity rotation applied before testing
   * @returns true when the transformed box does not overlap solid brush geometry
   */
  static transformedTestPosition(model: BrushModel, position: Vector, mins: Vector, maxs: Vector, origin: Vector = Vector.origin, angles: Vector = Vector.origin): boolean {
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
   * @param worldModel - world brush model with BSP data
   * @param headNode - BSP node index to start traversal from
   * @param start - world-space start point
   * @param end - world-space end point
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @returns trace result against BSP brushes
   */
  static boxTrace(worldModel: BrushModel, headNode: number, start: Vector, end: Vector, mins: Vector, maxs: Vector): Trace {
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

    const ctx: BrushTraceContext = {
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
      trueFraction: 1.0,
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
   * @param worldModel - world brush model with BSP data
   * @param headNode - BSP node index to start traversal from
   * @param position - world-space position to test
   * @param mins - box minimum corner relative to the origin
   * @param maxs - box maximum corner relative to the origin
   * @returns true when the position is clear of solid brushes
   */
  static testPosition(worldModel: BrushModel, headNode: number, position: Vector, mins: Vector, maxs: Vector): boolean {
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
   */
  static _testPositionRecursive(worldModel: BrushModel, node: Node, position: Vector, mins: Vector, maxs: Vector, boundsMins: Vector, boundsMaxs: Vector, extents: Vector, isPoint: boolean, checkCount: number): boolean {
    if (node.mins !== null && node.mins !== undefined && node.maxs !== null && node.maxs !== undefined
      && !BrushTrace._boundsOverlap(boundsMins, boundsMaxs, node.mins, node.maxs)) {
      return false;
    }

    // Leaf node: test all brushes in this leaf
    if (node.contents < content.CONTENT_NONE) {
      return BrushTrace._testLeafSolid(worldModel, node, position, mins, maxs, boundsMins, boundsMaxs, checkCount);
    }

    // Internal node: test which side(s) of the splitting plane the box is on
    const plane = node.plane!;
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
      const frontChild = node.children[0];
      console.assert(typeof frontChild === 'object' && frontChild !== null, 'brush trace expected linked BSP child node');
      if (typeof frontChild !== 'object' || frontChild === null) {
        return false;
      }
      return BrushTrace._testPositionRecursive(
        worldModel, frontChild as Node, position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
      );
    }

    // Entirely on back side
    if (d < -offset) {
      const backChild = node.children[1];
      console.assert(typeof backChild === 'object' && backChild !== null, 'brush trace expected linked BSP child node');
      if (typeof backChild !== 'object' || backChild === null) {
        return false;
      }
      return BrushTrace._testPositionRecursive(
        worldModel, backChild as Node, position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
      );
    }

    // Box straddles the plane: test both sides
    const frontChild = node.children[0];
    const backChild = node.children[1];
    console.assert(typeof frontChild === 'object' && frontChild !== null, 'brush trace expected linked BSP child node');
    console.assert(typeof backChild === 'object' && backChild !== null, 'brush trace expected linked BSP child node');
    if (typeof frontChild !== 'object' || frontChild === null || typeof backChild !== 'object' || backChild === null) {
      return false;
    }
    if (BrushTrace._testPositionRecursive(
      worldModel, frontChild as Node, position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
    )) {
      return true;
    }

    return BrushTrace._testPositionRecursive(
      worldModel, backChild as Node, position, mins, maxs, boundsMins, boundsMaxs, extents, isPoint, checkCount,
    );
  }

  /**
   * Trace a box from start to end against a submodel's brush range (brute-force).
   * Unlike boxTrace which walks the BSP tree, this tests every brush in the
   * submodel's range directly. Used for submodel entities (doors, plats, etc.)
   * whose brushes are NOT inserted into the world BSP leaf-brush index.
   */
  static boxTraceModel(model: BrushModel, start: Vector, end: Vector, mins: Vector, maxs: Vector): Trace {
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

    const ctx: BrushTraceContext = {
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
      trueFraction: 1.0,
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
   */
  static testPositionModel(model: BrushModel, position: Vector, mins: Vector, maxs: Vector): boolean {
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
   */
  static _testLeafSolid(worldModel: BrushModel, leaf: Node, position: Vector, mins: Vector, maxs: Vector, boundsMins: Vector, boundsMaxs: Vector, checkCount: number): boolean {
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
   */
  static _testBoxInBrush(worldModel: BrushModel, brush: Brush, position: Vector, mins: Vector, maxs: Vector): boolean {
    const brushsides = worldModel.brushsides!;
    const planes = worldModel.planes;

    console.assert(brushsides !== null, 'brush trace expected brushsides');

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

  static readonly _midPool: Vector[] = Array.from({ length: 96 }, () => new Vector());
  static readonly _mid2Pool: Vector[] = Array.from({ length: 96 }, () => new Vector());

  /**
   * Recursively traverse the BSP node tree, expanding by trace extents.
   * At leaf nodes, test all brushes. Equivalent to Q2’s CM_RecursiveHullCheck.
   */
  static _recursiveHullCheck(ctx: BrushTraceContext, node: Node, p1f: number, p2f: number, p1: Vector, p2: Vector, depth: number = 0) {
    if (!BrushTrace._nodeMayAffectTrace(ctx, node)) {
      return;
    }

    if (ctx.trace.fraction <= p1f) {
      return; // already hit something nearer
    }

    // Leaf node: test brushes
    if (node.contents < content.CONTENT_NONE) {
      BrushTrace._traceToLeaf(ctx, node);
      return;
    }

    // Internal node: find the point distances to the splitting plane
    const plane = node.plane!;
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
      const frontChild = node.children[0];
      console.assert(typeof frontChild === 'object' && frontChild !== null, 'brush trace expected linked BSP child node');
      if (typeof frontChild !== 'object' || frontChild === null) {
        return;
      }
      BrushTrace._recursiveHullCheck(ctx, frontChild as Node, p1f, p2f, p1, p2, depth + 1);
      return;
    }

    // Both on back side
    if (t1 < -offset && t2 < -offset) {
      const backChild = node.children[1];
      console.assert(typeof backChild === 'object' && backChild !== null, 'brush trace expected linked BSP child node');
      if (typeof backChild !== 'object' || backChild === null) {
        return;
      }
      BrushTrace._recursiveHullCheck(ctx, backChild as Node, p1f, p2f, p1, p2, depth + 1);
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

    const nearChild = node.children[side as 0 | 1];
    console.assert(typeof nearChild === 'object' && nearChild !== null, 'brush trace expected linked BSP child node');
    if (typeof nearChild !== 'object' || nearChild === null) {
      return;
    }
    BrushTrace._recursiveHullCheck(ctx, nearChild as Node, p1f, midf, p1, mid, depth + 1);

    // Go past the node
    const midf2 = p1f + (p2f - p1f) * frac2;
    const mid2 = BrushTrace._mid2Pool[depth];
    mid2[0] = p1[0] + frac2 * (p2[0] - p1[0]);
    mid2[1] = p1[1] + frac2 * (p2[1] - p1[1]);
    mid2[2] = p1[2] + frac2 * (p2[2] - p1[2]);

    const farChild = node.children[(side ^ 1) as 0 | 1];
    console.assert(typeof farChild === 'object' && farChild !== null, 'brush trace expected linked BSP child node');
    if (typeof farChild !== 'object' || farChild === null) {
      return;
    }
    BrushTrace._recursiveHullCheck(ctx, farChild as Node, midf2, p2f, mid2, p2, depth + 1);
  }

  /**
   * Test all brushes in a leaf against the current trace.
   * Equivalent to Q2’s CM_TraceToLeaf.
   */
  static _traceToLeaf(ctx: BrushTraceContext, leaf: Node) {
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
   */
  static _clipBoxToBrush(ctx: BrushTraceContext, brush: Brush) {
    const brushsides = ctx.worldModel.brushsides!;
    const planes = ctx.worldModel.planes;
    const totalMoveLength = Math.sqrt(ctx.totalMove[0] ** 2 + ctx.totalMove[1] ** 2 + ctx.totalMove[2] ** 2);
    const fractionEpsilon = totalMoveLength > DIST_EPSILON ? DIST_EPSILON / totalMoveLength : 1.0;
    const planeTieEpsilon = Math.min(fractionEpsilon, 0.0005);

    console.assert(brushsides !== null, 'brush trace expected brushsides');

    let enterfrac = -1;
    let leavefrac = 2;
    let nearfrac = 0;
    let clipplane: BrushTracePlane | null = null;
    let axialWallClearAxisMask = 0;

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
      const startClear = d1 >= -DIST_EPSILON;
      const endClear = d2 >= -DIST_EPSILON;
      const axialWallClearContact = plane.type < 3
        && Math.abs(plane.normal[2]) <= DIST_EPSILON
        && Math.abs(d1) <= DIST_EPSILON
        && d2 >= -DIST_EPSILON;

      if (endClear) {
        getout = true;
      }

      if (startClear) {
        startout = true;
      }

      if (axialWallClearContact) {
        if (d2 > DIST_EPSILON) {
          return;
        }

        axialWallClearAxisMask |= 1 << plane.type;
        continue;
      }

      // If completely in front of face, no intersection.
      if (startClear && (d2 >= d1 || endClear)) {
        return;
      }

      if (d1 <= -DIST_EPSILON && d2 <= -DIST_EPSILON) {
        continue;
      }

      // Crosses face
      if (d1 > d2) {
        // Enter
        const f = d1 / (d1 - d2);
        if (BrushTrace._preferCandidatePlane(clipplane, enterfrac, plane, f, planeTieEpsilon)) {
          enterfrac = f;
          nearfrac = (d1 - DIST_EPSILON) / (d1 - d2);
          clipplane = plane;
        }
      } else {
        // Leave
        const f = d1 / (d1 - d2);
        if (f < leavefrac) {
          leavefrac = f;
        }
      }
    }

    if (!startout) {
      // Original point was inside brush
      ctx.trace.startsolid = true;
      if (!getout) {
        ctx.trace.allsolid = true;
      }
      return;
    }

    if (ctx.isPoint && axialWallClearAxisMask === 3 && clipplane !== null && Math.abs(clipplane.normal[2]) > DIST_EPSILON) {
      return;
    }

    if (enterfrac <= leavefrac) {
      if (enterfrac > -1 && clipplane !== null) {
        const zeroProgressBevel = enterfrac <= fractionEpsilon
          && clipplane.type >= 3
          && clipplane.normal[2] < MIN_STEP_NORMAL;

        if (zeroProgressBevel && axialWallClearAxisMask !== 0) {
          return;
        }

        const replacesEarlierHit = enterfrac < ctx.trueFraction - fractionEpsilon;
        const tiesExistingHit = Math.abs(enterfrac - ctx.trueFraction) <= fractionEpsilon;
        const prefersEqualPlane = tiesExistingHit
          && ctx.trace.fraction < 1.0
          && BrushTrace._preferEquivalentHitPlane(ctx.trace.plane, clipplane);

        if (!replacesEarlierHit && !prefersEqualPlane) {
          return;
        }

        if (enterfrac < 0) {
          enterfrac = 0;
        }

        ctx.trace.fraction = Math.max(0, nearfrac);
        ctx.trueFraction = enterfrac;
        ctx.trace.plane.normal.set(clipplane.normal);
        ctx.trace.plane.dist = clipplane.dist;
      }
    }
  }

  /**
   * Convert a world-space point into local model space using the inverse of a
   * rigid transform represented by origin plus orthonormal basis rows.
   * @param point - world-space point
   * @param origin - transform origin
   * @param basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns point in local model space
   */
  static _transformPointToLocal(point: Vector, origin: Vector, basis: number[]): Vector {
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
   * @param point - local-space point
   * @param origin - transform origin
   * @param basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns point in world space
   */
  static _transformPointToWorld(point: Vector, origin: Vector, basis: number[]): Vector {
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
   * @param normal - local-space normal
   * @param basis - 3x3 rotation matrix from Vector.toRotationMatrix()
   * @returns world-space normal
   */
  static _transformNormalToWorld(normal: Vector, basis: number[]): Vector {
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return forward.multiply(normal[0])
      .add(right.multiply(normal[1]))
      .add(up.multiply(normal[2]));
  }

  /**
   * Convert a local-space trace result back into world space.
   * @param localTrace - local-space trace result
   * @param transform - entity transform context
   * @returns world-space trace result
   */
  static _transformTraceToWorld(localTrace: Trace, transform: BrushTraceTransform): Trace {
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

interface BrushTraceContext {
  readonly worldModel: BrushModel;
  readonly trace: Trace;
  readonly mins: Vector;
  readonly maxs: Vector;
  readonly isPoint: boolean;
  readonly extents: Vector;
  readonly start: Vector;
  readonly end: Vector;
  readonly totalMove: Vector;
  readonly sweepMins: Vector;
  readonly sweepMaxs: Vector;
  readonly checkCount: number;
  trueFraction: number;
}
