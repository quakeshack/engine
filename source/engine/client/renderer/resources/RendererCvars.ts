import Cvar from '../../../common/Cvar.ts';

/**
 * The console variables of the renderer: what it draws, how it lights it and what effects it adds. `register()`
 * creates them when the renderer starts, and everything that needs one reads it from here. The only thing this file
 * imports is `Cvar`, which cannot import it back, so reading a variable never depends on the order modules load in.
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

  /** `gamma`: brightness of the display, clamped to 0.5 to 1 when the frame's uniforms are written. */
  gamma: Cvar = null!;

  /** `gl_cshiftpercent`: how strongly the color shifts tint the view, in percent. */
  cshiftpercent: Cvar = null!;

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

  /** `r_refraction`: strength scale of the refraction of liquids and glass, 0 turns it off. */
  refraction: Cvar = null!;

  /** `r_refraction_distance`: how far away liquids and glass still refract, 0 for no limit. */
  refractionDistance: Cvar = null!;

  /**
   * Creates the variables, in the order `cvarlist` shows them. Called once by `R.Init()` when the renderer starts.
   */
  register(): void {
    this.waterwarp = new Cvar('r_waterwarp', '1');
    this.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
    this.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
    this.drawviewmodel = new Cvar('r_drawviewmodel', '1');
    this.drawturbulents = new Cvar('r_drawturbulents', '1', Cvar.FLAG.CHEAT);
    this.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    this.speeds = new Cvar('r_speeds', '0');
    this.polyblend = new Cvar('gl_polyblend', '1');
    this.cshiftpercent = new Cvar('gl_cshiftpercent', '100');
    this.gamma = new Cvar('gamma', '0.8', Cvar.FLAG.ARCHIVE | Cvar.FLAG.CHEAT); // CR: 1 is too dark
    this.flashblend = new Cvar('gl_flashblend', '0');
    this.nocolors = new Cvar('gl_nocolors', '0');
    this.bloom = new Cvar('r_bloom', '0', Cvar.FLAG.NONE, 'Screen-space bloom post-process, 0 = off, 1 = on.');
    this.bloomStrength = new Cvar('r_bloom_strength', '0.8', Cvar.FLAG.NONE, 'Additive bloom intensity.');
    this.bloomSkyStrength = new Cvar('r_bloom_sky_strength', '0.33', Cvar.FLAG.NONE, 'Sky contribution added to the bloom emissive target. Lower than 1 keeps the sky glow subtle.');
    this.bloomDlightStrength = new Cvar('r_bloom_dlight_strength', '0.33', Cvar.FLAG.NONE, 'Dynamic-light surface contribution added to the bloom emissive target. Set to 0 to disable.');
    this.bloomSpecularStrength = new Cvar('r_bloom_specular_strength', '0.33', Cvar.FLAG.NONE, 'Specular reflection contribution added to the bloom emissive target. Set to 0 to disable.');
    this.bloomDownsample = new Cvar('r_bloom_downsample', '4', Cvar.FLAG.NONE, 'Bloom buffer downsample divisor, clamped to 1-8.');
    this.bloomDebug = new Cvar('r_bloom_debug', '0', Cvar.FLAG.NONE, 'Bloom debug preview: 0 = off, 1 = emissive, 2 = extract, 3 = blur, 4 = all.');
    this.interpolation = new Cvar('r_interpolation', '1', Cvar.FLAG.NONE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');
    // fog controls (TODO: make that a cheat, but resetting cvar to default is done after Fog.NewMap, so need to rethink the order of operations)
    this.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.NONE, 'Fog color: R G B (0-255)');
    this.fog_start = new Cvar('r_fog_start', '128', Cvar.FLAG.NONE, 'Fog start distance (linear)');
    this.fog_end = new Cvar('r_fog_end', '4096', Cvar.FLAG.NONE, 'Fog end distance (linear)');
    this.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.NONE, 'Fog density (for exp/exp2)');
    this.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.NONE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

    // fog controls for underwater fog effect (post-process)
    this.underwater_fog_density = new Cvar('r_underwater_fog_density', '0.01', Cvar.FLAG.CHEAT, 'Fog density exponent for the underwater fog effect.');

    this.refraction = new Cvar('r_refraction', '1', Cvar.FLAG.CHEAT, 'Refraction of translucent liquids and glass that opt in: 0 = off, other values scale its strength.');
    this.refractionDistance = new Cvar('r_refraction_distance', '1024', Cvar.FLAG.ARCHIVE, 'Distance in units up to which liquids and glass refract, fading out before it; farther ones are blended, which saves a copy of the scene. 0 = no limit.');
  }
}

const rendererCvars = new RendererCvars();

export default rendererCvars;
