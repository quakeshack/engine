import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { BrushModelRenderer, resolveBrushBloomContributionStrength } from '../../source/engine/client/renderer/BrushModelRenderer.ts';
import { SimpleSkyBox } from '../../source/engine/client/renderer/Sky.ts';

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
    const worldModel = /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: new Uint8Array(3) });
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: null, submodel: true }),
      /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ ({}),
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
      worldModel,
    );

    assert.equal(lightingState.hasDeluxemap, true);
  });

  void test('uses sampled static and dynamic lighting for inline brush entities', () => {
    const model = /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: new Uint8Array(3), lightdata: null, lightdata_rgb: null });
    const entity = /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ (/** @type {unknown} */ ({ id: 7 }));
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
      /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: true }),
      /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ ({}),
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
      /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: false }),
      /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ ({}),
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
      /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ deluxemap: null, lightdata: null, lightdata_rgb: null }),
      /** @type {import('../../source/engine/client/ClientEntities.ts').ClientEdict} */ ({}),
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
    );

    assert.equal(lightingState.hasDeluxemap, false);
  });
});

void describe('BrushModelRenderer.sampleTurbulentFallbackLight', () => {
  void test('lifts dim no-lightmap turbulent samples toward nearby visible light', () => {
    const face = /** @type {import('../../source/engine/common/model/BaseModel.ts').Face} */ ({
      normal: new Vector(0, 0, 1),
      texinfo: 0,
      verts: [
        [0, 0, 0],
        [16, 0, 0],
        [16, 16, 0],
      ],
    });
    const model = /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ (/** @type {unknown} */ ({
      texinfo: [{ vecs: [[1, 0, 0, 0], [0, 1, 0, 0]] }],
    }));

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

  void test('blends vertex fallback toward a face-level fallback to soften seams', () => {
    const blendedLight = BrushModelRenderer.blendTurbulentFallbackLight(
      [0.2, 0.1, 0.05],
      [0.4, 0.3, 0.2],
      0.35,
    );

    assert(Math.abs(blendedLight[0] - 0.27) < 0.000001);
    assert(Math.abs(blendedLight[1] - 0.17) < 0.000001);
    assert(Math.abs(blendedLight[2] - 0.1025) < 0.000001);
  });
});

void describe('BrushModelRenderer.getWorldTurbulentChains', () => {
  void test('sorts world turbulents by tight batch bounds instead of oversized leaf bounds', () => {
    const previousR = registry.R;
    registry.R = /** @type {typeof import('../../source/engine/client/R.ts').default} */ ({
      visframecount: 7,
      CullBox() {
        return false;
      },
    });
    eventBus.publish('registry.frozen');

    try {
      const renderer = new BrushModelRenderer();
      const chain = {
        texture: 0,
        firstVertex: 12,
        vertexCount: 6,
        mins: new Vector(96, -8, -8),
        maxs: new Vector(128, 8, 8),
      };
      const model = /** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({
        leafs: [{
          visframe: 7,
          waterchain: 0,
          cmds: [[0, 12, 6]],
          turbulentChains: [chain],
          mins: new Vector(-1024, -1024, -1024),
          maxs: new Vector(1024, 1024, 1024),
        }],
      });

      const items = renderer.getWorldTurbulentChains(model, new Vector(0, 0, 0));

      assert.equal(items.length, 1);
      assert.equal(items[0].chain, chain);
      assert.equal(items[0].dist, 96);
    } finally {
      registry.R = previousR;
      eventBus.publish('registry.frozen');
    }
  });
});

void describe('SimpleSkyBox.shutdown', () => {
  void test('does not free shared sky face textures', () => {
    const skybox = new SimpleSkyBox(/** @type {import('../../source/engine/common/model/BSP.ts').BrushModel} */ ({ cmds: null, leafs: [], skychain: 0 }));
    const frees = [];
    const wraps = [];
    const makeTexture = (name) => /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({
      wrapClamped() {
        wraps.push(name);
      },
      free() {
        frees.push(name);
      },
    });

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
