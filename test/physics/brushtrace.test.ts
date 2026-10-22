import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { BrushTrace, DIST_EPSILON, Pmove } from '../../source/engine/common/Pmove.ts';
import { BrushSide, type BrushModel } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';

import {
  createAxisPlane,
  createBoxBrushModel,
  createBrushWorldModel,
} from '../support/fixtures.ts';
import { assertNear } from '../support/assertions.ts';
import { setBspTree } from '../support/bspTree.ts';

/**
 * Build a minimal two-brush submodel fixture with a gap between brushes.
 * @returns brush model fixture
 */
function createTwoBoxBrushModel(): BrushModel {
  const model = createBoxBrushModel({ center: [-32, 0, 0], halfExtents: [16, 16, 16] });
  const secondModel = createBoxBrushModel({ center: [32, 0, 0], halfExtents: [16, 16, 16] });
  const planeOffset = model.planes.length;
  const sideOffset = model.brushsides.length;

  model.planes.push(...secondModel.planes);

  for (const side of secondModel.brushsides) {
    side.planenum += planeOffset;
  }

  model.brushsides.push(...secondModel.brushsides);

  const secondBrush = secondModel.brushes[0];
  secondBrush.firstside += sideOffset;
  secondBrush._brushTraceCheck = 0;
  model.brushes.push(secondBrush);
  model.numBrushes = model.brushes.length;

  return model;
}

/**
 * Build a wedge brush whose inferred axial bounds bevel competes with a
 * walkable ramp face at almost the same enter fraction.
 * @returns brush model fixture
 */
function createRampBevelBrushModel(): BrushModel {
  const model = createBoxBrushModel({ center: [0, 0, 0], halfExtents: [32, 16, 32] });
  const normal = new Vector(-1, 0, 1);
  normal.normalize();
  const rampPlane = createAxisPlane([...normal], -22.627416610717773, 3);
  rampPlane.signbits = 1;

  model.planes.push(rampPlane);

  const side = new BrushSide(model);
  side.planenum = model.planes.length - 1;
  side.texinfo = 0;
  model.brushsides.push(side);
  model.brushes[0].numsides += 1;

  return model;
}

/**
 * Build a world model with one nearby brush and one distant child leaf whose
 * bounds do not intersect the current sweep.
 * @returns world model fixture
 */
function createPrunedLeafWorldModel(): BrushModel {
  const model = createBoxBrushModel({ center: [64, -16, 0], halfExtents: [16, 16, 16], name: 'test-pruned-world', submodel: false });
  const secondModel = createBoxBrushModel({ center: [224, 16, 0], halfExtents: [16, 16, 16], submodel: false });
  const planeOffset = model.planes.length;
  const sideOffset = model.brushsides.length;

  model.planes.push(...secondModel.planes);

  for (const side of secondModel.brushsides) {
    side.planenum += planeOffset;
  }

  model.brushsides.push(...secondModel.brushsides);

  const distantBrush = secondModel.brushes[0];
  distantBrush.firstside += sideOffset;
  distantBrush._brushTraceCheck = 0;
  model.brushes.push(distantBrush);
  model.numBrushes = model.brushes.length;

  model.planes.push(createAxisPlane([0, 1, 0], 0, 1));
  setBspTree(
    model,
    [{ planeNum: model.planes.length - 1, children: [~0, ~1], bounds: [32, -32, -32, 256, 32, 32] }],
    [
      { contents: content.CONTENT_EMPTY, firstLeafBrush: 0, numLeafBrushes: 1, bounds: [192, 0, -32, 256, 32, 32] },
      { contents: content.CONTENT_EMPTY, firstLeafBrush: 1, numLeafBrushes: 1, bounds: [32, -32, -32, 96, 0, 32] },
    ],
  );
  model.leafbrushes = [1, 0];

  return model;
}

void describe('BrushTrace', () => {
  void describe('transformedTestPosition', () => {
    void test('keeps exact face contact walkable', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const origin = new Vector(100, 0, 0);
      const tangentPosition = new Vector(100, 0, 40);
      const snappedContactPosition = new Vector(100, 0, 40 - DIST_EPSILON * 0.25);
      const penetratingPosition = new Vector(100, 0, 39.9);

      assert.equal(
        BrushTrace.transformedTestPosition(
          model,
          tangentPosition,
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
          origin,
          Vector.origin,
        ),
        true,
      );

      assert.equal(
        BrushTrace.transformedTestPosition(
          model,
          snappedContactPosition,
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
          origin,
          Vector.origin,
        ),
        true,
      );

      assert.equal(
        BrushTrace.transformedTestPosition(
          model,
          penetratingPosition,
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
          origin,
          Vector.origin,
        ),
        false,
      );
    });
  });

  void describe('transformedBoxTrace', () => {
    void test('returns world-space impact points', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const trace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(0, 0, 0),
        new Vector(100, 0, 0),
        new Vector(),
        new Vector(),
        new Vector(64, 0, 0),
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.ok(trace.fraction < 1.0);
      assertNear(trace.endpos[0], 47.96875, 0.001);
      assertNear(trace.endpos[1], 0);
      assertNear(trace.endpos[2], 0);
    });

    void test('keeps exact floor contact out of startsolid', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const origin = new Vector(100, 0, 0);
      const start = new Vector(100, 0, 40);
      const end = new Vector(100, 0, 39);

      const trace = BrushTrace.transformedBoxTrace(
        model,
        start,
        end,
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
        origin,
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assert.equal(trace.fraction, 0.0);
      assertNear(trace.plane.normal[0], 0.0);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], 1.0);
      assert.deepEqual([...trace.endpos], [...start]);
    });

    void test('clips against the nearest brush in a multi-brush submodel', () => {
      const model = createTwoBoxBrushModel();
      const trace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(-100, 0, 0),
        new Vector(100, 0, 0),
        new Vector(),
        new Vector(),
        Vector.origin,
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assertNear(trace.fraction, 0.25984375, 1e-9);
      assertNear(trace.endpos[0], -48.03125, 0.001);
      assertNear(trace.endpos[1], 0.0);
      assertNear(trace.endpos[2], 0.0);
      assertNear(trace.plane.normal[0], -1.0);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], 0.0);
    });

    void test('skips submodel brushes whose cached bounds miss the swept move', (t) => {
      const model = createTwoBoxBrushModel();
      const clipBoxToBrush = t.mock.method(BrushTrace, '_clipBoxToBrush');

      BrushTrace.transformedBoxTrace(
        model,
        new Vector(-100, 0, 0),
        new Vector(-40, 0, 0),
        new Vector(),
        new Vector(),
        Vector.origin,
        Vector.origin,
      );

      assert.deepEqual(clipBoxToBrush.mock.calls.map((call) => call.arguments[1].firstside), [0]);
    });

    void test('does not falsely clip edge-on brush sweeps', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const end = new Vector(16, 16, -40);
      const trace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(16, 16, 40),
        end,
        new Vector(),
        new Vector(),
        Vector.origin,
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assert.equal(trace.fraction, 1.0);
      assert.deepEqual([...trace.endpos], [...end]);
      assert.deepEqual([...trace.plane.normal], [0, 0, 0]);
    });

    void test('prefers a walkable ramp face over a nearly simultaneous axial bevel', () => {
      const model = createRampBevelBrushModel();
      const trace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(-48.375, 16, -40),
        new Vector(-34.875, 16, -40),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
        Vector.origin,
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assert.ok(trace.fraction > 0.0);
      assertNear(trace.plane.normal[0], -Math.SQRT1_2, 0.001);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], Math.SQRT1_2, 0.001);
    });

    void test('treats zero-extent submodel traces as point traces', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const trace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(0, 0, 40),
        new Vector(0, 0, -40),
        new Vector(),
        new Vector(),
        Vector.origin,
        Vector.origin,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assertNear(trace.fraction, 0.299609375, 1e-9);
      assertNear(trace.endpos[0], 0.0);
      assertNear(trace.endpos[1], 0.0);
      assertNear(trace.endpos[2], 16.03125, 0.001);
      assertNear(trace.plane.normal[0], 0.0);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], 1.0);
    });
  });

  void describe('contact edge cases', () => {
    void test('keeps edge-on point contacts walkable', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });

      assert.equal(
        BrushTrace.transformedTestPosition(model, new Vector(16, 16, 0), new Vector(), new Vector(), Vector.origin, Vector.origin),
        true,
      );
    });

    void test('checks every brush in a multi-brush submodel for position tests', () => {
      const model = createTwoBoxBrushModel();

      assert.equal(
        BrushTrace.transformedTestPosition(model, new Vector(0, 0, 0), new Vector(), new Vector(), Vector.origin, Vector.origin),
        true,
      );
      assert.equal(
        BrushTrace.transformedTestPosition(model, new Vector(-32, 0, 0), new Vector(), new Vector(), Vector.origin, Vector.origin),
        false,
      );
      assert.equal(
        BrushTrace.transformedTestPosition(model, new Vector(32, 0, 0), new Vector(), new Vector(), Vector.origin, Vector.origin),
        false,
      );
    });
  });

  void describe('rotation', () => {
    void test('transformed tests honor rotated entity angles', () => {
      const model = createBoxBrushModel({ halfExtents: [8, 32, 16] });
      const point = new Vector(20, 0, 0);

      assert.equal(
        BrushTrace.transformedTestPosition(model, point, new Vector(), new Vector(), Vector.origin, Vector.origin),
        true,
      );
      assert.equal(
        BrushTrace.transformedTestPosition(model, point, new Vector(), new Vector(), Vector.origin, new Vector(0, 90, 0)),
        false,
      );

      const unrotatedTrace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(-40, 0, 0),
        new Vector(40, 0, 0),
        new Vector(),
        new Vector(),
        Vector.origin,
        Vector.origin,
      );
      const rotatedTrace = BrushTrace.transformedBoxTrace(
        model,
        new Vector(-40, 0, 0),
        new Vector(40, 0, 0),
        new Vector(),
        new Vector(),
        Vector.origin,
        new Vector(0, 90, 0),
      );

      assert.ok(rotatedTrace.fraction < unrotatedTrace.fraction);
      assert.ok(rotatedTrace.endpos[0] < unrotatedTrace.endpos[0] - 20);
    });
  });

  void describe('world brush lists', () => {
    void test('boxTrace traverses BSP nodes', () => {
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(0, 0, 0),
        new Vector(100, 0, 0),
        new Vector(),
        new Vector(),
      );

      assert.equal(trace.startsolid, false);
      assert.ok(trace.fraction < 1.0);
      assertNear(trace.endpos[0], 47.96875, 0.001);
      assertNear(trace.endpos[1], 0);
      assertNear(trace.endpos[2], 0);
    });

    void test('a box that only touches the side of a brush falls past its top instead of landing on it', () => {
      // brush: x 32..96, y -16..16, z -16..16. A player box centered at y = 32 touches the face at y = 16 exactly.
      // Moving straight down along that face, the box cannot reach the brush, so it must not stop on the brush's top
      // (the player would be lifted on top of a ledge they only brush against, e.g. a step-high lower brush of a wall).
      const worldModel = createBrushWorldModel({ halfExtents: [32, 16, 16] });
      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(64, 32, 60),
        new Vector(64, 32, 0),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.fraction, 1.0);
      assert.deepEqual([...trace.endpos], [64, 32, 0]);
    });

    void test('a box that overlaps the side of a brush by a little still lands on its top', () => {
      const worldModel = createBrushWorldModel({ halfExtents: [32, 16, 16] });
      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(64, 31, 60),
        new Vector(64, 31, 0),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
      );

      assert.ok(trace.fraction < 1.0);
      // the box rests on the top at z = 16, so its origin is 24 above
      assertNear(trace.endpos[2], 40, 0.05);
      assertNear(trace.plane.normal[2], 1);
    });

    void test('testPosition traverses BSP nodes', () => {
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });

      assert.equal(
        BrushTrace.testPosition(
          worldModel,
          0,
          new Vector(64, 0, 40),
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
        ),
        true,
      );

      assert.equal(
        BrushTrace.testPosition(
          worldModel,
          0,
          new Vector(64, 0, 39.9),
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
        ),
        false,
      );
    });

    void test('treats zero-extent world traces as point traces', () => {
      const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, 0], halfExtents: [16, 16, 16] });
      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(0, 0, 40),
        new Vector(0, 0, -40),
        new Vector(),
        new Vector(),
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assertNear(trace.fraction, 0.299609375, 1e-9);
      assertNear(trace.endpos[0], 0.0);
      assertNear(trace.endpos[1], 0.0);
      assertNear(trace.endpos[2], 16.03125, 0.001);
      assertNear(trace.plane.normal[0], 0.0);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], 1.0);

      assert.equal(
        BrushTrace.testPosition(worldModel, 0, new Vector(0, 0, 16), new Vector(), new Vector()),
        true,
      );
      assert.equal(
        BrushTrace.testPosition(worldModel, 0, new Vector(0, 0, 15.9), new Vector(), new Vector()),
        false,
      );
    });

    void test('does not inherit allsolid from solid BSP leaves on tangent brush clips', () => {
      const worldModel = createBoxBrushModel({ center: [0, 0, 0], halfExtents: [16, 16, 16], submodel: false });
      // a tree needs a node at its root, both sides of this one lead into the same solid leaf
      setBspTree(worldModel, [{ planeNum: 0, children: [~0, ~0] }], [{ contents: content.CONTENT_SOLID, firstLeafBrush: 0, numLeafBrushes: 1 }]);
      worldModel.leafbrushes = [0];
      // Only the first clip node of the hull is read by a brush world trace.
      worldModel.hulls = [{ firstClipNode: 0 }] as unknown as typeof worldModel.hulls;

      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(0, 0, 40),
        new Vector(0, 0, 39),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.allsolid, false);
      assert.equal(trace.fraction, 0.0);
      assertNear(trace.plane.normal[0], 0.0);
      assertNear(trace.plane.normal[1], 0.0);
      assertNear(trace.plane.normal[2], 1.0);
      assert.deepEqual([...trace.endpos], [0, 0, 40]);
    });

    void test('prunes BSP child bounds that miss a straddled world sweep', (t) => {
      const worldModel = createPrunedLeafWorldModel();
      const traceToLeaf = t.mock.method(BrushTrace, '_traceToLeaf');

      const trace = BrushTrace.boxTrace(
        worldModel,
        0,
        new Vector(0, 0, 0),
        new Vector(128, 0, 0),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
      );

      assert.equal(trace.startsolid, false);
      assert.ok(trace.fraction < 1.0);
      assertNear(trace.endpos[0], 31.96875, 0.001);
      assertNear(trace.endpos[1], 0.0, 0.001);

      const visitedLeafs = traceToLeaf.mock.calls.map((call) => call.arguments[1]);

      assert.equal(visitedLeafs.length, 1);
      assert.equal(worldModel.leafTable.firstLeafBrushes[visitedLeafs[0]], 1);
    });
  });
});
