import Cvar from '../common/Cvar.ts';

/**
 * The console variables of the client: how the player moves, looks and what the client shows. `register()` creates
 * them when the client starts, and everything that needs one reads it from here. The only thing this file imports
 * is `Cvar`, which cannot import it back, so reading a variable never depends on the order modules load in.
 */
export class ClientCvars {
  nolerp: Cvar = null!;
  rcon_password: Cvar = null!;
  shownet: Cvar = null!;
  name: Cvar = null!;
  color: Cvar = null!;
  upspeed: Cvar = null!;
  forwardspeed: Cvar = null!;
  backspeed: Cvar = null!;
  sidespeed: Cvar = null!;
  movespeedkey: Cvar = null!;
  yawspeed: Cvar = null!;
  pitchspeed: Cvar = null!;
  anglespeedkey: Cvar = null!;
  lookspring: Cvar = null!;
  lookstrafe: Cvar = null!;
  sensitivity: Cvar = null!;
  m_pitch: Cvar = null!;
  m_yaw: Cvar = null!;
  m_forward: Cvar = null!;
  m_side: Cvar = null!;
  nopred: Cvar = null!;
  nohud: Cvar = null!;
  areaportals: Cvar = null!;

  /**
   * Creates the variables, in the order `cvarlist` shows them. Called once by `ClientLifecycle` when the client starts.
   */
  register(): void {
    this.name = new Cvar('_cl_name', 'player', Cvar.FLAG.ARCHIVE);
    this.color = new Cvar('_cl_color', '0', Cvar.FLAG.ARCHIVE);
    this.upspeed = new Cvar('cl_upspeed', '200');
    this.forwardspeed = new Cvar('cl_forwardspeed', '400', Cvar.FLAG.ARCHIVE);
    this.backspeed = new Cvar('cl_backspeed', '400', Cvar.FLAG.ARCHIVE);
    this.sidespeed = new Cvar('cl_sidespeed', '350');
    this.movespeedkey = new Cvar('cl_movespeedkey', '2.0');
    this.yawspeed = new Cvar('cl_yawspeed', '140');
    this.pitchspeed = new Cvar('cl_pitchspeed', '150');
    this.anglespeedkey = new Cvar('cl_anglespeedkey', '1.5');
    this.shownet = new Cvar('cl_shownet', '0');
    this.nolerp = new Cvar('cl_nolerp', '0', Cvar.FLAG.ARCHIVE);
    this.lookspring = new Cvar('lookspring', '0', Cvar.FLAG.ARCHIVE);
    this.lookstrafe = new Cvar('lookstrafe', '0', Cvar.FLAG.ARCHIVE);
    this.sensitivity = new Cvar('sensitivity', '3', Cvar.FLAG.ARCHIVE);
    this.m_pitch = new Cvar('m_pitch', '0.022', Cvar.FLAG.ARCHIVE);
    this.m_yaw = new Cvar('m_yaw', '0.022', Cvar.FLAG.ARCHIVE);
    this.m_forward = new Cvar('m_forward', '1', Cvar.FLAG.ARCHIVE);
    this.m_side = new Cvar('m_side', '0.8', Cvar.FLAG.ARCHIVE);
    this.rcon_password = new Cvar('rcon_password', '');
    this.nopred = new Cvar('cl_nopred', '0', Cvar.FLAG.NONE, 'Enables/disables client-side prediction');
    this.nohud = new Cvar('cl_nohud', '0', Cvar.FLAG.NONE, 'Disables all HUD elements');
    this.areaportals = new Cvar('cl_areaportals', '0', Cvar.FLAG.ARCHIVE, 'Enables/disables client-side area portal culling');
  }
}

const clientCvars = new ClientCvars();

export default clientCvars;
