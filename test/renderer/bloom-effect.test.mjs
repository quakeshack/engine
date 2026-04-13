import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { effect } from '../../source/shared/Defs.ts';
import { advanceBloomAdaptation, getBloomBufferSize, getBloomDebugPreviewItems, getEntityBloomEmissiveScale, resolveBloomAdaptationTarget, resolveBloomDebugMode, resolveBloomDownsample } from '../../source/engine/client/renderer/BloomEffect.ts';

const bloomBlurShaderSource = readFileSync(new URL('../../source/engine/client/shaders/bloom-blur.frag', import.meta.url), 'utf8');

describe('resolveBloomDownsample', () => {
  test('clamps invalid divisors to the supported minimum', () => {
    assert.equal(resolveBloomDownsample(0), 1);
    assert.equal(resolveBloomDownsample(1), 1);
    assert.equal(resolveBloomDownsample(-4), 1);
  });

  test('caps divisors at the supported maximum', () => {
    assert.equal(resolveBloomDownsample(4), 4);
    assert.equal(resolveBloomDownsample(16), 8);
  });
});

describe('getBloomBufferSize', () => {
  test('downsamples the bloom buffers while keeping a minimum size of one pixel', () => {
    assert.deepEqual(getBloomBufferSize(1920, 1080, 4), { width: 480, height: 270 });
    assert.deepEqual(getBloomBufferSize(3, 2, 4), { width: 1, height: 1 });
  });

  test('uses the sanitized downsample divisor', () => {
    assert.deepEqual(getBloomBufferSize(640, 360, 99), { width: 80, height: 45 });
  });
});

describe('resolveBloomDebugMode', () => {
  test('clamps invalid preview modes to off', () => {
    assert.equal(resolveBloomDebugMode(-1), 0);
    assert.equal(resolveBloomDebugMode(0), 0);
  });

  test('caps preview modes to the supported range', () => {
    assert.equal(resolveBloomDebugMode(1), 1);
    assert.equal(resolveBloomDebugMode(4), 4);
    assert.equal(resolveBloomDebugMode(99), 4);
  });
});

describe('getBloomDebugPreviewItems', () => {
  test('returns all bloom preview textures for combined debug mode', () => {
    const textures = {
      emissiveTexture: /** @type {WebGLTexture} */ ({}),
      extractTexture: /** @type {WebGLTexture} */ ({}),
      blurTexture: /** @type {WebGLTexture} */ ({}),
    };

    assert.deepEqual(getBloomDebugPreviewItems(4, textures), [
      { label: 'emissive', texture: textures.emissiveTexture },
      { label: 'extract', texture: textures.extractTexture },
      { label: 'blur', texture: textures.blurTexture },
    ]);
  });

  test('returns no previews when a selected texture is missing', () => {
    assert.deepEqual(getBloomDebugPreviewItems(2, {
      emissiveTexture: /** @type {WebGLTexture|null} */ ({}),
      extractTexture: null,
      blurTexture: /** @type {WebGLTexture|null} */ ({}),
    }), []);
  });
});

describe('getEntityBloomEmissiveScale', () => {
  test('enables emissive bloom for fullbright and muzzleflash entities', () => {
    assert.equal(getEntityBloomEmissiveScale(effect.EF_FULLBRIGHT), 1.0);
    assert.equal(getEntityBloomEmissiveScale(effect.EF_MUZZLEFLASH), 1.0);
  });

  test('keeps normal lit entities out of the emissive bloom buffer', () => {
    assert.equal(getEntityBloomEmissiveScale(effect.EF_NONE), 0.0);
    assert.equal(getEntityBloomEmissiveScale(effect.EF_BRIGHTLIGHT), 0.0);
  });
});

describe('resolveBloomAdaptationTarget', () => {
  test('keeps bloom at full strength when the measured bloom footprint is small', () => {
    assert.equal(resolveBloomAdaptationTarget(0.0, 0.0), 1.0);
    assert.equal(resolveBloomAdaptationTarget(Number.NaN, 0.9), 1.0);
    assert.equal(resolveBloomAdaptationTarget(0.15, 0.05), 1.0);
  });

  test('reduces bloom further as broad bright coverage grows', () => {
    const mediumCoverage = resolveBloomAdaptationTarget(0.14, 0.45);
    const highCoverage = resolveBloomAdaptationTarget(0.14, 0.8);

    assert.ok(highCoverage < mediumCoverage);
    assert.ok(highCoverage < 0.7);
  });

  test('never drops below the minimum multiplier for fully dominant bloom', () => {
    const target = resolveBloomAdaptationTarget(1.0, 1.0);

    assert.ok(target >= 0.35);
    assert.ok(target <= 0.36);
  });
});

describe('advanceBloomAdaptation', () => {
  test('settles toward a lower multiplier over time without snapping instantly', () => {
    let current = 1.0;

    for (let i = 0; i < 5; ++i) {
      current = advanceBloomAdaptation(current, 0.45, 0.1);
    }

    assert.ok(current < 0.7);
    assert.ok(current > 0.45);
  });

  test('recovers upward more gently than it settles downward', () => {
    const settled = advanceBloomAdaptation(1.0, 0.45, 0.1);
    const recovered = advanceBloomAdaptation(0.45, 1.0, 0.1);

    assert.ok(1.0 - settled > recovered - 0.45);
  });

  test('sanitizes invalid inputs back toward the default multiplier', () => {
    assert.equal(advanceBloomAdaptation(Number.NaN, Number.NaN, Number.NaN), 1.0);
    assert.equal(advanceBloomAdaptation(0.4, 0.8, 0.0), 0.4);
  });
});

describe('bloom blur shader kernel', () => {
  test('stays normalized and symmetric after widening the blur', () => {
    const centerMatch = bloomBlurShaderSource.match(/vec3 color = texture\(tTexture, vTexCoord\)\.rgb \* ([0-9.]+);/);
    const positiveMatches = [...bloomBlurShaderSource.matchAll(/vTexCoord \+ uTexelOffset \* ([0-9.]+)\)\.rgb \* ([0-9.]+);/g)];
    const negativeMatches = [...bloomBlurShaderSource.matchAll(/vTexCoord - uTexelOffset \* ([0-9.]+)\)\.rgb \* ([0-9.]+);/g)];

    assert.ok(centerMatch);
    assert.equal(positiveMatches.length, 3);
    assert.equal(negativeMatches.length, 3);

    let totalWeight = Number(centerMatch[1]);
    let previousOffset = 0.0;

    for (let i = 0; i < positiveMatches.length; ++i) {
      const positiveOffset = Number(positiveMatches[i][1]);
      const positiveWeight = Number(positiveMatches[i][2]);
      const negativeOffset = Number(negativeMatches[i][1]);
      const negativeWeight = Number(negativeMatches[i][2]);

      assert.equal(positiveOffset, negativeOffset);
      assert.equal(positiveWeight, negativeWeight);
      assert.ok(positiveOffset > previousOffset);

      totalWeight += positiveWeight * 2.0;
      previousOffset = positiveOffset;
    }

    assert.ok(Math.abs(totalWeight - 1.0) < 1e-9);
  });
});
