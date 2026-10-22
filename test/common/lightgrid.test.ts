import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Lightgrid, LIGHTGRID_POINT_MISSING } from '../../source/engine/common/model/Lightgrid.ts';
import { createSilentConsole } from '../support/modelContext.ts';
import { createRandom } from '../support/pmoveDeterminism.ts';
import {
  encodeLightgridLump,
  LGNODE_LEAF,
  LGNODE_MISSING,
  singleLeafLightgrid,
  type LightgridLumpSpec,
  type LightgridPointSpec,
} from '../support/lightgridLump.ts';

/**
 * Parses a lump with a console that records what it is told.
 * @param lump Lump bytes.
 * @returns The grid, or null, and the debug messages.
 */
function parse(lump: Uint8Array): { grid: Lightgrid | null; messages: string[] } {
  const messages: string[] = [];
  const con = createSilentConsole({ DPrint: (message: string) => { messages.push(message); } });
  // a file with something in front of the lump, like a real one
  const file = new Uint8Array(16 + lump.length);
  file.set(lump, 16);

  return { grid: Lightgrid.parse(file.buffer, 16, lump.length, con), messages };
}

/**
 * Reads a point the way the sampler does.
 * @param grid Grid to read from.
 * @param offset Offset returned by `findPoint`.
 * @returns The point's styles, or null for no data.
 */
function readPoint(grid: Lightgrid, offset: number): LightgridPointSpec {
  if (offset < 0) {
    return null;
  }

  const styles = [];

  for (let index = 0; index < grid.points[offset]; index++) {
    const style = offset + 1 + index * 4;
    styles.push({ stylenum: grid.points[style], rgb: [grid.points[style + 1], grid.points[style + 2], grid.points[style + 3]] as const });
  }

  return styles;
}

const RED = [{ stylenum: 0, rgb: [200, 0, 0] as const }];
const GREEN_AND_BLUE = [{ stylenum: 0, rgb: [0, 200, 0] as const }, { stylenum: 5, rgb: [0, 0, 200] as const }];

void describe('Lightgrid', () => {
  void describe('parse', () => {
    void test('reads the header, the octree and the leafs', () => {
      const spec: LightgridLumpSpec = {
        step: [16, 16, 32],
        size: [4, 2, 1],
        mins: [-64, -32, 0],
        numstyles: 2,
        rootnode: 0,
        nodes: [{ mid: [2, 1, 1], child: [LGNODE_LEAF | 0, LGNODE_LEAF | LGNODE_MISSING, 0, 0, 0, 0, 0, 0] }],
        leafs: [{ mins: [0, 0, 0], size: [1, 1, 1], points: [RED] }],
      };

      const { grid } = parse(encodeLightgridLump(spec));

      assert.ok(grid !== null);
      assert.deepEqual([...grid.step], [16, 16, 32]);
      assert.deepEqual([...grid.size], [4, 2, 1]);
      assert.deepEqual([...grid.mins], [-64, -32, 0]);
      assert.equal(grid.numstyles, 2);
      assert.equal(grid.nodeCount, 1);
      assert.equal(grid.leafCount, 1);
    });

    void test('copies the point data instead of keeping the file', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]));
      const { grid } = parse(lump);

      assert.ok(grid !== null);
      assert.ok(grid.points.byteLength < lump.length + 16);
      assert.equal(grid.points.buffer.byteLength, grid.points.byteLength);
    });

    void test('rejects a lump that is too small', () => {
      const { grid, messages } = parse(new Uint8Array(48));

      assert.equal(grid, null);
      assert.match(messages[0], /too small/);
    });

    void test('rejects truncated nodes', () => {
      const lump = encodeLightgridLump({
        ...singleLeafLightgrid([1, 1, 1], [RED]),
        nodes: [{ mid: [0, 0, 0], child: [0, 0, 0, 0, 0, 0, 0, 0] }],
      });
      const { grid, messages } = parse(lump.subarray(0, 49 + 20));

      assert.equal(grid, null);
      assert.match(messages[0], /nodes data truncated/);
    });

    void test('rejects a missing leaf count', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]));
      const { grid, messages } = parse(lump.subarray(0, 45));

      assert.equal(grid, null);
      assert.match(messages[0], /(too small|numleafs missing)/);
    });

    void test('rejects a truncated leaf header', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]));
      const { grid, messages } = parse(lump.subarray(0, 49 + 10));

      assert.equal(grid, null);
      assert.match(messages[0], /leaf 0 header truncated/);
    });

    void test('rejects a truncated point', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([2, 1, 1], [RED, GREEN_AND_BLUE]));
      // cut inside the last style
      const { grid, messages } = parse(lump.subarray(0, lump.length - 2));

      assert.equal(grid, null);
      assert.match(messages[0], /truncated/);
    });

    void test('rejects a leaf that claims more points than the lump has bytes', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]));
      const view = new DataView(lump.buffer, lump.byteOffset);
      // leaf size starts after the 49 byte header and the 12 byte leaf mins
      view.setInt32(49 + 12, 1 << 28, true);
      const { grid, messages } = parse(lump);

      assert.equal(grid, null);
      assert.match(messages[0], /invalid size/);
    });

    void test('rejects a negative leaf size', () => {
      const lump = encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]));
      new DataView(lump.buffer, lump.byteOffset).setInt32(49 + 12, -1, true);

      assert.equal(parse(lump).grid, null);
    });
  });

  void describe('findPoint', () => {
    void test('walks the octree to the leaf and the point', () => {
      // two leafs side by side along x: x < 2 and x >= 2; the second one is shifted in y
      const spec: LightgridLumpSpec = {
        step: [1, 1, 1],
        size: [4, 2, 1],
        mins: [0, 0, 0],
        numstyles: 2,
        rootnode: 0,
        nodes: [{ mid: [2, 0, 0], child: [LGNODE_LEAF | 0, LGNODE_LEAF | 0, LGNODE_LEAF | 0, LGNODE_LEAF | 0, LGNODE_LEAF | 1, LGNODE_LEAF | 1, LGNODE_LEAF | 1, LGNODE_LEAF | 1] }],
        leafs: [
          { mins: [0, 0, 0], size: [2, 2, 1], points: [RED, null, GREEN_AND_BLUE, RED] },
          { mins: [2, 0, 0], size: [2, 1, 1], points: [GREEN_AND_BLUE, null] },
        ],
      };
      const { grid } = parse(encodeLightgridLump(spec));

      assert.ok(grid !== null);
      assert.deepEqual(readPoint(grid, grid.findPoint(0, 0, 0)), RED);
      assert.equal(grid.findPoint(1, 0, 0), -1);
      assert.deepEqual(readPoint(grid, grid.findPoint(0, 1, 0)), GREEN_AND_BLUE);
      assert.deepEqual(readPoint(grid, grid.findPoint(1, 1, 0)), RED);
      assert.deepEqual(readPoint(grid, grid.findPoint(2, 0, 0)), GREEN_AND_BLUE);
      assert.equal(grid.findPoint(3, 0, 0), -1);
    });

    void test('finds nothing outside a leaf, in a missing region, or at an invalid reference', () => {
      const missing = parse(encodeLightgridLump({ ...singleLeafLightgrid([1, 1, 1], [RED]), rootnode: LGNODE_LEAF | LGNODE_MISSING })).grid;
      const outside = parse(encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [RED]))).grid;
      const dangling = parse(encodeLightgridLump({ ...singleLeafLightgrid([1, 1, 1], [RED]), rootnode: LGNODE_LEAF | 7 })).grid;
      const noNode = parse(encodeLightgridLump({ ...singleLeafLightgrid([1, 1, 1], [RED]), rootnode: 3 })).grid;

      assert.equal(missing!.findPoint(0, 0, 0), -1);
      assert.equal(outside!.findPoint(1, 0, 0), -1);
      assert.equal(outside!.findPoint(0, -1, 0), -1);
      assert.equal(dangling!.findPoint(0, 0, 0), -1);
      assert.equal(noNode!.findPoint(0, 0, 0), -1);
    });

    void test('does not hang on an octree that refers to itself', () => {
      const spec: LightgridLumpSpec = {
        ...singleLeafLightgrid([1, 1, 1], [RED]),
        rootnode: 0,
        nodes: [{ mid: [0, 0, 0], child: [0, 0, 0, 0, 0, 0, 0, 0] }],
      };

      assert.equal(parse(encodeLightgridLump(spec)).grid!.findPoint(5, 5, 5), -1);
    });

    void test('gives the same points as the data that was encoded, for random grids', () => {
      const random = createRandom(0x6c1d);

      for (let round = 0; round < 25; round++) {
        const size: [number, number, number] = [1 + Math.floor(random() * 9), 1 + Math.floor(random() * 6), 1 + Math.floor(random() * 4)];
        const points: LightgridPointSpec[] = [];

        for (let index = 0; index < size[0] * size[1] * size[2]; index++) {
          const kind = random();

          if (kind < 0.2) {
            points.push(null);
          } else if (kind < 0.3) {
            points.push([]);
          } else {
            const styles = [];

            for (let style = 0, count = 1 + Math.floor(random() * 3); style < count; style++) {
              styles.push({ stylenum: Math.floor(random() * 64), rgb: [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)] as const });
            }

            points.push(styles);
          }
        }

        const { grid } = parse(encodeLightgridLump(singleLeafLightgrid(size, points)));

        assert.ok(grid !== null);

        for (let z = 0; z < size[2]; z++) {
          for (let y = 0; y < size[1]; y++) {
            for (let x = 0; x < size[0]; x++) {
              const expected = points[(z * size[1] + y) * size[0] + x];

              assert.deepEqual(readPoint(grid, grid.findPoint(x, y, z)), expected, `round ${round}, point ${x} ${y} ${z}`);
            }
          }
        }
      }
    });

    void test('marks a point without data with the missing count', () => {
      const { grid } = parse(encodeLightgridLump(singleLeafLightgrid([1, 1, 1], [null])));

      assert.equal(grid!.points[grid!.rowOffsets[0]], LIGHTGRID_POINT_MISSING);
      assert.equal(grid!.findPoint(0, 0, 0), -1);
    });
  });
});
