import type Cvar from '../../common/Cvar.ts';

/**
 * The console variables of the first-person view: the walking bob, the roll into a strafe, the kick of a hit, the
 * idle sway, the pitch drift back to level. They are created by `FirstPersonView.Init()`, and read from here by
 * everything that needs them. Nothing in this file imports anything that could import it back, so reading a
 * variable never depends on the order modules load in.
 */
export class ViewCvars {
  /** `v_centermove`: seconds of walking forward at full speed before the view drifts back to level. */
  centermove: Cvar = null!;

  /** `v_centerspeed`: how fast the pitch drifts back to level, in degrees per second squared. */
  centerspeed: Cvar = null!;

  /** `v_iyaw_cycle`: speed of the idle yaw sway. */
  iyaw_cycle: Cvar = null!;

  /** `v_iroll_cycle`: speed of the idle roll sway. */
  iroll_cycle: Cvar = null!;

  /** `v_ipitch_cycle`: speed of the idle pitch sway. */
  ipitch_cycle: Cvar = null!;

  /** `v_iyaw_level`: size of the idle yaw sway in degrees. */
  iyaw_level: Cvar = null!;

  /** `v_iroll_level`: size of the idle roll sway in degrees. */
  iroll_level: Cvar = null!;

  /** `v_ipitch_level`: size of the idle pitch sway in degrees. */
  ipitch_level: Cvar = null!;

  /** `v_idlescale`: how much of the idle sway shows, 0 for none. */
  idlescale: Cvar = null!;

  /** `scr_ofsx`: offset of the eye along the player's forward axis. */
  ofsx: Cvar = null!;

  /** `scr_ofsy`: offset of the eye along the player's right axis. */
  ofsy: Cvar = null!;

  /** `scr_ofsz`: offset of the eye along the player's up axis. */
  ofsz: Cvar = null!;

  /** `cl_rollspeed`: sideways speed at which the view rolls by `cl_rollangle`. */
  rollspeed: Cvar = null!;

  /** `cl_rollangle`: roll of the view at `cl_rollspeed`, in degrees. */
  rollangle: Cvar = null!;

  /** `cl_bob`: strength of the walking bob, 0 for none. */
  bob: Cvar = null!;

  /** `cl_bobcycle`: seconds one step of the bob takes. */
  bobcycle: Cvar = null!;

  /** `cl_bobup`: share of the bob cycle that goes up. */
  bobup: Cvar = null!;

  /** `v_kicktime`: seconds the kick of a hit lasts. */
  kicktime: Cvar = null!;

  /** `v_kickroll`: roll of the kick of a hit per point of damage. */
  kickroll: Cvar = null!;

  /** `v_kickpitch`: pitch of the kick of a hit per point of damage. */
  kickpitch: Cvar = null!;

  /** `v_pitchdrift`: let the view drift back to level while walking forward, as Quake does. */
  pitchdrift: Cvar = null!;
}

const viewCvars = new ViewCvars();

export default viewCvars;
