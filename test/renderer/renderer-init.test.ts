import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import R from '../../source/engine/client/R.ts';
import GL from '../../source/engine/client/GL.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import Particles from '../../source/engine/client/renderer/effects/Particles.ts';
import Decals from '../../source/engine/client/renderer/effects/Decals.ts';
import ShadowMap from '../../source/engine/client/renderer/lighting/ShadowMap.ts';
import Lightmaps from '../../source/engine/client/renderer/lighting/Lightmaps.ts';
import LightStyles from '../../source/engine/client/renderer/lighting/LightStyles.ts';
import ShaderPrograms from '../../source/engine/client/renderer/programs/ShaderPrograms.ts';
import DefaultTextures from '../../source/engine/client/renderer/resources/DefaultTextures.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { modelRendererRegistry } from '../../source/engine/client/renderer/models/ModelRendererRegistry.ts';
import type PostProcessEffect from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';

/**
 * A stand-in for a WebGL context that creates objects for anything asked of it.
 * @returns The stand-in.
 */
function createFakeContext(): WebGL2RenderingContext {
  return new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

void describe('R.Init', () => {
  const previousContext = GL.gl;
  const previousVars = new Set(Object.keys(Cvar._vars));

  afterEach(() => {
    mock.restoreAll();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
    modelRendererRegistry.clear();

    for (const name of Object.keys(Cvar._vars)) {
      if (!previousVars.has(name)) {
        delete Cvar._vars[name];
      }
    }
  });

  /**
   * Runs `R.Init()` with everything that needs a real GL context replaced, and records what it did in order.
   * @returns The ordered steps and the names of the cvars it created, in creation order.
   */
  async function runInit(): Promise<{ steps: string[]; cvars: string[] }> {
    const steps: string[] = [];

    GL.gl = createFakeContext();
    mock.method(GL, 'CreateVAO', () => ({}) as WebGLVertexArrayObject);
    eventBus.publish('gl.ready');

    mock.method(DefaultTextures, 'Init', () => { steps.push('default textures'); });
    mock.method(Lightmaps, 'Init', () => { steps.push('lightmaps'); });
    mock.method(LightStyles, 'Init', () => { steps.push('lightstyles'); });
    mock.method(Particles, 'Init', () => { steps.push('particles'); });
    mock.method(Decals, 'Init', () => { steps.push('decals'); });
    mock.method(ShaderPrograms, 'Init', () => {
      steps.push('shaders');

      return Promise.resolve();
    });
    mock.method(PostProcess, 'init', () => { steps.push('postprocess'); });
    mock.method(PostProcess, 'addEffect', (effect: PostProcessEffect) => { steps.push(`effect ${effect.name}`); });
    mock.method(ShadowMap, 'init', () => { steps.push('shadowmap'); });
    mock.method(R, 'ClearAll', () => { steps.push('clear'); });
    mock.method(modelRendererRegistry, 'register', (renderer: object) => { steps.push(`renderer ${renderer.constructor.name}`); });

    await R.Init();

    return {
      steps,
      cvars: Object.keys(Cvar._vars).filter((name) => !previousVars.has(name)),
    };
  }

  void test('creates the console variables in a fixed order, which `cvarlist` shows', async () => {
    const { cvars } = await runInit();

    assert.deepEqual(cvars, [
      'r_waterwarp',
      'r_fullbright',
      'r_drawentities',
      'r_drawviewmodel',
      'r_drawturbulents',
      'r_novis',
      'r_speeds',
      'gl_polyblend',
      'gl_flashblend',
      'gl_nocolors',
      'r_bloom',
      'r_bloom_strength',
      'r_bloom_sky_strength',
      'r_bloom_dlight_strength',
      'r_bloom_specular_strength',
      'r_bloom_downsample',
      'r_bloom_debug',
      'r_interpolation',
      'r_fog_color',
      'r_fog_start',
      'r_fog_end',
      'r_fog_density',
      'r_fog_mode',
      'r_underwater_fog_density',
    ]);
  });

  void test('sets up resources, then model renderers, then the effect stack, then the shadow map', async () => {
    const { steps } = await runInit();

    assert.deepEqual(steps, [
      'default textures',
      'lightmaps',
      'lightstyles',
      'particles',
      'decals',
      'shaders',
      'renderer BrushModelRenderer',
      'renderer AliasModelRenderer',
      'renderer SpriteModelRenderer',
      'renderer MeshModelRenderer',
      'postprocess',
      // the order effects are registered in is the order they resolve in
      'effect bloom',
      'effect underwater-fog',
      'effect warp',
      'effect color-grade',
      'effect blur',
      'shadowmap',
      'clear',
    ]);
  });

  void test('exposes the created console variables where the renderer reads them', async () => {
    await runInit();

    assert.equal(rendererCvars.bloom.name, 'r_bloom');
    assert.equal(rendererCvars.fog_mode.string, '-1');
    assert.equal(rendererCvars.drawentities.value, 1);
  });
});
