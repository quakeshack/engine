import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GLTexture } from '../../source/engine/client/GL.ts';
import { BaseMaterial, MaterialFlags, NoTextureMaterial, PBRMaterial, QuakeMaterial } from '../../source/engine/client/renderer/models/Materials.ts';

/**
 * Creates a texture stand-in that counts how often it was freed.
 * @returns The texture and its free counter.
 */
function createTexture(): { texture: GLTexture; freed: () => number } {
  let freed = 0;
  const texture = { free: () => { freed++; } } as unknown as GLTexture;

  return { texture, freed: () => freed };
}

// Nothing in this file installs a renderer or a GL context: the model loaders build these classes in a server
// worker, where there is neither.
void describe('QuakeMaterial', () => {
  void test('is built and freed without a renderer', () => {
    const material = new QuakeMaterial('wall1', 64, 32);

    assert.equal(material.name, 'wall1');
    assert.equal(material.width, 64);
    assert.equal(material.height, 32);
    assert.equal(material.texture, null);
    assert.equal(material.luminanceTexture, null);
    assert.equal(material.luminance, null);

    material.free();
  });

  void test('reports no texture for a frame that has none, so the renderer draws its fallback', () => {
    const material = new QuakeMaterial('wall1', 64, 64);

    assert.equal(material.currentTexture, null);
    assert.equal(material.nextTexture, null);
    assert.equal(material.currentLuminanceTexture, null);
  });

  void describe('selectFrame', () => {
    /**
     * Builds a material with the given number of animation frames.
     * @param frames Frame count.
     * @returns The material and its textures.
     */
    function animated(frames: number): { material: QuakeMaterial; textures: GLTexture[] } {
      const material = new QuakeMaterial('+0water', 64, 64);
      const textures: GLTexture[] = [];

      for (let i = 0; i < frames; i++) {
        textures.push(createTexture().texture);
        material.addAnimationFrame(i, textures[i]);
      }

      return { material, textures };
    }

    void test('advances five frames per second and wraps around', () => {
      const { material, textures } = animated(3);

      material.selectFrame(0, 0.0);
      assert.equal(material.currentTexture, textures[0]);
      assert.equal(material.nextTexture, textures[1]);

      // 0.2 s * 5 = frame 1
      material.selectFrame(0, 0.2);
      assert.equal(material.currentTexture, textures[1]);
      assert.equal(material.nextTexture, textures[2]);

      // 0.4 s * 5 = frame 2, the next frame wraps to 0
      material.selectFrame(0, 0.4);
      assert.equal(material.currentTexture, textures[2]);
      assert.equal(material.nextTexture, textures[0]);
    });

    void test('offsets the animation by the frame of the entity', () => {
      const { material, textures } = animated(3);

      material.selectFrame(0, 0.0);
      assert.equal(material.currentTexture, textures[0]);

      material.selectFrame(2, 0.0);
      assert.equal(material.currentTexture, textures[2]);
    });

    void test('shows the alternate animation for an entity with a frame above 0', () => {
      const { material, textures } = animated(2);
      const alternate = [createTexture().texture, createTexture().texture];

      material.addAlternateFrame(0, alternate[0]);
      material.addAlternateFrame(1, alternate[1]);

      material.selectFrame(0, 0.0);
      assert.equal(material.currentTexture, textures[0]);

      // the entity frame also advances the animation: floor(1 + 0) % 2 = 1
      material.selectFrame(1, 0.0);
      assert.equal(material.currentTexture, alternate[1]);
      assert.equal(material.nextTexture, alternate[0]);
    });

    void test('ignores the alternate animation when the material has none', () => {
      const { material, textures } = animated(2);

      material.selectFrame(1, 0.0);

      assert.equal(material.currentTexture, textures[1]);
    });

    void test('selects the luminance texture of the same frame', () => {
      const material = new QuakeMaterial('+0lava', 64, 64);
      const luminance = createTexture().texture;

      material.addAnimationFrame(0, createTexture().texture, null);
      material.addAnimationFrame(1, createTexture().texture, luminance);

      material.selectFrame(0, 0.0);
      assert.equal(material.currentLuminanceTexture, null);

      material.selectFrame(0, 0.2);
      assert.equal(material.currentLuminanceTexture, luminance);
    });
  });

  void describe('free', () => {
    void test('frees every texture and luminance texture it holds', () => {
      const material = new QuakeMaterial('wall1', 64, 64);
      const diffuse = [createTexture(), createTexture()];
      const luminance = createTexture();

      material.addAnimationFrame(0, diffuse[0].texture, luminance.texture);
      material.addAnimationFrame(1, diffuse[1].texture, null);
      material.free();

      assert.equal(diffuse[0].freed(), 1);
      assert.equal(diffuse[1].freed(), 1);
      assert.equal(luminance.freed(), 1);
      assert.equal(material.texture, null);
    });
  });
});

void describe('PBRMaterial', () => {
  void test('has no layers until they are loaded, and is built without a renderer', () => {
    const material = new PBRMaterial('pbr', 128, 128);

    assert.equal(material.diffuse, null);
    assert.equal(material.specular, null);
    assert.equal(material.normal, null);
    assert.equal(material.luminance, null);
  });

  void test('frees the layers it has and skips the ones it does not', () => {
    const material = new PBRMaterial('pbr', 128, 128);
    const diffuse = createTexture();
    const normal = createTexture();

    material.diffuse = diffuse.texture;
    material.normal = normal.texture;
    material.free();

    assert.equal(diffuse.freed(), 1);
    assert.equal(normal.freed(), 1);
  });
});

void describe('BaseMaterial.getLiquidAlphaKeys', () => {
  void test('names the worldspawn keys by the liquid in the material name', () => {
    assert.deepEqual(new BaseMaterial('*lava1', 64, 64).getLiquidAlphaKeys(), ['_lavaalpha', 'lavaalpha']);
    assert.deepEqual(new BaseMaterial('*slime0', 64, 64).getLiquidAlphaKeys(), ['_slimealpha', 'slimealpha']);
    assert.deepEqual(new BaseMaterial('*teleport', 64, 64).getLiquidAlphaKeys(), ['_telealpha', 'telealpha', '_teleportalpha', 'teleportalpha']);
    assert.deepEqual(new BaseMaterial('*04water1', 64, 64).getLiquidAlphaKeys(), ['_wateralpha', 'wateralpha']);
  });
});

void describe('NoTextureMaterial', () => {
  void test('is a plain material that the renderer recognizes by its class', () => {
    const material = new NoTextureMaterial();

    assert.equal(material.name, 'notexture');
    assert.equal(material.flags, MaterialFlags.MF_NONE);
  });
});
