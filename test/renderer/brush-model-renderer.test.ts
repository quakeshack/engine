import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { BrushModelRenderer, resolveBrushBloomContributionStrength } from '../../source/engine/client/renderer/models/BrushModelRenderer.ts';
import { SimpleSkyBox } from '../../source/engine/client/renderer/scene/Sky.ts';
import { createRenderedWorld } from '../support/bspTree.ts';
import { WorldRenderState } from '../../source/engine/common/model/WorldRenderState.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { Face } from '../../source/engine/common/model/BaseModel.ts';
import type R from '../../source/engine/client/R.ts';
import type { GLTexture } from '../../source/engine/client/GL.ts';
import { installEngineMocks } from '../support/withEngineMocks.ts';

void describe('resolveBrushBloomContributionStrength', () => {
  void test('clamps invalid contribution strengths to zero', () => {
    assert.equal(resolveBrushBloomContributionStrength(-1), 0.0);
    assert.equal(resolveBrushBloomContributionStrength(0), 0.0);
    assert.equal(resolveBrushBloomContributionStrength(Number.NaN), 0.0);
  });

  void test('preserves positive contribution strengths', () => {
    assert.equal(resolveBrushBloomContributionStrength(0.33), 0.33);
    assert.equal(resolveBrushBloomContributionStrength(1.0), 1.0);
  });
});

void describe('BrushModelRenderer.resolveEntityLightingState', () => {
  void test('treats inline submodels as sharing the world deluxemap atlas', () => {
    const worldModel = ({ deluxemap: new Uint8Array(3) } as unknown as BrushModel);
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      ({ deluxemap: null, submodel: true } as unknown as BrushModel),
      ({} as unknown as ClientEdict),
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
      worldModel,
    );

    assert.equal(lightingState.hasDeluxemap, true);
  });

  void test('uses sampled static and dynamic lighting for inline brush entities', () => {
    const model = ({ deluxemap: new Uint8Array(3), lightdata: null, lightdata_rgb: null } as unknown as BrushModel);
    const entity = (({ id: 7 } as unknown as unknown) as unknown as ClientEdict);
    const ambientlight = new Vector(0.25, 0.5, 0.75);
    const shadelight = new Vector(0.75, 0.5, 0.25);
    const lightPosition = new Vector(100, 200, 300);
    const dynamicShadeLight = new Vector(0.1, 0.2, 0.3);
    const dynamicLightPosition = new Vector(-10, -20, 40);

    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      model,
      entity,
      (passedEntity) => {
        assert.equal(passedEntity, entity);
        return [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition];
      },
    );

    assert.equal(lightingState.ambientlight, ambientlight);
    assert.equal(lightingState.shadelight, shadelight);
    assert.equal(lightingState.lightPosition, lightPosition);
    assert.equal(lightingState.dynamicShadeLight, dynamicShadeLight);
    assert.equal(lightingState.dynamicLightPosition, dynamicLightPosition);
    assert.equal(lightingState.hasDeluxemap, true);
  });

  void test('keeps inline submodels on the world lightmap intensity contract', () => {
    const ambientlight = new Vector(0.25, 0.5, 0.75);
    const shadelight = new Vector(0.75, 0.5, 0.25);
    const lightPosition = new Vector(100, 200, 300);
    const dynamicShadeLight = new Vector(0.1, 0.2, 0.3);
    const dynamicLightPosition = new Vector(-10, -20, 40);

    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      ({ deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: true } as unknown as BrushModel),
      ({} as unknown as ClientEdict),
      () => [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition],
    );

    assert.deepEqual(Array.from(lightingState.ambientlight), [1, 1, 1]);
    assert.deepEqual(Array.from(lightingState.shadelight), [0, 0, 0]);
    assert.equal(lightingState.lightPosition, lightPosition);
    assert.equal(lightingState.dynamicShadeLight, dynamicShadeLight);
    assert.equal(lightingState.dynamicLightPosition, dynamicLightPosition);
  });

  void test('keeps sampled ambient and shade lighting for standalone brush bsp entities', () => {
    const ambientlight = new Vector(0.25, 0.5, 0.75);
    const shadelight = new Vector(0.75, 0.5, 0.25);
    const lightPosition = new Vector(100, 200, 300);
    const dynamicShadeLight = new Vector(0.1, 0.2, 0.3);
    const dynamicLightPosition = new Vector(-10, -20, 40);

    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      ({ deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: false } as unknown as BrushModel),
      ({} as unknown as ClientEdict),
      () => [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition],
    );

    assert.equal(lightingState.ambientlight, ambientlight);
    assert.equal(lightingState.shadelight, shadelight);
    assert.equal(lightingState.lightPosition, lightPosition);
    assert.equal(lightingState.dynamicShadeLight, dynamicShadeLight);
    assert.equal(lightingState.dynamicLightPosition, dynamicLightPosition);
  });

  void test('falls back to non-deluxemap lighting when the model has no deluxe data', () => {
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      ({ deluxemap: null, lightdata: null, lightdata_rgb: null, submodel: false } as unknown as BrushModel),
      ({} as unknown as ClientEdict),
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
    );

    assert.equal(lightingState.hasDeluxemap, false);
  });
});

void describe('BrushModelRenderer.sampleTurbulentFallbackLight', () => {
  void test('lifts dim no-lightmap turbulent samples toward nearby visible light', () => {
    const face = ({
      normal: new Vector(0, 0, 1),
      texinfo: 0,
      verts: [
        [0, 0, 0],
        [16, 0, 0],
        [16, 16, 0],
      ],
    } as unknown as Face);
    const model = (({
      texinfo: [{ vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] }],
    } as unknown as unknown) as unknown as BrushModel);

    const fallbackLight = BrushModelRenderer.sampleTurbulentFallbackLight(
      model,
      face,
      new Vector(0, 0, 0),
      (position) => {
        const hasNearbyVisibleLight = Math.abs(position[0]) >= 7.5 || Math.abs(position[1]) >= 7.5;

        if (hasNearbyVisibleLight) {
          return [new Vector(32, 24, 16), new Vector()];
        }

        return [new Vector(16, 12, 8), new Vector()];
      },
    );

    assert(fallbackLight[0] > 32 * 0.0078125);
    assert(fallbackLight[0] <= 32 * 0.0078125 * 1.3 + 0.0001);
    assert.equal(fallbackLight[1] > 24 * 0.0078125, true);
    assert.equal(fallbackLight[2] > 16 * 0.0078125, true);
  });

  void test('recovers real floor light through deep probes when a large water body has no shallow escape', () => {
    const face = ({
      normal: new Vector(0, 0, 1),
      texinfo: 0,
      verts: [
        [0, 0, 0],
        [16, 0, 0],
        [16, 16, 0],
      ],
    } as unknown as Face);
    const model = (({
      texinfo: [{ vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] }],
    } as unknown as unknown) as unknown as BrushModel);

    // Simulate a large, deep lake: every shallow/lateral probe (within ~2 units of the surface,
    // or anywhere on the surface plane) is still over water and finds nothing. Only the deep
    // (48 unit) probes clear the liquid volume and reach the real lit floor beneath it.
    const fallbackLight = BrushModelRenderer.sampleTurbulentFallbackLight(
      model,
      face,
      new Vector(0, 0, 0),
      (position) => {
        if (position[2] <= -20) {
          return [new Vector(40, 30, 20), new Vector()];
        }

        return [new Vector(), new Vector()];
      },
    );

    assert(fallbackLight[0] > 0.0, 'deep probe recovers real light instead of staying black');
    assert(Math.abs(fallbackLight[0] - 40 * 0.0078125 * 1.3) < 0.01);
    assert(Math.abs(fallbackLight[1] - 30 * 0.0078125 * 1.3) < 0.01);
    assert(Math.abs(fallbackLight[2] - 20 * 0.0078125 * 1.3) < 0.01);
  });

});

void describe('BrushModelRenderer._buildTurbulentFallbackLightMap', () => {
  void test('averages light at shared vertex positions across adjacent turbulent faces', () => {
    const renderer = new BrushModelRenderer();

    const sharedPos = [16, 0, 0, 0, 0, 0, 0];
    const face1 = (({
      texture: 0,
      styles: [],
      lightofs: -1,
      verts: [[0, 0, 0, 0, 0, 0, 0], sharedPos],
    } as unknown as unknown) as unknown as Face);
    const face2 = (({
      texture: 0,
      styles: [],
      lightofs: -1,
      verts: [sharedPos, [32, 0, 0, 0, 0, 0, 0]],
    } as unknown as unknown) as unknown as Face);
    const model = (({
      submodel: false,
      textures: [{ flags: 4 }], // MF_TURBULENT = 4
      * facesIter() { yield face1; yield face2; },
    } as unknown as unknown) as unknown as BrushModel);

    // face1 is dim, face2 is bright, both comfortably above the ambient floor derived from their
    // own mean (mean 0.7 * TURBULENT_FALLBACK_FLOOR_FRACTION 0.55 = 0.385) so the floor does not
    // interfere with this averaging-only assertion.
    renderer['_getTurbulentFallbackLight'] = (_m, face) =>
      face === face1 ? [0.5, 0.5, 0.5] : [0.9, 0.9, 0.9];

    const lightMap = renderer['_buildTurbulentFallbackLightMap'](model, new Map());

    // TURBULENT_FALLBACK_POS_QUANT = 16
    const keyShared = `${Math.round(16 * 16)}|0|0`;
    const keyLeft = '0|0|0';
    const keyRight = `${Math.round(32 * 16)}|0|0`;

    const sharedLight = lightMap.get(keyShared);
    assert(sharedLight !== undefined, 'shared vertex must appear in the map');
    assert(Math.abs(sharedLight[0] - 0.7) < 0.000001, 'shared vertex averages both faces');

    const leftLight = lightMap.get(keyLeft);
    assert(leftLight !== undefined, 'exclusive face1 vertex must appear in the map');
    assert(Math.abs(leftLight[0] - 0.5) < 0.000001, 'exclusive face1 vertex keeps face1 light');

    const rightLight = lightMap.get(keyRight);
    assert(rightLight !== undefined, 'exclusive face2 vertex must appear in the map');
    assert(Math.abs(rightLight[0] - 0.9) < 0.000001, 'exclusive face2 vertex keeps face2 light');
  });

  void test('lifts vertices with no valid samples to a fraction of the model average', () => {
    const renderer = new BrushModelRenderer();

    const sharedPos = [16, 0, 0, 0, 0, 0, 0];
    const face1 = (({
      texture: 0,
      styles: [],
      lightofs: -1,
      verts: [[0, 0, 0, 0, 0, 0, 0], sharedPos],
    } as unknown as unknown) as unknown as Face);
    const face2 = (({
      texture: 0,
      styles: [],
      lightofs: -1,
      verts: [sharedPos, [32, 0, 0, 0, 0, 0, 0]],
    } as unknown as unknown) as unknown as Face);
    const model = (({
      submodel: false,
      textures: [{ flags: 4 }], // MF_TURBULENT = 4
      * facesIter() { yield face1; yield face2; },
    } as unknown as unknown) as unknown as BrushModel);

    // face1 found nothing nearby (e.g. mid-lake, every probe re-hit more turbulent geometry);
    // face2 found real light. Only face2's samples feed the model average (mean 0.8), so the
    // floor is 0.8 * TURBULENT_FALLBACK_FLOOR_FRACTION 0.55 = 0.44.
    renderer['_getTurbulentFallbackLight'] = (_m, face) =>
      face === face1 ? [0.0, 0.0, 0.0] : [0.8, 0.8, 0.8];

    const lightMap = renderer['_buildTurbulentFallbackLightMap'](model, new Map());

    const keyShared = `${Math.round(16 * 16)}|0|0`;
    const keyLeft = '0|0|0';
    const keyRight = `${Math.round(32 * 16)}|0|0`;

    const leftLight = lightMap.get(keyLeft);
    assert(leftLight !== undefined, 'exclusive face1 vertex must appear in the map');
    assert(Math.abs(leftLight[0] - 0.44) < 0.000001, 'vertex with no valid samples is lifted to the floor instead of staying black');

    const sharedLight = lightMap.get(keyShared);
    assert(sharedLight !== undefined, 'shared vertex must appear in the map');
    assert(Math.abs(sharedLight[0] - 0.44) < 0.000001, 'shared vertex raw average (0.4) is still below the floor and gets lifted');

    const rightLight = lightMap.get(keyRight);
    assert(rightLight !== undefined, 'exclusive face2 vertex must appear in the map');
    assert(Math.abs(rightLight[0] - 0.8) < 0.000001, 'vertex already above the floor is left untouched');
  });

  void test('falls back to a fixed default floor when a model has no valid samples anywhere', () => {
    const renderer = new BrushModelRenderer();

    const face1 = (({
      texture: 0,
      styles: [],
      lightofs: -1,
      verts: [[0, 0, 0, 0, 0, 0, 0]],
    } as unknown as unknown) as unknown as Face);
    const model = (({
      submodel: false,
      textures: [{ flags: 4 }], // MF_TURBULENT = 4
      * facesIter() { yield face1; },
    } as unknown as unknown) as unknown as BrushModel);

    // No probe anywhere in the model finds real light (e.g. a fully unlit map/submodel).
    renderer['_getTurbulentFallbackLight'] = () => [0.0, 0.0, 0.0];

    const lightMap = renderer['_buildTurbulentFallbackLightMap'](model, new Map());

    const keyLeft = '0|0|0';
    const leftLight = lightMap.get(keyLeft);
    assert(leftLight !== undefined, 'vertex must appear in the map');
    // TURBULENT_FALLBACK_DEFAULT_FLOOR
    assert(Math.abs(leftLight[0] - 0.4) < 0.000001, 'falls back to the fixed default floor, not black');
  });
});

void describe('BrushModelRenderer.getWorldTurbulentChains', () => {
  void test('sorts world turbulents by tight batch bounds instead of oversized leaf bounds', () => {
    const restoreEngineMocks = installEngineMocks({
      R: {
        visframecount: 7,
        CullBox() {
          return false;
        },
      } as unknown as typeof R,
    });

    try {
      const renderer = new BrushModelRenderer();
      const chain = {
        texture: 0,
        firstVertex: 12,
        vertexCount: 6,
        mins: new Vector(96, -8, -8),
        maxs: new Vector(128, 8, 8),
      };
      const model = createRenderedWorld([{ visframe: 7, waterchain: 0, cmds: [[0, 12, 6]], bounds: [-1024, -1024, -1024, 1024, 1024, 1024] }]);
      WorldRenderState.of(model).turbulentChains[0] = [chain];

      const items = renderer.getWorldTurbulentChains(model, new Vector(0, 0, 0));

      assert.equal(items.length, 1);
      assert.equal(items[0].chain, chain);
      assert.equal(items[0].dist, 96);
    } finally {
      restoreEngineMocks();
    }
  });
});

void describe('BrushModelRenderer._buildSurfaceDisplayList', () => {
  /**
   * @returns a minimal quad-face brush model fixture
   */
  function createQuadModel(): BrushModel {
    return (({
      texinfo: [{ vecs: [[1, 0, 0, 0], [0, 1, 0, 0]], texture: 0 }],
      textures: [{ width: 64, height: 64 }],
      vertexes: [new Vector(0, 0, 0), new Vector(1, 0, 0), new Vector(1, 1, 0), new Vector(0, 1, 0)],
      edges: [null, [0, 1], [1, 2], [2, 3], [3, 0]],
      surfedges: [1, 2, 3, 4],
    } as unknown as unknown) as unknown as BrushModel);
  }

  /**
   * @param vertexNormals
   * @param vertexTangents
   * @param vertexBitangents
   * @returns a quad face carrying per-vertex FACENORMALS-style data
   */
  function createQuadFace(vertexNormals: Vector[] | null, vertexTangents: Vector[] | null, vertexBitangents: Vector[] | null): Face {
    return ({
      firstedge: 0,
      numedges: 4,
      texinfo: 0,
      sky: false,
      texturemins: [0, 0],
      light_s: 0,
      light_t: 0,
      lmshift: null,
      vertexNormals,
      vertexTangents,
      vertexBitangents,
    } as unknown as Face);
  }

  void test('carries precomputed per-vertex normal/tangent/bitangent onto each triangulated vertex', () => {
    const renderer = new BrushModelRenderer();
    const model = createQuadModel();
    const vertexNormals = [new Vector(1, 0, 0), new Vector(0, 1, 0), new Vector(0, 0, 1), new Vector(-1, 0, 0)];
    const vertexTangents = [new Vector(0, 1, 0), new Vector(0, 0, 1), new Vector(1, 0, 0), new Vector(0, -1, 0)];
    const vertexBitangents = [new Vector(0, 0, 1), new Vector(1, 0, 0), new Vector(0, 1, 0), new Vector(0, 0, -1)];
    const face = createQuadFace(vertexNormals, vertexTangents, vertexBitangents);

    renderer._buildSurfaceDisplayList(model, face);

    // Quad (4 edges) triangulates into 6 fan vertices: [v0, v1, v2, v0, v2, v3].
    assert.equal(face.verts!.length, 6);
    const edgeIndexPerTriangulatedVertex = [0, 1, 2, 0, 2, 3];

    for (let k = 0; k < face.verts!.length; k++) {
      const vert = face.verts![k];
      const edgeIndex = edgeIndexPerTriangulatedVertex[k];
      assert.deepEqual(vert.slice(7, 10), [...vertexNormals[edgeIndex]]);
      assert.deepEqual(vert.slice(10, 13), [...vertexTangents[edgeIndex]]);
      assert.deepEqual(vert.slice(13, 16), [...vertexBitangents[edgeIndex]]);
    }

    // The two triangulated occurrences of the shared vertex (index 2) reuse the same array.
    assert.equal(face.verts![2], face.verts![4]);
  });

  void test('leaves normal/tangent/bitangent slots unset when the face has no FACENORMALS data', () => {
    const renderer = new BrushModelRenderer();
    const model = createQuadModel();
    const face = createQuadFace(null, null, null);

    renderer._buildSurfaceDisplayList(model, face);

    for (const vert of face.verts!) {
      assert.equal(vert.length, 7);
    }
  });
});

void describe('SimpleSkyBox.shutdown', () => {
  void test('does not free shared sky face textures', () => {
    const skybox = new SimpleSkyBox(({ cmds: null, skychain: 0 } as unknown as BrushModel));
    const frees: string[] = [];
    const wraps: string[] = [];
    const makeTexture = (name: string) => ({
      wrapClamped() {
        wraps.push(name);
      },
      free() {
        frees.push(name);
      },
    } as unknown as GLTexture);

    skybox.setSkyTextures(
      makeTexture('front'),
      makeTexture('back'),
      makeTexture('left'),
      makeTexture('right'),
      makeTexture('up'),
      makeTexture('down'),
    );

    assert.deepEqual(wraps, ['front', 'back', 'left', 'right', 'up', 'down']);

    skybox.shutdown();

    assert.deepEqual(frees, []);
  });
});
