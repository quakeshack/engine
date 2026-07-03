import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import R, { compareTransparentItems } from '../../source/engine/client/R.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Vector from '../../source/shared/Vector.ts';
import { Face, Plane } from '../../source/engine/common/model/BaseModel.ts';
import { BrushModel, Node } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import V from '../../source/engine/client/V.ts';
import { assertNear } from '../physics/fixtures.mjs';

void describe('compareTransparentItems', () => {
  void test('sorts farther items first', () => {
    const result = compareTransparentItems(
      { dist: 64, kind: 0 },
      { dist: 128, kind: 1 },
    );

    assert(result > 0);
  });

  void test('sorts fog before turbulent when their front depth ties', () => {
    const fog = { dist: 96, kind: 1 };
    const turbulent = { dist: 96, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('treats near-equal distances as a tie for boundary-sharing fog and water', () => {
    const fog = { dist: 96.00005, kind: 1 };
    const turbulent = { dist: 96.0, kind: 0 };
    const items = [turbulent, fog];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [fog, turbulent]);
  });

  void test('uses deterministic tie ordering for sprite, decal, and particle kinds', () => {
    const sprite = { dist: 64.0, kind: 4 };
    const decal = { dist: 64.0, kind: 5 };
    const particle = { dist: 64.0, kind: 6 };
    const items = [particle, decal, sprite];

    items.sort(compareTransparentItems);

    assert.deepEqual(items, [sprite, decal, particle]);
  });
});

void describe('R.GetEntityLightSamplePoint', () => {
  // CR: this is currently not working, see original
  // test('derives alias sample height from negative mins to match classic Quake monsters', () => {
  //   const previousCL = registry.CL;
  //   const previousMod = registry.Mod;

  //   registry.CL = { state: { viewent: null } };
  //   registry.Mod = { type: { alias: 2 } };
  //   eventBus.publish('registry.frozen');

  //   try {
  //     const entity = {
  //       lerp: { origin: new Vector(10, 20, 30) },
  //       model: { type: 2 },
  //       mins: new Vector(-16, -16, -24),
  //     };

  //     const samplePoint = R.GetEntityLightSamplePoint(entity);

  //     assert.deepEqual(Array.from(samplePoint), [10, 20, 54]);
  //     assert.deepEqual(Array.from(entity.lerp.origin), [10, 20, 30]);
  //   } finally {
  //     registry.CL = previousCL;
  //     registry.Mod = previousMod;
  //     eventBus.publish('registry.frozen');
  //   }
  // });

  void test('keeps brush and sprite entities on their true origin', () => {
    const previousCL = registry.CL;
    const previousMod = registry.Mod;

    registry.CL = /** @type {typeof import('../../source/engine/client/CL.ts').default} */ ({ state: { viewent: null } });
    registry.Mod = /** @type {typeof import('../../source/engine/common/Mod.ts').default} */ (/** @type {unknown} */ ({ type: { alias: 2, brush: 1 } }));
    eventBus.publish('registry.frozen');

    try {
      const entity = /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ ({
        lerp: { origin: new Vector(-4, 8, 12) },
        model: { type: 1 },
        mins: new Vector(),
      });

      const samplePoint = R.GetEntityLightSamplePoint(entity);

      assert.deepEqual(Array.from(samplePoint), [-4, 8, 12]);
    } finally {
      registry.CL = previousCL;
      registry.Mod = previousMod;
      eventBus.publish('registry.frozen');
    }
  });
});

void describe('R._SampleDeluxemapDirection', () => {
  /**
   * Builds a single-texel face pointing straight up, matching a flat floor.
   * @returns A face configured for a single, always-active lightstyle.
   */
  function makeSurf() {
    const surf = new Face();
    surf.lightofs = 0;
    surf.styles = [0];
    surf.normal = new Vector(0, 0, 1);
    return surf;
  }

  const tex = /** @type {import('../../source/engine/common/model/BSP.ts').BrushTexInfo} */ ({
    vecs: [[1, 0, 0, 0], [0, 1, 0, 0]],
    texture: 0,
    flags: 0,
  });

  /**
   * Temporarily installs a mock worldmodel on the client registry for the
   * duration of the callback, then restores the previous registry state.
   * @param worldmodel Mock worldmodel exposing just the fields under test.
   * @param callback Test body to run with the mock installed.
   */
  function withMockWorldmodel(worldmodel, callback) {
    const previousCL = registry.CL;

    registry.CL = /** @type {typeof import('../../source/engine/client/CL.ts').default} */ ({ state: { worldmodel } });
    eventBus.publish('registry.frozen');

    try {
      callback();
    } finally {
      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }
  }

  void test('decodes a tangent-space-encoded direction back into world space', () => {
    const previousA = R.lightstylevalue_a[0];
    const previousB = R.lightstylevalue_b[0];

    // Encodes world direction (1, 0, 0): dot with sAxis (1,0,0) -> 1, tAxis (0,-1,0) -> 0, surface normal (0,0,1) -> 0.
    // Encoding is `(component + 1) * 128`, matching ericw-tools' WriteSingleLightmap.
    R.lightstylevalue_a[0] = 12;
    R.lightstylevalue_b[0] = 12;

    withMockWorldmodel({ deluxemap: new Uint8Array([255, 128, 128]) }, () => {
      const direction = R._SampleDeluxemapDirection(makeSurf(), tex, 1, 1, 0, 0, 0);

      assert.notEqual(direction, null);
      assertNear(direction[0], 1.0, 0.01);
      assertNear(direction[1], 0.0, 0.01);
      assertNear(direction[2], 0.0, 0.01);
    });

    R.lightstylevalue_a[0] = previousA;
    R.lightstylevalue_b[0] = previousB;
  });

  void test('returns null when the map has no deluxemap data', () => {
    withMockWorldmodel({ deluxemap: null }, () => {
      const direction = R._SampleDeluxemapDirection(makeSurf(), tex, 1, 1, 0, 0, 0);

      assert.equal(direction, null);
    });
  });

  void test('returns null when no active lightstyle contributes any weight', () => {
    const previousA = R.lightstylevalue_a[0];
    const previousB = R.lightstylevalue_b[0];

    R.lightstylevalue_a[0] = 0;
    R.lightstylevalue_b[0] = 0;

    withMockWorldmodel({ deluxemap: new Uint8Array([255, 128, 128]) }, () => {
      const direction = R._SampleDeluxemapDirection(makeSurf(), tex, 1, 1, 0, 0, 0);

      assert.equal(direction, null);
    });

    R.lightstylevalue_a[0] = previousA;
    R.lightstylevalue_b[0] = previousB;
  });
});

void describe('R.RecursiveLightPoint', () => {
  /**
   * Builds a minimal one-face BSP tree: a horizontal splitting plane at z=0
   * (an empty leaf above, a solid leaf below), with a single lit face on the
   * root node representing a plain floor with no deluxemap data.
   * @returns The brush model and the root node of its BSP tree.
   */
  function makeFloorWorld() {
    const brushmodel = new BrushModel('test');

    const surf = new Face();
    surf.sky = false;
    surf.texinfo = 0;
    surf.lightofs = 0;
    surf.styles = [0];
    surf.texturemins = [0, 0];
    surf.extents = [16, 16];
    surf.lmshift = 4;
    surf.normal = new Vector(0, 0, 1);

    brushmodel.faces = [surf];
    brushmodel.texinfo = [/** @type {import('../../source/engine/common/model/BSP.ts').BrushTexInfo} */ ({
      vecs: [[1, 0, 0, 0], [0, 1, 0, 0]],
      texture: 0,
      flags: 0,
    })];
    brushmodel.lightdata_rgb = new Uint8Array([128, 128, 128]);
    brushmodel.deluxemap = null;

    const above = new Node(brushmodel);
    above.contents = content.CONTENT_EMPTY;

    const below = new Node(brushmodel);
    below.contents = content.CONTENT_SOLID;

    const root = new Node(brushmodel);
    root.contents = content.CONTENT_NONE;
    root.plane = new Plane(new Vector(0, 0, 1), 0);
    root.children = [above, below];
    root.firstface = 0;
    root.numfaces = 1;

    brushmodel.nodes = [root];

    return { brushmodel, root };
  }

  /**
   * Runs the callback with a mocked worldmodel/interpolation Cvar installed,
   * restoring the previous registry state afterwards.
   * @param callback Test body to run with the mocks installed.
   */
  function withFloorWorld(callback) {
    const previousCL = registry.CL;
    const previousInterpolation = R.interpolation;

    const { brushmodel, root } = makeFloorWorld();

    registry.CL = /** @type {typeof import('../../source/engine/client/CL.ts').default} */ ({ state: { worldmodel: brushmodel } });
    // GetLightstyleInterpolation() only needs a Cvar-shaped value, disabling
    // interpolation so it returns early without touching CL.state.time.
    R.interpolation = /** @type {import('../../source/engine/common/Cvar.ts').default} */ ({ value: 0 });
    eventBus.publish('registry.frozen');

    try {
      callback(root);
    } finally {
      registry.CL = previousCL;
      R.interpolation = previousInterpolation;
      eventBus.publish('registry.frozen');
    }
  }

  void test('projects the top-down fallback origin far above the surface instead of gluing it to the model', () => {
    withFloorWorld((root) => {
      const start = new Vector(0, 0, 40);
      const end = new Vector(0, 0, 40 - 2048);

      const result = R.RecursiveLightPoint(root, start, end);

      assert.notEqual(result, null);
      const [, lightOrigin] = /** @type {[Vector, Vector]} */ (result);

      // The trace hits the floor face ("mid") at z=0. A small fixed offset
      // here would put the proxy light origin only slightly above the model
      // itself instead of dominating its scale — see #lightOriginProxyDistance
      // in R.ts, which both fallback branches now share. The direction is
      // tilted 30° off vertical (see next test), so the projected height is
      // scaled by cos(30°) rather than landing at the full distance.
      assertNear(lightOrigin[2], 512.0 * Math.cos(30.0 * Math.PI / 180.0), 0.5);
    });
  });

  void test('tilts the fallback origin off vertical so it is not invariant to an entity yawing in place', () => {
    withFloorWorld((root) => {
      const start = new Vector(0, 0, 40);
      const end = new Vector(0, 0, 40 - 2048);

      const result = R.RecursiveLightPoint(root, start, end);

      assert.notEqual(result, null);
      const [, lightOrigin] = /** @type {[Vector, Vector]} */ (result);

      // A purely vertical (0, 0, 1) fallback direction is invariant to an
      // entity's own yaw (a rotation about world Z never changes a vector
      // that only has a Z component), so its diffuse/specular response would
      // never change while it turns in place. Asserting a nonzero horizontal
      // component here is what actually rules that "stuck" behavior out.
      assert(Math.abs(lightOrigin[0]) > 100.0, `expected a nonzero horizontal component, got ${lightOrigin[0]}`);
      assert(Math.abs(lightOrigin[1]) > 100.0, `expected a nonzero horizontal component, got ${lightOrigin[1]}`);
    });
  });
});

void describe('R._SmoothLightValues', () => {
  /**
   * Runs the callback with a mocked `Host.frametime`, restoring the previous
   * registry entry afterwards.
   * @param frametime Frame delta time to expose via `Host.frametime`.
   * @param callback Test body to run with the mock installed.
   */
  function withMockFrametime(frametime, callback) {
    const previousHost = registry.Host;
    const previousV = registry.V;

    registry.Host = /** @type {typeof import('../../source/engine/client/Host.ts').default} */ ({ frametime });
    registry.V = V;
    eventBus.publish('registry.frozen');

    try {
      callback();
    } finally {
      registry.Host = previousHost;
      registry.V = previousV;
      eventBus.publish('registry.frozen');
    }
  }

  void test('snaps to the sampled value on first use', () => {
    const e = new ClientEdict(1);
    const ambient = new Vector(0.5, 0.4, 0.3);
    const shade = new Vector(0.6, 0.5, 0.4);
    const lightOrigin = new Vector(10, 20, 30);
    const dynamicShade = new Vector(0.1, 0.1, 0.1);
    const dynamicOrigin = new Vector(40, 50, 60);

    withMockFrametime(0.1, () => {
      const [resultAmbient, resultShade, resultLightOrigin] = R._SmoothLightValues(e, ambient, shade, lightOrigin, dynamicShade, dynamicOrigin);

      assert.deepEqual(Array.from(resultAmbient), Array.from(ambient));
      assert.deepEqual(Array.from(resultShade), Array.from(shade));
      assert.deepEqual(Array.from(resultLightOrigin), Array.from(lightOrigin));
      assert.notEqual(e.smoothedAmbientLight, null);
    });
  });

  void test('eases towards a new target instead of snapping', () => {
    const e = new ClientEdict(1);

    withMockFrametime(0.1, () => {
      R._SmoothLightValues(e, new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      const [resultAmbient] = R._SmoothLightValues(e, new Vector(1, 1, 1), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      assert(resultAmbient[0] > 0.0, 'moved towards the new target');
      assert(resultAmbient[0] < 1.0, 'did not jump straight to the new target');
    });
  });

  void test('snaps immediately when the light origin jumps far enough to indicate a teleport', () => {
    const e = new ClientEdict(1);

    withMockFrametime(0.1, () => {
      R._SmoothLightValues(e, new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(0, 0, 0), new Vector(), new Vector());

      const farOrigin = new Vector(1000, 0, 0);
      const newAmbient = new Vector(1, 1, 1);
      const [resultAmbient, , resultLightOrigin] = R._SmoothLightValues(e, newAmbient, new Vector(0, 0, 0), farOrigin, new Vector(), new Vector());

      assert.deepEqual(Array.from(resultAmbient), Array.from(newAmbient));
      assert.deepEqual(Array.from(resultLightOrigin), Array.from(farOrigin));
    });
  });
});
