import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import GL, { type GLProgramInfo, type GLTexture } from '../../source/engine/client/GL.ts';
import MaterialBinder, { resolveMaterialLuminanceTexture } from '../../source/engine/client/renderer/models/MaterialBinder.ts';
import { MaterialFlags, NoTextureMaterial, PBRMaterial, QuakeMaterial } from '../../source/engine/client/renderer/models/Materials.ts';
import DefaultTextures from '../../source/engine/client/renderer/resources/DefaultTextures.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import RenderStats from '../../source/engine/client/renderer/scene/RenderStats.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';

type Binding = [name: string, unit: number];

/**
 * Creates a texture stand-in that logs the unit it is bound to.
 * @param name Name to log.
 * @param log Where bindings go.
 * @returns The texture.
 */
function createTexture(name: string, log: Binding[]): GLTexture {
  return {
    name,
    bind: (unit: number) => { log.push([name, unit]); },
    free: () => {},
  } as unknown as GLTexture;
}

/**
 * Creates a program that declares the given samplers and uniforms; each sampler is its unit number.
 * @param members Declared members.
 * @returns The program.
 */
function createProgram(members: Record<string, number | string>): GLProgramInfo {
  return members as unknown as GLProgramInfo;
}

void describe('resolveMaterialLuminanceTexture', () => {
  const fallbackTexture = {} as GLTexture;
  const diffuseTexture = {} as GLTexture;
  const luminanceTexture = {} as GLTexture;

  void test('keeps the explicit luminance texture when one is present', () => {
    assert.equal(resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, luminanceTexture, diffuseTexture, fallbackTexture), luminanceTexture);
  });

  void test('uses the diffuse texture as luminance for MF_FULLBRIGHT materials without an emissive map', () => {
    assert.equal(resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, fallbackTexture, diffuseTexture, fallbackTexture), diffuseTexture);
  });

  void test('falls back to the black texture for non-fullbright materials without emissive data', () => {
    assert.equal(resolveMaterialLuminanceTexture(MaterialFlags.MF_NONE, null, diffuseTexture, fallbackTexture), fallbackTexture);
  });
});

void describe('MaterialBinder', () => {
  const previousContext = GL.gl;
  let log: Binding[] = [];
  let uniformCalls: Array<[string, number]> = [];
  let restoreTextures: () => void = () => {};
  let restoreCvars: () => void = () => {};
  let notexture: GLTexture = null!;
  let blacktexture: GLTexture = null!;
  let flatnormalmap: GLTexture = null!;

  beforeEach(() => {
    log = [];
    uniformCalls = [];
    notexture = createTexture('notexture', log);
    blacktexture = createTexture('black', log);
    flatnormalmap = createTexture('flatnormal', log);
    restoreTextures = patchMembers(DefaultTextures, { notexture, blacktexture, flatnormalmap });
    restoreCvars = patchMembers(rendererCvars, { interpolation: { value: 0 } });
    GL.gl = {
      uniform1i: (location: string, value: number) => { uniformCalls.push([location, value]); },
      uniform1f: (location: string, value: number) => { uniformCalls.push([location, value]); },
    } as unknown as WebGL2RenderingContext;
    eventBus.publish('gl.ready');
    RenderStats.Reset();
  });

  afterEach(() => {
    restoreCvars();
    restoreTextures();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void describe('Bind a QuakeMaterial', () => {
    const program = createProgram({
      uPerformDotLighting: 'uPerformDotLighting',
      uInterpolation: 'uInterpolation',
      tTextureA: 0,
      tTextureB: 1,
      tLuminance: 2,
      tNormal: 3,
      tSpecular: 4,
    });

    void test('keeps dot lighting disabled and leaves normal and specular unbound without a deluxemap', () => {
      MaterialBinder.Bind(new QuakeMaterial('wall1', 64, 64), program, false);

      assert.deepEqual(uniformCalls.filter(([location]) => location === 'uPerformDotLighting'), [['uPerformDotLighting', 0]]);
      // the checkerboard for both diffuse samplers, the black texture only as the luminance fallback
      assert.deepEqual(log, [['notexture', 0], ['notexture', 1], ['black', 2]]);
    });

    void test('enables dot lighting and binds a flat normal and black specular with a deluxemap', () => {
      MaterialBinder.Bind(new QuakeMaterial('wall1', 64, 64), program, true);

      assert.deepEqual(uniformCalls.filter(([location]) => location === 'uPerformDotLighting'), [['uPerformDotLighting', 1]]);
      assert.deepEqual(log.filter(([name]) => name === 'flatnormal'), [['flatnormal', 3]]);
      assert.deepEqual(log.filter(([name]) => name === 'black'), [['black', 2], ['black', 4]]);
    });

    void test('defaults to dot lighting disabled when no deluxemap flag is passed', () => {
      MaterialBinder.Bind(new QuakeMaterial('wall1', 64, 64), createProgram({ uPerformDotLighting: 'uPerformDotLighting' }));

      assert.deepEqual(uniformCalls, [['uPerformDotLighting', 0]]);
      assert.deepEqual(log, []);
    });

    void test('binds the textures of the selected frame, and the next frame to the second sampler', () => {
      const material = new QuakeMaterial('+0wall', 64, 64);

      material.addAnimationFrame(0, createTexture('a', log), null);
      material.addAnimationFrame(1, createTexture('b', log), null);
      material.selectFrame(0, 0.2);
      MaterialBinder.Bind(material, createProgram({ uPerformDotLighting: 'uPerformDotLighting', tTextureA: 0, tTextureB: 1 }));

      assert.deepEqual(log, [['b', 0], ['a', 1]]);
    });

    void test('shows the diffuse texture as emissive for a fullbright material', () => {
      const material = new QuakeMaterial('wall1', 64, 64);

      material.flags = MaterialFlags.MF_FULLBRIGHT;
      material.texture = createTexture('diffuse', log);
      MaterialBinder.Bind(material, createProgram({ uPerformDotLighting: 'uPerformDotLighting', tTexture: 0, tLuminance: 2 }));

      assert.deepEqual(log, [['diffuse', 0], ['diffuse', 2]]);
    });

    void test('counts the texture binds', () => {
      MaterialBinder.Bind(new QuakeMaterial('wall1', 64, 64), program, true);

      // two diffuse samplers, luminance, normal and specular
      assert.equal(RenderStats.c_brush_texture_binds, 5);
    });

    void test('writes the interpolation factor of the client clock', () => {
      const restoreClock = useClientStateOf({ state: { time: 0.1 } });
      const restoreInterpolation = patchMembers(rendererCvars, { interpolation: { value: 1 } });

      try {
        MaterialBinder.Bind(new QuakeMaterial('wall1', 64, 64), createProgram({ uPerformDotLighting: 'uPerformDotLighting', uInterpolation: 'uInterpolation' }));
      } finally {
        restoreInterpolation();
        restoreClock();
      }

      assert.deepEqual(uniformCalls.find(([location]) => location === 'uInterpolation'), ['uInterpolation', 0.5]);
    });
  });

  void describe('Bind a PBRMaterial', () => {
    const program = createProgram({
      uPerformDotLighting: 'uPerformDotLighting',
      tTexture: 0,
      tLuminance: 2,
      tNormal: 3,
      tSpecular: 4,
    });

    void test('draws the defaults for the layers it does not have', () => {
      MaterialBinder.Bind(new PBRMaterial('pbr', 64, 64), program);

      assert.deepEqual(uniformCalls, [['uPerformDotLighting', 1]]);
      assert.deepEqual(log, [['notexture', 0], ['black', 4], ['flatnormal', 3], ['black', 2]]);
    });

    void test('draws the layers it has', () => {
      const material = new PBRMaterial('pbr', 64, 64);

      material.diffuse = createTexture('diffuse', log);
      material.specular = createTexture('specular', log);
      material.normal = createTexture('normal', log);
      material.luminance = createTexture('luma', log);
      MaterialBinder.Bind(material, program);

      assert.deepEqual(log, [['diffuse', 0], ['specular', 4], ['normal', 3], ['luma', 2]]);
    });
  });

  void test('Bind draws the checkerboard for a material without a texture', () => {
    MaterialBinder.Bind(new NoTextureMaterial(), createProgram({}));

    assert.deepEqual(log, [['notexture', 0]]);
  });

  void describe('Emit', () => {
    const world = { frame: 0 } as unknown as ClientEdict;
    const door = { frame: 0 } as unknown as ClientEdict;
    let restoreClientState: () => void = () => {};

    beforeEach(() => {
      restoreClientState = useClientStateOf({
        state: {
          time: 0.0,
          worldmodel: { worldspawnInfo: { _wateralpha: '0.4', _lavaalpha: 'not a number', lavaalpha: '2.5' } },
          clientEntities: { getEntity: (index: number) => (index === 0 ? world : null) },
        },
      });
    });

    afterEach(() => {
      restoreClientState();
    });

    void test('takes the liquid alpha from the worldspawn for the world', () => {
      const water = new QuakeMaterial('*04water1', 64, 64);

      water.flags = MaterialFlags.MF_TURBULENT;
      MaterialBinder.Emit(water, world);

      assert.equal(water.currentAlpha, 0.4);
    });

    void test('skips an unusable key and clamps to 1', () => {
      const lava = new QuakeMaterial('*lava1', 64, 64);

      lava.flags = MaterialFlags.MF_TURBULENT;
      MaterialBinder.Emit(lava, world);

      assert.equal(lava.currentAlpha, 1.0);
    });

    void test('is opaque for a liquid that is drawn for another entity than the world', () => {
      const water = new QuakeMaterial('*04water1', 64, 64);

      water.flags = MaterialFlags.MF_TURBULENT;
      MaterialBinder.Emit(water, door);

      assert.equal(water.currentAlpha, 1.0);
    });

    void test('is opaque for a surface that is not a liquid', () => {
      const wall = new QuakeMaterial('wall1', 64, 64);

      MaterialBinder.Emit(wall, world);

      assert.equal(wall.currentAlpha, 1.0);
    });

    void test('selects the animation frame from the entity frame and the client clock', () => {
      const material = new QuakeMaterial('+0wall', 64, 64);
      const frameA = createTexture('a', log);
      const frameB = createTexture('b', log);

      material.addAnimationFrame(0, frameA, null);
      material.addAnimationFrame(1, frameB, null);

      MaterialBinder.Emit(material, world);
      assert.equal(material.currentTexture, frameA);

      MaterialBinder.Emit(material, { frame: 1 } as unknown as ClientEdict);
      assert.equal(material.currentTexture, frameB);
    });
  });
});
