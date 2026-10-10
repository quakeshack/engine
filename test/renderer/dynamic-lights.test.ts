import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import DynamicLights from '../../source/engine/client/renderer/lighting/DynamicLights.ts';
import Lightmaps from '../../source/engine/client/renderer/lighting/Lightmaps.ts';
import { LIGHTMAP_BLOCK_SIZE } from '../../source/engine/client/renderer/lighting/LightmapAtlas.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { ClientDlight } from '../../source/engine/client/ClientEntities.ts';
import * as Def from '../../source/engine/common/Def.ts';
import { Face, Plane } from '../../source/engine/common/model/BaseModel.ts';
import { BrushModel, Node, type BrushTexInfo } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';

const CLOCK = 100.0;

/**
 * A square floor of 16x16 units at z = 0, facing up, with a corner at the origin.
 * @returns The face and the map it belongs to.
 */
function createFloor(): { face: Face; model: BrushModel; root: Node; above: Node; below: Node } {
  const model = new BrushModel('maps/test.bsp');
  const face = new Face();

  face.normal = new Vector(0, 0, 1);
  face.firstedge = 0;
  face.numedges = 4;
  face.texinfo = 0;
  face.texturemins = [0, 0];
  face.extents = [16, 16];
  face.lmshift = 4;
  face.light_s = 4;
  face.light_t = 6;

  model.faces = [face];
  model.surfedges = [0];
  model.edges = [[0, 1]];
  model.vertexes = [new Vector(0, 0, 0), new Vector(16, 0, 0)];
  model.texinfo = [{ vecs: [[1, 0, 0, 0], [0, 1, 0, 0]], texture: 0, flags: 0 } as unknown as BrushTexInfo];

  const above = new Node(model);
  above.contents = content.CONTENT_EMPTY;

  const below = new Node(model);
  below.contents = content.CONTENT_SOLID;

  const root = new Node(model);
  root.contents = content.CONTENT_NONE;
  root.plane = new Plane(new Vector(0, 0, 1), 0);
  root.children = [above, below];
  root.firstface = 0;
  root.numfaces = 1;

  model.nodes = [root];

  return { face, model, root, above, below };
}

/**
 * Makes a dynamic light.
 * @param origin Where it is.
 * @param radius How far it reaches.
 * @returns The light, alive until long after the test.
 */
function createLight(origin: Vector, radius: number): ClientDlight {
  const light = new ClientDlight();

  light.origin.set(origin);
  light.radius = radius;
  light.die = CLOCK + 1e6;
  light.color.setTo(1, 1, 1);

  return light;
}

void describe('DynamicLights', () => {
  let restores: Array<() => void> = [];

  beforeEach(() => {
    DynamicLights.dlightframecount = 0;
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    restores = [];
  });

  /**
   * Makes the client look at a map with some lights and a collision query.
   * @param model The map.
   * @param lights The dynamic lights, the other slots are free.
   * @param collision What `clientCollision` answers.
   */
  function show(model: BrushModel, lights: ClientDlight[] = [], collision: object = {}): void {
    const dlights = Array.from({ length: Def.limits.dlights }, (_, index) => lights[index] ?? new ClientDlight());

    restores.push(useClientStateOf({
      state: { time: CLOCK, worldmodel: model, clientEntities: { dlights, getVisibleEntities: () => [] } },
      collision,
    }));
  }

  void describe('GetDynamicLightSurfaceImpact', () => {
    void test('projects a light in front of the face onto it', () => {
      const { face, model } = createFloor();

      show(model);

      const impact = DynamicLights.GetDynamicLightSurfaceImpact(createLight(new Vector(5, 6, 20), 100), face)!;

      assert.notEqual(impact, null);
      assertNear(impact.distanceToPlane, 20);
      assert.deepEqual([...impact.impact], [5, 6, 0]);
    });

    void test('ignores a light behind the face', () => {
      const { face, model } = createFloor();

      show(model);

      assert.equal(DynamicLights.GetDynamicLightSurfaceImpact(createLight(new Vector(5, 6, -20), 100), face), null);
    });

    void test('ignores a light that does not reach the plane', () => {
      const { face, model } = createFloor();

      show(model);

      assert.equal(DynamicLights.GetDynamicLightSurfaceImpact(createLight(new Vector(5, 6, 200), 100), face), null);
    });
  });

  void describe('IsDynamicLightSurfaceVisible', () => {
    void test('is true when the trace to the surface is free', () => {
      const { face, model } = createFloor();

      show(model, [], { traceStaticWorldLine: () => ({ startsolid: false, allsolid: false, fraction: 1.0 }) });

      assert.equal(DynamicLights.IsDynamicLightSurfaceVisible(createLight(new Vector(0, 0, 10), 100), face, new Vector(4, 4, 0)), true);
    });

    void test('is false when something is in the way', () => {
      const { face, model } = createFloor();

      show(model, [], { traceStaticWorldLine: () => ({ startsolid: false, allsolid: false, fraction: 0.5 }) });

      assert.equal(DynamicLights.IsDynamicLightSurfaceVisible(createLight(new Vector(0, 0, 10), 100), face, new Vector(4, 4, 0)), false);
    });
  });

  void describe('MarkLights', () => {
    const free = { traceStaticWorldLine: () => ({ startsolid: false, allsolid: false, fraction: 1.0 }) };

    void test('tags the faces of a node a light reaches with the light bit, for the next frame', () => {
      const { face, model, root } = createFloor();

      show(model, [], free);

      DynamicLights.MarkLights(createLight(new Vector(5, 6, 20), 100), 4, root);

      assert.equal(face.dlightbits, 4);
      assert.equal(face.dlightframe, DynamicLights.dlightframecount + 1);
    });

    void test('adds the bit of a second light to the same face', () => {
      const { face, model, root } = createFloor();

      show(model, [], free);

      DynamicLights.MarkLights(createLight(new Vector(5, 6, 20), 100), 1, root);
      DynamicLights.MarkLights(createLight(new Vector(9, 2, 30), 100), 2, root);

      assert.equal(face.dlightbits, 3);
    });

    void test('does not tag faces the light cannot see', () => {
      const { face, model, root } = createFloor();

      show(model, [], { traceStaticWorldLine: () => ({ startsolid: false, allsolid: false, fraction: 0.2 }) });

      DynamicLights.MarkLights(createLight(new Vector(5, 6, 20), 100), 1, root);

      assert.equal(face.dlightbits, 0);
    });

    void test('does not tag sky faces', () => {
      const { face, model, root } = createFloor();

      face.sky = true;
      show(model, [], free);

      DynamicLights.MarkLights(createLight(new Vector(5, 6, 20), 100), 1, root);

      assert.equal(face.dlightbits, 0);
    });

    void test('stays away from the faces of a node that is further than the radius', () => {
      const { face, model, root } = createFloor();

      show(model, [], free);

      DynamicLights.MarkLights(createLight(new Vector(5, 6, 500), 100), 1, root);

      assert.equal(face.dlightbits, 0);
    });
  });

  void describe('Push', () => {
    const free = { traceStaticWorldLine: () => ({ startsolid: false, allsolid: false, fraction: 1.0 }) };

    beforeEach(() => {
      Lightmaps.Begin();
      restores.push(
        patchMembers(rendererCvars, { flashblend: { value: 0 } }),
        patchMembers(Lightmaps, { dlightmap_rgba_texture: { bind() {} } }),
      );

      GL.gl = { TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, texSubImage2D() {} } as unknown as WebGL2RenderingContext;
      eventBus.publish('gl.ready');
    });

    afterEach(() => {
      eventBus.publish('gl.shutdown');
      Lightmaps.Clear();
    });

    void test('lights the dynamic lightmap block of a face a light reaches', () => {
      const { face, model } = createFloor();

      show(model, [createLight(new Vector(8, 8, 20), 100)], free);

      DynamicLights.Push();

      // the block of the face is 2x2 texels at (4, 6); at least one texel got light
      const base = (6 * LIGHTMAP_BLOCK_SIZE + 4) * 4;
      const texels = [0, 1].flatMap((row) => [0, 1].map((column) => Lightmaps.dlightmaps_rgba![base + row * LIGHTMAP_BLOCK_SIZE * 4 + column * 4]));

      assert.ok(texels.some((value) => value > 0), `expected light in the block, got ${texels}`);
      assert.equal(Lightmaps.lightmap_modified[6], 1);
      assert.equal(face.dlightframe, 1);
    });

    void test('advances the frame counter by one', () => {
      const { model } = createFloor();

      show(model, [], free);

      DynamicLights.Push();

      assert.equal(DynamicLights.dlightframecount, 1);
    });

    void test('clears the block of a face whose light is gone', () => {
      const { face, model } = createFloor();
      const light = createLight(new Vector(8, 8, 20), 100);

      show(model, [light], free);

      DynamicLights.Push();
      light.die = 0;
      DynamicLights.Push();
      DynamicLights.Push();

      const base = (6 * LIGHTMAP_BLOCK_SIZE + 4) * 4;

      assert.deepEqual([...Lightmaps.dlightmaps_rgba!.subarray(base, base + 4)], [0, 0, 0, 255]);
      assert.equal(face.dlightframe, 1, 'it was tagged for the first frame only, the later frames left it alone');
    });

    void test('does nothing in flashblend mode, the coronas replace the lightmap', () => {
      const { face, model } = createFloor();

      restores.push(patchMembers(rendererCvars, { flashblend: { value: 1 } }));
      show(model, [createLight(new Vector(8, 8, 20), 100)], free);

      DynamicLights.Push();

      assert.equal(DynamicLights.dlightframecount, 0);
      assert.equal(face.dlightframe, -1);
    });
  });
});
