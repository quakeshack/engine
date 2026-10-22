/**
 * Builds the BSP tree of a test model from a short description, the way a map loader fills the node and leaf tables.
 */

import { content } from '../../source/shared/Defs.ts';
import { LeafTable, NodeTable } from '../../source/engine/common/model/BspTree.ts';
import { BrushModel } from '../../source/engine/common/model/BSP.ts';
import Vector from '../../source/shared/Vector.ts';
import { WorldRenderState } from '../../source/engine/common/model/WorldRenderState.ts';

/** Bounds that never keep a trace or a cull test away from a node: the tests that do not care leave them out. */
const EVERYWHERE = [-1e9, -1e9, -1e9, 1e9, 1e9, 1e9];

/** A leaf of a test tree. Left out: solid contents, no cluster, nothing in it. */
export interface LeafDescription {
  readonly contents?: number;
  readonly cluster?: number;
  readonly area?: number;
  readonly visofs?: number;
  readonly bounds?: readonly number[];
  readonly firstMarkSurface?: number;
  readonly numMarkSurfaces?: number;
  readonly firstLeafBrush?: number;
  readonly numLeafBrushes?: number;
  readonly ambient?: readonly number[];
}

/** A node of a test tree. */
export interface NodeDescription {
  /** Index into the plane array of the model. */
  readonly planeNum?: number;
  /** Front and back child: a node index, or `~leaf` for a leaf. */
  readonly children: readonly [number, number];
  readonly bounds?: readonly number[];
  readonly firstFace?: number;
  readonly numFaces?: number;
}

/**
 * Puts a tree into a model.
 * @param model The model, whose planes the nodes refer to.
 * @param nodes The nodes; the first one is the root.
 * @param leafs The leafs; the children of the nodes refer to them as `~index`.
 */
export function setBspTree(model: BrushModel, nodes: readonly NodeDescription[], leafs: readonly LeafDescription[]): void {
  const nodeTable = new NodeTable(nodes.length);
  const leafTable = new LeafTable(leafs.length);

  nodes.forEach((node, index) => {
    nodeTable.planeNums[index] = node.planeNum ?? 0;
    nodeTable.children[index * 2] = node.children[0];
    nodeTable.children[index * 2 + 1] = node.children[1];
    nodeTable.bounds.set(node.bounds ?? EVERYWHERE, index * 6);
    nodeTable.firstFaces[index] = node.firstFace ?? 0;
    nodeTable.numFaces[index] = node.numFaces ?? 0;
  });

  leafs.forEach((leaf, index) => {
    leafTable.contents[index] = leaf.contents ?? content.CONTENT_SOLID;
    leafTable.clusters[index] = leaf.cluster ?? -1;
    leafTable.areas[index] = leaf.area ?? 0;
    leafTable.visofs[index] = leaf.visofs ?? -1;
    leafTable.bounds.set(leaf.bounds ?? EVERYWHERE, index * 6);
    leafTable.firstMarkSurfaces[index] = leaf.firstMarkSurface ?? 0;
    leafTable.numMarkSurfaces[index] = leaf.numMarkSurfaces ?? 0;
    leafTable.firstLeafBrushes[index] = leaf.firstLeafBrush ?? 0;
    leafTable.numLeafBrushes[index] = leaf.numLeafBrushes ?? 0;
    leafTable.ambient.set(leaf.ambient ?? [0, 0, 0, 0], index * 4);
  });

  nodeTable.linkParents(leafTable);
  model.nodeTable = nodeTable;
  model.leafTable = leafTable;
}

/**
 * Builds a model for the tests that only need a world to walk: planes, and a tree over them.
 * @param planes Planes of the model, given as `{ normal, dist, type }`.
 * @param nodes The nodes of the tree.
 * @param leafs The leafs of the tree.
 * @returns The model.
 */
export function createTreeModel(planes: readonly { normal: readonly number[]; dist: number; type: number }[], nodes: readonly NodeDescription[], leafs: readonly LeafDescription[]): BrushModel {
  const model = new BrushModel('test');

  model.planes = planes.map((plane) => ({ normal: new Vector(plane.normal[0], plane.normal[1], plane.normal[2]), dist: plane.dist, type: plane.type, signbits: 0 }) as unknown as BrushModel['planes'][number]);
  setBspTree(model, nodes, leafs);

  return model;
}

/**
 * A world that is one open leaf, which every point is in. Its single node splits far out at x = 100 million, so that a box is
 * on one side of it and visits the leaf once, and leads into that leaf on both sides.
 * @param contents Contents of the leaf.
 * @returns The model.
 */
export function createSingleLeafWorld(contents: number = content.CONTENT_EMPTY): BrushModel {
  return createTreeModel([{ normal: [1, 0, 0], dist: 1e8, type: 0 }], [{ planeNum: 0, children: [~0, ~0] }], [{ contents }]);
}

/**
 * Builds a world for the tests of the renderer's leaf loops: leafs with the marksurfaces and draw chains the test gives, and
 * a render state to hold the chains.
 * @param leafs The leafs, with the draw chains `[texture, first vertex, vertex count]` the display lists made for them.
 * @param members Other members of the model, e.g. faces, marksurfaces and textures; tests give just the parts the code under test reads, so they are not checked against the model's own types.
 * @returns The model; its render state is made, with the chains set.
 */
export function createRenderedWorld(
  leafs: readonly (LeafDescription & { readonly skychain?: number; readonly waterchain?: number; readonly cmds?: number[][]; readonly visframe?: number })[],
  members: object = {},
): BrushModel {
  const model = new BrushModel('test-world');

  Object.assign(model, members);
  setBspTree(model, [], leafs);

  const state = WorldRenderState.of(model);

  leafs.forEach((leaf, index) => {
    state.cmds[index] = leaf.cmds ?? [];
    state.skychains[index] = leaf.skychain ?? 0;
    state.waterchains[index] = leaf.waterchain ?? 0;
    state.visframes[index] = leaf.visframe ?? 0;
  });

  return model;
}
