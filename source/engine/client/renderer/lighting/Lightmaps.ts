import { eventBus } from '../../../common/EventBus.ts';
import { BrushModel } from '../../../common/model/BSP.ts';
import type { Face } from '../../../common/model/BaseModel.ts';
import GL, { GLRenderTexture, GLTextureArray } from '../../GL.ts';
import { LIGHTMAP_BLOCK_HEIGHT, LIGHTMAP_BLOCK_SIZE } from './LightmapAtlas.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The lightmap atlas of the current map: the baked light of every face packed into one set of textures (the
 * layers are R, G and B, the four channels hold the four lightstyles of a face), the deluxemap that goes with it
 * and the dynamic lightmap that dynamic lights are added to.
 */
export class Lightmaps {
  /** The skyline of the atlas: how far each column is filled. */
  static allocated: number[] = [];

  /** CPU copy of the baked lightmaps, allocated by {@link Lightmaps.Begin}. */
  static lightmaps_rgb: Uint8Array | null = null;

  /** CPU copy of the dynamic lightmap, allocated by {@link Lightmaps.Begin}. */
  static dlightmaps_rgba: Uint8Array | null = null;

  /** CPU copy of the deluxemap (light directions), allocated when the first map with one is built. */
  static deluxemap: Uint8Array | null = null;

  /** Which rows of the dynamic lightmap changed since {@link Lightmaps.ResetModifiedRows}. */
  static lightmap_modified = new Uint8Array(LIGHTMAP_BLOCK_SIZE);

  static deluxemap_texture: GLTextureArray = null!;
  static lightmap_texture: GLTextureArray = null!;
  static dlightmap_rgba_texture: GLRenderTexture = null!;

  /**
   * Creates the three atlas textures. Needs a GL context.
   */
  static Init(): void {
    Lightmaps.deluxemap_texture = new GLTextureArray();
    Lightmaps.deluxemap_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    Lightmaps.lightmap_texture = new GLTextureArray();
    Lightmaps.lightmap_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    Lightmaps.dlightmap_rgba_texture = new GLRenderTexture();
    Lightmaps.dlightmap_rgba_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE);
  }

  /**
   * Starts building the atlas of a map: empties the skyline and allocates the CPU buffers. Follow with
   * {@link Lightmaps.AddModel} for each model and {@link Lightmaps.Upload}.
   */
  static Begin(): void {
    Lightmaps.allocated = (new Array<number>(LIGHTMAP_BLOCK_SIZE)).fill(0);

    Lightmaps.lightmaps_rgb = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    Lightmaps.dlightmaps_rgba = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4));
  }

  /**
   * Gives every lit face of a model its place in the atlas and copies its baked light there. Submodels (`*1`, ...)
   * are skipped, their faces are part of the world model.
   * @param model The brush model.
   */
  static AddModel(model: BrushModel): void {
    if (model.name[0] === '*') {
      return;
    }

    for (let j = 0; j < model.faces.length; j++) {
      const surf = model.faces[j];
      if (!surf.sky) {
        Lightmaps.AllocBlock(surf);
        if (model.lightdata_rgb !== null) {
          Lightmaps.BuildLightMapEx(model, surf);
        } else if (model.lightdata !== null) {
          Lightmaps.BuildLightMap(model, surf);
        }
      }
    }
  }

  /**
   * Uploads the baked lightmaps and the deluxemap that {@link Lightmaps.AddModel} collected to their textures.
   */
  static Upload(): void {
    const layerBytes = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4;
    Lightmaps.lightmap_texture.bind(0);
    for (let k = 0; k < 3; k++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, Lightmaps.lightmaps_rgb!.subarray(k * layerBytes, (k + 1) * layerBytes));
    }

    Lightmaps.deluxemap_texture.bind(0);
    if (Lightmaps.deluxemap) {
      for (let k = 0; k < 3; k++) {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, Lightmaps.deluxemap.subarray(k * layerBytes, (k + 1) * layerBytes));
      }
    }
  }

  /**
   * Makes the dynamic lightmap dark, in memory and in its texture. Done when a map is loaded.
   */
  static ResetDynamic(): void {
    const dlightmapsRgba = Lightmaps.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    for (let i = 0; i < dlightmapsRgba.length; i++) {
      dlightmapsRgba[i] = 0;
    }

    Lightmaps.dlightmap_rgba_texture.bind(0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba);
  }

  /**
   * Drops the CPU buffers, as when the client disconnects.
   */
  static Clear(): void {
    Lightmaps.deluxemap = null;
    Lightmaps.lightmaps_rgb = null;
    Lightmaps.dlightmaps_rgba = null;

    Lightmaps.allocated = [];
  }

  /**
   * Starts a frame of dynamic light updates: no row of the dynamic lightmap is marked as changed.
   */
  static ResetModifiedRows(): void {
    Lightmaps.lightmap_modified.fill(0);
  }

  /**
   * Writes the light that dynamic lights add to a face into its block of the dynamic lightmap.
   * @param surf The face.
   * @param smax Width of the face's block in texels.
   * @param tmax Height of the face's block in texels.
   * @param blocklights Summed light of the face, three values per texel, 256 times the channel value times 128.
   */
  static WriteDynamicBlock(surf: Face, smax: number, tmax: number, blocklights: number[]): void {
    const dlightmapsRgba = Lightmaps.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    for (let t = 0, i = 0; t < tmax; t++) {
      Lightmaps.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        const blrgb = [
          Math.min(Math.floor(blocklights[i * 3] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 1] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 2] / 128), 255),
        ];
        i++;
        for (let channel = 0; channel < 3; channel++) {
          dlightmapsRgba[dldest + channel] = blrgb[channel];
        }
      }
    }
  }

  /**
   * Clears a face's block of the dynamic lightmap, fully opaque and without light.
   * @param surf The face.
   * @param smax Width of the face's block in texels.
   * @param tmax Height of the face's block in texels.
   */
  static ClearDynamicBlock(surf: Face, smax: number, tmax: number): void {
    const dlightmapsRgba = Lightmaps.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    for (let t = 0; t < tmax; t++) {
      Lightmaps.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        for (let i = 0; i < 3; i++) {
          dlightmapsRgba[dldest + i] = 0;
        }
        dlightmapsRgba[dldest + 3] = 255; // fully opaque
      }
    }
  }

  /**
   * Uploads the rows of the dynamic lightmap that changed since {@link Lightmaps.ResetModifiedRows}, in one
   * call covering the first to the last of them.
   */
  static UploadDynamic(): void {
    Lightmaps.dlightmap_rgba_texture.bind(0);

    const modified = Lightmaps.lightmap_modified;
    const first = modified.indexOf(1);

    if (first === -1) {
      return;
    }

    const last = modified.lastIndexOf(1);
    const dlightmapsRgba = Lightmaps.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, LIGHTMAP_BLOCK_SIZE, last - first + 1, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba.subarray(first * LIGHTMAP_BLOCK_SIZE * 4, (last + 1) * LIGHTMAP_BLOCK_SIZE * 4));
  }

  static BuildLightMap(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = Lightmaps.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdata = currentmodel.lightdata!;
    console.assert(lightdata !== null, 'brush lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdata[lightmap + j];
          }
          lightmap += smax;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  }

  static BuildLightMapEx(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = Lightmaps.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdataRgb = currentmodel.lightdata_rgb!;
    console.assert(lightdataRgb !== null, 'brush rgb lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    if (currentmodel.deluxemap && !Lightmaps.deluxemap) {
      Lightmaps.deluxemap = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    }

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs * 3;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdataRgb[(lightmap + j * 3) + k];

            if (currentmodel.deluxemap) {
              Lightmaps.deluxemap![dest + (j << 2) + offset] = currentmodel.deluxemap[(lightmap + j * 3) + k];
            }
          }
          lightmap += smax * 3;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;

            if (currentmodel.deluxemap) {
              Lightmaps.deluxemap![dest + (j << 2) + offset] = 0;
            }
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  }

  static AllocBlock(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const w = (surf.extents[0] >> lmshift) + 1;
    const h = (surf.extents[1] >> lmshift) + 1;
    let x = 0; let y = 0; let i; let j; let best = LIGHTMAP_BLOCK_SIZE; let best2;
    for (i = 0; i < (LIGHTMAP_BLOCK_SIZE - w); i++) {
      best2 = 0;
      for (j = 0; j < w; j++) {
        if (Lightmaps.allocated[i + j] >= best) {
          break;
        }
        if (Lightmaps.allocated[i + j] > best2) {
          best2 = Lightmaps.allocated[i + j];
        }
      }
      if (j === w) {
        x = i;
        y = best = best2;
      }
    }
    best += h;
    if (best > LIGHTMAP_BLOCK_SIZE) {
      throw new Error('Lightmaps.AllocBlock: full');
    }
    for (i = 0; i < w; i++) {
      Lightmaps.allocated[x + i] = best;
    }
    surf.light_s = x;
    surf.light_t = y;
  }
}

export default Lightmaps;
