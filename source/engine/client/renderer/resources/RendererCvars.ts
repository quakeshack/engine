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

  /** `gl_flashblend`: draw dynamic lights as coronas instead of lighting the surfaces they reach. */
  flashblend: Cvar = null!;

  /** `r_novis`: 0 uses the PVS, 1 reveals every leaf, 2 uses the PHS, a cheat. */
  novis: Cvar = null!;

  /** `r_fog_color`: global fog color as "R G B" in the 0 to 255 range. */
  fog_color: Cvar = null!;

  /** `r_fog_start`: distance where linear fog begins. */
  fog_start: Cvar = null!;

  /** `r_fog_end`: distance where linear fog is opaque. */
  fog_end: Cvar = null!;

  /** `r_fog_density`: density of exponential fog. */
  fog_density: Cvar = null!;

  /** `r_fog_mode`: 0 linear, 1 exp, 2 exp2, -1 off. */
  fog_mode: Cvar = null!;
}

const rendererCvars = new RendererCvars();

export default rendererCvars;
