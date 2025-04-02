/* global Protocol, Vector */

// eslint-disable-next-line no-global-assign
Protocol = {};

Protocol.version = 15;

Protocol.u = {
  morebits: 1,
  origin1: 1 << 1,
  origin2: 1 << 2,
  origin3: 1 << 3,
  angle2: 1 << 4,
  nolerp: 1 << 5,
  frame: 1 << 6,
  signal: 1 << 7,

  angle1: 1 << 8,
  angle3: 1 << 9,
  model: 1 << 10,
  colormap: 1 << 11,
  skin: 1 << 12,
  effects: 1 << 13,
  longentity: 1 << 14,
};

Protocol.su = {
  viewheight: 1,
  idealpitch: 1 << 1,
  punch1: 1 << 2,
  punch2: 1 << 3,
  punch3: 1 << 4,
  velocity1: 1 << 5,
  velocity2: 1 << 6,
  velocity3: 1 << 7,
  items: 1 << 9,
  onground: 1 << 10,
  inwater: 1 << 11,
  weaponframe: 1 << 12,
  armor: 1 << 13,
  weapon: 1 << 14,
};

Protocol.default_viewheight = 22;

Protocol.svc = {
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
  serverinfo: 11,
  lightstyle: 12,
  updatename: 13,
  updatefrags: 14,
  clientdata: 15,
  stopsound: 16,
  updatecolors: 17,
  particle: 18,
  damage: 19,
  spawnstatic: 20,
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
  updatepings: 35,
  loadsound: 36,
  chatmsg: 37,
  obituary: 38,
};

Protocol.clc = {
  nop: 1,
  disconnect: 2,
  move: 3,
  stringcmd: 4,
  rconcmd: 5,
};

Protocol.te = {
  spike: 0,
  superspike: 1,
  gunshot: 2,
  explosion: 3,
  tarexplosion: 4,
  lightning1: 5,
  lightning2: 6,
  wizspike: 7,
  knightspike: 8,
  lightning3: 9,
  lavasplash: 10,
  teleport: 11,
  explosion2: 12,
  beam: 13,
};

Protocol.button = {
  attack: 1,
  jump: 2,
  use: 4,
};

Protocol.EntityState = class EntityState { // entity_state_t
  constructor() {
    /** @type {number} edict index */
    this.number = 0;
    /** @type {number} nolerp, etc. */
    this.flags = 0;
    this.frame = 0;
    this.modelindex = 0;
    this.colormap = 0;
    this.skinnum = 0;
    this.effects = 0;

    this.origin = new Vector();
    this.angles = new Vector();
  }
};

Protocol.UserCmd = class UserCmd { // usercmd_t
  constructor() {
    /** @type {number} uint8_t in QW */
    this.msec = 0;
    this.forwardmove = 0;
    this.sidemove = 0;
    this.upmove = 0;
    this.angles = new Vector();
    this.buttons = 0;
    this.impulse = 0;
  }
};
