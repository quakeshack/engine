import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import type { GLRenderTexture } from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Lightmaps from '../../source/engine/client/renderer/lighting/Lightmaps.ts';
import { LIGHTMAP_BLOCK_HEIGHT, LIGHTMAP_BLOCK_SIZE } from '../../source/engine/client/renderer/lighting/LightmapAtlas.ts';
import { Face } from '../../source/engine/common/model/BaseModel.ts';
import { BrushModel } from '../../source/engine/common/model/BSP.ts';

const LAYER_STRIDE = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT;

interface Upload {
  readonly args: unknown[];
}

/**
 * Creates a face of one lightmap texel.
 * @param lightofs Offset of its light in the map's light data.
 * @param styles The lightstyles that light it.
 * @returns The face.
 */
function createFace(lightofs = 0, styles: number[] = [0]): Face {
  const face = new Face();

  face.lmshift = 4;
  face.extents = [0, 0];
  face.lightofs = lightofs;
  face.styles = styles;

  return face;
}

void describe('Lightmaps', () => {
  const previousContext = GL.gl;
  const previousTextures = [Lightmaps.lightmap_texture, Lightmaps.deluxemap_texture, Lightmaps.dlightmap_rgba_texture];
  const uploads2D: Upload[] = [];
  const uploads3D: Upload[] = [];
  const bound: string[] = [];

  before(() => {
    Lightmaps.Begin();
  });

  beforeEach(() => {
    uploads2D.length = 0;
    uploads3D.length = 0;
    bound.length = 0;

    const texture = (name: string) => ({ bind: () => { bound.push(name); } });

    Lightmaps.lightmap_texture = texture('lightmap') as unknown as typeof Lightmaps.lightmap_texture;
    Lightmaps.deluxemap_texture = texture('deluxemap') as unknown as typeof Lightmaps.deluxemap_texture;
    Lightmaps.dlightmap_rgba_texture = texture('dlightmap') as unknown as GLRenderTexture;

    GL.gl = {
      TEXTURE_2D: 1,
      TEXTURE_2D_ARRAY: 2,
      RGBA: 3,
      UNSIGNED_BYTE: 4,
      texSubImage2D: (...args: unknown[]) => { uploads2D.push({ args }); },
      texSubImage3D: (...args: unknown[]) => { uploads3D.push({ args }); },
    } as unknown as WebGL2RenderingContext;
    eventBus.publish('gl.ready');

    Lightmaps.lightmaps_rgb!.fill(0);
    Lightmaps.dlightmaps_rgba!.fill(0);
    Lightmaps.deluxemap = null;
    Lightmaps.allocated = new Array<number>(LIGHTMAP_BLOCK_SIZE).fill(0);
    Lightmaps.ResetModifiedRows();
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
    [Lightmaps.lightmap_texture, Lightmaps.deluxemap_texture, Lightmaps.dlightmap_rgba_texture] = previousTextures as [typeof Lightmaps.lightmap_texture, typeof Lightmaps.deluxemap_texture, GLRenderTexture];
  });

  void describe('Begin', () => {
    void test('allocates the three layers of baked light, the dynamic lightmap and an empty skyline', () => {
      assert.equal(Lightmaps.lightmaps_rgb!.length, LAYER_STRIDE * 3);
      assert.equal(Lightmaps.dlightmaps_rgba!.length, LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4);
      assert.equal(Lightmaps.allocated.length, LIGHTMAP_BLOCK_SIZE);
      assert.ok(Lightmaps.allocated.every((value) => value === 0));
    });
  });

  void describe('AddModel', () => {
    /**
     * Makes a brush model of the given faces.
     * @param name Model name; submodels of the world are called `*1`, `*2`, ...
     * @param faces The faces.
     * @returns The model.
     */
    function createModel(name: string, faces: Face[]): BrushModel {
      const model = new BrushModel(name);

      model.faces = faces;

      return model;
    }

    void test('copies monochrome light into all three layers and zeroes the unused lightstyle channels', () => {
      const model = createModel('maps/test.bsp', [createFace(0, [0])]);

      model.lightdata = new Uint8Array([77]);
      Lightmaps.lightmaps_rgb!.fill(9);

      Lightmaps.AddModel(model);

      for (let layer = 0; layer < 3; layer++) {
        const base = layer * LAYER_STRIDE;

        assert.equal(Lightmaps.lightmaps_rgb![base], 77, `layer ${layer} style 0`);
        assert.deepEqual([...Lightmaps.lightmaps_rgb!.subarray(base + 1, base + 4)], [0, 0, 0], `layer ${layer} styles 1 to 3`);
      }
    });

    void test('splits RGB light into the layers', () => {
      const model = createModel('maps/test.bsp', [createFace(0, [0])]);

      model.lightdata_rgb = new Uint8Array([10, 20, 30]);

      Lightmaps.AddModel(model);

      assert.deepEqual([0, 1, 2].map((layer) => Lightmaps.lightmaps_rgb![layer * LAYER_STRIDE]), [10, 20, 30]);
    });

    void test('places the texel where the face was allocated', () => {
      const first = createFace(0, [0]);
      const second = createFace(0, [0]);
      const model = createModel('maps/test.bsp', [first, second]);

      model.lightdata_rgb = new Uint8Array([10, 20, 30]);

      Lightmaps.AddModel(model);

      // two one-texel blocks side by side on the first row
      assert.deepEqual([first.light_s, first.light_t, second.light_s, second.light_t], [0, 0, 1, 0]);
      assert.equal(Lightmaps.lightmaps_rgb![(second.light_s << 2)], 10);
    });

    void test('leaves sky faces without a block', () => {
      const sky = createFace();

      sky.sky = true;
      sky.light_s = -1;
      sky.light_t = -1;

      const model = createModel('maps/test.bsp', [sky]);

      model.lightdata_rgb = new Uint8Array([1, 2, 3]);

      Lightmaps.AddModel(model);

      assert.deepEqual([sky.light_s, sky.light_t], [-1, -1]);
    });

    void test('skips submodels, their faces are part of the world', () => {
      const face = createFace();

      face.light_s = -1;

      const model = createModel('*1', [face]);

      model.lightdata_rgb = new Uint8Array([1, 2, 3]);

      Lightmaps.AddModel(model);

      assert.equal(face.light_s, -1);
    });
  });

  void describe('Upload', () => {
    void test('uploads the three layers of the baked light, and the deluxemap when the map has one', () => {
      Lightmaps.deluxemap = new Uint8Array(LAYER_STRIDE * 3);

      Lightmaps.Upload();

      assert.equal(uploads3D.length, 6);
      assert.deepEqual(uploads3D.slice(0, 3).map((upload) => upload.args[4]), [0, 1, 2], 'layers of the lightmap');
      assert.deepEqual(bound, ['lightmap', 'deluxemap']);
    });

    void test('uploads no deluxemap for a map without one', () => {
      Lightmaps.Upload();

      assert.equal(uploads3D.length, 3);
    });
  });

  void describe('dynamic lightmap', () => {
    void test('WriteDynamicBlock stores a byte per channel, clamped, and marks the rows of the block', () => {
      const face = createFace();

      face.light_s = 2;
      face.light_t = 5;

      // two texels: 128 * 10 = 1280 / 128 = 10, and far more than a byte can hold
      Lightmaps.WriteDynamicBlock(face, 2, 1, [1280, 2560, 0, 1000000, 128, 127]);

      const base = (5 * LIGHTMAP_BLOCK_SIZE + 2) * 4;

      assert.deepEqual([...Lightmaps.dlightmaps_rgba!.subarray(base, base + 3)], [10, 20, 0]);
      assert.deepEqual([...Lightmaps.dlightmaps_rgba!.subarray(base + 4, base + 7)], [255, 1, 0]);
      assert.equal(Lightmaps.lightmap_modified[5], 1);
      assert.equal(Lightmaps.lightmap_modified[4], 0);
    });

    void test('ClearDynamicBlock darkens a block and keeps it opaque', () => {
      const face = createFace();

      face.light_s = 0;
      face.light_t = 3;
      Lightmaps.dlightmaps_rgba!.fill(200, (3 * LIGHTMAP_BLOCK_SIZE) * 4, (3 * LIGHTMAP_BLOCK_SIZE) * 4 + 4);

      Lightmaps.ClearDynamicBlock(face, 1, 1);

      const base = (3 * LIGHTMAP_BLOCK_SIZE) * 4;

      assert.deepEqual([...Lightmaps.dlightmaps_rgba!.subarray(base, base + 4)], [0, 0, 0, 255]);
      assert.equal(Lightmaps.lightmap_modified[3], 1);
    });

    void test('UploadDynamic sends one range from the first to the last changed row', () => {
      Lightmaps.lightmap_modified[7] = 1;
      Lightmaps.lightmap_modified[20] = 1;

      Lightmaps.UploadDynamic();

      assert.equal(uploads2D.length, 1);
      assert.deepEqual(uploads2D[0].args.slice(1, 8), [0, 0, 7, LIGHTMAP_BLOCK_SIZE, 14, 3, 4]);
      assert.equal((uploads2D[0].args[8] as Uint8Array).length, 14 * LIGHTMAP_BLOCK_SIZE * 4);
    });

    void test('UploadDynamic sends nothing when no row changed, but still binds the texture', () => {
      Lightmaps.UploadDynamic();

      assert.equal(uploads2D.length, 0);
      assert.deepEqual(bound, ['dlightmap']);
    });

    void test('ResetModifiedRows forgets the changed rows', () => {
      Lightmaps.lightmap_modified[1] = 1;

      Lightmaps.ResetModifiedRows();

      assert.ok(Lightmaps.lightmap_modified.every((value) => value === 0));
    });

    void test('ResetDynamic darkens the buffer and uploads all of it', () => {
      Lightmaps.dlightmaps_rgba!.fill(99);

      Lightmaps.ResetDynamic();

      assert.ok(Lightmaps.dlightmaps_rgba!.every((value) => value === 0));
      assert.equal(uploads2D.length, 1);
      assert.deepEqual(uploads2D[0].args.slice(4, 6), [LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE]);
    });
  });

  void describe('Clear', () => {
    void test('drops the buffers and the skyline', () => {
      Lightmaps.deluxemap = new Uint8Array(1);

      const lightmaps = Lightmaps.lightmaps_rgb;
      const dlightmaps = Lightmaps.dlightmaps_rgba;

      Lightmaps.Clear();

      assert.equal(Lightmaps.lightmaps_rgb, null);
      assert.equal(Lightmaps.dlightmaps_rgba, null);
      assert.equal(Lightmaps.deluxemap, null);
      assert.deepEqual(Lightmaps.allocated, []);

      // the other tests of this file go on with the buffers
      Lightmaps.lightmaps_rgb = lightmaps;
      Lightmaps.dlightmaps_rgba = dlightmaps;
    });
  });
});
