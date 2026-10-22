/**
 * Builds collision hulls from the plain description that tests write down: the planes and clip nodes as lists of small
 * objects, the way the BSP lumps are laid out.
 */

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { ClipTree, Hull, PlaneTable } from '../../source/engine/common/collision/Hull.ts';

/** A plane of a hull description. */
export interface PlaneDescription {
  readonly normal: Vector | readonly number[];
  readonly dist: number;
  readonly type: number;
  readonly signbits?: number;
}

/** A clip node of a hull description. */
export interface ClipNodeDescription {
  readonly planenum: number;
  readonly children: readonly number[];
}

/** What a test writes down for a hull. */
export interface HullDescription {
  readonly clip_mins?: Vector;
  readonly clip_maxs?: Vector;
  readonly firstclipnode?: number;
  readonly lastclipnode?: number;
  readonly allowedClipNodes?: Uint8Array | null;
  readonly planes: readonly PlaneDescription[];
  readonly clipnodes: readonly ClipNodeDescription[];
}

/**
 * Builds the nodes of a clip tree.
 * @param nodes Plane and children of each node.
 * @returns The tree.
 */
export function createClipTree(nodes: readonly ClipNodeDescription[]): ClipTree {
  const tree = new ClipTree(nodes.length);

  nodes.forEach((node, index) => {
    tree.set(index, node.planenum, node.children[0], node.children[1]);
  });

  return tree;
}

/**
 * Builds a hull from a description.
 * @param description Planes, clip nodes and the rest of what a hull has.
 * @returns The hull; the first clip node is the root unless the description says otherwise.
 */
export function createLegacyHull(description: HullDescription): Hull {
  const planes = PlaneTable.fromPlanes(description.planes.map((plane) => ({
    normal: plane.normal instanceof Vector ? plane.normal : new Vector(plane.normal[0], plane.normal[1], plane.normal[2]),
    dist: plane.dist,
    type: plane.type,
    signbits: plane.signbits ?? 0,
  })));
  const tree = createClipTree(description.clipnodes);
  const hull = new Hull(
    planes,
    tree,
    description.clip_mins ?? new Vector(),
    description.clip_maxs ?? new Vector(),
    description.firstclipnode ?? 0,
    description.lastclipnode ?? tree.count - 1,
  );

  hull.allowedClipNodes = description.allowedClipNodes ?? null;

  return hull;
}

/**
 * Builds the hull of a room whose inside is empty and whose outside is solid.
 * @param mins Room minimum corner.
 * @param maxs Room maximum corner.
 * @returns The hull, with the room as the box a mover is expanded by.
 */
export function createRoomHull(mins: Vector, maxs: Vector): Hull {
  const axisPlane = (axis: 0 | 1 | 2, dist: number): PlaneDescription => {
    const normal = new Vector();

    normal[axis] = 1;

    return { normal, dist, type: axis };
  };

  return createLegacyHull({
    clip_mins: mins.copy(),
    clip_maxs: maxs.copy(),
    firstclipnode: 0,
    lastclipnode: 5,
    planes: [axisPlane(0, maxs[0]), axisPlane(0, mins[0]), axisPlane(1, maxs[1]), axisPlane(1, mins[1]), axisPlane(2, maxs[2]), axisPlane(2, mins[2])],
    clipnodes: [
      { planenum: 0, children: [content.CONTENT_SOLID, 1] },
      { planenum: 1, children: [2, content.CONTENT_SOLID] },
      { planenum: 2, children: [content.CONTENT_SOLID, 3] },
      { planenum: 3, children: [4, content.CONTENT_SOLID] },
      { planenum: 4, children: [content.CONTENT_SOLID, 5] },
      { planenum: 5, children: [content.CONTENT_EMPTY, content.CONTENT_SOLID] },
    ],
  });
}
