import Vector from '../../../shared/Vector.ts';
import { content } from '../../../shared/Defs.ts';
import { type BrushModel } from '../Mod.ts';

/* eslint-disable jsdoc/require-returns */

interface HullContentsSampler {
  pointContents(point: Vector): content;
}

interface BrushHullFallbackOptions {
  readonly model: BrushModel;
  readonly position: Vector;
  readonly hull: HullContentsSampler;
  readonly localPosition: Vector;
  readonly playerMins: Vector;
  readonly playerMaxs: Vector;
  readonly distEpsilon: number;
  readonly minStepNormal: number;
  readonly slopeContactEpsilon: number;
}

/**
 * Resolve brush-vs-hull tangent mismatch policy for position tests.
 */
export function shouldUseHullTangentFallback(options: BrushHullFallbackOptions): boolean {
  if (hasNearbyWalkableSlopeContact(options)) {
    return false;
  }

  if (!brushPositionNeedsHullTangentFallback(options)) {
    return false;
  }

  return !hullHasRaisedEscape(options);
}

/**
 * Check if the current position touches a walkable non-axial slope plane.
 */
function hasNearbyWalkableSlopeContact(options: BrushHullFallbackOptions): boolean {
  const brushes = options.model.brushes;
  const planes = options.model.planes;
  const brushsides = options.model.brushsides;

  if (!brushes || !planes || !brushsides) {
    return false;
  }

  const firstBrush = options.model.firstBrush ?? 0;
  const lastBrush = firstBrush + (options.model.numBrushes ?? brushes.length);

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

    const expandedMinX = brush.mins![0] - options.playerMaxs[0] - options.distEpsilon;
    const expandedMinY = brush.mins![1] - options.playerMaxs[1] - options.distEpsilon;
    const expandedMinZ = brush.mins![2] - options.playerMaxs[2] - options.distEpsilon;
    const expandedMaxX = brush.maxs![0] - options.playerMins[0] + options.distEpsilon;
    const expandedMaxY = brush.maxs![1] - options.playerMins[1] + options.distEpsilon;
    const expandedMaxZ = brush.maxs![2] - options.playerMins[2] + options.distEpsilon;

    if (options.position[0] < expandedMinX || options.position[0] > expandedMaxX
      || options.position[1] < expandedMinY || options.position[1] > expandedMaxY
      || options.position[2] < expandedMinZ || options.position[2] > expandedMaxZ) {
      continue;
    }

    for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
      const side = brushsides[brush.firstside + sideIndex];
      const plane = planes[side.planenum];

      if (plane.type < 3 || plane.normal[2] < options.minStepNormal) {
        continue;
      }

      let dist = plane.dist;
      for (let axis = 0; axis < 3; axis++) {
        dist -= (plane.normal[axis] < 0 ? options.playerMaxs[axis] : options.playerMins[axis]) * plane.normal[axis];
      }

      const planeDistance = plane.normal.dot(options.position) - dist;
      if (Math.abs(planeDistance) <= options.slopeContactEpsilon) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect axial-wall tangency poses where hull semantics should still block.
 */
function brushPositionNeedsHullTangentFallback(options: BrushHullFallbackOptions): boolean {
  const brushes = options.model.brushes;
  const planes = options.model.planes;
  const brushsides = options.model.brushsides;

  if (!brushes || !planes || !brushsides) {
    return false;
  }

  const firstBrush = options.model.firstBrush ?? 0;
  const lastBrush = firstBrush + (options.model.numBrushes ?? brushes.length);

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

    const expandedMinX = brush.mins![0] - options.playerMaxs[0] - options.distEpsilon;
    const expandedMinY = brush.mins![1] - options.playerMaxs[1] - options.distEpsilon;
    const expandedMinZ = brush.mins![2] - options.playerMaxs[2] - options.distEpsilon;
    const expandedMaxX = brush.maxs![0] - options.playerMins[0] + options.distEpsilon;
    const expandedMaxY = brush.maxs![1] - options.playerMins[1] + options.distEpsilon;
    const expandedMaxZ = brush.maxs![2] - options.playerMins[2] + options.distEpsilon;

    if (options.position[0] < expandedMinX || options.position[0] > expandedMaxX
      || options.position[1] < expandedMinY || options.position[1] > expandedMaxY
      || options.position[2] < expandedMinZ || options.position[2] > expandedMaxZ) {
      continue;
    }

    let touchingAxialWall = false;
    let inside = true;

    for (let sideIndex = 0; sideIndex < brush.numsides; sideIndex++) {
      const side = brushsides[brush.firstside + sideIndex];
      const plane = planes[side.planenum];
      let dist = plane.dist;

      for (let axis = 0; axis < 3; axis++) {
        dist -= (plane.normal[axis] < 0 ? options.playerMaxs[axis] : options.playerMins[axis]) * plane.normal[axis];
      }

      const planeDistance = plane.normal.dot(options.position) - dist;
      const axialWall = plane.type < 3 && Math.abs(plane.normal[2]) <= options.distEpsilon;

      if (axialWall && Math.abs(planeDistance) <= options.distEpsilon) {
        touchingAxialWall = true;
        continue;
      }

      if (plane.type >= 3) {
        if (planeDistance >= -options.distEpsilon) {
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
 * Probe a slight upward offset to detect whether hull space has a valid escape.
 */
function hullHasRaisedEscape(options: BrushHullFallbackOptions): boolean {
  const raised = options.localPosition.copy();
  raised[2] += options.slopeContactEpsilon;

  const raisedContents = options.hull.pointContents(raised);
  return raisedContents !== content.CONTENT_SOLID && raisedContents !== content.CONTENT_SKY;
}
