import type Cvar from '../common/Cvar.ts';

/**
 * The console variables of the client: how the player moves, looks and what the client shows. They are
 * created by `ClientLifecycle` when the client starts, and read from here by everything that needs them.
 * Nothing in this file imports anything that could import it back, so reading a variable never depends on
 * the order modules load in.
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
}

const clientCvars = new ClientCvars();

export default clientCvars;
