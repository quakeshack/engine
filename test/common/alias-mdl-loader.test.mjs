import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildAliasSkinLayers } from '../../source/engine/common/model/loaders/AliasMDLLoader.mjs';

describe('buildAliasSkinLayers', () => {
  test('splits legacy alias fullbright pixels into diffuse and luminance layers', () => {
    const palette = new Uint8Array(256 * 3);
    palette[16 * 3] = 1;
    palette[16 * 3 + 1] = 2;
    palette[16 * 3 + 2] = 3;
    palette[240 * 3] = 10;
    palette[240 * 3 + 1] = 20;
    palette[240 * 3 + 2] = 30;

    const { diffuse, luminance } = buildAliasSkinLayers(new Uint8Array([16, 240]), 2, 1, palette, null, 240);

    assert.deepEqual(Array.from(diffuse), [
      1, 2, 3, 255,
      10, 20, 30, 0,
    ]);
    assert.deepEqual(Array.from(luminance), [
      0, 0, 0, 0,
      10, 20, 30, 255,
    ]);
  });

  test('respects transparent pixels when building alias luminance layers', () => {
    const palette = new Uint8Array(256 * 3);
    palette[255 * 3] = 70;
    palette[255 * 3 + 1] = 80;
    palette[255 * 3 + 2] = 90;

    const { diffuse, luminance } = buildAliasSkinLayers(new Uint8Array([255]), 1, 1, palette, 255, 240);

    assert.deepEqual(Array.from(diffuse), [0, 0, 0, 0]);
    assert.deepEqual(Array.from(luminance), [0, 0, 0, 0]);
  });
});
