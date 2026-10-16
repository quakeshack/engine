/**
 * Seeded random hulls and queries for the tests of the hull traversal (`test/physics/hull-traversal.test.ts`).
 *
 * A spec is plain data, so that it can be turned into whatever shape a hull has: the digest the tests compare with was
 * produced by the two traversals that `Hull` replaced (Pmove's and the server's, 14000 results), from the same specs.
 */

import Vector from '../../source/shared/Vector.ts';
import { ClipTree, Hull, PlaneTable } from '../../source/engine/common/collision/Hull.ts';
import type { HullTrace } from '../../source/engine/common/collision/Hull.ts';

/** A plane of a spec. */
export interface PlaneSpec {
  readonly normal: readonly [number, number, number];
  readonly dist: number;
  readonly type: number;
  readonly signbits: number;
}

/** A node of a spec: the plane and the two children (a node index, or a negative contents value). */
export interface NodeSpec {
  readonly planeNum: number;
  readonly children: readonly [number, number];
}

/** A hull as data. */
export interface HullSpec {
  readonly planes: readonly PlaneSpec[];
  readonly nodes: readonly NodeSpec[];
  readonly mask: readonly number[] | null;
}

/** One hull with the queries to run against it. */
export interface HullCase {
  readonly spec: HullSpec;
  readonly points: readonly (readonly [number, number, number])[];
  readonly segments: readonly (readonly [number, number, number, number, number, number])[];
}

/**
 * Builds a plane the way the BSP loader does, with its axis type and sign bits.
 * @param normal Plane normal.
 * @param dist Plane distance.
 * @returns The plane.
 */
export function createPlaneSpec(normal: readonly [number, number, number], dist: number): PlaneSpec {
  let type = 3;

  if (normal[0] === 1 && normal[1] === 0 && normal[2] === 0) {
    type = 0;
  } else if (normal[0] === 0 && normal[1] === 1 && normal[2] === 0) {
    type = 1;
  } else if (normal[0] === 0 && normal[1] === 0 && normal[2] === 1) {
    type = 2;
  }

  return { normal, dist, type, signbits: (normal[0] < 0 ? 1 : 0) | (normal[1] < 0 ? 2 : 0) | (normal[2] < 0 ? 4 : 0) };
}

/**
 * Turns a spec into a hull.
 * @param spec The hull as data.
 * @returns A hull whose first node is the root.
 */
export function buildHull(spec: HullSpec): Hull {
  const planes = PlaneTable.fromPlanes(spec.planes.map((plane) => ({ ...plane, normal: new Vector(...plane.normal) })));
  const tree = new ClipTree(spec.nodes.length);

  spec.nodes.forEach((node, index) => {
    tree.set(index, node.planeNum, node.children[0], node.children[1]);
  });

  const hull = new Hull(planes, tree);
  hull.allowedClipNodes = spec.mask === null ? null : Uint8Array.from(spec.mask);

  return hull;
}

/**
 * Reads the comparable state out of a trace.
 * @param trace Finished trace.
 * @returns The state as one line of text, numbers in their shortest exact form.
 */
export function summarizeTrace(trace: HullTrace): string {
  return JSON.stringify([trace.allsolid, trace.startsolid, trace.fraction, [...trace.endpos], [...trace.plane.normal], trace.plane.dist, trace.inopen, trace.inwater]);
}

/**
 * A random clip tree over axial and slanted planes, with solid, empty, water, sky and current leafs, and no promise that it is
 * a geometrically consistent BSP: the traversal must do the same arithmetic whatever the tree.
 * @param random Seeded generator.
 * @returns The hull as data; some have a mask of the nodes they may enter.
 */
export function createRandomHullSpec(random: () => number): HullSpec {
  // empty (twice as likely), solid, water, sky, current up
  const leafContents = [-1, -1, -2, -3, -6, -13];
  const planes: PlaneSpec[] = [];
  const nodes: NodeSpec[] = [];

  /**
   * Builds a random subtree.
   * @param depth Levels left below this one.
   * @returns A node index, or a negative contents value for a leaf.
   */
  function build(depth: number): number {
    if (depth === 0 || (depth < 4 && random() < 0.15)) {
      return leafContents[Math.floor(random() * leafContents.length)];
    }

    const planeNum = planes.length;

    if (random() < 0.6) {
      const normal: [number, number, number] = [0, 0, 0];
      normal[Math.floor(random() * 3)] = 1;
      planes.push(createPlaneSpec(normal, Math.round((random() - 0.5) * 200)));
    } else {
      const x = random() - 0.5;
      const y = random() - 0.5;
      const z = random() - 0.5;
      const length = Math.hypot(x, y, z) || 1;

      planes.push(createPlaneSpec([Math.fround(x / length), Math.fround(y / length), Math.fround(z / length)], Math.round((random() - 0.5) * 200)));
    }

    const index = nodes.length;
    nodes.push({ planeNum, children: [0, 0] });
    const front = build(depth - 1);
    const back = build(depth - 1);
    nodes[index] = { planeNum, children: [front, back] };

    return index;
  }

  build(7);

  const mask = random() < 0.3 ? nodes.map(() => (random() < 0.85 ? 1 : 0)) : null;

  if (mask !== null) {
    mask[0] = 1;
  }

  return { planes, nodes, mask };
}

/**
 * Random hulls with 200 points and 150 segments for each.
 * @param random Seeded generator.
 * @param count Number of hulls.
 * @returns The cases.
 */
export function createRandomHullCases(random: () => number, count: number): HullCase[] {
  const cases: HullCase[] = [];

  for (let tree = 0; tree < count; tree++) {
    const spec = createRandomHullSpec(random);
    const points: [number, number, number][] = [];
    const segments: [number, number, number, number, number, number][] = [];

    for (let index = 0; index < 200; index++) {
      points.push([(random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300]);
    }

    for (let index = 0; index < 150; index++) {
      segments.push([(random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300]);
    }

    cases.push({ spec, points, segments });
  }

  return cases;
}
