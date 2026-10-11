import type { PostProcessColorShiftDescriptor } from '../../../../shared/GameInterfaces.ts';
import { eventBus } from '../../../common/EventBus.ts';
import GL, { type GLRenderTexture } from '../../GL.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import PostProcess from './PostProcess.ts';
import PostProcessEffect from './PostProcessEffect.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The tint that a run of entries mixes to: the color in 0 to 1 and how much of the view it covers.
 */
export interface MixedColorShift {
  readonly color: [number, number, number];
  readonly alpha: number;
}

/**
 * A tint over the whole view: damage, pickups, powerups, the color of the liquid the eye is in.
 *
 * Entries are layers. The ones that follow each other are mixed into one tint, in the order they are applied, with
 * the formula Quake always used (each layer is laid over the result of the ones before), scaled by the player's
 * `gl_cshiftpercent`, and drawn as one quad over the scene. `gl_polyblend` 0 draws none. Mixing is a function of
 * numbers, `ColorShiftEffect.mix`.
 */
export default class ColorShiftEffect extends PostProcessEffect {
  /** Nothing is tinted at an alpha of 0. The color is not listed: only the alpha carries the intensity. */
  override readonly neutral: PostProcessColorShiftDescriptor = { alpha: 0.0 };

  /** Over everything the renderer's own effects made of the scene, and under the HUD. */
  override readonly defaultStage = 'final';

  constructor() {
    super('color-shift');
    this.stackable = true;
  }

  /**
   * Mixes layers of a tint the way Quake does: `a = a + a2 * (1 - a)`, and the color is weighted by the share
   * `a2 / a` of the new coverage that the layer brings. The same as laying one layer after the other over the
   * scene with ordinary alpha blending.
   * @param layers The tints in the order they are applied.
   * @param percent How strongly all of them count, 1 for full strength.
   * @returns The mixed tint; its alpha is 0 when no layer covers anything.
   */
  static mix(layers: readonly PostProcessColorShiftDescriptor[], percent = 1.0): MixedColorShift {
    let r = 0.0;
    let g = 0.0;
    let b = 0.0;
    let a = 0.0;

    for (const layer of layers) {
      const a2 = (layer.alpha ?? 0.0) * percent;

      if (!(a2 > 0.0)) {
        continue;
      }

      a = a + a2 * (1.0 - a);

      const share = a2 / a;
      const color = layer.color;

      r = r * (1.0 - share) + (color?.[0] ?? 0.0) * share;
      g = g * (1.0 - share) + (color?.[1] ?? 0.0) * share;
      b = b * (1.0 - share) + (color?.[2] ?? 0.0) * share;
    }

    return { color: [r, g, b], alpha: Math.min(Math.max(a, 0.0), 1.0) };
  }

  static resolveSettings(settings: PostProcessColorShiftDescriptor): PostProcessColorShiftDescriptor {
    const color = settings.color;

    return {
      color: color !== undefined && Number.isFinite(color[0] + color[1] + color[2]) ? color : [0.0, 0.0, 0.0],
      alpha: Number.isFinite(settings.alpha ?? Number.NaN) ? settings.alpha : 0.0,
    };
  }

  override resolveSettings(settings: PostProcessColorShiftDescriptor): PostProcessColorShiftDescriptor {
    return ColorShiftEffect.resolveSettings(settings);
  }

  override combineSettings(settings: readonly PostProcessColorShiftDescriptor[]): MixedColorShift | null {
    if (rendererCvars.polyblend?.value === 0) {
      return null;
    }

    const percent = (rendererCvars.cshiftpercent?.value ?? 100) / 100.0;
    const mixed = ColorShiftEffect.mix(settings, percent);

    return mixed.alpha > 0.0 ? mixed : null;
  }

  override apply(inputTexture: GLRenderTexture, x: number, y: number, width: number, height: number, settings: MixedColorShift | null = null): void {
    // the scene as it is, then the tint over it
    PostProcess._blitToScreen(inputTexture, x, y, width, height);

    if (settings !== null && settings.alpha > 0.0) {
      const [r, g, b] = settings.color;
      const byte = (value: number): number => Math.min(Math.max(Math.round(value * 255.0), 0), 255);

      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      GL.UseProgram('fill', true);
      GL.StreamDrawColoredQuad(x, y, width, height, byte(r), byte(g), byte(b), byte(settings.alpha));
      GL.StreamFlush();
    }

    // the chain of passes draws without blending
    gl.disable(gl.BLEND);
  }
}
