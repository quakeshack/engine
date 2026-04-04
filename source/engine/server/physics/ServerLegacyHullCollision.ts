import type { BrushModel, Hull } from '../../common/model/BSP.ts';
import type { CollisionTrace } from './ServerCollisionSupport.ts';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { DIST_EPSILON } from '../../common/Pmove.ts';
import { eventBus, getCommonRegistry } from '../../registry.ts';

interface LegacyHull extends Hull {
  readonly firstclipnode: number;
  readonly allowedClipNodes?: Uint8Array | null;
}

let { Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = getCommonRegistry());
});

/**
 * Check whether a clipnode belongs to the owning legacy hull subtree.
 * BSP29 hull arrays are shared across models, so foreign clipnodes must be
 * ignored to keep world traces from wandering into inline trigger geometry.
 * @param hull Hull descriptor.
 * @param num Clipnode index.
 * @returns True when the clipnode belongs to the active hull subtree.
 */
export function isHullNodeAllowed(hull: LegacyHull, num: number): boolean {
  const allowedClipNodes = hull.allowedClipNodes;
  return allowedClipNodes === undefined || allowedClipNodes === null || allowedClipNodes[num] === 1;
}

/**
 * Compute the signed distance from a point to a hull plane.
 * @param plane Hull plane.
 * @param point Point to test.
 * @returns Signed distance to the plane.
 */
export function getHullPlaneDistance(plane: Hull['planes'][number], point: Vector): number {
  if (plane.type < 3) {
    return point[plane.type] - plane.dist;
  }

  return plane.normal.dot(point) - plane.dist;
}

/**
 * Update trace state after reaching a terminal hull leaf.
 * @param contents Terminal hull contents value.
 * @param trace Trace accumulator.
 * @returns True when traversal should continue upward.
 */
export function classifyHullLeaf(contents: number, trace: CollisionTrace): boolean {
  if (contents !== Defs.content.CONTENT_SOLID) {
    trace.allsolid = false;
    if (contents === Defs.content.CONTENT_EMPTY) {
      trace.inopen = true;
    } else {
      trace.inwater = true;
    }
  } else {
    trace.startsolid = true;
  }

  return true;
}

/**
 * Determines the contents inside a hull by descending the clipnode tree.
 * @param hull Hull data to test against.
 * @param num Starting clipnode index.
 * @param p Point to classify.
 * @returns Content type for the point.
 */
export function hullPointContents(hull: LegacyHull, num: number, p: Vector): number {
  while (num >= 0) {
    if (!isHullNodeAllowed(hull, num)) {
      return Defs.content.CONTENT_EMPTY;
    }

    console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);
    const node = hull.clipnodes[num]!;
    const plane = hull.planes[node.planenum]!;
    const d = getHullPlaneDistance(plane, p);

    if (d < 0) {
      num = node.children[1];
    } else {
      num = node.children[0];
    }
  }

  return num;
}

/**
 * Returns the contents at the specified world position.
 * @param worldmodel World model that owns hull 0.
 * @param p Position to sample.
 * @returns World content.
 */
export function pointContents(worldmodel: BrushModel, p: Vector): number {
  const cont = hullPointContents(worldmodel.hulls[0] as LegacyHull, 0, p);
  if (cont <= Defs.content.CONTENT_CURRENT_0 && cont >= Defs.content.CONTENT_CURRENT_DOWN) {
    return Defs.content.CONTENT_WATER;
  }
  return cont;
}

/**
 * Recursively tests a swept hull against the world and aggregates the trace result.
 * @param hull Hull to trace against.
 * @param num Clipnode index.
 * @param p1f Fraction at the start point.
 * @param p2f Fraction at the end point.
 * @param p1 Start point.
 * @param p2 End point.
 * @param trace Trace accumulator.
 * @param depth Recursion depth reserved for API compatibility.
 * @returns True if traversal should continue downward.
 */
export function recursiveHullCheck(
  hull: LegacyHull,
  num: number,
  p1f: number,
  p2f: number,
  p1: Vector,
  p2: Vector,
  trace: CollisionTrace,
  depth = 0,
): boolean {
  void depth;

  if (trace.fraction <= p1f) {
    return false;
  }

  if (num < 0) {
    return classifyHullLeaf(num, trace);
  }

  if (!isHullNodeAllowed(hull, num)) {
    return classifyHullLeaf(Defs.content.CONTENT_EMPTY, trace);
  }

  console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);

  const node = hull.clipnodes[num]!;
  const plane = hull.planes[node.planenum]!;
  const t1 = getHullPlaneDistance(plane, p1);
  const t2 = getHullPlaneDistance(plane, p2);

  if (t1 >= 0.0 && t2 >= 0.0) {
    return recursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace, depth + 1);
  }

  if (t1 < 0.0 && t2 < 0.0) {
    return recursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace, depth + 1);
  }

  let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2)));
  let midf = p1f + (p2f - p1f) * frac;
  const mid = new Vector(
    p1[0] + frac * (p2[0] - p1[0]),
    p1[1] + frac * (p2[1] - p1[1]),
    p1[2] + frac * (p2[2] - p1[2]),
  );
  const side = t1 < 0.0 ? 1 : 0;

  if (!recursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace, depth + 1)) {
    return false;
  }

  if (hullPointContents(hull, node.children[side ^ 1], mid) !== Defs.content.CONTENT_SOLID) {
    return recursiveHullCheck(hull, node.children[side ^ 1], midf, p2f, mid, p2, trace, depth + 1);
  }

  if (trace.allsolid) {
    return false;
  }

  if (side === 0) {
    trace.plane.normal = plane.normal.copy();
    trace.plane.dist = plane.dist;
  } else {
    trace.plane.normal = plane.normal.copy().multiply(-1);
    trace.plane.dist = -plane.dist;
  }

  while (hullPointContents(hull, hull.firstclipnode, mid) === Defs.content.CONTENT_SOLID) {
    frac -= 0.1;
    if (frac < 0.0) {
      trace.fraction = midf;
      trace.endpos = mid.copy();
      Con.DPrint('backup past 0\n');
      return false;
    }

    midf = p1f + (p2f - p1f) * frac;
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);
  }

  trace.fraction = midf;
  trace.endpos = mid.copy();

  return false;
}
