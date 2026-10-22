/**
 * Builds `LIGHTGRID_OCTREE` lumps for the tests of the lightgrid parser and of the sampler that reads it.
 */

/** One light style of a grid point. */
export interface LightgridStyleSpec {
  readonly stylenum: number;
  readonly rgb: readonly [number, number, number];
}

/** A grid point: its light styles, or null for a point without data. */
export type LightgridPointSpec = readonly LightgridStyleSpec[] | null;

/** A leaf of the octree: a box of grid points, x varying fastest. */
export interface LightgridLeafSpec {
  readonly mins: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly points: readonly LightgridPointSpec[];
}

/** An octree node. */
export interface LightgridNodeSpec {
  readonly mid: readonly [number, number, number];
  readonly child: readonly number[];
}

/** Everything a lump holds. */
export interface LightgridLumpSpec {
  readonly step: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly mins: readonly [number, number, number];
  readonly numstyles: number;
  readonly rootnode: number;
  readonly nodes: readonly LightgridNodeSpec[];
  readonly leafs: readonly LightgridLeafSpec[];
}

/** Child reference flag: a leaf index. */
export const LGNODE_LEAF = 1 << 31;

/** Child reference flag: no data in this region. */
export const LGNODE_MISSING = 1 << 30;

/**
 * Encodes a lump the way the map compiler stores it.
 * @param spec What the lump holds.
 * @returns The lump bytes.
 */
export function encodeLightgridLump(spec: LightgridLumpSpec): Uint8Array {
  let length = 49 + spec.nodes.length * 44;

  for (const leaf of spec.leafs) {
    length += 24;

    for (const point of leaf.points) {
      length += point === null ? 1 : 1 + point.length * 4;
    }
  }

  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  const writeFloats = (values: readonly number[]): void => {
    for (const value of values) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  };

  const writeInts = (values: readonly number[]): void => {
    for (const value of values) {
      view.setInt32(offset, value, true);
      offset += 4;
    }
  };

  const writeUints = (values: readonly number[]): void => {
    for (const value of values) {
      view.setUint32(offset, value >>> 0, true);
      offset += 4;
    }
  };

  writeFloats(spec.step);
  writeInts(spec.size);
  writeFloats(spec.mins);
  view.setUint8(offset++, spec.numstyles);
  writeUints([spec.rootnode, spec.nodes.length]);

  for (const node of spec.nodes) {
    writeUints([...node.mid, ...node.child]);
  }

  writeUints([spec.leafs.length]);

  for (const leaf of spec.leafs) {
    writeInts([...leaf.mins, ...leaf.size]);

    for (const point of leaf.points) {
      if (point === null) {
        view.setUint8(offset++, 0xff);
        continue;
      }

      view.setUint8(offset++, point.length);

      for (const style of point) {
        view.setUint8(offset++, style.stylenum);
        view.setUint8(offset++, style.rgb[0]);
        view.setUint8(offset++, style.rgb[1]);
        view.setUint8(offset++, style.rgb[2]);
      }
    }
  }

  return bytes;
}

/**
 * Builds a grid with one leaf that covers all of it.
 * @param size Grid size in points.
 * @param points The points of the leaf, x varying fastest.
 * @param step World units between two points.
 * @returns The grid spec, the octree being a single leaf.
 */
export function singleLeafLightgrid(size: readonly [number, number, number], points: readonly LightgridPointSpec[], step = 1): LightgridLumpSpec {
  return {
    step: [step, step, step],
    size,
    mins: [0, 0, 0],
    numstyles: 1,
    rootnode: LGNODE_LEAF,
    nodes: [],
    leafs: [{ mins: [0, 0, 0], size, points }],
  };
}
