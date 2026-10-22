import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { BoxHull, ClipTree, Hull, PlaneTable } from '../../source/engine/common/collision/Hull.ts';
import { Trace } from '../../source/engine/common/Pmove.ts';
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { buildHull, createPlaneSpec, createRandomHullCases, summarizeTrace, type HullSpec } from '../support/hullSpecs.ts';
import { createRandom } from '../support/pmoveDeterminism.ts';

/**
 * The hull traversal that player movement (on the server and in prediction) and the movement of entities share. It
 * replaced two implementations, Pmove's and the server's, which differed in one thing on purpose: sky.
 */

/**
 * A single split at x = 0: x >= 0 is open, x < 0 is `behind`.
 * @param behind Contents on the negative side of the plane.
 * @returns The hull.
 */
function createWallHull(behind: content): Hull {
  return buildHull({
    planes: [createPlaneSpec([1, 0, 0], 0)],
    nodes: [{ planeNum: 0, children: [content.CONTENT_EMPTY, behind] }],
    mask: null,
  });
}

/**
 * Traces the way player movement does.
 * @param hull Hull to trace through.
 * @param start Segment start.
 * @param end Segment end.
 * @returns What the trace reports.
 */
function playerTrace(hull: Hull, start: Vector, end: Vector): string {
  const trace = new Trace();
  trace.endpos.set(end);
  hull.trace(trace, start, end, true);

  return summarizeTrace(trace);
}

/**
 * Traces the way the movement of an entity does.
 * @param hull Hull to trace through.
 * @param start Segment start.
 * @param end Segment end.
 * @returns What the trace reports.
 */
function entityTrace(hull: Hull, start: Vector, end: Vector): string {
  const trace = new CollisionTrace(end.copy(), { allsolid: true });
  hull.trace(trace, start, end, false);

  return summarizeTrace(trace);
}

void describe('Hull', () => {
  void describe('against what the two traversals before it computed', () => {
    // sha256 of the results of Pmove.Hull.check and pointContents, and of the server's recursiveHullCheck and
    // hullPointContents, on these hulls (8000 points and 6000 segments, each for player and entity movement), taken
    // before they were replaced. The hulls have sky, solid, water, current and open leafs, and some have a mask.
    const DIGEST = 'd3dcf60e2332c755f51781b82f5ff8d51227f0f7c7767dc92aa2e69c4bd572ee';

    void test('gives the same contents and the same traces, bit for bit', (t) => {
      // the backup loop runs out now and then on a random tree
      t.mock.method(console, 'debug', () => {});

      const lines: string[] = [];
      let hits = 0;
      let differ = 0;

      for (const { spec, points, segments } of createRandomHullCases(createRandom(0x2f01), 40)) {
        const hull = buildHull(spec);

        for (const point of points) {
          const vector = new Vector(...point);

          lines.push(`pm ${hull.pointContents(vector)} sv ${hull.pointContents(vector, 0)}`);
        }

        for (const segment of segments) {
          const start = new Vector(segment[0], segment[1], segment[2]);
          const end = new Vector(segment[3], segment[4], segment[5]);
          const player = playerTrace(hull, start.copy(), end.copy());
          const entity = entityTrace(hull, start.copy(), end.copy());

          lines.push(`pm ${player} sv ${entity}`);

          if ((JSON.parse(player) as unknown[])[2] as number < 1) {
            hits++;
          }

          if (player !== entity) {
            differ++;
          }
        }
      }

      assert.equal(createHash('sha256').update(lines.join('\n')).digest('hex'), DIGEST);

      // a test that never hits anything, or never tells the two apart, would pass for the wrong reason
      assert.ok(hits > 2000, `only ${hits} of 6000 segments hit something`);
      assert.ok(differ > 1000, `only ${differ} of 6000 segments differ between player and entity movement`);
    });
  });

  void describe('sky', () => {
    // Players must not fall or step through sky, so player movement treats it like solid. Projectiles must enter the sky
    // leaf, where the game sees CONTENT_SKY and removes them quietly (a solid hit would make sparks or an explosion).
    const start = new Vector(10, 0, 0);
    const end = new Vector(-10, 0, 0);

    // 10 - 0.03125 (DIST_EPSILON) of 20 units
    const impactFraction = 0.4984375;

    void test('player movement stops at sky like at a wall', () => {
      const sky = playerTrace(createWallHull(content.CONTENT_SKY), start, end);

      assert.equal((JSON.parse(sky) as number[])[2], impactFraction);
      assert.equal(sky, playerTrace(createWallHull(content.CONTENT_SOLID), start, end));
    });

    void test('entity movement goes into sky and reports it as a liquid-like volume, not as an impact', () => {
      const [allsolid, startsolid, fraction, endpos, , , , inwater] = JSON.parse(entityTrace(createWallHull(content.CONTENT_SKY), start, end)) as [boolean, boolean, number, number[], unknown, unknown, unknown, boolean];

      assert.equal(fraction, 1);
      assert.deepEqual(endpos, [-10, 0, 0]);
      assert.equal(startsolid, false);
      assert.equal(allsolid, false);
      // every contents that is neither solid nor empty is filed under "water"
      assert.equal(inwater, true);
    });

    void test('a wall stops both at the same place', () => {
      const [, , fraction, , normal] = JSON.parse(entityTrace(createWallHull(content.CONTENT_SOLID), start, end)) as [unknown, unknown, number, unknown, number[]];

      assert.equal(fraction, impactFraction);
      assert.deepEqual(normal, [1, 0, 0]);
      assert.equal(entityTrace(createWallHull(content.CONTENT_SOLID), start, end), playerTrace(createWallHull(content.CONTENT_SOLID), start, end));
    });

    void test('starting inside sky is startsolid for player movement and not for entity movement', () => {
      const inside = new Vector(-5, 0, 0);
      const outside = new Vector(-20, 0, 0);

      assert.equal((JSON.parse(playerTrace(createWallHull(content.CONTENT_SKY), inside, outside)) as boolean[])[1], true);
      assert.equal((JSON.parse(entityTrace(createWallHull(content.CONTENT_SKY), inside, outside)) as boolean[])[1], false);
    });

    void test('point contents report sky as it is', () => {
      assert.equal(createWallHull(content.CONTENT_SKY).pointContents(new Vector(-1, 0, 0)), content.CONTENT_SKY);
    });
  });

  void describe('nodes outside the subtree of the hull', () => {
    // BSP29 shares one tree between the world and its inline models; the mask keeps a trace in its own subtree.
    /**
     * A hull of one node that its mask does not allow.
     * @returns The hull.
     */
    function createMaskedHull(): Hull {
      const spec: HullSpec = {
        planes: [createPlaneSpec([1, 0, 0], 0)],
        nodes: [{ planeNum: 0, children: [content.CONTENT_EMPTY, content.CONTENT_SOLID] }],
        mask: [0],
      };

      return buildHull(spec);
    }

    void test('a masked node reads as empty for point contents', () => {
      assert.equal(createMaskedHull().pointContents(new Vector(-5, 0, 0)), content.CONTENT_EMPTY);
    });

    void test('a trace through a masked node is the open, unblocked trace', () => {
      const [allsolid, , fraction, , , , inopen] = JSON.parse(playerTrace(createMaskedHull(), new Vector(10, 0, 0), new Vector(-10, 0, 0))) as [boolean, unknown, number, unknown, unknown, unknown, boolean];

      assert.equal(fraction, 1);
      assert.equal(inopen, true);
      assert.equal(allsolid, false);
    });
  });

  void describe('a trace that has hit something nearer already', () => {
    // both sides of the plane are open, so the line is walked in two parts
    const hull = buildHull({
      planes: [createPlaneSpec([1, 0, 0], 0)],
      nodes: [{ planeNum: 0, children: [content.CONTENT_EMPTY, content.CONTENT_EMPTY] }],
      mask: null,
    });
    const start = new Vector(10, 0, 0);
    const end = new Vector(-10, 0, 0);

    void test('does not go on with the second part of the line', () => {
      const trace = new CollisionTrace(end.copy(), { allsolid: true, fraction: 0.2 });

      assert.equal(hull.trace(trace, start, end, false), false);
      assert.equal(trace.fraction, 0.2);
    });

    void test('a trace that has hit nothing goes on', () => {
      const trace = new CollisionTrace(end.copy(), { allsolid: true });

      assert.equal(hull.trace(trace, start, end, false), true);
      assert.equal(trace.fraction, 1);
    });
  });

  void describe('hulls that share their data', () => {
    void test('two hulls over one plane table and one tree do not copy either', () => {
      const planes = new PlaneTable(1);
      planes.set(0, 1, 0, 0, 0, 0, 0);
      const tree = new ClipTree(1);
      tree.set(0, 0, content.CONTENT_EMPTY, content.CONTENT_SOLID);

      const first = new Hull(planes, tree, new Vector(-16, -16, -24), new Vector(16, 16, 32));
      const second = new Hull(planes, tree, new Vector(-32, -32, -24), new Vector(32, 32, 64));

      assert.equal(first.planes, second.planes);
      assert.equal(first.tree, second.tree);
      assert.equal(first.pointContents(new Vector(-1, 0, 0)), content.CONTENT_SOLID);
      assert.equal(second.pointContents(new Vector(1, 0, 0)), content.CONTENT_EMPTY);
    });

    void test('a hull can start at a node of its own, the way an inline model does', () => {
      const planes = new PlaneTable(2);
      planes.set(0, 1, 0, 0, 0, 0, 0);
      planes.set(1, 0, 1, 0, 0, 1, 0);
      const tree = new ClipTree(2);
      tree.set(0, 0, content.CONTENT_EMPTY, content.CONTENT_SOLID);
      tree.set(1, 1, content.CONTENT_WATER, content.CONTENT_EMPTY);

      const world = new Hull(planes, tree);
      const door = new Hull(planes, tree, new Vector(), new Vector(), 1);

      assert.equal(world.pointContents(new Vector(1, 0, 0)), content.CONTENT_EMPTY);
      assert.equal(door.pointContents(new Vector(1, 0, 0)), content.CONTENT_WATER);
    });
  });

  void describe('BoxHull', () => {
    void test('stands in for a box: solid inside, open outside', () => {
      const box = new BoxHull().setSize(new Vector(-10, -20, -30), new Vector(10, 20, 30));

      assert.equal(box.pointContents(new Vector(0, 0, 0)), content.CONTENT_SOLID);
      assert.equal(box.pointContents(new Vector(9.9, 19.9, 29.9)), content.CONTENT_SOLID);
      assert.equal(box.pointContents(new Vector(10.1, 0, 0)), content.CONTENT_EMPTY);
      assert.equal(box.pointContents(new Vector(0, -20.1, 0)), content.CONTENT_EMPTY);
      assert.equal(box.pointContents(new Vector(0, 0, 30.1)), content.CONTENT_EMPTY);
    });

    void test('stops a line at the face it meets first', () => {
      const box = new BoxHull().setBounds(-16, -16, -16, 16, 16, 16);
      const trace = new Trace();
      trace.endpos.set(new Vector(0, 0, 100));
      box.trace(trace, new Vector(0, 0, 100), new Vector(0, 0, 0), true);

      assert.deepEqual([...trace.plane.normal], [0, 0, 1]);
      assert.equal(trace.plane.dist, 16);
      assert.ok(trace.fraction > 0.8 && trace.fraction < 0.85);
    });

    void test('setSize and setBounds say the same', () => {
      const first = new BoxHull().setSize(new Vector(-1, -2, -3), new Vector(4, 5, 6));
      const second = new BoxHull().setBounds(-1, -2, -3, 4, 5, 6);

      assert.deepEqual([...first.planes.dists], [...second.planes.dists]);
      assert.deepEqual([...first.planes.dists], [4, -1, 5, -2, 6, -3]);
    });

    void test('all boxes share the nodes and none shares the planes', () => {
      const first = new BoxHull();
      const second = new BoxHull();

      assert.equal(first.tree, second.tree);
      assert.notEqual(first.planes, second.planes);
      assert.notEqual(first.planes.dists, second.planes.dists);
    });
  });
});
