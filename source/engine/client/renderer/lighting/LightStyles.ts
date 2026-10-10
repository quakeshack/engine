import { eventBus } from '../../../common/EventBus.ts';
import GL, { GLRenderTexture } from '../../GL.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import rendererCvars from '../resources/RendererCvars.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The lightstyles (flickering and pulsing lights) of the 64 style slots: their value for the current and the next
 * 10 Hz step, and the two one-row textures the brush and turbulent shaders read them from.
 */
export class LightStyles {
  /** Intensity per style for the current step, `a` is 0, `m` (12) is normal, `z` is 25. */
  static lightstylevalue_a = new Uint8Array(new ArrayBuffer(64));

  /** Intensity per style for the next step, the shaders blend between the two. */
  static lightstylevalue_b = new Uint8Array(new ArrayBuffer(64));

  /** {@link LightStyles.lightstylevalue_a} as a 64x1 texture. */
  static lightstyle_texture_a: GLRenderTexture = null!;

  /** {@link LightStyles.lightstylevalue_b} as a 64x1 texture. */
  static lightstyle_texture_b: GLRenderTexture = null!;

  /**
   * Creates the two lightstyle textures. Needs a GL context.
   */
  static Init(): void {
    LightStyles.lightstyle_texture_a = new GLRenderTexture();
    LightStyles.lightstyle_texture_a.bind(0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 64, 1);

    LightStyles.lightstyle_texture_b = new GLRenderTexture();
    LightStyles.lightstyle_texture_b.bind(0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 64, 1);
  }

  /**
   * Resets every style to normal brightness, as for a map without lightstyles.
   */
  static Clear(): void {
    for (let i = 0; i < 64; i++) {
      LightStyles.lightstylevalue_a[i] = 12;
      LightStyles.lightstylevalue_b[i] = 12;
    }
  }

  /**
   * Steps the styles to the client clock and uploads them to the textures. Every style is normal with `r_fullbright`.
   */
  static Animate(): void {
    if (rendererCvars.fullbright.value === 0) {
      const i = Math.floor(clientRuntimeState.time * 10.0);
      for (let j = 0; j < 64; j++) {
        const ls = clientRuntimeState.clientEntities.lightstyle[j];
        if (ls.length === 0) {
          LightStyles.lightstylevalue_a[j] = 12;
          LightStyles.lightstylevalue_b[j] = 12;
          continue;
        }
        LightStyles.lightstylevalue_a[j] = ls.charCodeAt(i % ls.length) - 97;
        LightStyles.lightstylevalue_b[j] = ls.charCodeAt((i + 1) % ls.length) - 97;
      }
    } else {
      for (let j = 0; j < 64; j++) {
        LightStyles.lightstylevalue_a[j] = 12;
        LightStyles.lightstylevalue_b[j] = 12;
      }
    }
    LightStyles.lightstyle_texture_a.bind(0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, LightStyles.lightstylevalue_a!);
    LightStyles.lightstyle_texture_b.bind(0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, LightStyles.lightstylevalue_b!);
  }
}

export default LightStyles;
