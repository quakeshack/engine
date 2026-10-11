import Cvar from '../../common/Cvar.ts';

/**
 * The console variables of the view: the field of view and the size of the 3D view on the screen, the walking
 * bob, the roll into a strafe, the kick of a hit, the idle sway, the pitch drift back to level. `register()`
 * creates them, and everything that needs one reads it from here. The only thing this file imports is `Cvar`,
 * which cannot import it back, so reading a variable never depends on the order modules load in.
 */
export class ViewCvars {
  /** `fov`: horizontal field of view in degrees, 10 to 170, a cheat. */
  fov: Cvar = null!;

  /** `viewsize`: size of the 3D view on the screen, 30 to 120, where 120 is the whole screen without a status bar. */
  viewsize: Cvar = null!;

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

  /**
   * Creates the variables, in the order `cvarlist` shows them. Called once by `FirstPersonView.Init()`, early enough
   * for everything that can ask for them, an in-thread server included.
   */
  register(): void {
    this.fov = new Cvar('fov', '90', Cvar.FLAG.CHEAT);
    this.viewsize = new Cvar('viewsize', '120', Cvar.FLAG.ARCHIVE);
    this.centermove = new Cvar('v_centermove', '0.15');
    this.centerspeed = new Cvar('v_centerspeed', '500');
    this.iyaw_cycle = new Cvar('v_iyaw_cycle', '2');
    this.iroll_cycle = new Cvar('v_iroll_cycle', '0.5');
    this.ipitch_cycle = new Cvar('v_ipitch_cycle', '1');
    this.iyaw_level = new Cvar('v_iyaw_level', '0.3');
    this.iroll_level = new Cvar('v_iroll_level', '0.1');
    this.ipitch_level = new Cvar('v_ipitch_level', '0.3');
    this.idlescale = new Cvar('v_idlescale', '0');
    this.ofsx = new Cvar('scr_ofsx', '0');
    this.ofsy = new Cvar('scr_ofsy', '0');
    this.ofsz = new Cvar('scr_ofsz', '0');
    this.rollspeed = new Cvar('cl_rollspeed', '200');
    this.rollangle = new Cvar('cl_rollangle', '2.0');
    this.bob = new Cvar('cl_bob', '0.02');
    this.bobcycle = new Cvar('cl_bobcycle', '0.6');
    this.bobup = new Cvar('cl_bobup', '0.5');
    this.kicktime = new Cvar('v_kicktime', '0.5');
    this.kickroll = new Cvar('v_kickroll', '0.6');
    this.kickpitch = new Cvar('v_kickpitch', '0.6');
    this.pitchdrift = new Cvar('v_pitchdrift', '1', Cvar.FLAG.ARCHIVE, 'Vanilla Quake drift pitch when moving forward.');
  }
}

const viewCvars = new ViewCvars();

export default viewCvars;
