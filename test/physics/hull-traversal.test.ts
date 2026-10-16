import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { Plane } from '../../source/engine/common/model/BaseModel.ts';
import type { Clipnode, Hull as ModelHull } from '../../source/engine/common/model/BSP.ts';
import { Hull, Trace } from '../../source/engine/common/Pmove.ts';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { hullPointContents, pointContents, recursiveHullCheck } from '../../source/engine/server/physics/ServerLegacyHullCollision.ts';
import { createRandom } from '../support/pmoveDeterminism.ts';

/**
 * Characterization of the two hull traversals that exist side by side today: `Pmove.Hull` (players, client prediction) and
 * `ServerLegacyHullCollision` (entities on the server). `plans/bsp-flat-layout.md` unifies them behind one implementation;
 * these tests pin what each does now, including the one difference that is on purpose (sky), so the unification can be
 * checked against both.
 */

type ServerHull = Parameters<typeof recursiveHullCheck>[0];

/** A hull in the model's own shape, which both traversals are built from. */
interface HullSpec {
  readonly model: ModelHull & { readonly firstclipnode: number };
}

/**
 
 Builds a plane the way the BSP loader does, including its axis type and sign bits.
 * @param normal Plane normal.
 * @param dist Plane distance.
 * @returns The plane.
 */
function createPlane(normal: [number, number, number], dist: number): Plane {
  const vector = new Vector(...normal);
  const plane = new Plane(vector, dist);

  if (normal[0] === 1 && normal[1] === 0 && normal[2] === 0) {
    plane.type = 0;
  } else if (normal[0] === 0 && normal[1] === 1 && normal[2] === 0) {
    plane.type = 1;
  } else if (normal[0] === 0 && normal[1] === 0 && normal[2] === 1) {
    plane.type = 2;
  } else {
    plane.type = 3;
  }

  plane.signbits = ((vector[0] < 0 ? 1 : 0) | (vector[1] < 0 ? 2 : 0) | (vector[2] < 0 ? 4 : 0)) as Plane['signbits'];

  return plane;
}

/**
 
 Wraps planes and clipnodes in the model's hull shape.
 * @param planes Planes the clipnodes refer to.
 * @param clipnodes Clipnodes of the hull, the first one is the root.
 * @param allowedClipNodes Optional mask of the clipnodes the hull may enter.
 * @returns The hull.
 */
function createHull(planes: Plane[], clipnodes: Clipnode[], allowedClipNodes: Uint8Array | null = null): HullSpec {
  return {
    model: {
      clipnodes,
      planes,
      firstclipnode: 0,
      lastclipnode: clipnodes.length - 1,
      clip_mins: new Vector(),
      clip_maxs: new Vector(),
      allowedClipNodes,
    },
  };
}

/**
 * A single split at x = 0: x >= 0 is open, x < 0 is `behind`.
 * @param behind Contents on the negative side of the plane.
 * @returns The hull.
 */
function createWallHull(behind: content): HullSpec {
  return createHull(
    [createPlane([1, 0, 0], 0)],
    [{ planenum: 0, children: [content.CONTENT_EMPTY, behind] }],
  );
}

interface TraceResult {
  readonly allsolid: boolean;
  readonly startsolid: boolean;
  readonly fraction: number;
  readonly endpos: number[];
  readonly planeNormal: number[];
  readonly planeDist: number;
  readonly inopen: boolean;
  readonly inwater: boolean;
}

/**
 
 Traces a segment with the hull Pmove builds from the model hull.
 * @param spec Hull to trace through.
 * @param start Segment start.
 * @param end Segment end.
 * @returns What the trace reports.
 */
function pmoveTrace(spec: HullSpec, start: Vector, end: Vector): TraceResult {
  const trace = new Trace();
  trace.endpos.set(end);
  Hull.fromModelHull(spec.model).check(0, 1, start, end, trace);

  return summarize(trace);
}

/**
 
 Traces a segment with the server's entity hull traversal.
 * @param spec Hull to trace through.
 * @param start Segment start.
 * @param end Segment end.
 * @returns What the trace reports.
 */
function serverTrace(spec: HullSpec, start: Vector, end: Vector): TraceResult {
  const trace = new CollisionTrace(end.copy(), { allsolid: true });
  recursiveHullCheck(spec.model as ServerHull, spec.model.firstclipnode, 0, 1, start, end, trace);

  return summarize(trace);
}

/**
 
 Reads the comparable state out of a trace of either implementation.
 * @param trace Finished trace.
 * @returns The state, as plain values.
 */
function summarize(trace: Trace | CollisionTrace): TraceResult {
  return {
    allsolid: trace.allsolid,
    startsolid: trace.startsolid,
    fraction: trace.fraction,
    endpos: [...trace.endpos],
    planeNormal: [...trace.plane.normal],
    planeDist: trace.plane.dist,
    inopen: trace.inopen,
    inwater: trace.inwater,
  };
}

/**
 * A random clipnode tree over axial and slanted planes, without sky, and without any promise that it is a geometrically
 * consistent BSP: the two traversals must agree on the arithmetic, whatever the tree.
 * @param random Seeded generator.
 * @returns The hull.
 */
function createRandomHull(random: () => number): HullSpec {
  const planes: Plane[] = [];
  const clipnodes: Clipnode[] = [];
  const leafContents = [content.CONTENT_EMPTY, content.CONTENT_EMPTY, content.CONTENT_SOLID, content.CONTENT_WATER];

  /**
   
   Builds a random subtree and returns its reference: a clipnode index, or a negative contents value.
   * @param depth Levels left below this one.
   * @returns The reference.
   */
  function build(depth: number): number {
    if (depth === 0 || (depth < 4 && random() < 0.15)) {
      return leafContents[Math.floor(random() * leafContents.length)];
    }

    const planeNum = planes.length;

    if (random() < 0.6) {
      const axis = Math.floor(random() * 3);
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = 1;
      planes.push(createPlane(normal, Math.round((random() - 0.5) * 200)));
    } else {
      const raw = new Vector(random() - 0.5, random() - 0.5, random() - 0.5);
      raw.normalize();
      planes.push(createPlane([raw[0], raw[1], raw[2]], Math.round((random() - 0.5) * 200)));
    }

    const index = clipnodes.length;
    clipnodes.push({ planenum: planeNum, children: [0, 0] });
    const front = build(depth - 1);
    const back = build(depth - 1);
    clipnodes[index] = { planenum: planeNum, children: [front, back] };

    return index;
  }

  const root = build(7);
  assert.equal(root, 0, 'the root must be the first clipnode');

  return createHull(planes, clipnodes);
}

void describe('hull traversal', () => {
  void describe('the two implementations agree outside of sky', () => {
    void test('point contents are the same for random points in random trees', () => {
      const random = createRandom(0x6b5d);

      for (let tree = 0; tree < 20; tree++) {
        const spec = createRandomHull(random);
        const pmoveHull = Hull.fromModelHull(spec.model);

        for (let sample = 0; sample < 200; sample++) {
          const point = new Vector((random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300);

          assert.equal(
            hullPointContents(spec.model as ServerHull, 0, point),
            pmoveHull.pointContents(point),
            `tree ${tree}, point ${[...point]}`,
          );
        }
      }
    });

    void test('traces are the same for random segments in random trees', (t) => {
      // both print when the backup loop runs out, which a random tree provokes now and then
      t.mock.method(console, 'warn', () => {});
      t.mock.method(console, 'debug', () => {});

      const random = createRandom(0x51ab);
      let hits = 0;

      for (let tree = 0; tree < 20; tree++) {
        const spec = createRandomHull(random);

        for (let sample = 0; sample < 150; sample++) {
          const start = new Vector((random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300);
          const end = new Vector((random() - 0.5) * 300, (random() - 0.5) * 300, (random() - 0.5) * 300);
          const expected = pmoveTrace(spec, start.copy(), end.copy());

          assert.deepEqual(serverTrace(spec, start.copy(), end.copy()), expected, `tree ${tree}, segment ${[...start]} -> ${[...end]}`);

          if (expected.fraction < 1) {
            hits++;
          }
        }
      }

      // a test that never hits anything would pass for the wrong reason
      assert.ok(hits > 300, `only ${hits} of 3000 segments hit something`);
    });
  });

  void describe('sky', () => {
    // Players must not fall or step through sky, so Pmove treats it like solid. Projectiles must enter the sky leaf, where
    // the game sees CONTENT_SKY and removes them quietly (a solid hit would make sparks or an explosion).
    const start = new Vector(10, 0, 0);
    const end = new Vector(-10, 0, 0);

    // 10 - 0.03125 (DIST_EPSILON) of 20 units
    const impactFraction = 0.4984375;

    void test('Pmove stops at sky like at a wall', () => {
      const sky = pmoveTrace(createWallHull(content.CONTENT_SKY), start, end);
      const wall = pmoveTrace(createWallHull(content.CONTENT_SOLID), start, end);

      assert.equal(sky.fraction, impactFraction);
      assert.deepEqual(sky, wall);
    });

    void test('the server trace goes into sky and reports it as a liquid-like volume, not as an impact', () => {
      const trace = serverTrace(createWallHull(content.CONTENT_SKY), start, end);

      assert.equal(trace.fraction, 1);
      assert.deepEqual(trace.endpos, [-10, 0, 0]);
      assert.equal(trace.startsolid, false);
      // classifyHullLeaf files every contents that is neither solid nor empty under "water"
      assert.equal(trace.inwater, true);
    });

    void test('the server trace stops at a wall at the same place Pmove does', () => {
      const trace = serverTrace(createWallHull(content.CONTENT_SOLID), start, end);

      assert.equal(trace.fraction, impactFraction);
      assert.deepEqual(trace.planeNormal, [1, 0, 0]);
    });

    void test('starting inside sky is startsolid for Pmove and not for the server', () => {
      const inside = new Vector(-5, 0, 0);
      const outside = new Vector(-20, 0, 0);

      assert.equal(pmoveTrace(createWallHull(content.CONTENT_SKY), inside, outside).startsolid, true);
      assert.equal(serverTrace(createWallHull(content.CONTENT_SKY), inside, outside).startsolid, false);
    });

    void test('point contents report sky as it is, for both', () => {
      const spec = createWallHull(content.CONTENT_SKY);
      const point = new Vector(-1, 0, 0);

      assert.equal(hullPointContents(spec.model as ServerHull, 0, point), content.CONTENT_SKY);
      assert.equal(Hull.fromModelHull(spec.model).pointContents(point), content.CONTENT_SKY);
    });
  });

  void describe('clipnodes outside the hull subtree', () => {
    // BSP29 shares one clipnode array between the world and its inline models; the mask keeps a trace in its own subtree.
    /**
     * A one-node hull whose only clipnode is masked out.
     * @returns The hull.
     */
    function createMaskedHull(): HullSpec {
      return createHull(
        [createPlane([1, 0, 0], 0)],
        [{ planenum: 0, children: [content.CONTENT_EMPTY, content.CONTENT_SOLID] }],
        new Uint8Array([0]),
      );
    }

    void test('a masked node reads as empty for point contents in both', () => {
      const spec = createMaskedHull();
      const point = new Vector(-5, 0, 0);

      assert.equal(hullPointContents(spec.model as ServerHull, 0, point), content.CONTENT_EMPTY);
      assert.equal(Hull.fromModelHull(spec.model).pointContents(point), content.CONTENT_EMPTY);
    });

    void test('a trace through a masked node is the open, unblocked trace in both', () => {
      const spec = createMaskedHull();
      const start = new Vector(10, 0, 0);
      const end = new Vector(-10, 0, 0);

      const expected = pmoveTrace(spec, start, end);

      assert.equal(expected.fraction, 1);
      assert.equal(expected.inopen, true);
      assert.equal(expected.allsolid, false);
      assert.deepEqual(serverTrace(spec, start, end), expected);
    });

    void test('the hull Pmove builds does not share the mask with the model', () => {
      const spec = createMaskedHull();
      const hull = Hull.fromModelHull(spec.model);

      assert.notEqual(hull.allowedClipNodes, spec.model.allowedClipNodes);
      assert.deepEqual(hull.allowedClipNodes, spec.model.allowedClipNodes);
    });
  });

  void describe('what only the server does', () => {
    void test('a trace that already hit something nearer than this segment is not continued', () => {
      const spec = createWallHull(content.CONTENT_SOLID);
      const trace = new CollisionTrace(new Vector(), { allsolid: true, fraction: 0.2 });

      const continued = recursiveHullCheck(spec.model as ServerHull, 0, 0.5, 1, new Vector(10, 0, 0), new Vector(-10, 0, 0), trace);

      assert.equal(continued, false);
      assert.equal(trace.fraction, 0.2);
      assert.equal(trace.allsolid, true);
    });

    void test('world point contents fold the current contents into water', () => {
      const currents = [
        content.CONTENT_CURRENT_0,
        content.CONTENT_CURRENT_90,
        content.CONTENT_CURRENT_180,
        content.CONTENT_CURRENT_270,
        content.CONTENT_CURRENT_UP,
        content.CONTENT_CURRENT_DOWN,
      ];

      for (const current of currents) {
        const spec = createWallHull(current);
        const point = new Vector(-1, 0, 0);

        assert.equal(hullPointContents(spec.model as ServerHull, 0, point), current);
        assert.equal(pointContents({ hulls: [spec.model] } as unknown as Parameters<typeof pointContents>[0], point), content.CONTENT_WATER);
      }
    });

    void test('Pmove reports a current as it is', () => {
      const spec = createWallHull(content.CONTENT_CURRENT_UP);

      assert.equal(Hull.fromModelHull(spec.model).pointContents(new Vector(-1, 0, 0)), content.CONTENT_CURRENT_UP);
    });
  });
});
