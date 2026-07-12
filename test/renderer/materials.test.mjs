import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import { MaterialFlags, QuakeMaterial, resolveMaterialLuminanceTexture } from '../../source/engine/client/renderer/Materials.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * A minimal {@link import('../../source/engine/client/GL.ts').GLTexture} stub
 * that records which texture unit indices it was bound to.
 * @param {string} name debug label, unused by the stub itself
 * @returns {import('../../source/engine/client/GL.ts').GLTexture & {boundTargets: number[]}} texture stub
 */
function createTextureStub(name) {
  return /** @type {import('../../source/engine/client/GL.ts').GLTexture & {boundTargets: number[]}} */ ({
    name,
    boundTargets: [],
    bind(target) {
      this.boundTargets.push(target);
    },
    free() {},
  });
}

/**
 * Installs a mocked WebGL context and renderer registry (`R`) so
 * `QuakeMaterial.bindTo()` can run outside a real browser, then restores
 * both afterward.
 * @param {(textures: {flatNormal: ReturnType<typeof createTextureStub>, blackTexture: ReturnType<typeof createTextureStub>, noTexture: ReturnType<typeof createTextureStub>}, uniformCalls: unknown[][]) => void} callback test body
 */
function withMockMaterialRenderer(callback) {
  const uniformCalls = [];
  const mockGl = {
    uniform1i(location, value) { uniformCalls.push([location, value]); },
    uniform1f() {},
  };

  const flatNormal = createTextureStub('flatnormal');
  const blackTexture = createTextureStub('black');
  const noTexture = createTextureStub('notexture');

  const previousR = registry.R;
  const previousGl = GL.gl;

  registry.R = /** @type {typeof import('../../source/engine/client/R.ts').default} */ ({
    blacktexture: blackTexture,
    notexture: noTexture,
    flatnormalmap: flatNormal,
    interpolation: { value: false },
    c_brush_texture_binds: 0,
  });
  GL.gl = /** @type {WebGL2RenderingContext} */ (mockGl);
  eventBus.publish('gl.ready');
  eventBus.publish('registry.frozen');

  try {
    callback({ flatNormal, blackTexture, noTexture }, uniformCalls);
  } finally {
    registry.R = previousR;
    GL.gl = previousGl;
    eventBus.publish('gl.shutdown');
    if (previousGl) {
      eventBus.publish('gl.ready');
    }
    eventBus.publish('registry.frozen');
  }
}

void describe('resolveMaterialLuminanceTexture', () => {
  void test('keeps the explicit luminance texture when one is present', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const luminanceTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, luminanceTexture, diffuseTexture, fallbackTexture),
      luminanceTexture,
    );
  });

  void test('uses the diffuse texture as luminance for MF_FULLBRIGHT materials without an emissive map', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, fallbackTexture, diffuseTexture, fallbackTexture),
      diffuseTexture,
    );
  });

  void test('falls back to the renderer black texture for non-fullbright materials without emissive data', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_NONE, null, diffuseTexture, fallbackTexture),
      fallbackTexture,
    );
  });
});

void describe('QuakeMaterial.bindTo', () => {
  void test('keeps dot lighting disabled and leaves normal/specular unbound without a deluxemap', () => {
    withMockMaterialRenderer(({ flatNormal, blackTexture }, uniformCalls) => {
      const material = new QuakeMaterial('wall1', 64, 64);
      const program = /** @type {import('../../source/engine/client/GL.ts').GLProgramInfo} */ ({
        uPerformDotLighting: 'uPerformDotLighting',
        uInterpolation: 'uInterpolation',
        tTextureA: 0,
        tTextureB: 1,
        tLuminance: 2,
        tNormal: 3,
        tSpecular: 4,
      });

      material.bindTo(program, false);

      assert.deepEqual(uniformCalls, [['uPerformDotLighting', 0]]);
      assert.deepEqual(flatNormal.boundTargets, []);
      // The black texture is still bound once, as the luminance fallback (target 2) — just not to tSpecular (target 4).
      assert.deepEqual(blackTexture.boundTargets, [2]);
    });
  });

  void test('enables dot lighting and binds a flat normal / black specular when the model has a deluxemap', () => {
    withMockMaterialRenderer(({ flatNormal, blackTexture }, uniformCalls) => {
      const material = new QuakeMaterial('wall1', 64, 64);
      const program = /** @type {import('../../source/engine/client/GL.ts').GLProgramInfo} */ ({
        uPerformDotLighting: 'uPerformDotLighting',
        uInterpolation: 'uInterpolation',
        tTextureA: 0,
        tTextureB: 1,
        tLuminance: 2,
        tNormal: 3,
        tSpecular: 4,
      });

      material.bindTo(program, true);

      assert.deepEqual(uniformCalls, [['uPerformDotLighting', 1]]);
      assert.deepEqual(flatNormal.boundTargets, [3]);
      // Luminance fallback (target 2) and the specular fallback (target 4) are distinct binds of the same texture.
      assert.deepEqual(blackTexture.boundTargets, [2, 4]);
    });
  });

  void test('defaults to dot lighting disabled when no deluxemap flag is passed', () => {
    withMockMaterialRenderer(({ flatNormal }, uniformCalls) => {
      const material = new QuakeMaterial('wall1', 64, 64);
      const program = /** @type {import('../../source/engine/client/GL.ts').GLProgramInfo} */ ({
        uPerformDotLighting: 'uPerformDotLighting',
      });

      material.bindTo(program);

      assert.deepEqual(uniformCalls, [['uPerformDotLighting', 0]]);
      assert.deepEqual(flatNormal.boundTargets, []);
    });
  });
});
