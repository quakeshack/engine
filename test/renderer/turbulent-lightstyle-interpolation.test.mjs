import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const turbulentShaderSource = readFileSync(new URL('../../source/engine/client/shaders/turbulent.frag', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../../source/engine/client/R.ts', import.meta.url), 'utf8');

void describe('turbulent lightstyle interpolation shader wiring', () => {
  void test('mixes lightstyle A/B with uInterpolation in turbulent shader', () => {
    assert.match(turbulentShaderSource, /uniform\s+float\s+uLightstyleInterpolation\s*;/);
    assert.match(turbulentShaderSource, /uniform\s+sampler2D\s+tLightStyleA\s*;/);
    assert.match(turbulentShaderSource, /uniform\s+sampler2D\s+tLightStyleB\s*;/);
    assert.match(turbulentShaderSource, /mix\(lightstyleA,\s*lightstyleB,\s*uLightstyleInterpolation\)/);
  });

  void test('registers turbulent program with interpolated lightstyle samplers', () => {
    assert.match(rendererSource, /GL\.CreateProgram\('turbulent',[\s\S]*'uLightstyleInterpolation'/);
    assert.match(rendererSource, /GL\.CreateProgram\('turbulent',[\s\S]*'tLightStyleA'/);
    assert.match(rendererSource, /GL\.CreateProgram\('turbulent',[\s\S]*'tLightStyleB'/);
  });

  void test('registers brush program with dedicated lightstyle interpolation', () => {
    assert.match(rendererSource, /GL\.CreateProgram\('brush',[\s\S]*'uLightstyleInterpolation'/);
  });
});
