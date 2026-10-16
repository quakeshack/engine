import Vector from '../../../shared/Vector.ts';
import { content } from '../../../shared/Defs.ts';

/** How far from a plane a trace is stopped, in world units (1/32). */
export const DIST_EPSILON = 0.03125;

/** What a plane has to provide to be copied into a `PlaneTable`. */
export interface PlaneSource {
  readonly normal: Vector;
  readonly dist: number;
  readonly type: number;
  readonly signbits: number;
}

/** What a hull trace reads and writes of a trace result; `Pmove`'s `Trace` and the server's `CollisionTrace` both are one. */
export interface HullTrace {
  allsolid: boolean;
  startsolid: boolean;
  fraction: number;
  endpos: Vector;
  readonly plane: { readonly normal: Vector; dist: number };
  inopen: boolean;
  inwater: boolean;
}

/**
 * The planes a hull is cut by, in typed arrays: no object per plane. Shared by all hulls of a map and, by reference, by every
 * realm and system that traces against it.
 */
export class PlaneTable {
  /** Plane normals, three values per plane. */
  readonly normals: Float32Array;

  /** Plane distances. Doubles, so a box hull can hold distances that are not float32 values. */
  readonly dists: Float64Array;

  /** Axis of an axial plane (0 to 2), 3 and above for the others. */
  readonly types: Uint8Array;

  /** One bit per negative normal component, for box tests. */
  readonly signbits: Uint8Array;

  /** Number of planes. */
  readonly count: number;

  constructor(count: number) {
    this.count = count;
    this.normals = new Float32Array(count * 3);
    this.dists = new Float64Array(count);
    this.types = new Uint8Array(count);
    this.signbits = new Uint8Array(count);
  }

  /**
   * Copies planes into a table.
   * @param planes The planes, e.g. the ones a BSP loader read.
   * @returns The table, in the same order.
   */
  static fromPlanes(planes: readonly PlaneSource[]): PlaneTable {
    const table = new PlaneTable(planes.length);

    for (let index = 0; index < planes.length; index++) {
      const plane = planes[index];

      table.set(index, plane.normal[0], plane.normal[1], plane.normal[2], plane.dist, plane.type, plane.signbits);
    }

    return table;
  }

  /**
   * Sets a plane.
   * @param index Plane index.
   * @param normalX Normal x component.
   * @param normalY Normal y component.
   * @param normalZ Normal z component.
   * @param dist Distance from the origin along the normal.
   * @param type Axis of an axial plane (0 to 2), 3 and above for the others.
   * @param signbits One bit per negative normal component.
   */
  set(index: number, normalX: number, normalY: number, normalZ: number, dist: number, type: number, signbits: number): void {
    this.normals[index * 3] = normalX;
    this.normals[index * 3 + 1] = normalY;
    this.normals[index * 3 + 2] = normalZ;
    this.dists[index] = dist;
    this.types[index] = type;
    this.signbits[index] = signbits;
  }

  /**
   * Signed distance of a point from a plane.
   * @param index Plane index.
   * @param point Point to measure.
   * @returns Positive in front of the plane, negative behind it.
   */
  distance(index: number, point: Vector): number {
    const type = this.types[index];

    if (type < 3) {
      return point[type] - this.dists[index];
    }

    const base = index * 3;

    return this.normals[base] * point[0] + this.normals[base + 1] * point[1] + this.normals[base + 2] * point[2] - this.dists[index];
  }
}

/**
 * The nodes of a clip tree: the plane of each node and its two children. A child is the index of another node, or, when
 * negative, the contents of the leaf it stands for (`content.CONTENT_SOLID` and so on).
 */
export class ClipTree {
  /** Plane index of each node. */
  readonly planeNums: Int32Array;

  /** Children of each node, front first, two values per node. */
  readonly children: Int32Array;

  /** Number of nodes. */
  readonly count: number;

  constructor(count: number) {
    this.count = count;
    this.planeNums = new Int32Array(count);
    this.children = new Int32Array(count * 2);
  }

  /**
   * Sets a node.
   * @param index Node index.
   * @param planeNum Plane index.
   * @param front Child on the front side of the plane.
   * @param back Child on the back side of the plane.
   */
  set(index: number, planeNum: number, front: number, back: number): void {
    this.planeNums[index] = planeNum;
    this.children[index * 2] = front;
    this.children[index * 2 + 1] = back;
  }
}

/**
 * A collision hull: a clip tree cut by a plane table, with the box the moving thing is expanded by. The planes and the tree
 * are shared by all hulls of a map and by everything that traces against them; they are read-only after loading.
 *
 * This is the one implementation of the point and line queries against a hull, used by player movement on the server and in
 * prediction as well as by entity movement on the server.
 */
export class Hull {
  static readonly #midPool: Vector[] = Array.from({ length: 64 }, () => new Vector());

  /** The planes the tree refers to. */
  readonly planes: PlaneTable;

  /** The nodes of the hull. */
  readonly tree: ClipTree;

  /** Hull-space minimum bounds: what a moving box is expanded by. */
  readonly clipMins: Vector;

  /** Hull-space maximum bounds: what a moving box is expanded by. */
  readonly clipMaxs: Vector;

  /** First clip node of this hull, which is the root of its subtree when hulls share a tree. Set by the loader. */
  firstClipNode: number;

  /** Last valid clip node. */
  readonly lastClipNode: number;

  /**
   * Nodes this hull may enter, when it shares the tree with others. A node that is not in the mask reads as open space, which
   * keeps a trace from wandering into the geometry of another model. Set by the loader.
   */
  allowedClipNodes: Uint8Array | null;

  constructor(
    planes: PlaneTable,
    tree: ClipTree,
    clipMins: Vector = new Vector(),
    clipMaxs: Vector = new Vector(),
    firstClipNode = 0,
    lastClipNode: number = tree.count - 1,
  ) {
    this.planes = planes;
    this.tree = tree;
    this.clipMins = clipMins;
    this.clipMaxs = clipMaxs;
    this.firstClipNode = firstClipNode;
    this.lastClipNode = lastClipNode;
    this.allowedClipNodes = null;
  }

  /**
   * Determines the contents at a point by descending the tree.
   * @param point Point in hull space.
   * @param num Node to start at.
   * @returns The negative contents value of the leaf the point is in.
   */
  pointContents(point: Vector, num: number = this.firstClipNode): content {
    const allowed = this.allowedClipNodes;
    const planeNums = this.tree.planeNums;
    const children = this.tree.children;

    // as long as num is a valid node, keep going down the tree
    while (num >= 0) {
      if (allowed !== null && allowed[num] !== 1) {
        return content.CONTENT_EMPTY;
      }

      console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid hull node', num);

      const d = this.planes.distance(planeNums[num], point);

      // Q1: d < 0 goes to the back child, else to the front child. This has to match the line trace, which sends
      // `t1 >= 0 && t2 >= 0` to the front, so that a point and a trace agree on a boundary.
      num = children[num * 2 + (d < 0 ? 1 : 0)];
    }

    return num;
  }

  /**
   * Traces a line through the hull and updates the trace with the first thing it hits.
   * @param trace Trace result to update; a fresh one has `allsolid` set and a fraction of 1.
   * @param start Start of the line in hull space.
   * @param end End of the line in hull space.
   * @param skyBlocks Whether sky is solid. Player movement must not fall or step through sky, so it is. Projectiles have
   * to enter the sky leaf so that the game sees the contents and removes them without an impact, so for entities it is not.
   * @returns True when the line was not stopped.
   */
  trace(trace: HullTrace, start: Vector, end: Vector, skyBlocks: boolean): boolean {
    return this.#check(trace, 0.0, 1.0, start, end, skyBlocks, this.firstClipNode, 0);
  }

  /**
   * Whether a hull contents value stops a trace.
   * @param contents Contents of a leaf.
   * @param skyBlocks Whether sky is solid.
   * @returns True for solid, and for sky when it blocks.
   */
  static #blocks(contents: content, skyBlocks: boolean): boolean {
    return contents === content.CONTENT_SOLID || (skyBlocks && contents === content.CONTENT_SKY);
  }

  #check(trace: HullTrace, p1f: number, p2f: number, p1: Vector, p2: Vector, skyBlocks: boolean, num: number, depth: number): boolean {
    // something nearer than this part of the line has been hit already
    if (trace.fraction <= p1f) {
      return false;
    }

    // check for empty
    if (num < 0) {
      const contents = num as content;

      if (Hull.#blocks(contents, skyBlocks)) {
        trace.startsolid = true;
        return true;
      }

      trace.allsolid = false;

      if (contents === content.CONTENT_EMPTY) {
        trace.inopen = true;
      } else {
        trace.inwater = true;
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
    const planeNum = this.tree.planeNums[num];
    const t1 = this.planes.distance(planeNum, p1);
    const t2 = this.planes.distance(planeNum, p2);
    const children = this.tree.children;

    // checking children on side 1
    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.#check(trace, p1f, p2f, p1, p2, skyBlocks, children[num * 2], depth + 1);
    }

    // checking children on side 2
    if (t1 < 0.0 && t2 < 0.0) {
      return this.#check(trace, p1f, p2f, p1, p2, skyBlocks, children[num * 2 + 1], depth + 1);
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2)));
    let midf = p1f + (p2f - p1f) * frac;

    while (depth >= Hull.#midPool.length) {
      Hull.#midPool.push(new Vector());
    }

    const mid = Hull.#midPool[depth];
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    const side = t1 < 0.0 ? 1 : 0;

    // move up to the node
    if (!this.#check(trace, p1f, midf, p1, mid, skyBlocks, children[num * 2 + side], depth + 1)) {
      return false;
    }

    // go past the node
    if (!Hull.#blocks(this.pointContents(mid, children[num * 2 + (1 - side)]), skyBlocks)) {
      return this.#check(trace, midf, p2f, mid, p2, skyBlocks, children[num * 2 + (1 - side)], depth + 1);
    }

    // never got out of the solid area
    if (trace.allsolid) {
      return false;
    }

    // the other side of the node is solid, this is the impact point
    const base = planeNum * 3;
    const planeNormals = this.planes.normals;
    const planeDist = this.planes.dists[planeNum];

    if (side === 0) {
      trace.plane.normal[0] = planeNormals[base];
      trace.plane.normal[1] = planeNormals[base + 1];
      trace.plane.normal[2] = planeNormals[base + 2];
      trace.plane.dist = planeDist;
    } else {
      trace.plane.normal[0] = -planeNormals[base];
      trace.plane.normal[1] = -planeNormals[base + 1];
      trace.plane.normal[2] = -planeNormals[base + 2];
      trace.plane.dist = -planeDist;
    }

    while (Hull.#blocks(this.pointContents(mid), skyBlocks)) {
      // shouldn’t really happen, but does occasionally
      frac -= 0.1;

      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos.set(mid);
        console.debug('Hull: backup past 0', frac);
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
}

/** The six nodes of a box: one plane each, the box being the solid behind all of them. Never changes, so all boxes share it. */
const BOX_TREE = (() => {
  const tree = new ClipTree(6);

  for (let index = 0; index < 6; index++) {
    const side = index & 1;
    const next = index !== 5 ? index + 1 : content.CONTENT_SOLID;

    tree.set(index, index, side === 0 ? content.CONTENT_EMPTY : next, side === 0 ? next : content.CONTENT_EMPTY);
  }

  return tree;
})();

/**
 * The planes of a box, with a distance that is set per use: even planes are the maximum along an axis, odd planes the minimum.
 * @returns A table of six axial planes at distance 0.
 */
function createBoxPlanes(): PlaneTable {
  const planes = new PlaneTable(6);

  for (let index = 0; index < 6; index++) {
    // axis-aligned unit normal, matches Q1: box_planes[i].normal[i>>1] = 1
    planes.set(index, index >> 1 === 0 ? 1 : 0, index >> 1 === 1 ? 1 : 0, index >> 1 === 2 ? 1 : 0, 0, index >> 1, 0);
  }

  return planes;
}

/**
 * Sets up the planes and clip nodes so that the six floats of a bounding box can just be stored out and get a proper hull.
 * To keep everything totally uniform, bounding boxes are turned into small BSP trees instead of being compared directly.
 * Use `setSize()` or `setBounds()` to set the box.
 *
 * A box hull is the one hull that changes: it is reused for every entity, so a caller has to finish reading a result before
 * the next call to `setSize()`. A verbatim port of vanilla Quake's SV_HullForBox, which uses a static box_hull for the same
 * reason: this runs once per candidate entity for every trace against an entity without a brush model.
 */
export class BoxHull extends Hull {
  constructor() {
    super(createBoxPlanes(), BOX_TREE, new Vector(), new Vector(), 0, 5);
  }

  /**
   * Configures the box.
   * @param mins Local minimum corner.
   * @param maxs Local maximum corner.
   * @returns This hull, for chaining.
   */
  setSize(mins: Vector, maxs: Vector): this {
    console.assert(mins instanceof Vector, 'mins must be a Vector');
    console.assert(maxs instanceof Vector, 'maxs must be a Vector');

    return this.setBounds(mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2]);
  }

  /**
   * Configures the box without needing vectors for its corners. Matches Q1’s SV_HullForBox.
   * @param minX Minimum x.
   * @param minY Minimum y.
   * @param minZ Minimum z.
   * @param maxX Maximum x.
   * @param maxY Maximum y.
   * @param maxZ Maximum z.
   * @returns This hull, for chaining.
   */
  setBounds(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): this {
    const dists = this.planes.dists;

    dists[0] = maxX;
    dists[1] = minX;
    dists[2] = maxY;
    dists[3] = minY;
    dists[4] = maxZ;
    dists[5] = minZ;

    return this;
  }
}
