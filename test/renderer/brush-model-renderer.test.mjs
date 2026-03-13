import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.mjs';
import { BrushModelRenderer } from '../../source/engine/client/renderer/BrushModelRenderer.mjs';

describe('BrushModelRenderer.resolveEntityLightingState', () => {
  test('treats inline submodels as sharing the world deluxemap atlas', () => {
    const worldModel = { deluxemap: new Uint8Array(3) };
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      { deluxemap: null, submodel: true },
      {},
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
      worldModel,
    );

    assert.equal(lightingState.hasDeluxemap, true);
  });

  test('uses sampled static and dynamic lighting for inline brush entities', () => {
    const model = { deluxemap: new Uint8Array(3), lightdata: null, lightdata_rgb: null };
    const entity = { id: 7 };
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

  test('keeps inline submodels on the world lightmap intensity contract', () => {
    const ambientlight = new Vector(0.25, 0.5, 0.75);
    const shadelight = new Vector(0.75, 0.5, 0.25);
    const lightPosition = new Vector(100, 200, 300);
    const dynamicShadeLight = new Vector(0.1, 0.2, 0.3);
    const dynamicLightPosition = new Vector(-10, -20, 40);

    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      { deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: true },
      {},
      () => [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition],
    );

    assert.deepEqual(Array.from(lightingState.ambientlight), [1, 1, 1]);
    assert.deepEqual(Array.from(lightingState.shadelight), [0, 0, 0]);
    assert.equal(lightingState.lightPosition, lightPosition);
    assert.equal(lightingState.dynamicShadeLight, dynamicShadeLight);
    assert.equal(lightingState.dynamicLightPosition, dynamicLightPosition);
  });

  test('keeps sampled ambient and shade lighting for standalone brush bsp entities', () => {
    const ambientlight = new Vector(0.25, 0.5, 0.75);
    const shadelight = new Vector(0.75, 0.5, 0.25);
    const lightPosition = new Vector(100, 200, 300);
    const dynamicShadeLight = new Vector(0.1, 0.2, 0.3);
    const dynamicLightPosition = new Vector(-10, -20, 40);

    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      { deluxemap: null, lightdata: new Uint8Array(3), lightdata_rgb: null, submodel: false },
      {},
      () => [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition],
    );

    assert.equal(lightingState.ambientlight, ambientlight);
    assert.equal(lightingState.shadelight, shadelight);
    assert.equal(lightingState.lightPosition, lightPosition);
    assert.equal(lightingState.dynamicShadeLight, dynamicShadeLight);
    assert.equal(lightingState.dynamicLightPosition, dynamicLightPosition);
  });

  test('falls back to non-deluxemap lighting when the model has no deluxe data', () => {
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      { deluxemap: null, lightdata: null, lightdata_rgb: null },
      {},
      () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()],
    );

    assert.equal(lightingState.hasDeluxemap, false);
  });
});
