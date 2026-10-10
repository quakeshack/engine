import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import R from '../../source/engine/client/R.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';

// A square 90 degree view from the origin looking along +X, 400x400 pixels: the frustum planes sit at 45 degrees.
const FOV = 90.0;
const VIEW_SIZE = 400;

void describe('view frustum', () => {
  const previous = {
    vpn: R.vpn,
    vup: R.vup,
    vright: R.vright,
    vieworg: R.refdef.vieworg.copy(),
    fovX: R.refdef.fov_x,
    fovY: R.refdef.fov_y,
    vrect: { ...R.refdef.vrect },
    viewMatrix: R.viewMatrix,
    projectionMatrix: R.projectionMatrix,
    perspective: [...R.perspective],
  };

  beforeEach(() => {
    const { forward, right, up } = new Vector(0.0, 0.0, 0.0).angleVectors();

    R.vpn = forward;
    R.vright = right;
    R.vup = up;
    R.refdef.vieworg.setTo(0.0, 0.0, 0.0);
    R.refdef.fov_x = FOV;
    R.refdef.fov_y = FOV;
    R.refdef.vrect.x = 0;
    R.refdef.vrect.y = 0;
    R.refdef.vrect.width = VIEW_SIZE;
    R.refdef.vrect.height = VIEW_SIZE;
    R.SetFrustum();
  });

  afterEach(() => {
    R.vpn = previous.vpn;
    R.vup = previous.vup;
    R.vright = previous.vright;
    R.refdef.vieworg.set(previous.vieworg);
    R.refdef.fov_x = previous.fovX;
    R.refdef.fov_y = previous.fovY;
    Object.assign(R.refdef.vrect, previous.vrect);
    R.viewMatrix = previous.viewMatrix;
    R.projectionMatrix = previous.projectionMatrix;
    R.perspective.splice(0, R.perspective.length, ...previous.perspective);
  });

  void describe('R.SetFrustum', () => {
    void test('builds four planes through the view origin', () => {
      R.refdef.vieworg.setTo(10.0, 20.0, 30.0);
      R.SetFrustum();

      for (const plane of R.frustum) {
        assertNear(plane.dist, R.refdef.vieworg.dot(plane.normal), 1e-9);
      }
    });

    void test('leaves the planes alone while the view vectors are not set', () => {
      const before = R.frustum.map((plane) => plane.dist);

      R.vpn = new Vector(0.0, 0.0, 0.0);
      R.refdef.vieworg.setTo(500.0, 500.0, 500.0);
      R.SetFrustum();

      assert.deepEqual(R.frustum.map((plane) => plane.dist), before);
    });
  });

  void describe('R.CullBox', () => {
    /**
     * Creates the bounds of a cube around a point.
     * @param center Cube center.
     * @param halfSize Half the edge length.
     * @returns The minimum and maximum corner.
     */
    function cube(center: Vector, halfSize: number): [Vector, Vector] {
      return [
        new Vector(center[0] - halfSize, center[1] - halfSize, center[2] - halfSize),
        new Vector(center[0] + halfSize, center[1] + halfSize, center[2] + halfSize),
      ];
    }

    void test('keeps a box straight ahead', () => {
      assert.equal(R.CullBox(...cube(new Vector(100.0, 0.0, 0.0), 10.0)), false);
    });

    void test('culls a box behind the viewer', () => {
      assert.equal(R.CullBox(...cube(new Vector(-100.0, 0.0, 0.0), 10.0)), true);
    });

    void test('culls a box far to the side', () => {
      assert.equal(R.CullBox(...cube(new Vector(100.0, 500.0, 0.0), 10.0)), true);
      assert.equal(R.CullBox(...cube(new Vector(100.0, -500.0, 0.0), 10.0)), true);
    });

    void test('culls a box far above or below', () => {
      assert.equal(R.CullBox(...cube(new Vector(100.0, 0.0, 500.0), 10.0)), true);
      assert.equal(R.CullBox(...cube(new Vector(100.0, 0.0, -500.0), 10.0)), true);
    });

    void test('keeps a box that straddles a frustum plane', () => {
      // at x = 100 the 45 degree plane passes through y = 100
      assert.equal(R.CullBox(...cube(new Vector(100.0, 100.0, 0.0), 20.0)), false);
    });
  });

  void describe('R.WorldToScreen', () => {
    beforeEach(() => {
      // What R.Perspective() derives for viewangles (0, 0, 0) and a 90 degree square view, spelled out
      // so the test does not need a GL context: the view rotation maps Quake's x/y/z (forward/left/up) to
      // GL's right/up/back, and the projection scale is 4 / (ymax * aspect) = 1 for fov 90 and aspect 1.
      R.viewMatrix = [
        0.0, 1.0, 0.0, 0.0,
        -1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
      ];
      R.perspective[0] = 1.0;
      R.perspective[5] = 1.0;
      R.projectionMatrix = R.perspective;
    });

    void test('maps the point straight ahead to the center of the view rectangle', () => {
      const screen = R.WorldToScreen(new Vector(100.0, 0.0, 0.0))!;

      assert.notEqual(screen, null);
      assertNear(screen[0], VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 2, 1e-6);
      assert.ok(screen[2] > 0.0 && screen[2] < 1.0, 'depth is in the 0..1 range');
    });

    void test('maps a point to the left of the view axis left of the center', () => {
      // +Y is to the left in Quake; at 45 degrees it lands a quarter of the width from the left edge
      const screen = R.WorldToScreen(new Vector(100.0, 50.0, 0.0))!;

      assertNear(screen[0], VIEW_SIZE / 4, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 2, 1e-6);
    });

    void test('maps a point above the view axis above the center', () => {
      const screen = R.WorldToScreen(new Vector(100.0, 0.0, 50.0))!;

      assertNear(screen[0], VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 4, 1e-6);
    });

    void test('offsets the result by the view rectangle position', () => {
      R.refdef.vrect.x = 40;
      R.refdef.vrect.y = 60;

      const screen = R.WorldToScreen(new Vector(100.0, 0.0, 0.0))!;

      assertNear(screen[0], 40 + VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], 60 + VIEW_SIZE / 2, 1e-6);
    });

    void test('returns null for a point behind the viewer', () => {
      assert.equal(R.WorldToScreen(new Vector(-100.0, 0.0, 0.0)), null);
    });

    void test('returns null for a point outside the view', () => {
      assert.equal(R.WorldToScreen(new Vector(100.0, 300.0, 0.0)), null);
    });

    void test('returns null before a frame has set up the matrices', () => {
      R.viewMatrix = null;

      assert.equal(R.WorldToScreen(new Vector(100.0, 0.0, 0.0)), null);
    });
  });
});
