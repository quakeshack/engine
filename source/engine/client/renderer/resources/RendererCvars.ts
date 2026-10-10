import type Cvar from '../../../common/Cvar.ts';

/**
 * The console variables of the renderer: what it draws, how it lights it and what effects it adds. They are
 * created by `R.Init()` when the renderer starts (the creation order is what `cvarlist` shows), and read from
 * here by everything that needs them. Nothing in
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

  /** `r_waterwarp`: distort the view while the camera is inside a liquid. */
  waterwarp: Cvar = null!;

  /** `r_drawentities`: draw entities at all, a cheat. */
  drawentities: Cvar = null!;

  /** `r_drawviewmodel`: draw the weapon model in front of the view. */
  drawviewmodel: Cvar = null!;

  /** `r_drawturbulents`: draw liquid surfaces, a cheat. */
  drawturbulents: Cvar = null!;

  /** `r_underwater_fog_density`: density exponent of the underwater fog effect, a cheat. */
  underwater_fog_density: Cvar = null!;

  /** `r_speeds`: show draw call and frame time statistics. */
  speeds: Cvar = null!;

  /** `gl_polyblend`: tint the whole view with the damage, pickup and liquid color. */
  polyblend: Cvar = null!;

  /** `gl_nocolors`: do not apply the player's shirt and pants colors to other players. */
  nocolors: Cvar = null!;

  /** `r_bloom`: screen-space bloom post-process. */
  bloom: Cvar = null!;

  /** `r_bloom_strength`: additive bloom intensity. */
  bloomStrength: Cvar = null!;

  /** `r_bloom_sky_strength`: sky contribution to the bloom emissive target. */
  bloomSkyStrength: Cvar = null!;

  /** `r_bloom_dlight_strength`: dynamic-light surface contribution to the bloom emissive target. */
  bloomDlightStrength: Cvar = null!;

  /** `r_bloom_specular_strength`: specular reflection contribution to the bloom emissive target. */
  bloomSpecularStrength: Cvar = null!;

  /** `r_bloom_downsample`: bloom buffer downsample divisor. */
  bloomDownsample: Cvar = null!;

  /** `r_bloom_debug`: bloom debug preview mode. */
  bloomDebug: Cvar = null!;
}

const rendererCvars = new RendererCvars();

export default rendererCvars;
