import type { ConsoleOutput } from '../Services.ts';
import Vector from '../../../shared/Vector.ts';

/** Child reference flag: the reference is a leaf index, not a node index. */
export const LIGHTGRID_NODE_LEAF = 1 << 31;

/** Child reference flag (with `LIGHTGRID_NODE_LEAF`): the region has no lighting data. */
export const LIGHTGRID_NODE_MISSING = 1 << 30;

/** Style count that marks a grid point without data. */
export const LIGHTGRID_POINT_MISSING = 0xff;

/** Bytes per node in the lump: `mid` (3 x uint32) and `child` (8 x uint32). */
const NODE_BYTES = 44;

/** Bytes per leaf header in the lump: `mins` and `size` (3 x int32 each). */
const LEAF_HEADER_BYTES = 24;

/** Bytes per light style of a point in the lump: style number and RGB. */
const STYLE_BYTES = 4;

/** Uint32 values per node in `Lightgrid.nodes`: `mid[3]`, `child[8]`. */
const NODE_STRIDE = 11;

/** More levels than any octree over a 32 bit grid can have, so a cyclic node reference cannot hang a lookup. */
const MAX_DEPTH = 64;

/**
 * The BSPX `LIGHTGRID_OCTREE` lump: a volumetric light probe grid for lighting entities.
 *
 * A big map has millions of grid points (3.3 million on a 24 MB map), so the points are not turned into objects. The lump's
 * point data is kept as it is stored and read when a point is sampled; only the octree, the leaf headers and an offset per
 * row of points are decoded, because a point is `1 + 4 * stylecount` bytes wide and therefore not directly addressable.
 *
 * A point in `points` is a style count, followed by that many `[stylenum, r, g, b]` records. A count of
 * `LIGHTGRID_POINT_MISSING` is a point without data and has no records.
 */
export class Lightgrid {
  /** World units between two grid points. */
  readonly step: readonly [number, number, number];

  /** Grid size in points. */
  readonly size: readonly [number, number, number];

  /** World position of grid point 0, 0, 0. */
  readonly mins: Vector;

  /** Number of light styles the grid was baked with. */
  readonly numstyles: number;

  /** Reference to the octree root, a node index or a flagged leaf index. */
  readonly rootnode: number;

  /** Octree nodes, `NODE_STRIDE` values each: `mid[3]`, then `child[8]` (node indices or flagged leaf references). */
  readonly nodes: Uint32Array;

  /** Leaf boxes in grid points, 6 values each: `mins[3]`, `size[3]`. */
  readonly leafBounds: Int32Array;

  /** Index into `rowOffsets` of the first row of each leaf. */
  readonly leafFirstRow: Uint32Array;

  /** Byte offset into `points` of the first point of every row, a row being the points of one leaf with the same y and z. */
  readonly rowOffsets: Uint32Array;

  /** The point data of all leafs, as stored in the lump (leaf headers included, they are skipped by `rowOffsets`). */
  readonly points: Uint8Array;

  constructor(
    step: readonly [number, number, number],
    size: readonly [number, number, number],
    mins: Vector,
    numstyles: number,
    rootnode: number,
    nodes: Uint32Array,
    leafBounds: Int32Array,
    leafFirstRow: Uint32Array,
    rowOffsets: Uint32Array,
    points: Uint8Array,
  ) {
    this.step = step;
    this.size = size;
    this.mins = mins;
    this.numstyles = numstyles;
    this.rootnode = rootnode;
    this.nodes = nodes;
    this.leafBounds = leafBounds;
    this.leafFirstRow = leafFirstRow;
    this.rowOffsets = rowOffsets;
    this.points = points;
  }

  /**
   * Number of octree nodes.
   * @returns The count.
   */
  get nodeCount(): number {
    return this.nodes.length / NODE_STRIDE;
  }

  /**
   * Number of octree leafs.
   * @returns The count.
   */
  get leafCount(): number {
    return this.leafFirstRow.length;
  }

  /**
   * Reads a `LIGHTGRID_OCTREE` lump.
   * @param buffer The BSP file.
   * @param fileofs Offset of the lump in the file.
   * @param filelen Length of the lump.
   * @param con Where a malformed lump is reported.
   * @returns The grid, or null when the lump is malformed or truncated.
   */
  static parse(buffer: ArrayBuffer, fileofs: number, filelen: number, con: ConsoleOutput): Lightgrid | null {
    // vec3 step (12) + ivec3 size (12) + vec3 mins (12) + byte numstyles (1) + uint32 rootnode (4) + uint32 numnodes (4)
    // + uint32 numleafs (4) = 49 bytes
    if (filelen < 49) {
      con.DPrint('BSPXLoader: LIGHTGRID_OCTREE lump too small\n');
      return null;
    }

    const view = new DataView(buffer);
    const endOffset = fileofs + filelen;
    let offset = fileofs;

    const step: [number, number, number] = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
    offset += 12;

    const size: [number, number, number] = [view.getInt32(offset, true), view.getInt32(offset + 4, true), view.getInt32(offset + 8, true)];
    offset += 12;

    const mins = new Vector(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
    offset += 12;

    // the byte makes the rest of the lump unaligned
    const numstyles = view.getUint8(offset);
    offset += 1;

    const rootnode = view.getUint32(offset, true);
    offset += 4;

    const numnodes = view.getUint32(offset, true);
    offset += 4;

    if (offset + (numnodes * NODE_BYTES) > endOffset) {
      con.DPrint('BSPXLoader: LIGHTGRID_OCTREE nodes data truncated\n');
      return null;
    }

    const nodes = new Uint32Array(numnodes * NODE_STRIDE);

    for (let index = 0; index < nodes.length; index++, offset += 4) {
      nodes[index] = view.getUint32(offset, true);
    }

    if (offset + 4 > endOffset) {
      con.DPrint('BSPXLoader: LIGHTGRID_OCTREE numleafs missing\n');
      return null;
    }

    const numleafs = view.getUint32(offset, true);
    offset += 4;

    // the leafs are kept as they are stored, so the offsets below are relative to their start
    const leafsStart = offset;
    const leafBounds = new Int32Array(numleafs * 6);
    const leafFirstRow = new Uint32Array(numleafs);
    const rowOffsets: number[] = [];
    const raw = new Uint8Array(buffer, leafsStart, endOffset - leafsStart);

    for (let leaf = 0; leaf < numleafs; leaf++) {
      if (offset + LEAF_HEADER_BYTES > endOffset) {
        con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${leaf} header truncated\n`);
        return null;
      }

      for (let index = 0; index < 6; index++, offset += 4) {
        leafBounds[leaf * 6 + index] = view.getInt32(offset, true);
      }

      const sizeX = leafBounds[leaf * 6 + 3];
      const sizeY = leafBounds[leaf * 6 + 4];
      const sizeZ = leafBounds[leaf * 6 + 5];

      // every point takes at least a byte, which also keeps a corrupt size from allocating
      if (sizeX < 0 || sizeY < 0 || sizeZ < 0 || sizeX * sizeY * sizeZ > endOffset - offset) {
        con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${leaf} has an invalid size\n`);
        return null;
      }

      leafFirstRow[leaf] = rowOffsets.length;

      for (let z = 0; z < sizeZ; z++) {
        for (let y = 0; y < sizeY; y++) {
          rowOffsets.push(offset - leafsStart);

          for (let x = 0; x < sizeX; x++) {
            if (offset >= endOffset) {
              con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${leaf} point ${(z * sizeY + y) * sizeX + x} truncated\n`);
              return null;
            }

            const stylecount = raw[offset - leafsStart];
            offset += 1;

            if (stylecount === LIGHTGRID_POINT_MISSING) {
              continue;
            }

            // the last byte of the last style
            if (stylecount > 0 && offset + (stylecount * STYLE_BYTES) - 1 >= endOffset) {
              con.DPrint(`BSPXLoader: LIGHTGRID_OCTREE leaf ${leaf} point ${(z * sizeY + y) * sizeX + x} style data truncated\n`);
              return null;
            }

            offset += stylecount * STYLE_BYTES;
          }
        }
      }
    }

    // a copy, so that the grid does not keep the whole BSP file alive
    const points = raw.slice();

    return new Lightgrid(step, size, mins, numstyles, rootnode, nodes, leafBounds, leafFirstRow, Uint32Array.from(rowOffsets), points);
  }

  /**
   * Finds a grid point.
   * @param gridX Grid coordinate on the x axis.
   * @param gridY Grid coordinate on the y axis.
   * @param gridZ Grid coordinate on the z axis.
   * @returns Offset of the point in `points`, or -1 when the grid has no sample there.
   */
  findPoint(gridX: number, gridY: number, gridZ: number): number {
    const nodes = this.nodes;
    const nodeCount = this.nodeCount;
    let reference = this.rootnode;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if ((reference & LIGHTGRID_NODE_LEAF) !== 0) {
        if ((reference & LIGHTGRID_NODE_MISSING) !== 0) {
          return -1;
        }

        return this.#findPointInLeaf(reference & ~(LIGHTGRID_NODE_LEAF | LIGHTGRID_NODE_MISSING), gridX, gridY, gridZ);
      }

      if (reference >= nodeCount) {
        return -1;
      }

      // child index: ((z >= mid[2]) << 0) | ((y >= mid[1]) << 1) | ((x >= mid[0]) << 2)
      const base = reference * NODE_STRIDE;
      let child = 0;

      if (gridZ >= nodes[base + 2]) {
        child |= 1;
      }

      if (gridY >= nodes[base + 1]) {
        child |= 2;
      }

      if (gridX >= nodes[base]) {
        child |= 4;
      }

      reference = nodes[base + 3 + child];
    }

    return -1;
  }

  /**
   * Finds a grid point inside a leaf.
   * @param leaf Leaf index.
   * @param gridX Grid coordinate on the x axis.
   * @param gridY Grid coordinate on the y axis.
   * @param gridZ Grid coordinate on the z axis.
   * @returns Offset of the point in `points`, or -1 when the leaf has no sample there.
   */
  #findPointInLeaf(leaf: number, gridX: number, gridY: number, gridZ: number): number {
    if (leaf >= this.leafCount) {
      return -1;
    }

    const bounds = this.leafBounds;
    const base = leaf * 6;
    const localX = gridX - bounds[base];
    const localY = gridY - bounds[base + 1];
    const localZ = gridZ - bounds[base + 2];
    const sizeX = bounds[base + 3];
    const sizeY = bounds[base + 4];

    if (localX < 0 || localX >= sizeX || localY < 0 || localY >= sizeY || localZ < 0 || localZ >= bounds[base + 5]) {
      return -1;
    }

    const points = this.points;
    let offset = this.rowOffsets[this.leafFirstRow[leaf] + localZ * sizeY + localY];

    // points have different widths, so walk from the start of the row
    for (let x = 0; x < localX; x++) {
      const stylecount = points[offset];

      offset += stylecount === LIGHTGRID_POINT_MISSING ? 1 : 1 + stylecount * STYLE_BYTES;
    }

    return points[offset] === LIGHTGRID_POINT_MISSING ? -1 : offset;
  }
}
