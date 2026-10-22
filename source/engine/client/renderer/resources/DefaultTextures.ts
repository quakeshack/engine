import { eventBus } from '../../../common/EventBus.ts';
import GL, { GLRenderTexture, GLTexture, GLTextureArray } from '../../GL.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The small textures every other part of the renderer falls back to when it has nothing better: the checkerboard
 * for a missing texture, black and flat-normal stand-ins for missing material layers, a transparent texture to
 * unbind sampler units with, and the one-texel arrays that stand in for lightstyle and normal data.
 */
class DefaultTextures {
  /** Red and black checkerboard, shown for a surface whose texture is missing. */
  static notexture: GLTexture = null!;

  /** One opaque black texel, for a missing luminance or specular layer. */
  static blacktexture: GLTexture = null!;

  /** One texel pointing straight out of the surface, for a missing normal map. */
  static flatnormalmap: GLTexture = null!;

  /** One texel array with lightstyle 0 at full in all three layers. */
  static fullbright_texture: GLTextureArray = null!;

  /** One transparent texel. */
  static null_texture: GLRenderTexture = null!;

  /** One texel array with the normal pointing up. */
  static normal_up_texture: GLTextureArray = null!;

  /**
   * Creates the default textures and announces them with `renderer.textures.initialized`.
   */
  static Init(): void {
    // make a default texture (a red and black checkerboard)
    const data = new Uint8Array(new ArrayBuffer(256 * 4));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        data[((i << 4) + j) * 4 + 0] = 255;
        data[((i << 4) + j) * 4 + 1] = 0;
        data[((i << 4) + j) * 4 + 2] = 0;
        data[((i << 4) + j) * 4 + 3] = 255;

        data[(136 + (i << 4) + j) * 4 + 0] = 255;
        data[(136 + (i << 4) + j) * 4 + 1] = 0;
        data[(136 + (i << 4) + j) * 4 + 2] = 0;
        data[(136 + (i << 4) + j) * 4 + 3] = 255;

        data[(8 + (i << 4) + j) * 4 + 0] = 0;
        data[(8 + (i << 4) + j) * 4 + 1] = 0;
        data[(8 + (i << 4) + j) * 4 + 2] = 0;
        data[(8 + (i << 4) + j) * 4 + 3] = 255;

        data[(128 + (i << 4) + j) * 4 + 0] = 0;
        data[(128 + (i << 4) + j) * 4 + 1] = 0;
        data[(128 + (i << 4) + j) * 4 + 2] = 0;
        data[(128 + (i << 4) + j) * 4 + 3] = 255;
      }
    }

    DefaultTextures.notexture = GLTexture.Allocate('r_notexture', 16, 16, data);
    DefaultTextures.blacktexture = GLTexture.Allocate('r_blacktexture', 1, 1, new Uint8Array([0, 0, 0, 255]));
    DefaultTextures.flatnormalmap = GLTexture.Allocate('r_flatnormalmap', 1, 1, new Uint8Array([128, 128, 255, 255]));

    DefaultTextures.fullbright_texture = new GLTextureArray();
    DefaultTextures.fullbright_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      255, 0, 0, 0, // layer 0 (R): lightstyle 0 at full
      255, 0, 0, 0, // layer 1 (G): lightstyle 0 at full
      255, 0, 0, 0, // layer 2 (B): lightstyle 0 at full
    ]));

    DefaultTextures.null_texture = new GLRenderTexture();
    DefaultTextures.null_texture.bind(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    DefaultTextures.normal_up_texture = new GLTextureArray();
    DefaultTextures.normal_up_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      128, 0, 0, 0, // layer 0 (X): neutral
      255, 0, 0, 0, // layer 1 (Y): full (up direction)
      128, 0, 0, 0, // layer 2 (Z): neutral
    ]));

    eventBus.publish('renderer.textures.initialized');
  }
}

export default DefaultTextures;
