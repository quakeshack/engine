import Vector from '../../shared/Vector.ts';

export const version = 42;

export const update_backup = 64;
export const update_mask = update_backup - 1;

export enum u {
  classname = 1 << 0,
  origin1 = 1 << 1,
  origin2 = 1 << 2,
  origin3 = 1 << 3,
  angle1 = 1 << 4,
  angle2 = 1 << 5,
  angle3 = 1 << 6,
  nextthink = 1 << 7,
  frame = 1 << 8,
  free = 1 << 9,
  model = 1 << 10,
  colormap = 1 << 11,
  skin = 1 << 12,
  effects = 1 << 13,
  solid = 1 << 14,
  size = 1 << 15,
}

export enum su {
  viewheight = 1,
  idealpitch = 1 << 1,
  punch1 = 1 << 2,
  punch2 = 1 << 3,
  punch3 = 1 << 4,
  velocity1 = 1 << 5,
  velocity2 = 1 << 6,
  velocity3 = 1 << 7,
  moveack = 1 << 8,
  items = 1 << 9,
  onground = 1 << 10,
  inwater = 1 << 11,
  weaponframe = 1 << 12,
  armor = 1 << 13,
  weapon = 1 << 14,
}

export const CMD_BUFFER_SIZE = 64;
export const CMD_BUFFER_MASK = CMD_BUFFER_SIZE - 1;

export const default_viewheight = 22;

export const svc = Object.freeze({
  null: 0,
  nop: 1,
  disconnect: 2,
  updatestat: 3,
  version: 4,
  setview: 5,
  sound: 6,
  time: 7,
  print: 8,
  stufftext: 9,
  setangle: 10,
  serverdata: 11,
  lightstyle: 12,
  updatename: 13,
  updatefrags: 14,
  clientdata: 15,
  stopsound: 16,
  updatecolors: 17,
  particle: 18,
  damage: 19,
  spawnstatic: 20,
  spawnbinary: 21,
  spawnbaseline: 22,
  temp_entity: 23,
  setpause: 24,
  signonnum: 25,
  centerprint: 26,
  killedmonster: 27,
  foundsecret: 28,
  spawnstaticsound: 29,
  intermission: 30,
  finale: 31,
  cdtrack: 32,
  sellscreen: 33,
  cutscene: 34,
  smallkick: 34,
  bigkick: 35,
  updateping: 36,
  updateentertime: 7,
  updatestatlong: 8,
  muzzleflash: 39,
  updateuserinfo: 0,
  download: 41,
  playerinfo: 42,
  nails: 43,
  chokecount: 44,
  modellist: 45,
  soundlist: 46,
  packetentities: 47,
  deltapacketentities: 48,
  maxspeed: 49,
  entgravity: 50,
  setinfo: 51,
  serverinfo: 52,
  updatepl: 53,
  updatepings: 101,
  loadsound: 102,
  chatmsg: 103,
  obituary: 104,
  pmovevars: 105,
  cvar: 106,
  changelevel: 107,
  clientevent: 108,
  gamestateupdate: 109,
  clientstateupdate: 110,
  setportalstate: 111,
} as const);

export enum clc {
  nop = 1,
  disconnect = 2,
  move = 3,
  stringcmd = 4,
  rconcmd = 5,
  delta = 6,
  qwmove = 7,
  sync = 8,
}

export const serializableTypes = Object.freeze({
  none: 0,
  long: 1,
  vector: 2,
  string: 3,
  true: 4,
  false: 5,
  null: 6,
  array: 7,
  float: 8,
  short: 9,
  byte: 10,
} as const);

export enum te {
  spike = 0,
  superspike = 1,
  gunshot = 2,
  explosion = 3,
  tarexplosion = 4,
  lightning1 = 5,
  lightning2 = 6,
  wizspike = 7,
  knightspike = 8,
  lightning3 = 9,
  lavasplash = 10,
  teleport = 11,
  explosion2 = 12,
  beam = 13,
}

export enum button {
  attack = 1,
  jump = 2,
  use = 4,
}

export enum pf {
  PF_MSEC = 1 << 0,
  PF_COMMAND = 1 << 1,
  PF_VELOCITY1 = 1 << 2,
  PF_VELOCITY2 = 1 << 3,
  PF_VELOCITY3 = 1 << 4,
  PF_MODEL = 1 << 5,
  PF_SKINNUM = 1 << 6,
  PF_EFFECTS = 1 << 7,
  PF_WEAPONFRAME = 1 << 8,
  PF_DEAD = 1 << 9,
  PF_GIB = 1 << 10,
  PF_NOGRAV = 1 << 11,
  PF_VELOCITY = 1 << 12,
}

export enum cm {
  CM_ANGLE1 = 1 << 0,
  CM_ANGLE3 = 1 << 1,
  CM_FORWARD = 1 << 2,
  CM_SIDE = 1 << 3,
  CM_UP = 1 << 4,
  CM_BUTTONS = 1 << 5,
  CM_IMPULSE = 1 << 6,
  CM_ANGLE2 = 1 << 7,
}

export class EntityState {
  number: number;
  flags: number;
  frame: number;
  modelindex: number;
  colormap: number;
  skinnum: number;
  effects: number;
  alpha: number;
  origin: Vector;
  angles: Vector;

  constructor() {
    this.number = 0;
    this.flags = 0;
    this.frame = 0;
    this.modelindex = 0;
    this.colormap = 0;
    this.skinnum = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.origin = new Vector();
    this.angles = new Vector();
  }
}

export class UserCmd {
  msec: number;
  forwardmove: number;
  sidemove: number;
  upmove: number;
  angles: Vector;
  buttons: number;
  impulse: number;

  constructor() {
    this.msec = 0;
    this.forwardmove = 0;
    this.sidemove = 0;
    this.upmove = 0;
    this.angles = new Vector();
    this.buttons = 0;
    this.impulse = 0;
  }

  copy(): UserCmd {
    const cmd = new UserCmd();

    cmd.msec = this.msec;
    cmd.forwardmove = this.forwardmove;
    cmd.sidemove = this.sidemove;
    cmd.upmove = this.upmove;
    cmd.angles.set(this.angles);
    cmd.buttons = this.buttons;
    cmd.impulse = this.impulse;

    return cmd;
  }

  set(other: UserCmd): this {
    this.msec = other.msec;
    this.forwardmove = other.forwardmove;
    this.sidemove = other.sidemove;
    this.upmove = other.upmove;
    this.angles.set(other.angles);
    this.buttons = other.buttons;
    this.impulse = other.impulse;

    return this;
  }

  reset(): this {
    this.msec = 0;
    this.forwardmove = 0;
    this.sidemove = 0;
    this.upmove = 0;
    this.angles.clear();
    this.buttons = 0;
    this.impulse = 0;

    return this;
  }

  equals(other: UserCmd): boolean {
    return this.msec === other.msec &&
      this.forwardmove === other.forwardmove &&
      this.sidemove === other.sidemove &&
      this.upmove === other.upmove &&
      this.angles.equals(other.angles) &&
      this.buttons === other.buttons &&
      this.impulse === other.impulse;
  }
}
