/**
 * The BSP tree of a map as typed arrays: one entry per node and one per leaf, no object per element.
 *
 * A child of a node is a reference: a node index when it is zero or more, a leaf when it is negative, the leaf being `~reference`
 * (that is `-1 - reference`, the convention of the BSP files). The tables are filled by the map loader and never change
 * afterwards, so they can be shared by every system that reads the map. What the renderer marks on the tree each frame lives in
 * its own state (`WorldRenderState`), not here.
 */

import type { content } from '../../../shared/Defs.ts';

/** The contents of the leafs: an `Int32Array` whose elements are known to be contents values. */
export interface ContentsArray extends Int32Array {
  [index: number]: content;
}

/** Nodes of the BSP tree. */
export class NodeTable {
  /** Number of nodes. */
  readonly count: number;

  /** Plane index of each node. */
  readonly planeNums: Int32Array;

  /** Children of each node, front first, two references per node (a node index, or `~leaf`). */
  readonly children: Int32Array;

  /** Parent node of each node, -1 for the root. */
  readonly parents: Int32Array;

  /** Bounds of each node, six values: minimum corner, then maximum corner. */
  readonly bounds: Float32Array;

  /** First face of each node. */
  readonly firstFaces: Uint32Array;

  /** Number of faces of each node. */
  readonly numFaces: Uint32Array;

  constructor(count: number) {
    this.count = count;
    this.planeNums = new Int32Array(count);
    this.children = new Int32Array(count * 2);
    this.parents = new Int32Array(count).fill(-1);
    this.bounds = new Float32Array(count * 6);
    this.firstFaces = new Uint32Array(count);
    this.numFaces = new Uint32Array(count);
  }

  /**
   * Sets the parent of every node and leaf that can be reached from the root, from the children of the nodes. Run it once
   * the children are set. The subtrees of inline models hang from nodes that nothing refers to, and share leafs with the
   * world, so they are left alone: a leaf has the parent it has in the world tree.
   * @param leafs The leafs of the same tree.
   */
  linkParents(leafs: LeafTable): void {
    this.parents.fill(-1);
    leafs.parents.fill(-1);

    if (this.count === 0) {
      return;
    }

    const stack = [0];

    while (stack.length > 0) {
      const node = stack.pop()!;

      for (let side = 0; side < 2; side++) {
        const child = this.children[node * 2 + side];

        if (child >= 0) {
          this.parents[child] = node;
          stack.push(child);
        } else {
          leafs.parents[~child] = node;
        }
      }
    }
  }
}

/** Leafs of the BSP tree. */
export class LeafTable {
  /** Number of leafs. */
  readonly count: number;

  /** Contents of each leaf (`content.CONTENT_SOLID` and so on). */
  readonly contents: ContentsArray;

  /** Visibility cluster of each leaf, -1 for none. */
  readonly clusters: Int32Array;

  /** Offset of the visibility data of each leaf in the PVS lump. */
  readonly visofs: Int32Array;

  /** Area of each leaf, for area portals. */
  readonly areas: Int32Array;

  /** Parent node of each leaf. */
  readonly parents: Int32Array;

  /** Bounds of each leaf, six values: minimum corner, then maximum corner. */
  readonly bounds: Float32Array;

  /** First marksurface of each leaf. */
  readonly firstMarkSurfaces: Uint32Array;

  /** Number of marksurfaces of each leaf. */
  readonly numMarkSurfaces: Uint32Array;

  /** First leaf brush of each leaf. */
  readonly firstLeafBrushes: Uint32Array;

  /** Number of leaf brushes of each leaf. */
  readonly numLeafBrushes: Uint32Array;

  /** Ambient sound levels, four per leaf: water, sky, slime, lava. */
  readonly ambient: Uint8Array;

  constructor(count: number) {
    this.count = count;
    this.contents = new Int32Array(count) as ContentsArray;
    this.clusters = new Int32Array(count).fill(-1);
    this.visofs = new Int32Array(count).fill(-1);
    this.areas = new Int32Array(count);
    this.parents = new Int32Array(count).fill(-1);
    this.bounds = new Float32Array(count * 6);
    this.firstMarkSurfaces = new Uint32Array(count);
    this.numMarkSurfaces = new Uint32Array(count);
    this.firstLeafBrushes = new Uint32Array(count);
    this.numLeafBrushes = new Uint32Array(count);
    this.ambient = new Uint8Array(count * 4);
  }
}
