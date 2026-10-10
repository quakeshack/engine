import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import LightSampler from '../../source/engine/client/renderer/lighting/LightSampler.ts';
import LightStyles from '../../source/engine/client/renderer/lighting/LightStyles.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { Face, Plane } from '../../source/engine/common/model/BaseModel.ts';
import { BrushModel, Node, type BrushTexInfo, type LightgridOctree } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';

const LGNODE_LEAF = 1 << 31;
const LGNODE_MISSING = 1 << 30;

const floorTexinfo = { vecs: [[1, 0, 0, 0], [0, 1, 0, 0]], texture: 0, flags: 0 } as unknown as BrushTexInfo;

void describe('LightSampler', () => {
  const previousA = LightStyles.lightstylevalue_a.slice();
  const previousB = LightStyles.lightstylevalue_b.slice();
  let restores: Array<() => void> = [];

  beforeEach(() => {
    LightStyles.lightstylevalue_a.fill(12);
    LightStyles.lightstylevalue_b.fill(12);
    // interpolation off: the lightstyle blend then returns early without reading the client clock
    restores = [patchMembers(rendererCvars, { interpolation: { value: 0 } })];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    LightStyles.lightstylevalue_a.set(previousA);
    LightStyles.lightstylevalue_b.set(previousB);
  });

  /**
   * Makes the client look at a map.
   * @param worldmodel The map, or the fields of it under test.
   */
  function showWorld(worldmodel: object): void {
    restores.push(useClientStateOf({ state: { worldmodel } }));
  }

  void describe('SampleDeluxemapDirection', () => {
    /**
     * Builds a single-texel face pointing straight up, matching a flat floor.
     * @returns A face with a single, always-active lightstyle.
     */
    function makeSurf(): Face {
      const surf = new Face();

      surf.lightofs = 0;
      surf.styles = [0];
      surf.normal = new Vector(0, 0, 1);

      return surf;
    }

    void test('decodes a tangent-space-encoded direction back into world space', () => {
      // Encodes world direction (1, 0, 0): dot with sAxis (1,0,0) -> 1, tAxis (0,-1,0) -> 0, surface normal (0,0,1) -> 0.
      // Encoding is `(component + 1) * 128`, matching ericw-tools' WriteSingleLightmap.
      showWorld({ deluxemap: new Uint8Array([255, 128, 128]) });

      const direction = LightSampler.SampleDeluxemapDirection(makeSurf(), floorTexinfo, 1, 1, 0, 0, 0)!;

      assert.notEqual(direction, null);
      assertNear(direction[0], 1.0, 0.01);
      assertNear(direction[1], 0.0, 0.01);
      assertNear(direction[2], 0.0, 0.01);
    });

    void test('returns null when the map has no deluxemap data', () => {
      showWorld({ deluxemap: null });

      assert.equal(LightSampler.SampleDeluxemapDirection(makeSurf(), floorTexinfo, 1, 1, 0, 0, 0), null);
    });

    void test('returns null when no active lightstyle contributes any weight', () => {
      LightStyles.lightstylevalue_a[0] = 0;
      LightStyles.lightstylevalue_b[0] = 0;
      showWorld({ deluxemap: new Uint8Array([255, 128, 128]) });

      assert.equal(LightSampler.SampleDeluxemapDirection(makeSurf(), floorTexinfo, 1, 1, 0, 0, 0), null);
    });
  });

  void describe('RecursiveLightPoint', () => {
    /**
     * Builds a minimal one-face BSP tree: a horizontal splitting plane at z=0 (an empty leaf above, a solid leaf
     * below), with a single lit face on the root node representing a plain floor with no deluxemap data.
     * @returns The brush model and the root node of its BSP tree.
     */
    function makeFloorWorld(): { brushmodel: BrushModel; root: Node } {
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
      brushmodel.texinfo = [floorTexinfo];
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

    void test('projects the top-down fallback origin far above the surface instead of gluing it to the model', () => {
      const { brushmodel, root } = makeFloorWorld();

      showWorld(brushmodel);

      const result = LightSampler.RecursiveLightPoint(root, new Vector(0, 0, 40), new Vector(0, 0, 40 - 2048));

      assert.notEqual(result, null);
      const [, lightOrigin] = result!;

      // The trace hits the floor face ("mid") at z=0. A small fixed offset here would put the proxy light origin
      // only slightly above the model itself instead of dominating its scale, see #lightOriginProxyDistance in
      // LightSampler.ts, which both fallback branches share. The direction is tilted 30 degrees off vertical (see
      // next test), so the projected height is scaled by cos(30) rather than landing at the full distance.
      assertNear(lightOrigin[2], 512.0 * Math.cos(30.0 * Math.PI / 180.0), 0.5);
    });

    void test('tilts the fallback origin off vertical so it is not invariant to an entity yawing in place', () => {
      const { brushmodel, root } = makeFloorWorld();

      showWorld(brushmodel);

      const [, lightOrigin] = LightSampler.RecursiveLightPoint(root, new Vector(0, 0, 40), new Vector(0, 0, 40 - 2048))!;

      // A purely vertical (0, 0, 1) fallback direction is invariant to an entity's own yaw (a rotation about world
      // Z never changes a vector that only has a Z component), so its diffuse/specular response would never
      // change while it turns in place. Asserting a nonzero horizontal component rules that "stuck" behavior out.
      assert(Math.abs(lightOrigin[0]) > 100.0, `expected a nonzero horizontal component, got ${lightOrigin[0]}`);
      assert(Math.abs(lightOrigin[1]) > 100.0, `expected a nonzero horizontal component, got ${lightOrigin[1]}`);
    });

    void test('returns the baked light of the floor, scaled by the lightstyle', () => {
      const { brushmodel, root } = makeFloorWorld();

      showWorld(brushmodel);

      const [color] = LightSampler.RecursiveLightPoint(root, new Vector(0, 0, 40), new Vector(0, 0, 40 - 2048))!;

      // 128 * (style 12 * 22) = 33792, then >> 8 = 132
      assert.deepEqual([...color], [132, 132, 132]);
    });

    void test('finds nothing when the trace stays above the surface', () => {
      const { brushmodel, root } = makeFloorWorld();

      showWorld(brushmodel);

      assert.equal(LightSampler.RecursiveLightPoint(root, new Vector(0, 0, 40), new Vector(0, 0, 20)), null);
    });
  });

  void describe('LightPointFromGrid', () => {
    /**
     * Builds a lightgrid of one leaf of 2x2x2 points with unit spacing, all lit by style 0 in the same color.
     * @param rootnode Root node reference, a leaf by default.
     * @returns The octree.
     */
    function makeGrid(rootnode = LGNODE_LEAF): LightgridOctree {
      const point = { stylecount: 1, styles: [{ stylenum: 0, rgb: [100, 50, 0] as [number, number, number] }] };

      return {
        step: [1, 1, 1],
        size: [2, 2, 2],
        mins: new Vector(0, 0, 0),
        numstyles: 1,
        rootnode,
        nodes: [],
        leafs: [{ mins: [0, 0, 0], size: [2, 2, 2], points: new Array(8).fill(point) }],
      };
    }

    void test('interpolates between the grid points and applies the lightstyle', () => {
      showWorld({ lightgrid: makeGrid() });

      const [color, origin] = LightSampler.LightPointFromGrid(new Vector(0.25, 0.5, 0.75))!;

      // all corners carry the same color, so the weights sum to 1; style 12 scales by 12 * 22 / 256
      const scale = 12 * 0.0859375;

      assertNear(color[0], 100 * scale, 1e-6);
      assertNear(color[1], 50 * scale, 1e-6);
      assertNear(color[2], 0, 1e-6);
      assert.deepEqual([...origin], [0.25, 0.5, 0.75]);
    });

    void test('returns null for a map without a lightgrid', () => {
      showWorld({ lightgrid: null });

      assert.equal(LightSampler.LightPointFromGrid(new Vector(0, 0, 0)), null);
    });

    void test('returns null where the octree has no data', () => {
      showWorld({ lightgrid: makeGrid(LGNODE_LEAF | LGNODE_MISSING) });

      assert.equal(LightSampler.LightPointFromGrid(new Vector(0.5, 0.5, 0.5)), null);
    });
  });
});
