import type Cvar from '../../../common/Cvar.ts';

/**
 * The console variables of the renderer: what it draws, how it lights it and what effects it adds. They are
 * created by `R.Init()` when the renderer starts, and read from here by everything that needs them. Nothing in
 * this file imports anything that could import it back, so reading a variable never depends on the order
 * modules load in.
 */
export class RendererCvars {
  /** `r_fullbright`: ignore lightstyles and lightmaps, a cheat. */
  fullbright: Cvar = null!;

  /** `r_interpolation`: interpolate animated textures and lightstyles between their steps. */
  interpolation: Cvar = null!;
}

const rendererCvars = new RendererCvars();

export default rendererCvars;
