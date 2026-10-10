import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';

// A square 90 degree view from the origin looking along +X, 400x400 pixels: the frustum planes sit at 45 degrees.
const FOV = 90.0;
const VIEW_SIZE = 400;

void describe('Camera', () => {
  const previous = {
    vpn: Camera.vpn,
    vup: Camera.vup,
    vright: Camera.vright,
    vieworg: Camera.refdef.vieworg.copy(),
    fovX: Camera.refdef.fov_x,
    fovY: Camera.refdef.fov_y,
    vrect: { ...Camera.refdef.vrect },
    viewMatrix: Camera.viewMatrix,
    rotation: Camera.rotation,
    projectionMatrix: Camera.projectionMatrix,
    perspective: [...Camera.perspective],
  };

  beforeEach(() => {
    const { forward, right, up } = new Vector(0.0, 0.0, 0.0).angleVectors();

    Camera.vpn = forward;
    Camera.vright = right;
    Camera.vup = up;
    Camera.refdef.vieworg.setTo(0.0, 0.0, 0.0);
    Camera.refdef.fov_x = FOV;
    Camera.refdef.fov_y = FOV;
    Camera.refdef.vrect.x = 0;
    Camera.refdef.vrect.y = 0;
    Camera.refdef.vrect.width = VIEW_SIZE;
    Camera.refdef.vrect.height = VIEW_SIZE;
    Camera.SetFrustum();
  });

  afterEach(() => {
    Camera.vpn = previous.vpn;
    Camera.vup = previous.vup;
    Camera.vright = previous.vright;
    Camera.refdef.vieworg.set(previous.vieworg);
    Camera.refdef.fov_x = previous.fovX;
    Camera.refdef.fov_y = previous.fovY;
    Object.assign(Camera.refdef.vrect, previous.vrect);
    Camera.viewMatrix = previous.viewMatrix;
    Camera.rotation = previous.rotation;
    Camera.projectionMatrix = previous.projectionMatrix;
    Camera.perspective.splice(0, Camera.perspective.length, ...previous.perspective);
  });

  void describe('Camera.UpdateViewVectors', () => {
    void test('derives forward, right and up from the view angles', () => {
      Camera.refdef.viewangles.setTo(0.0, 90.0, 0.0);
      Camera.UpdateViewVectors();

      // yaw 90 turns the view from +X to +Y, right of that is +X
      assertNear(Camera.vpn[0], 0.0, 1e-9);
      assertNear(Camera.vpn[1], 1.0, 1e-9);
      assertNear(Camera.vright[0], 1.0, 1e-9);
      assertNear(Camera.vright[1], 0.0, 1e-9);
      assertNear(Camera.vup[2], 1.0, 1e-9);
    });

    void test('replaces the vectors instead of changing them in place', () => {
      const before = Camera.vpn;

      Camera.refdef.viewangles.setTo(0.0, 45.0, 0.0);
      Camera.UpdateViewVectors();

      assert.notEqual(Camera.vpn, before);
    });
  });

  void describe('Camera.UpdateMatrices', () => {
    void test('builds the rotation that maps Quake axes to GL axes for a view along +X', () => {
      Camera.refdef.viewangles.setTo(0.0, 0.0, 0.0);
      Camera.UpdateMatrices();

      const expected = [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

      for (let i = 0; i < expected.length; i++) {
        assertNear(Camera.rotation[i], expected[i], 1e-9);
      }
    });

    void test('pads the rotation into the 4x4 view matrix without a translation', () => {
      Camera.refdef.viewangles.setTo(10.0, 70.0, 5.0);
      Camera.UpdateMatrices();

      const viewMatrix = Camera.viewMatrix!;
      const rotation = Camera.rotation;

      assert.equal(viewMatrix.length, 16);
      assert.deepEqual(viewMatrix.slice(0, 3), rotation.slice(0, 3));
      assert.deepEqual(viewMatrix.slice(4, 7), rotation.slice(3, 6));
      assert.deepEqual(viewMatrix.slice(8, 11), rotation.slice(6, 9));
      assert.deepEqual([viewMatrix[3], viewMatrix[7], viewMatrix[11], viewMatrix[15]], [0.0, 0.0, 0.0, 1.0]);
      assert.deepEqual(viewMatrix.slice(12, 15), [0.0, 0.0, 0.0]);
    });

    void test('takes the perspective matrix into use as the projection', () => {
      Camera.UpdateMatrices();

      assert.equal(Camera.projectionMatrix, Camera.perspective);
    });

    void test('lets WorldToScreen see a point the frustum keeps and the screen shows', () => {
      // the same view as the SetFrustum tests, set up the way a frame does it
      Camera.refdef.viewangles.setTo(0.0, 0.0, 0.0);
      Camera.perspective[0] = 1.0;
      Camera.perspective[5] = 1.0;
      Camera.UpdateViewVectors();
      Camera.SetFrustum();
      Camera.UpdateMatrices();

      const center = new Vector(200.0, 0.0, 0.0);
      const screen = Camera.WorldToScreen(center)!;

      assert.notEqual(screen, null);
      assertNear(screen[0], VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 2, 1e-6);
      assert.equal(Camera.CullBox(center, center), false);
    });
  });

  void describe('Camera.SetFrustum', () => {
    void test('builds four planes through the view origin', () => {
      Camera.refdef.vieworg.setTo(10.0, 20.0, 30.0);
      Camera.SetFrustum();

      for (const plane of Camera.frustum) {
        assertNear(plane.dist, Camera.refdef.vieworg.dot(plane.normal), 1e-9);
      }
    });

    void test('leaves the planes alone while the view vectors are not set', () => {
      const before = Camera.frustum.map((plane) => plane.dist);

      Camera.vpn = new Vector(0.0, 0.0, 0.0);
      Camera.refdef.vieworg.setTo(500.0, 500.0, 500.0);
      Camera.SetFrustum();

      assert.deepEqual(Camera.frustum.map((plane) => plane.dist), before);
    });
  });

  void describe('Camera.CullBox', () => {
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
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, 0.0, 0.0), 10.0)), false);
    });

    void test('culls a box behind the viewer', () => {
      assert.equal(Camera.CullBox(...cube(new Vector(-100.0, 0.0, 0.0), 10.0)), true);
    });

    void test('culls a box far to the side', () => {
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, 500.0, 0.0), 10.0)), true);
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, -500.0, 0.0), 10.0)), true);
    });

    void test('culls a box far above or below', () => {
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, 0.0, 500.0), 10.0)), true);
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, 0.0, -500.0), 10.0)), true);
    });

    void test('keeps a box that straddles a frustum plane', () => {
      // at x = 100 the 45 degree plane passes through y = 100
      assert.equal(Camera.CullBox(...cube(new Vector(100.0, 100.0, 0.0), 20.0)), false);
    });
  });

  void describe('Camera.WorldToScreen', () => {
    beforeEach(() => {
      // What Camera.Perspective() derives for viewangles (0, 0, 0) and a 90 degree square view, spelled out
      // so the test does not need a GL context: the view rotation maps Quake's x/y/z (forward/left/up) to
      // GL's right/up/back, and the projection scale is 4 / (ymax * aspect) = 1 for fov 90 and aspect 1.
      Camera.viewMatrix = [
        0.0, 1.0, 0.0, 0.0,
        -1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
      ];
      Camera.perspective[0] = 1.0;
      Camera.perspective[5] = 1.0;
      Camera.projectionMatrix = Camera.perspective;
    });

    void test('maps the point straight ahead to the center of the view rectangle', () => {
      const screen = Camera.WorldToScreen(new Vector(100.0, 0.0, 0.0))!;

      assert.notEqual(screen, null);
      assertNear(screen[0], VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 2, 1e-6);
      assert.ok(screen[2] > 0.0 && screen[2] < 1.0, 'depth is in the 0..1 range');
    });

    void test('maps a point to the left of the view axis left of the center', () => {
      // +Y is to the left in Quake; at 45 degrees it lands a quarter of the width from the left edge
      const screen = Camera.WorldToScreen(new Vector(100.0, 50.0, 0.0))!;

      assertNear(screen[0], VIEW_SIZE / 4, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 2, 1e-6);
    });

    void test('maps a point above the view axis above the center', () => {
      const screen = Camera.WorldToScreen(new Vector(100.0, 0.0, 50.0))!;

      assertNear(screen[0], VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], VIEW_SIZE / 4, 1e-6);
    });

    void test('offsets the result by the view rectangle position', () => {
      Camera.refdef.vrect.x = 40;
      Camera.refdef.vrect.y = 60;

      const screen = Camera.WorldToScreen(new Vector(100.0, 0.0, 0.0))!;

      assertNear(screen[0], 40 + VIEW_SIZE / 2, 1e-6);
      assertNear(screen[1], 60 + VIEW_SIZE / 2, 1e-6);
    });

    void test('returns null for a point behind the viewer', () => {
      assert.equal(Camera.WorldToScreen(new Vector(-100.0, 0.0, 0.0)), null);
    });

    void test('returns null for a point outside the view', () => {
      assert.equal(Camera.WorldToScreen(new Vector(100.0, 300.0, 0.0)), null);
    });

    void test('returns null before a frame has set up the matrices', () => {
      Camera.viewMatrix = null;

      assert.equal(Camera.WorldToScreen(new Vector(100.0, 0.0, 0.0)), null);
    });
  });
});
