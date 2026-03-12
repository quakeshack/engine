import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { BrushTrace, Pmove } from '../../source/engine/common/Pmove.mjs';

import {
  assertNear,
  createBoxBrushModel,
  createBrushWorldModel,
} from './fixtures.mjs';

/**
 * Build a minimal two-brush submodel fixture with a gap between brushes.
 * @returns {import('../../source/engine/common/model/BSP.mjs').BrushModel} brush model fixture
 */
function createTwoBoxBrushModel() {
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

describe('BrushTrace', () => {
  describe('transformedTestPosition', () => {
    test('keeps exact face contact walkable', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
      const origin = new Vector(100, 0, 0);
      const tangentPosition = new Vector(100, 0, 40);
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

  describe('transformedBoxTrace', () => {
    test('returns world-space impact points', () => {
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

    test('keeps exact floor contact out of startsolid', () => {
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

    test('clips against the nearest brush in a multi-brush submodel', () => {
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

    test('does not falsely clip edge-on brush sweeps', () => {
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

    test('treats zero-extent submodel traces as point traces', () => {
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

  describe('contact edge cases', () => {
    test('keeps edge-on point contacts walkable', () => {
      const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });

      assert.equal(
        BrushTrace.transformedTestPosition(model, new Vector(16, 16, 0), new Vector(), new Vector(), Vector.origin, Vector.origin),
        true,
      );
    });

    test('checks every brush in a multi-brush submodel for position tests', () => {
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

  describe('rotation', () => {
    test('transformed tests honor rotated entity angles', () => {
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

  describe('world brush lists', () => {
    test('boxTrace traverses BSP nodes', () => {
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

    test('testPosition traverses BSP nodes', () => {
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

    test('treats zero-extent world traces as point traces', () => {
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
  });
});
