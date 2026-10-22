import { clientRuntimeState } from '../../ClientState.ts';
import rendererCvars from '../resources/RendererCvars.ts';

/**
 * How far between two steps of a stepped animation the client clock is, for the animations that the shaders blend
 * (texture frames and lightstyles). Both are 0 while `r_interpolation` is off, which shows the steps.
 */
export class Interpolation {
  /**
   * Returns interpolation for animated texture/material groups.
   * @returns The 0..1 interpolation factor for animated textures.
   */
  static Texture(): number {
    if (rendererCvars.interpolation.value === 0) {
      return 0.0;
    }

    return (clientRuntimeState.time % 0.2) / 0.2;
  }

  /**
   * Returns smoothed interpolation for 10 Hz lightstyle animation.
   * @returns The smoothed 0..1 lightstyle interpolation factor.
   */
  static Lightstyle(): number {
    if (rendererCvars.interpolation.value === 0) {
      return 0.0;
    }

    const linear = (clientRuntimeState.time * 10.0) % 1.0;

    return linear * linear * (3.0 - 2.0 * linear);
  }
}

export default Interpolation;
