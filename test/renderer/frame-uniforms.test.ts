import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import type { GLProgramInfo } from '../../source/engine/client/GL.ts';
import V from '../../source/engine/client/V.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import ShadowMap from '../../source/engine/client/renderer/lighting/ShadowMap.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import FrameUniforms from '../../source/engine/client/renderer/scene/FrameUniforms.ts';
import { assertNear } from '../support/assertions.ts';

type Call = [string, string, ...unknown[]];

/**
 * Creates a stand-in for a console variable.
 * @param value Its value.
 * @param string Its string value.
 * @returns The stand-in.
 */
function fakeCvar(value: number, string = String(value)): Cvar {
  const cvar = {
    value,
    string,
    set(newValue: number): void {
      cvar.value = newValue;
    },
  };

  return cvar as unknown as Cvar;
}

/**
 * Creates a program that declares the given uniforms; each location is its name, so a call says what it wrote.
 * @param uniforms Uniform names the program declares.
 * @returns The program.
 */
function fakeProgram(...uniforms: string[]): GLProgramInfo {
  const program: Record<string, unknown> = { program: { name: `program of ${uniforms.join(',')}` } };

  for (const uniform of uniforms) {
    program[uniform] = uniform;
  }

  return program as unknown as GLProgramInfo;
}

void describe('FrameUniforms.Upload', () => {
  const previous = {
    context: GL.gl,
    programs: GL.programs,
    currentProgram: GL.currentProgram,
    gamma: V.gamma,
    fogColor: rendererCvars.fog_color,
    fogStart: rendererCvars.fog_start,
    fogEnd: rendererCvars.fog_end,
    fogDensity: rendererCvars.fog_density,
    fogMode: rendererCvars.fog_mode,
    enabled: ShadowMap.enabled,
    darkness: ShadowMap.darkness,
    maxDepth: ShadowMap.maxDepth,
    range: ShadowMap.range,
    pointBias: ShadowMap.pointBias,
    pointLightActiveCount: ShadowMap.pointLightActiveCount,
    vieworg: Camera.refdef.vieworg.copy(),
    rotation: Camera.rotation,
  };
  let calls: Call[] = [];

  /**
   * Records a uniform call.
   * @param name GL function the engine called.
   * @returns A function that records its arguments.
   */
  function record(name: string): (location: string, ...rest: unknown[]) => void {
    return (location, ...rest) => {
      calls.push([name, location, ...rest]);
    };
  }

  beforeEach(() => {
    calls = [];
    GL.currentProgram = null;
    GL.gl = {
      useProgram: (program: { name: string }) => { calls.push(['useProgram', program.name]); },
      uniform1f: record('uniform1f'),
      uniform3fv: record('uniform3fv'),
      uniform4f: record('uniform4f'),
      uniformMatrix3fv: record('uniformMatrix3fv'),
      uniformMatrix4fv: record('uniformMatrix4fv'),
    } as unknown as WebGL2RenderingContext;
    eventBus.publish('gl.ready');

    V.gamma = fakeCvar(1.0);
    rendererCvars.fog_color = fakeCvar(0, '255 0 51');
    rendererCvars.fog_start = fakeCvar(128);
    rendererCvars.fog_end = fakeCvar(4096);
    rendererCvars.fog_density = fakeCvar(0.01);
    rendererCvars.fog_mode = fakeCvar(1);
    ShadowMap.enabled = fakeCvar(1);
    ShadowMap.darkness = fakeCvar(0.4);
    ShadowMap.maxDepth = fakeCvar(512);
    ShadowMap.range = fakeCvar(2048);
    ShadowMap.pointBias = fakeCvar(0.05);
    ShadowMap.pointLightActiveCount = 0;
    Camera.refdef.vieworg.setTo(1.0, 2.0, 3.0);
    Camera.rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previous.context;
    GL.programs = previous.programs;
    GL.currentProgram = previous.currentProgram;
    V.gamma = previous.gamma;
    rendererCvars.fog_color = previous.fogColor;
    rendererCvars.fog_start = previous.fogStart;
    rendererCvars.fog_end = previous.fogEnd;
    rendererCvars.fog_density = previous.fogDensity;
    rendererCvars.fog_mode = previous.fogMode;
    ShadowMap.enabled = previous.enabled;
    ShadowMap.darkness = previous.darkness;
    ShadowMap.maxDepth = previous.maxDepth;
    ShadowMap.range = previous.range;
    ShadowMap.pointBias = previous.pointBias;
    ShadowMap.pointLightActiveCount = previous.pointLightActiveCount;
    Camera.refdef.vieworg.set(previous.vieworg);
    Camera.rotation = previous.rotation;
  });

  void test('writes the view to a program that declares it, and nothing else', () => {
    GL.programs = [fakeProgram('uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma')];

    FrameUniforms.Upload();

    assert.deepEqual(calls.map(([name, location]) => `${name} ${location}`), [
      'useProgram program of uViewOrigin,uViewAngles,uPerspective,uGamma',
      'uniform3fv uViewOrigin',
      'uniformMatrix3fv uViewAngles',
      'uniformMatrix4fv uPerspective',
      'uniform1f uGamma',
    ]);
    assert.deepEqual(Array.from(calls[1][2] as ArrayLike<number>), [1.0, 2.0, 3.0]);
    assert.equal(calls[2][2], false);
    assert.equal(calls[2][3], Camera.rotation);
    assert.equal(calls[3][3], Camera.perspective);
  });

  void test('visits every program', () => {
    GL.programs = [fakeProgram('uGamma'), fakeProgram('uViewOrigin')];

    FrameUniforms.Upload();

    assert.deepEqual(calls.filter(([name]) => name === 'useProgram').map(([, program]) => program), [
      'program of uGamma',
      'program of uViewOrigin',
    ]);
  });

  void test('clamps the gamma cvar before it is uploaded', () => {
    GL.programs = [fakeProgram('uGamma')];

    V.gamma = fakeCvar(0.2);
    FrameUniforms.Upload();
    assert.equal(V.gamma.value, 0.5);
    assert.deepEqual(calls.at(-1), ['uniform1f', 'uGamma', 0.5]);

    V.gamma = fakeCvar(3.0);
    FrameUniforms.Upload();
    assert.equal(V.gamma.value, 1.0);
    assert.deepEqual(calls.at(-1), ['uniform1f', 'uGamma', 1.0]);
  });

  void test('turns the fog color cvar into the 0 to 1 range', () => {
    GL.programs = [fakeProgram('uFogColor')];

    FrameUniforms.Upload();

    const color = calls[1][2] as number[];

    assertNear(color[0], 1.0, 1e-9);
    assertNear(color[1], 128 / 255, 1e-9); // a 0 falls back to 128, as before
    assertNear(color[2], 51 / 255, 1e-9);
  });

  void test('uses a neutral gray when the fog color cvar is empty', () => {
    GL.programs = [fakeProgram('uFogColor')];
    rendererCvars.fog_color = fakeCvar(0, '');

    FrameUniforms.Upload();

    const color = calls[1][2] as number[];

    assert.deepEqual(color.map((component) => Math.round(component * 255)), [128, 128, 128]);
  });

  void test('packs start, end, density and mode into the fog parameters', () => {
    GL.programs = [fakeProgram('uFogParams')];

    FrameUniforms.Upload();

    assert.deepEqual(calls[1], ['uniform4f', 'uFogParams', 128, 4096, 0.01, 1]);
  });

  void test('converts the shadow max depth into the normalized depth of the top-down map', () => {
    GL.programs = [fakeProgram('uShadowMaxDepthNDC')];

    FrameUniforms.Upload();

    // the map spans 2 * range world units: 512 / (2 * 2048)
    assert.deepEqual(calls[1], ['uniform1f', 'uShadowMaxDepthNDC', 0.125]);
  });

  void test('switches the point-light shadows on from the number of active lights', () => {
    GL.programs = [fakeProgram('uPointShadowEnabled')];

    FrameUniforms.Upload();
    assert.deepEqual(calls.at(-1), ['uniform1f', 'uPointShadowEnabled', 0.0]);

    ShadowMap.pointLightActiveCount = 2;
    FrameUniforms.Upload();
    assert.deepEqual(calls.at(-1), ['uniform1f', 'uPointShadowEnabled', 1.0]);
  });
});
