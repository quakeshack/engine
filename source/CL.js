/* global Con, Mod, COM, Host, CL, Cmd, Cvar, Vector, S, Q, NET, MSG, Protocol, SV, SCR, R, IN, Sys, Def, V, CDAudio, Draw, Pmove, PR */

// eslint-disable-next-line no-global-assign
CL = {};

CL.cshift = {
  contents: 0,
  damage: 1,
  bonus: 2,
  powerup: 3,
};

CL.active = {
  disconnected: 0,
  connecting: 1,
  connected: 2,
};

/** @type {?Pmove.Pmove} */
CL.pmove = null;

// demo

CL.StopPlayback = function() {
  if (CL.cls.demoplayback !== true) {
    return;
  }
  CL.cls.demoplayback = false;
  CL.cls.demofile = null;
  CL.cls.state = CL.active.disconnected;
  if (CL.cls.timedemo === true) {
    CL.FinishTimeDemo();
  }
};

CL.WriteDemoMessage = function() {
  const len = CL.cls.demoofs + 16 + NET.message.cursize;
  if (CL.cls.demofile.byteLength < len) {
    const src = new Uint8Array(CL.cls.demofile, 0, CL.cls.demoofs);
    CL.cls.demofile = new ArrayBuffer(CL.cls.demofile.byteLength + 16384);
    (new Uint8Array(CL.cls.demofile)).set(src);
  }
  const f = new DataView(CL.cls.demofile, CL.cls.demoofs, 16);
  f.setInt32(0, NET.message.cursize, true);
  f.setFloat32(4, CL.state.viewangles[0], true);
  f.setFloat32(8, CL.state.viewangles[1], true);
  f.setFloat32(12, CL.state.viewangles[2], true);
  (new Uint8Array(CL.cls.demofile)).set(new Uint8Array(NET.message.data, 0, NET.message.cursize), CL.cls.demoofs + 16);
  CL.cls.demoofs = len;
};

CL.GetMessage = function() {
  if (CL.cls.demoplayback === true) {
    if (CL.cls.signon === 4) {
      if (CL.cls.timedemo === true) {
        if (Host.framecount === CL.cls.td_lastframe) {
          return 0;
        }
        CL.cls.td_lastframe = Host.framecount;
        if (Host.framecount === (CL.cls.td_startframe + 1)) {
          CL.cls.td_starttime = Host.realtime;
        }
      } else if (CL.state.time <= CL.state.mtime[0]) {
        return 0;
      }
    }
    if ((CL.cls.demoofs + 16) >= CL.cls.demosize) {
      CL.StopPlayback();
      return 0;
    }
    const view = new DataView(CL.cls.demofile);
    NET.message.cursize = view.getUint32(CL.cls.demoofs, true);
    if (NET.message.cursize > 8000) {
      Sys.Error('Demo message > MAX_MSGLEN');
    }
    CL.state.mviewangles[1] = CL.state.mviewangles[0];
    CL.state.mviewangles[0] = [view.getFloat32(CL.cls.demoofs + 4, true), view.getFloat32(CL.cls.demoofs + 8, true), view.getFloat32(CL.cls.demoofs + 12, true)];
    CL.cls.demoofs += 16;
    if ((CL.cls.demoofs + NET.message.cursize) > CL.cls.demosize) {
      CL.StopPlayback();
      return 0;
    }
    const src = new Uint8Array(CL.cls.demofile, CL.cls.demoofs, NET.message.cursize);
    const dest = new Uint8Array(NET.message.data, 0, NET.message.cursize);
    let i;
    for (i = 0; i < NET.message.cursize; ++i) {
      dest[i] = src[i];
    }
    CL.cls.demoofs += NET.message.cursize;
    return 1;
  };

  let r;
  for (;;) {
    r = NET.GetMessage(CL.cls.netcon);
    if ((r !== 1) && (r !== 2)) {
      return r;
    }
    if ((NET.message.cursize === 1) && ((new Uint8Array(NET.message.data, 0, 1))[0] === Protocol.svc.nop)) {
      Con.Print('<-- server to client keepalive\n');
    } else {
      break;
    }
  }

  if (CL.cls.demorecording === true) {
    CL.WriteDemoMessage();
  }

  return r;
};

CL.Stop_f = function() {
  if (this.client) {
    return;
  }
  if (CL.cls.demorecording !== true) {
    Con.Print('Not recording a demo.\n');
    return;
  }
  NET.message.clear();
  MSG.WriteByte(NET.message, Protocol.svc.disconnect);
  MSG.WriteString(NET.message, 'CL.Stop_f');
  CL.WriteDemoMessage();
  if (COM.WriteFile(CL.cls.demoname, new Uint8Array(CL.cls.demofile), CL.cls.demoofs) !== true) {
    Con.PrintError('ERROR: couldn\'t open.\n');
  }
  CL.cls.demofile = null;
  CL.cls.demorecording = false;
  Con.PrintSuccess('Completed demo\n');
};

CL.Record_f = function(demoname, map, track) {
  if (demoname === undefined) {
    Con.Print('Usage: record <demoname> [<map> [cd track]]\n');
    return;
  }
  if (demoname.indexOf('..') !== -1) {
    Con.PrintWarning('Relative pathnames are not allowed.\n');
    return;
  }
  if (map === undefined && (CL.cls.state === CL.active.connected)) {
    Con.Print('Can not record - already connected to server\nClient demo recording must be started before connecting\n');
    return;
  }
  if (track !== undefined) {
    CL.cls.forcetrack = Q.atoi(track);
    Con.Print('Forcing CD track to ' + CL.cls.forcetrack);
  } else {
    CL.cls.forcetrack = -1;
  }
  CL.cls.demoname = COM.DefaultExtension(demoname, '.dem');
  if (map !== undefined) {
    Cmd.ExecuteString('map ' + map);
  }
  Con.PrintSuccess('recording to ' + CL.cls.demoname + '.\n');
  CL.cls.demofile = new ArrayBuffer(16384);
  const trackstr = CL.cls.forcetrack.toString() + '\n';
  let i; const dest = new Uint8Array(CL.cls.demofile, 0, trackstr.length);
  for (i = 0; i < trackstr.length; ++i) {
    dest[i] = trackstr.charCodeAt(i);
  }
  CL.cls.demoofs = trackstr.length;
  CL.cls.demorecording = true;
};

CL.PlayDemo_f = function(demoname) {
  if (this.client) {
    return;
  }
  if (demoname === undefined) {
    Con.Print('Usage: playdemo <demoname>\n');
    return;
  }
  CL.Disconnect();
  const name = COM.DefaultExtension(demoname, '.dem');
  Con.Print('Playing demo from ' + name + '.\n');
  let demofile = COM.LoadFile(name);
  if (demofile == null) {
    Con.PrintError('ERROR: couldn\'t open.\n');
    CL.cls.demonum = -1;
    SCR.disabled_for_loading = false;
    return;
  }
  CL.cls.demofile = demofile;
  demofile = new Uint8Array(demofile);
  CL.cls.demosize = demofile.length;
  CL.cls.demoplayback = true;
  CL.cls.state = CL.active.connected;
  CL.cls.forcetrack = 0;
  let i; let c; let neg;
  for (i = 0; i < demofile.length; ++i) {
    c = demofile[i];
    if (c === 10) {
      break;
    }
    if (c === 45) {
      neg = true;
    } else {
      CL.cls.forcetrack = CL.cls.forcetrack * 10 + c - 48;
    }
  }
  if (neg === true) {
    CL.cls.forcetrack = -CL.cls.forcetrack;
  }
  CL.cls.demoofs = i + 1;
};

CL.FinishTimeDemo = function() {
  CL.cls.timedemo = false;
  const frames = Host.framecount - CL.cls.td_startframe - 1;
  let time = Host.realtime - CL.cls.td_starttime;
  if (time === 0.0) {
    time = 1.0;
  }
  Con.Print(frames + ' frames ' + time.toFixed(1) + ' seconds ' + (frames / time).toFixed(1) + ' fps\n');
};

CL.TimeDemo_f = function(demoname) {
  if (this.client) {
    return;
  }
  if (demoname === undefined) {
    Con.Print('Usage: timedemo <demoname>\n');
    return;
  }
  CL.PlayDemo_f();
  CL.cls.timedemo = true;
  CL.cls.td_startframe = Host.framecount;
  CL.cls.td_lastframe = -1;
};

// input

CL.kbutton = {
  mlook: 0,
  klook: 1,
  left: 2,
  right: 3,
  forward: 4,
  back: 5,
  lookup: 6,
  lookdown: 7,
  moveleft: 8,
  moveright: 9,
  strafe: 10,
  speed: 11,
  use: 12,
  jump: 13,
  attack: 14,
  moveup: 15,
  movedown: 16,
  num: 17,
};
CL.kbuttons = [];

CL.KeyDown_f = function(cmd) {
  let b = CL.kbutton[this.command.substring(1)];
  if (b == null) {
    return;
  }
  b = CL.kbuttons[b];

  let k;
  if (cmd !== undefined) {
    k = Q.atoi(cmd);
  } else {
    k = -1;
  }

  if ((k === b.down[0]) || (k === b.down[1])) {
    return;
  }

  if (b.down[0] === 0) {
    b.down[0] = k;
  } else if (b.down[1] === 0) {
    b.down[1] = k;
  } else {
    Con.Print('Three keys down for a button!\n');
    return;
  }

  if ((b.state & 1) === 0) {
    b.state |= 3;
  }
};

CL.KeyUp_f = function(cmd) {
  let b = CL.kbutton[this.command.substring(1)];
  if (b == null) {
    return;
  }
  b = CL.kbuttons[b];

  let k;
  if (cmd !== undefined) {
    k = Q.atoi(cmd);
  } else {
    b.down[0] = b.down[1] = 0;
    b.state = 4;
    return;
  }

  if (b.down[0] === k) {
    b.down[0] = 0;
  } else if (b.down[1] === k) {
    b.down[1] = 0;
  } else {
    return;
  }
  if ((b.down[0] !== 0) || (b.down[1] !== 0)) {
    return;
  }

  if ((b.state & 1) !== 0) {
    b.state = (b.state - 1) | 4;
  }
};

CL.MLookUp_f = function(cmd) {
  CL.KeyUp_f.call(this, cmd);
  if (((CL.kbuttons[CL.kbutton.mlook].state & 1) === 0) && (CL.lookspring.value !== 0)) {
    V.StartPitchDrift();
  }
};

CL.Impulse_f = function(code) {
  if (code === undefined) {
    Con.Print('Usage: impulse <code>\n');
    return;
  }

  CL.impulse = Q.atoi(code);
};

CL.KeyState = function(key) {
  key = CL.kbuttons[key];
  const down = key.state & 1;
  key.state &= 1;
  if ((key.state & 2) !== 0) {
    if ((key.state & 4) !== 0) {
      return (down !== 0) ? 0.75 : 0.25;
    }
    return (down !== 0) ? 0.5 : 0.0;
  }
  if ((key.state & 4) !== 0) {
    return 0.0;
  }
  return (down !== 0) ? 1.0 : 0.0;
};

CL.AdjustAngles = function() {
  let speed = Host.frametime;
  if ((CL.kbuttons[CL.kbutton.speed].state & 1) !== 0) {
    speed *= CL.anglespeedkey.value;
  }

  const angles = CL.state.viewangles;

  if ((CL.kbuttons[CL.kbutton.strafe].state & 1) === 0) {
    angles[1] += speed * CL.yawspeed.value * (CL.KeyState(CL.kbutton.left) - CL.KeyState(CL.kbutton.right));
    angles[1] = Vector.anglemod(angles[1]);
  }
  if ((CL.kbuttons[CL.kbutton.klook].state & 1) !== 0) {
    V.StopPitchDrift();
    angles[0] += speed * CL.pitchspeed.value * (CL.KeyState(CL.kbutton.back) - CL.KeyState(CL.kbutton.forward));
  }

  const up = CL.KeyState(CL.kbutton.lookup); const down = CL.KeyState(CL.kbutton.lookdown);
  if ((up !== 0.0) || (down !== 0.0)) {
    angles[0] += speed * CL.pitchspeed.value * (down - up);
    V.StopPitchDrift();
  }

  if (angles[0] > 80.0) {
    angles[0] = 80.0;
  } else if (angles[0] < -70.0) {
    angles[0] = -70.0;
  }

  if (angles[2] > 50.0) {
    angles[2] = 50.0;
  } else if (angles[2] < -50.0) {
    angles[2] = -50.0;
  }
};

CL.BaseMove = function() {
  if (CL.cls.signon !== 4) {
    return;
  }

  CL.AdjustAngles();

  const cmd = CL.state.cmd;

  cmd.sidemove = CL.sidespeed.value * (CL.KeyState(CL.kbutton.moveright) - CL.KeyState(CL.kbutton.moveleft));
  if ((CL.kbuttons[CL.kbutton.strafe].state & 1) !== 0) {
    cmd.sidemove += CL.sidespeed.value * (CL.KeyState(CL.kbutton.right) - CL.KeyState(CL.kbutton.left));
  }

  cmd.upmove = CL.upspeed.value * (CL.KeyState(CL.kbutton.moveup) - CL.KeyState(CL.kbutton.movedown));

  if ((CL.kbuttons[CL.kbutton.klook].state & 1) === 0) {
    cmd.forwardmove = CL.forwardspeed.value * CL.KeyState(CL.kbutton.forward) - CL.backspeed.value * CL.KeyState(CL.kbutton.back);
  } else {
    cmd.forwardmove = 0.0;
  }

  if ((CL.kbuttons[CL.kbutton.speed].state & 1) !== 0) {
    cmd.forwardmove *= CL.movespeedkey.value;
    cmd.sidemove *= CL.movespeedkey.value;
    cmd.upmove *= CL.movespeedkey.value;
  }

  cmd.impulse = CL.impulse;
  cmd.angles.set(CL.state.viewangles);
  // TODO: cmd.msec =

  CL.impulse = 0;
};

CL.impulse = 0;

CL.SendMove = function() {
  CL.state.cmd.buttons = 0;

  if ((CL.kbuttons[CL.kbutton.attack].state & 3) !== 0) {
    CL.state.cmd.buttons |= Protocol.button.attack;
  }
  CL.kbuttons[CL.kbutton.attack].state &= 5;

  if ((CL.kbuttons[CL.kbutton.jump].state & 3) !== 0) {
    CL.state.cmd.buttons |= Protocol.button.jump;
  }
  CL.kbuttons[CL.kbutton.jump].state &= 5;

  if ((CL.kbuttons[CL.kbutton.use].state & 3) !== 0) {
    CL.state.cmd.buttons |= Protocol.button.use;
  }
  CL.kbuttons[CL.kbutton.use].state &= 5;

  if (CL.state.cmd.equals(CL.state.lastcmd)) {
    return; // nothing new happened
  }

  const buf = new MSG.Buffer(16);
  MSG.WriteByte(buf, Protocol.clc.move);
  MSG.WriteFloat(buf, CL.state.mtime[0]);
  MSG.WriteAngleVector(buf, CL.state.cmd.angles);
  MSG.WriteShort(buf, CL.state.cmd.forwardmove);
  MSG.WriteShort(buf, CL.state.cmd.sidemove);
  MSG.WriteShort(buf, CL.state.cmd.upmove);
  MSG.WriteByte(buf, CL.state.cmd.buttons);
  MSG.WriteByte(buf, CL.state.cmd.impulse);

  if (CL.cls.demoplayback === true) {
    return;
  }
  if (++CL.state.movemessages <= 2) {
    return;
  }
  CL.state.lastcmd.set(CL.state.cmd);
  if (NET.SendUnreliableMessage(CL.cls.netcon, buf) === -1) {
    Con.Print('CL.SendMove: lost server connection\n');
    Host.Error('lost server connection');
  }
};

CL.InitInput = function() {
  let i;

  const commands = ['moveup', 'movedown', 'left', 'right',
    'forward', 'back', 'lookup', 'lookdown',
    'strafe', 'moveleft', 'moveright', 'speed',
    'attack', 'use', 'jump', 'klook',
  ];
  for (i = 0; i < commands.length; ++i) {
    Cmd.AddCommand('+' + commands[i], CL.KeyDown_f);
    Cmd.AddCommand('-' + commands[i], CL.KeyUp_f);
  }
  Cmd.AddCommand('impulse', CL.Impulse_f);
  Cmd.AddCommand('+mlook', CL.KeyDown_f);
  Cmd.AddCommand('-mlook', CL.MLookUp_f);

  for (i = 0; i < CL.kbutton.num; ++i) {
    CL.kbuttons[i] = {down: [0, 0], state: 0};
  }
};

// main

CL.gameAPI = null;

CL.cls = {
  signon: 0,
  state: 0,
  spawnparms: '',
  demonum: 0,
  demoplayback: false,
  demos: [],
  timedemo: false,
  message: new MSG.Buffer(8192, 'CL.cls.message'),
  netcon: null,
  connecting: null,
  latency: 0.0,
  serverInfo: {},

  // used by CL.ParseClientdata
  oldparsecountmod: 0,
  parsecountmod: 0,
  parsecounttime: 0.0,

  lastcmdsent: 0,
};

CL.static_entities = [];
CL.visedicts = [];

CL.Entity = class ClientEdict {
  constructor(num) {
    this.classname = null;
    this.num = num;
    this.model = null;
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.origin = new Vector();
    /** @type {?Vector} used to keep track of origin changes, unset when no previous origin is known */
    this.origin_old = null;
    this.angles = new Vector();
    /** @type {?Vector} used to keep track of angles changes, unset when no previous angles is known */
    this.angles_old = null;
    this.dlightbits = 0;
    this.dlightframe = 0;
    /** keeps track of last updates */
    this.msg_time = [0.0, 0.0];
    /** keeps track of origin changes */
    this.msg_origins = [new Vector(), new Vector()];
    /** keeps track of angle changes */
    this.msg_angles = [new Vector(), new Vector()];
    this.leafs = [];
    /** count of received updates */
    this.updatecount = 0;
    /** whether is ClientEntity is free */
    this.free = false;
    this.syncbase = 0.0;

    Object.seal(this);
  }

  equals(other) {
    // CR: playing with fire here
    return this === other || (this.num !== -1 && this.num === other.num);
  }

  freeEdict() {
    this.model = null;
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.origin.clear();
    this.origin_old = null;
    this.angles.clear();
    this.angles_old = null;
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_time[0] = 0.0;
    this.msg_time[1] = 0.0;
    this.msg_origins[0].clear();
    this.msg_origins[1].clear();
    this.msg_angles[0].clear();
    this.msg_angles[1].clear();
    this.leafs = [];
    this.updatecount = 0;
    this.free = false;
  }

  /**
   * Sets origin and angles according to the current message.
   * @param {boolean} doLerp whether to do a point lerp
   */
  updatePosition(doLerp) {
    if (this.origin_old === null) {
      this.origin_old = this.msg_origins[0].copy();
    } else {
      this.origin_old.set(this.origin);
    }

    if (this.angles_old === null) {
      this.angles_old = this.msg_angles[0].copy();
    } else {
      this.angles_old.set(this.angles);
    }

    if (!doLerp) {
      this.origin.set(this.msg_origins[0]);
      this.angles.set(this.msg_angles[0]);
      return;
    }

    let f = CL.LerpPoint();
    const delta = new Vector();

    for (let j = 0; j < 3; j++) {
      delta[j] = this.msg_origins[0][j] - this.origin_old[j];
      if ((delta[j] > 100.0) || (delta[j] < -100.0)) {
        f = 1.0;
      }
    }
    for (let j = 0; j < 3; j++) {
      this.origin[j] = this.origin_old[j] + f * delta[j];
      let d = this.msg_angles[0][j] - this.angles_old[j];
      if (d > 180.0) {
        d -= 360.0;
      } else if (d < -180.0) {
        d += 360.0;
      }
      this.angles[j] = this.angles_old[j] + f * d;
    }
  }

  emit() {
    return true;
  }

  think() {

  }
};

CL.Rcon_f = function(...args) {
  if (args.length === 0) {
    Con.Print('Usage: rcon <command>\n');
    return;
  }

  const password = CL.rcon_password.string;

  if (!password) {
    Con.Print('You must set \'rcon_password\' before issuing an rcon command.\n');
    return;
  }

  MSG.WriteByte(CL.cls.message, Protocol.clc.rconcmd);
  MSG.WriteString(CL.cls.message, password);
  MSG.WriteString(CL.cls.message, this.args);
};

CL.SetConnectingStep = function(percentage, message) {
  if (percentage === null && message === null) {
    CL.cls.connecting = null;
    return;
  }

  Con.DPrint(`${percentage.toFixed(0).padStart(3, ' ')}% ${message}\n`);

  SCR.con_current = 0; // force Console to disappear

  percentage = Math.round(percentage);

  CL.cls.connecting = {
    percentage,
    message
  };

  // SCR.UpdateScreen();
};

CL.Draw = function() { // FIXME: maybe put that into M?
  if (CL.cls.connecting !== null) {
    const x0 = 32, y0 = 32;
    Draw.BlackScreen();
    Draw.String(x0, y0, "Connecting", 2);
    Draw.StringWhite(x0, y0 + 32, CL.cls.connecting.message);

    const len = 30;
    const p = CL.cls.connecting.percentage;
    Draw.String(x0, y0 + 48, `[${'#'.repeat(p / 100 * len).padEnd(len, '_')}] ${p.toFixed(0).padStart(' ')}%`);
  }
};

CL.ClearState = function() {
  if (SV.server.active !== true) {
    Con.DPrint('Clearing memory\n');
    Mod.ClearAll();
    CL.cls.signon = 0;
  }

  CL.SetConnectingStep(null, null);

  CL.gameAPI = null;

  CL.state = {
    movemessages: 0,
    cmd: new Protocol.UserCmd(),
    lastcmd: new Protocol.UserCmd(),
    stats: Object.keys(Def.stat).fill(0),
    items: 0,
    item_gettime: new Array(32).fill(0.0),
    faceanimtime: 0.0,
    cshifts: [
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
    ],
    mviewangles: [new Vector(), new Vector()],
    viewangles: new Vector(),
    mvelocity: [new Vector(), new Vector()],
    velocity: new Vector(),
    punchangle: new Vector(),
    idealpitch: 0.0,
    pitchvel: 0.0,
    driftmove: 0.0,
    laststop: 0.0,
    intermission: 0,
    completed_time: 0,
    mtime: [0.0, 0.0],
    time: 0.0,
    oldtime: 0.0,
    last_received_message: 0.0,
    viewentity: 0,
    num_statics: 0,
    viewent: new CL.Entity(-1),
    cdtrack: 0,
    looptrack: 0,
    chatlog: [],
    model_precache: [],
    sound_precache: [],
    levelname: null,
    gametype: 0,
    onground: false,
    maxclients: 1,
    scores: [],
    worldmodel: null,
    viewheight: 0,
    inwater: false,
    nodrift: false,
    lerp: null,
  };

  CL.cls.message.clear();
  CL.cls.serverInfo = {};
  CL.cls.lastcmdsent = 0;

  CL.entities = [];

  let i;

  CL.dlights = [];
  for (i = 0; i <= 31; ++i) {
    CL.dlights[i] = {radius: 0.0, die: 0.0, color: new Vector(1, 1, 1), decay: 0.0, minlight: 0.0, key: 0}; // TODO: Dlight class
  }

  CL.lightstyle = [];
  for (i = 0; i <= 63; ++i) {
    CL.lightstyle[i] = '';
  }

  CL.beams = [];
  for (i = 0; i <= 23; ++i) {
    CL.beams[i] = {endtime: 0.0}; // TODO: Beam class
  }

};

CL.ResetCheatCvars = function() {
  for (const cvar of Cvar.Filter((cvar) => (cvar.flags & Cvar.FLAG.CHEAT) !== 0)) {
    cvar.reset();
  }
};

CL.Disconnect = function() {
  CL.SetConnectingStep(null, null);
  S.StopAllSounds();
  if (CL.cls.demoplayback === true) {
    CL.StopPlayback();
  } else if (CL.cls.state === CL.active.connecting) {
    CL.cls.state = CL.active.disconnected;
    CL.cls.message.clear();
  } else if (CL.cls.state === CL.active.connected) {
    if (CL.cls.demorecording === true) {
      CL.Stop_f();
    }
    Con.DPrint('Sending clc_disconnect\n');
    CL.cls.message.clear();
    MSG.WriteByte(CL.cls.message, Protocol.clc.disconnect);
    NET.SendUnreliableMessage(CL.cls.netcon, CL.cls.message);
    CL.cls.message.clear();
    NET.Close(CL.cls.netcon);
    CL.cls.state = CL.active.disconnected;
    if (SV.server.active === true) {
      Host.ShutdownServer();
    }
  }
  CL.cls.demoplayback = CL.cls.timedemo = false;
  CL.cls.signon = 0;
  CL.ResetCheatCvars();
};

CL.Connect = function(sock) {
  CL.cls.netcon = sock;
  Con.DPrint('CL.Connect: connected to ' + CL.host + '\n');
  CL.cls.demonum = -1;
  CL.cls.state = CL.active.connected;
  CL.cls.signon = 0;
  CL.SetConnectingStep(10, 'Connected to ' + CL.host);
};

CL.EstablishConnection = function(host) {
  if (CL.cls.demoplayback === true) {
    return;
  }
  CL.Disconnect();
  CL.host = host;
  CL.SetConnectingStep(5, 'Connecting to ' + CL.host);
  const sock = NET.Connect(host);
  if (sock == null) {
    Host.Error('CL.EstablishConnection: connect failed\n');
  }
  CL.Connect(sock);
};

CL.SignonReply = function() {
  Con.DPrint('CL.SignonReply: ' + CL.cls.signon + '\n');
  switch (CL.cls.signon) {
    case 1:
      CL.SetConnectingStep(90, 'About to spawn');
      MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
      MSG.WriteString(CL.cls.message, 'prespawn');
      return;
    case 2:
      CL.SetConnectingStep(95, 'Setting client state');
      MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
      MSG.WriteString(CL.cls.message, 'name "' + CL.name.string + '"\n');
      MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
      MSG.WriteString(CL.cls.message, 'color ' + (CL.color.value >> 4) + ' ' + (CL.color.value & 15) + '\n');
      MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
      MSG.WriteString(CL.cls.message, 'spawn ' + CL.cls.spawnparms);
      return;
    case 3:
      CL.SetConnectingStep(100, 'Joining the game!');
      MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
      MSG.WriteString(CL.cls.message, 'begin');
      return;
    // called when the first entities are received
    case 4:
      CL.SetConnectingStep(null, null);
      SCR.EndLoadingPlaque();
      Con.forcedup = true;
      SCR.con_current = 0;
      S.LoadPendingFiles();
      return;
  }
};

CL.NextDemo = function() {
  if (CL.cls.demonum === -1) {
    return;
  }
  SCR.BeginLoadingPlaque();
  if (CL.cls.demonum >= CL.cls.demos.length) {
    if (CL.cls.demos.length === 0) {
      Con.Print('No demos listed with startdemos\n');
      CL.cls.demonum = -1;
      return;
    }
    CL.cls.demonum = 0;
  }
  Cmd.text = 'playdemo ' + CL.cls.demos[CL.cls.demonum++] + '\n' + Cmd.text;
};

CL.PrintEntities_f = function() {
    for (let i = 0; i < CL.entities.length; ++i) {
    const ent = CL.entities[i];

    if (ent.model == null) {
      continue;
    }

    Con.Print(i.toFixed(0).padStart(3, ' ') + ' ' + ent.model.name.padEnd(32) + ' : ' + ent.frame.toFixed().padStart(3) + ' (' + ent.origin + ') [' + ent.angles + ']\n');
  }
};

CL.AllocDlight = function(key) { // TODO: Dlight class
  let dl, i = 0;
  if (key !== 0) {
    for (i = 0; i <= 31; ++i) {
      if (CL.dlights[i].key === key) {
        dl = CL.dlights[i];
        break;
      }
    }
  }
  if (dl == null) {
    for (i = 0; i <= 31; ++i) {
      if (CL.dlights[i].die < CL.state.time) {
        dl = CL.dlights[i];
        break;
      }
    }
    if (dl == null) {
      dl = CL.dlights[0];
    }
  }
  dl.origin = new Vector();
  dl.radius = 0.0;
  dl.die = 0.0;
  dl.decay = 0.0;
  dl.minlight = 0.0;
  dl.key = key;
  return dl;
};

CL.DecayLights = function() {
  let i; let dl; const time = CL.state.time - CL.state.oldtime;
  for (i = 0; i <= 31; ++i) {
    dl = CL.dlights[i];
    if ((dl.die < CL.state.time) || (dl.radius === 0.0)) {
      continue;
    }
    dl.radius -= time * dl.decay;
    if (dl.radius < 0.0) {
      dl.radius = 0.0;
    }
  }
};

/**
 * Calculates lerp fraction for the current frame.
 * It also updates CL.state.time.
 * @returns {number} interval [0.0, 1.0]
 */
CL.LerpPoint = function() {
  if (CL.state.lerp !== null) {
    return CL.state.lerp;
  }

  let f = CL.state.mtime[0] - CL.state.mtime[1];
  if ((f === 0.0) || (CL.nolerp.value !== 0) || (CL.cls.timedemo === true) || (SV.server.active === true)) {
    CL.state.time = CL.state.mtime[0];
    CL.state.lerp = 1.0;
    return CL.state.lerp;
  }
  if (f > 0.1) {
    CL.state.mtime[1] = CL.state.mtime[0] - 0.1;
    f = 0.1;
  }
  const frac = (CL.state.time - CL.state.mtime[1]) / f;
  if (frac < 0.0) {
    if (frac < -0.01) {
      CL.state.time = CL.state.mtime[1];
    }
    CL.state.lerp = 0.0;
    return CL.state.lerp;
  }
  if (frac > 1.0) {
    if (frac > 1.01) {
      CL.state.time = CL.state.mtime[0];
    }
    CL.state.lerp = 1.0;
    return CL.state.lerp;
  }
  CL.state.lerp = frac;
  return frac;
};

/** @deprecated */
CL.RelinkEntities = function() {
  debugger;
  let i; let j;
  const frac = CL.LerpPoint(); let f; let d; const delta = [];

  CL.numvisedicts = 0;

  // velo = mvelo[1] + frac * (mvelo[0] - mvelo[1])
  // CL.state.velocity.set(CL.state.mvelocity[1].copy().add(CL.state.mvelocity[0].copy().subtract(CL.state.mvelocity[1]).multiply(frac)));

  if (CL.cls.demoplayback === true) {
    for (i = 0; i <= 2; ++i) {
      d = CL.state.mviewangles[0][i] - CL.state.mviewangles[1][i];
      if (d > 180.0) {
        d -= 360.0;
      } else if (d < -180.0) {
        d += 360.0;
      }
      CL.state.viewangles[i] = CL.state.mviewangles[1][i] + frac * d;
    }
  }

  const bobjrotate = Vector.anglemod(100.0 * CL.state.time);
  let ent; let dl;
  for (i = 1; i < CL.entities.length; ++i) {
    ent = CL.entities[i];
    if (ent.model == null) {
      continue;
    }
    // if (ent.msgtime !== CL.state.mtime[0]) {
    //   ent.model = null;
    //   continue;
    // }
    const oldorg = ent.origin.copy();
    // if (ent.forcelink === true) {
    //   ent.origin = ent.msg_origins[0].copy();
    //   ent.angles = ent.msg_angles[0].copy();
    // } else {
    //   f = frac;
    //   for (j = 0; j <= 2; ++j) {
    //     delta[j] = ent.msg_origins[0][j] - ent.msg_origins[1][j];
    //     if ((delta[j] > 100.0) || (delta[j] < -100.0)) {
    //       f = 1.0;
    //     }
    //   }
    //   for (j = 0; j <= 2; ++j) {
    //     ent.origin[j] = ent.msg_origins[1][j] + f * delta[j];
    //     d = ent.msg_angles[0][j] - ent.msg_angles[1][j];
    //     if (d > 180.0) {
    //       d -= 360.0;
    //     } else if (d < -180.0) {
    //       d += 360.0;
    //     }
    //     ent.angles[j] = ent.msg_angles[1][j] + f * d;
    //   }
    // }

    if ((ent.model.flags & Mod.flags.rotate) !== 0) {
      ent.angles[1] = bobjrotate;
    }
    if ((ent.effects & Mod.effects.brightfield) !== 0) {
      R.EntityParticles(ent);
    }
    if ((ent.effects & Mod.effects.muzzleflash) !== 0) {
      dl = CL.AllocDlight(i);
      const fv = ent.angles.angleVectors().forward;
      dl.origin = new Vector(
        ent.origin[0] + 18.0 * fv[0],
        ent.origin[1] + 18.0 * fv[1],
        ent.origin[2] + 16.0 + 18.0 * fv[2],
      );
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.minlight = 32.0;
      dl.die = CL.state.time + 0.1;
      // dl.color = new Vector(1.0, 0.95, 0.85);
    }
    if ((ent.effects & Mod.effects.brightlight) !== 0) {
      dl = CL.AllocDlight(i);
      dl.origin = new Vector(ent.origin[0], ent.origin[1], ent.origin[2] + 16.0);
      dl.radius = 400.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
    }
    if ((ent.effects & Mod.effects.dimlight) !== 0) {
      dl = CL.AllocDlight(i);
      dl.origin = new Vector(ent.origin[0], ent.origin[1], ent.origin[2] + 16.0);
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
      // dl.color = new Vector(0.5, 0.5, 1.0);
    }
    if ((ent.model.flags & Mod.flags.gib) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 2);
    } else if ((ent.model.flags & Mod.flags.zomgib) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 4);
    } else if ((ent.model.flags & Mod.flags.tracer) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 3);
    } else if ((ent.model.flags & Mod.flags.tracer2) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 5);
    } else if ((ent.model.flags & Mod.flags.rocket) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 0);
      dl = CL.AllocDlight(i);
      dl.origin = new Vector(ent.origin[0], ent.origin[1], ent.origin[2]);
      dl.radius = 200.0;
      dl.die = CL.state.time + 0.01;
    } else if ((ent.model.flags & Mod.flags.grenade) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 1);
    } else if ((ent.model.flags & Mod.flags.tracer3) !== 0) {
      R.RocketTrail(oldorg, ent.origin, 6);
    }

    // ent.forcelink = false;
    // if ((i !== CL.state.viewentity) || (Chase.active.value !== 0)) {
    //   CL.visedicts[CL.numvisedicts++] = ent;
    // }
  }
};

CL.ReadFromServer = function() {
  CL.state.oldtime = CL.state.time;
  CL.state.time += Host.frametime;
  let ret;
  while (true) {
    if (CL._processingServerDataState === 1) {
      return;
    }
    if (CL._processingServerDataState === 2) {
      CL._processingServerDataState = 3;
    } else {
      ret = CL.GetMessage();
      if (ret === -1) {
        if (CL._processingServerDataState === 0 && CL.cls.signon < 4) {
          break;
        }
        Host.Error('CL.ReadFromServer: lost server connection');
      }
      if (ret === 0) {
        break;
      }
    }
    CL.state.last_received_message = Host.realtime;
    // console.debug('CL.ReadFromServer: ', NET.message.toHexString());
    CL.ParseServerMessage();
    if (CL.cls.state !== CL.active.connected) {
      break;
    }
  }
  if (CL.shownet.value !== 0) {
    Con.Print('\n');
  }

  CL.state.velocity.set(CL.state.mvelocity[1].copy().add(CL.state.mvelocity[0].copy().subtract(CL.state.mvelocity[1]).multiply(CL.LerpPoint()))); // TODO: this is going to be replaced by Pmove

  // CL.RelinkEntities();
  CL.UpdateTEnts();
};

CL.SendCmd = function() {
  if (CL.cls.state !== CL.active.connected) {
    return;
  }

  if (CL.cls.signon === 4) {
    CL.BaseMove();
    IN.Move();
    CL.SendMove();

    // send a no-op if we haven't sent anything in a while
    if (Host.realtime - CL.cls.lastcmdsent > 10) {
      MSG.WriteByte(CL.cls.message, Protocol.clc.nop);
    }
  }

  if (CL.cls.demoplayback === true) {
    CL.cls.message.clear();
    return;
  }

  if (CL.cls.message.cursize === 0) {
    return;
  }

  if (NET.CanSendMessage(CL.cls.netcon) !== true) {
    Con.DPrint('CL.SendCmd: can\'t send\n');
    return;
  }

  if (NET.SendMessage(CL.cls.netcon, CL.cls.message) === -1) {
    Host.Error('CL.SendCmd: lost server connection');
  }

  // Con.DPrint('CL.SendCmd: sent ' + CL.cls.message.cursize + ' bytes, clearing\n');
  CL.cls.message.clear(); // CR: this clear during a local connect will break everything, make sure to only send an clear after signon 4

  CL.cls.lastcmdsent = Host.realtime;
};

CL.ServerInfo_f = function() {
  if (CL.cls.state !== CL.active.connected) {
    Con.Print(`Can't "${this.command}", not connected\n`);
    return;
  }

  for (const [key, value] of Object.entries(CL.cls.serverInfo)) {
    Con.Print(`${key}: ${value}\n`);
  }
};

CL.InitPmove = function() {
  CL.pmove = new Pmove.Pmove();
  CL.pmove.movevars = new Pmove.MoveVars();
};

CL.Init = async function() {
  CL.ClearState();
  CL.InitInput();
  CL.InitTEnts();
  CL.InitPmove();
  CL.name = new Cvar('_cl_name', 'player', Cvar.FLAG.ARCHIVE);
  CL.color = new Cvar('_cl_color', '0', Cvar.FLAG.ARCHIVE);
  CL.upspeed = new Cvar('cl_upspeed', '200');
  CL.forwardspeed = new Cvar('cl_forwardspeed', '400', Cvar.FLAG.ARCHIVE);
  CL.backspeed = new Cvar('cl_backspeed', '400', Cvar.FLAG.ARCHIVE);
  CL.sidespeed = new Cvar('cl_sidespeed', '350');
  CL.movespeedkey = new Cvar('cl_movespeedkey', '2.0');
  CL.yawspeed = new Cvar('cl_yawspeed', '140');
  CL.pitchspeed = new Cvar('cl_pitchspeed', '150');
  CL.anglespeedkey = new Cvar('cl_anglespeedkey', '1.5');
  CL.shownet = new Cvar('cl_shownet', '0');
  CL.nolerp = new Cvar('cl_nolerp', '1'); // CR: set to 1 for the time being, the code is janky as hell
  CL.lookspring = new Cvar('lookspring', '0', Cvar.FLAG.ARCHIVE);
  CL.lookstrafe = new Cvar('lookstrafe', '0', Cvar.FLAG.ARCHIVE);
  CL.sensitivity = new Cvar('sensitivity', '3', Cvar.FLAG.ARCHIVE);
  CL.m_pitch = new Cvar('m_pitch', '0.022', Cvar.FLAG.ARCHIVE);
  CL.m_yaw = new Cvar('m_yaw', '0.022', Cvar.FLAG.ARCHIVE);
  CL.m_forward = new Cvar('m_forward', '1', Cvar.FLAG.ARCHIVE);
  CL.m_side = new Cvar('m_side', '0.8', Cvar.FLAG.ARCHIVE);
  CL.rcon_password = new Cvar('rcon_password', '');
  CL.nopred = new Cvar('cl_nopred', '0', Cvar.FLAG.NONE, 'Enables/disables client-side prediction');
  Cmd.AddCommand('entities', CL.PrintEntities_f);
  Cmd.AddCommand('disconnect', CL.Disconnect);
  Cmd.AddCommand('record', CL.Record_f);
  Cmd.AddCommand('stop', CL.Stop_f);
  Cmd.AddCommand('playdemo', CL.PlayDemo_f);
  Cmd.AddCommand('timedemo', CL.TimeDemo_f);
  Cmd.AddCommand('rcon', CL.Rcon_f);
  Cmd.AddCommand('serverinfo', CL.ServerInfo_f);
  CL.svc_strings = Object.keys(Protocol.svc);

  if (!PR.QuakeJS?.ClientGameAPI) {
    return;
  }

  try {
    if (COM.CheckParm('-noquakejs')) {
      throw new Error('QuakeJS disabled');
    }

    PR.QuakeJS.ClientGameAPI.Init();
  } catch (e) {
    Con.PrintError('CL.Init: Failed to import QuakeJS client code, ' + e.message + '.\n');
  }
};

// parse

CL.svc_strings = [];

/**
 * @param {number} num edict Id
 * @returns {CL.Entity} client entity
 */
CL.EntityNum = function(num) {
  if (num < CL.entities.length) {
    return CL.entities[num];
  }
  for (; CL.entities.length <= num; ) {
    CL.entities.push(new CL.Entity(CL.entities.length));
  }
  return CL.entities[num];
};

CL.ParseStartSoundPacket = function() {
  const field_mask = MSG.ReadByte();
  const volume = ((field_mask & 1) !== 0) ? MSG.ReadByte() : 255;
  const attenuation = ((field_mask & 2) !== 0) ? MSG.ReadByte() * 0.015625 : 1.0;
  const entchannel = MSG.ReadShort();
  const sound_num = MSG.ReadByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = MSG.ReadCoordVector();
  S.StartSound(ent, channel, CL.state.sound_precache[sound_num], pos, volume / 255.0, attenuation);
};

CL.lastmsg = 0.0;
CL.KeepaliveMessage = function() {
  if ((SV.server.active === true) || (CL.cls.demoplayback === true)) {
    return;
  }
  const oldsize = NET.message.cursize;
  const olddata = new Uint8Array(8192);
  olddata.set(new Uint8Array(NET.message.data, 0, oldsize));
  let ret;
  for (;;) {
    ret = CL.GetMessage();
    switch (ret) {
      case 0:
        break;
      case 1:
        Host.Error('CL.KeepaliveMessage: received a message');
        break;
      case 2:
        if (MSG.ReadByte() !== Protocol.svc.nop) {
          Host.Error('CL.KeepaliveMessage: datagram wasn\'t a nop');
        }
        break;
      default:
        Host.Error('CL.KeepaliveMessage: CL.GetMessage failed');
    }
    if (ret === 0) {
      break;
    }
  }
  NET.message.cursize = oldsize;
  (new Uint8Array(NET.message.data, 0, oldsize)).set(olddata.subarray(0, oldsize));
  const time = Sys.FloatTime();
  if ((time - CL.lastmsg) < 5.0) {
    return;
  }
  CL.lastmsg = time;
  Con.Print('--> client to server keepalive\n');
  MSG.WriteByte(CL.cls.message, Protocol.clc.nop);
  NET.SendMessage(CL.cls.netcon, CL.cls.message);
  CL.cls.message.clear();
};

CL.ParsePmovevars = function() {
  CL.pmove.movevars.gravity = MSG.ReadFloat();
  CL.pmove.movevars.stopspeed = MSG.ReadFloat();
  CL.pmove.movevars.maxspeed = MSG.ReadFloat();
  CL.pmove.movevars.spectatormaxspeed = MSG.ReadFloat();
  CL.pmove.movevars.accelerate = MSG.ReadFloat();
  CL.pmove.movevars.airaccelerate = MSG.ReadFloat();
  CL.pmove.movevars.wateraccelerate = MSG.ReadFloat();
  CL.pmove.movevars.friction = MSG.ReadFloat();
  CL.pmove.movevars.waterfriction = MSG.ReadFloat();
  CL.pmove.movevars.entgravity = MSG.ReadFloat();

  Con.DPrint('Reconfigured Pmovevars.\n');
};

CL.ScoreSlot = class ClientScoreSlot {
  constructor() {
    this.name = '';
    this.entertime = 0.0;
    this.frags = 0;
    this.colors = 0;
    this.ping = 0;
  }
};

CL.ParseServerData = function() {
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = MSG.ReadByte();

  if (version !== Protocol.version) {
    Host.Error('Server returned protocol version ' + version + ', not ' + Protocol.version + '\n');
    return;
  }

  const isHavingClientQuakeJS = MSG.ReadByte() === 1;

  Con.DPrint('Server is running QuakeJS with ClientGameAPI provided.\n');

  // check if client is actually compatible with the server
  if (isHavingClientQuakeJS) {
    if (!PR.QuakeJS?.ClientGameAPI) {
      Host.Error('Server is running QuakeJS with client code provided,\nbut client code is not imported.\nTry clearing your cache and connect again.');
      return;
    }

    const name = MSG.ReadString();
    const author = MSG.ReadString();
    const version = [MSG.ReadByte(), MSG.ReadByte(), MSG.ReadByte()];

    const identification = PR.QuakeJS.identification;

    if (identification.name !== name || identification.author !== author) {
      Host.Error(`Cannot connect, because the server is running ${name} by ${author} and you are running ${name} by ${author}.`);
      return;
    }

    if (!PR.QuakeJS.ClientGameAPI.IsServerCompatible(version)) {
      Host.Error(`Server (v${version.join('.')}) is not compatible. You are running v${identification.version.join('.')}.\nTry clearing your cache and connect again.`);
      return;
    }
  }

  CL.state.maxclients = MSG.ReadByte();
  if ((CL.state.maxclients <= 0) || (CL.state.maxclients > 32)) {
    Con.Print('Bad maxclients (' + CL.state.maxclients + ') from server\n');
    return;
  }

  CL.state.scores = [];
  for (let i = 0; i < CL.state.maxclients; ++i) {
    CL.state.scores[i] = new CL.ScoreSlot();
  }

  CL.state.gametype = MSG.ReadByte(); // CR: unused (set to CL.state, but unused)
  CL.state.levelname = MSG.ReadString();

  CL.ParsePmovevars();

  Con.Print('\n\n\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n\n');
  Con.Print('\x02' + CL.state.levelname + '\n\n');

  CL.SetConnectingStep(15, 'Received server info');

  let str;
  let nummodels; const model_precache = [];
  for (nummodels = 1; ; ++nummodels) {
    str = MSG.ReadString();
    if (str.length === 0) {
      break;
    }
    model_precache[nummodels] = str;
  }
  let numsounds; const sound_precache = [];
  for (numsounds = 1; ; ++numsounds) {
    str = MSG.ReadString();
    if (str.length === 0) {
      break;
    }
    sound_precache[numsounds] = str;
  }

  CL.state.model_precache = [];
  CL.state.sound_precache = [];

  CL._processingServerDataState = 1;

  (async () => {
    let lastYield = Host.realtime;

    for (let i = 1; i < nummodels; ++i) {
      CL.SetConnectingStep(25 + (i / nummodels) * 20, 'Loading model: ' + model_precache[i]);
      CL.state.model_precache[i] = Mod.ForName(model_precache[i]);
      if (CL.state.model_precache[i] == null) {
        Con.Print('Model ' + model_precache[i] + ' not found\n');
        return;
      }

      if (Host.realtime - lastYield > 0.1) {
        await Q.yield();
        lastYield = Host.realtime;
      }
    }

    for (let i = 1; i < numsounds; ++i) {
      CL.SetConnectingStep(45 + (i / numsounds) * 20, 'Loading sound: ' + sound_precache[i]);
      CL.state.sound_precache[i] = await S.PrecacheSoundAsync(sound_precache[i]);

      if (Host.realtime - lastYield > 0.1) {
        await Q.yield();
        lastYield = Host.realtime;
      }
    }
  })().then(() => {
    CL._processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1];
    CL.EntityNum(0).model = CL.state.worldmodel;
    CL.SetConnectingStep(66, 'Preparing map');
    R.NewMap();
    Host.noclip_anglehack = false;
  });
};

CL.ParseClientdata = function(bits) {
  CL.cls.oldparsecountmod = CL.cls.parsecountmod;

  CL.ParseClientdataWinQuake(bits);
};

CL.ParseClientdataWinQuake = function(bits) {
  let i;

  CL.state.viewheight = ((bits & Protocol.su.viewheight) !== 0) ? MSG.ReadChar() : Protocol.default_viewheight;
  CL.state.idealpitch = ((bits & Protocol.su.idealpitch) !== 0) ? MSG.ReadChar() : 0.0;

  CL.state.mvelocity[1] = CL.state.mvelocity[0].copy();
  for (i = 0; i <= 2; ++i) {
    if ((bits & (Protocol.su.punch1 << i)) !== 0) {
      CL.state.punchangle[i] = MSG.ReadShort() / 90.0;
    } else {
      CL.state.punchangle[i] = 0.0;
    }
    if ((bits & (Protocol.su.velocity1 << i)) !== 0) {
      CL.state.mvelocity[0][i] = MSG.ReadChar() * 16.0;
    } else {
      CL.state.mvelocity[0][i] = 0.0;
    }
  }

  i = MSG.ReadLong();
  let j;
  if (CL.state.items !== i) {
    for (j = 0; j <= 31; ++j) {
      if ((((i >>> j) & 1) !== 0) && (((CL.state.items >>> j) & 1) === 0)) {
        CL.state.item_gettime[j] = CL.state.time;
      }
    }
    CL.state.items = i;
  }

  CL.state.onground = (bits & Protocol.su.onground) !== 0;
  CL.state.inwater = (bits & Protocol.su.inwater) !== 0;

  CL.state.stats[Def.stat.weaponframe] = ((bits & Protocol.su.weaponframe) !== 0) ? MSG.ReadByte() : 0;
  CL.state.stats[Def.stat.armor] = ((bits & Protocol.su.armor) !== 0) ? MSG.ReadByte() : 0;
  CL.state.stats[Def.stat.weapon] = ((bits & Protocol.su.weapon) !== 0) ? MSG.ReadByte() : 0;
  CL.state.stats[Def.stat.health] = MSG.ReadShort();
  CL.state.stats[Def.stat.ammo] = MSG.ReadByte();
  CL.state.stats[Def.stat.shells] = MSG.ReadByte();
  CL.state.stats[Def.stat.nails] = MSG.ReadByte();
  CL.state.stats[Def.stat.rockets] = MSG.ReadByte();
  CL.state.stats[Def.stat.cells] = MSG.ReadByte();
  if (COM.standard_quake === true) {
    CL.state.stats[Def.stat.activeweapon] = MSG.ReadByte();
  } else {
    CL.state.stats[Def.stat.activeweapon] = 1 << MSG.ReadByte();
  }
};

CL.nullcmd = new Protocol.UserCmd();

CL.Frame = class ClientFrame {
  constructor() {
    // -- client side --
    /** @type {Protocol.UserCmd} cmd that generated the frame */
    this.cmd = new Protocol.UserCmd();
    /** time cmd was sent off */
    this.sentTime = 0.0;
    /** sequence number to delta from, -1 = full update */
    this.deltaSequence = 0;

    // -- server side --
    /** time message was received, or -1 */
    this.receivedTime = 0.0;
    /** @type {CL.PlayerState[]} message received that reflects performing the usercmd */
    this.playerStates = [];
    /** @type {Protocol.EntityState[]} */
    this.packetEntities = [];
    /** true if the packet_entities delta was invalid */
    this.invalid = false;
  }
};

/**
 * ClientPlayerState is the information needed by a player entity
 * to do move prediction and to generate a drawable entity
 */
CL.PlayerState = class ClientPlayerState extends Protocol.EntityState {
  constructor() {
    super();
    /** @type {Protocol.UserCmd} last command for prediction */
    this.command = new Protocol.UserCmd();

    /** all player's won't be updated each frame */
    this.messagenum = 0;
    /** not the same as the packet time, because player commands come asyncronously */
    this.stateTime = 0.0;

    this.origin = new Vector();
    this.velocity = new Vector();

    this.weaponframe = 0;

    this.waterjumptime = 0.0;
    /** @type {?number} null in air, else pmove entity number */
    this.onground = null;
    this.oldbuttons = 0;

    Object.seal(this);
  }

  readFromMessage() {
    this.flags = MSG.ReadShort();
    this.origin.set(MSG.ReadCoordVector());
    this.frame = MSG.ReadByte();

    this.stateTime = CL.state.parsecounttime;

    if (this.flags & Protocol.pf.PF_MSEC) {
      const msec = MSG.ReadByte();
      this.stateTime -= (msec / 1000.0);
    }

    // TODO: stateTime, parsecounttime

    if (this.flags & Protocol.pf.PF_COMMAND) {
      this.command.set(MSG.ReadDeltaUsercmd(CL.nullcmd));
    }

    if (this.flags & Protocol.pf.PF_VELOCITY) {
      this.velocity.set(MSG.ReadCoordVector());
    }

    if (this.flags & Protocol.pf.PF_MODEL) {
      this.modelindex = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_EFFECTS) {
      this.effects = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_SKINNUM) {
      this.skin = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_WEAPONFRAME) {
      this.weaponframe = MSG.ReadByte();
    }
  }
};

CL.ParsePlayerinfo = function() {
  const num = MSG.ReadByte();

  if (num > CL.state.maxclients) {
    Sys.Error('CL.ParsePlayerinfo: num > maxclients');
  }

  const state = new CL.PlayerState();
  state.number = num;
  state.readFromMessage();
  state.angles.set(state.command.angles);

  // console.log('read player info', state, state.command);
};

CL.ParseStaticEntity = function() {
  const ent = new CL.Entity(-1);
  CL.static_entities[CL.state.num_statics++] = ent;
  ent.model = CL.state.model_precache[MSG.ReadByte()];
  ent.frame = MSG.ReadByte();
  ent.colormap = MSG.ReadByte();
  ent.skinnum = MSG.ReadByte();
  ent.msg_angles[0].set(MSG.ReadAngleVector());
  ent.msg_origins[0].set(MSG.ReadCoordVector());
  ent.updatePosition(false);
  R.currententity = ent;
  R.emins = ent.origin.copy().add(ent.model.mins);
  R.emaxs = ent.origin.copy().add(ent.model.maxs);
  R.SplitEntityOnNode(CL.state.worldmodel.nodes[0]);
};

CL.ParseStaticSound = function() {
  const org = MSG.ReadCoordVector();
  const soundId = MSG.ReadByte();
  const vol = MSG.ReadByte();
  const attn = MSG.ReadByte();
  S.StaticSound(CL.state.sound_precache[soundId], org, vol / 255.0, attn);
};

CL.Shownet = function(x) {
  if (CL.shownet.value === 2) {
    Con.Print((MSG.readcount <= 99 ? (MSG.readcount <= 9 ? '  ' : ' ') : '') +
			(MSG.readcount - 1) + ':' + x + '\n');
  }
};

CL.AppendChatMessage = function(name, message, direct) { // TODO: Client
  if (CL.state.chatlog.length > 5) {
    CL.state.chatlog.shift();
  }

  CL.state.chatlog.push({name, message, direct});
};

CL.PublishObituary = function(killerEdictId, victimEdictId, killerWeapon, killerItems) { // TODO: Client
  if (!CL.state.scores[killerEdictId + 1] || !CL.state.scores[victimEdictId + 1]) {
    return;
  }

  const killer = CL.state.scores[killerEdictId - 1].name;
  const victim = CL.state.scores[victimEdictId - 1].name;

  CL.AppendChatMessage(killer, `killed ${victim} using ${killerWeapon} (${killerItems})`, true);
};

CL.ParseServerCvars = function () {
  let count = MSG.ReadByte();

  while(count-- > 0) {
    const name = MSG.ReadString();
    const value = MSG.ReadString();

    CL.cls.serverInfo[name] = value;

    if (CL.cls.signon === 4) {
      Con.Print(`"${name}" changed to "${value}"\n`);
    }

    // special handling for cheats
    if (name === 'sv_cheats' && value === '0') {
      CL.ResetCheatCvars();
    }
  }
};

CL.PrintLastServerMessages = function() {
  if (CL._lastServerMessages.length > 0) {
    Con.Print('Last server messages:\n');
    for (const cmd of CL._lastServerMessages) {
      Con.Print(' ' + cmd + '\n');
    }
  }
}

/**
 * @type {number}
 * as long as we do not have a fully async architecture, we have to cheat
 * processingServerInfoState will hold off parsing and processing any further command
 * 0 - normal operation
 * 1 - we entered parsing serverdata, holding off any further processing
 * 2 - we are done processing, we can continue processing the rest
 * 3 - we need to re-enter the loop, but not reset the MSG pointer
 */
CL._processingServerDataState = 0;
CL._lastServerMessages = [];

CL.ParseServerMessage = function() {
  if (CL.shownet.value === 1) {
    Con.Print(NET.message.cursize + ' ');
  } else if (CL.shownet.value === 2) {
    Con.Print('------------------\n');
  }

  let entitiesReceived = 0

  CL.state.onground = false;

  if (CL._processingServerDataState === 1) {
    return;
  }

  if (CL._processingServerDataState === 3) {
    CL._processingServerDataState = 0;
  } else {
    CL._lastServerMessages = [];
    MSG.BeginReading();
    // Con.DPrint('CL.ParseServerMessage: reading server message\n' + NET.message.toHexString() + '\n');
  }

  let i;
  while (CL.cls.state > CL.active.disconnected) {
    if (CL._processingServerDataState > 0) {
      break;
    }

    if (MSG.badread === true) {
      CL.PrintLastServerMessages();
      MSG.PrintLastRead();
      Host.Error('CL.ParseServerMessage: Bad server message');
      return;
    }

    const cmd = MSG.ReadByte();

    if (cmd === -1) {
      CL.Shownet('END OF MESSAGE');
      break;
    }

    CL.Shownet('svc_' + CL.svc_strings[cmd]);
    CL._lastServerMessages.push(CL.svc_strings[cmd]);
    if (CL._lastServerMessages.length > 10) {
      CL._lastServerMessages.shift();
    }
    // Con.DPrint('CL.ParseServerMessage: parsing ' + CL.svc_strings[cmd] + ' ' + cmd + '\n');
    switch (cmd) {
      case Protocol.svc.nop:
        continue;
      case Protocol.svc.time:
        CL.state.mtime[1] = CL.state.mtime[0];
        CL.state.mtime[0] = MSG.ReadFloat();
        CL.state.lerp = null;
        continue;
      case Protocol.svc.clientdata:
        CL.ParseClientdata(MSG.ReadShort());
        continue;
      case Protocol.svc.version:
        i = MSG.ReadLong();
        if (i !== Protocol.version) {
          Host.Error('CL.ParseServerMessage: Server is protocol ' + i + ' instead of ' + Protocol.version + '\n');
        }
        continue;
      case Protocol.svc.disconnect:
        Host.EndGame(`Server disconnected: ${MSG.ReadString()}`);
        continue;
      case Protocol.svc.print:
        Con.Print(MSG.ReadString());
        continue;
      case Protocol.svc.centerprint: {
          const string = MSG.ReadString();
          SCR.CenterPrint(string);
          Con.Print(string + '\n'); // TODO: make it more stand out
        }
        continue;
      case Protocol.svc.chatmsg: // TODO: Client
        CL.AppendChatMessage(MSG.ReadString(), MSG.ReadString(), MSG.ReadByte() === 1);
        S.LocalSound(Con.sfx_talk);
        continue;
      case Protocol.svc.obituary: // TODO: Client
        CL.PublishObituary(MSG.ReadShort(), MSG.ReadShort(), MSG.ReadLong(), MSG.ReadLong());
        continue;
      case Protocol.svc.stufftext:
        Cmd.text += MSG.ReadString();
        continue;
      case Protocol.svc.damage: // TODO: Client
        V.ParseDamage();
        continue;
      case Protocol.svc.serverdata:
        CL.ParseServerData();
        SCR.recalc_refdef = true;
        continue;
      case Protocol.svc.changelevel: {
          const mapname = MSG.ReadString();
          CL.SetConnectingStep(5, 'Changing level to ' + mapname);
          CL.cls.signon = 0;
        }
        continue;
      case Protocol.svc.setangle:
        CL.state.viewangles.set(MSG.ReadAngleVector());
        continue;
      case Protocol.svc.setview: // TODO: Client
        CL.state.viewentity = MSG.ReadShort();
        continue;
      case Protocol.svc.lightstyle:
        i = MSG.ReadByte();
        if (i >= 64) {
          Sys.Error('svc_lightstyle > MAX_LIGHTSTYLES');
        }
        CL.lightstyle[i] = MSG.ReadString();
        continue;
      case Protocol.svc.sound:
        CL.ParseStartSoundPacket();
        continue;
      case Protocol.svc.stopsound:
        i = MSG.ReadShort(); // first couple of bits are entnum, last 4 bits are channel
        S.StopSound(i >> 3, i & 7);
        continue;
      case Protocol.svc.loadsound:
        i = MSG.ReadByte();
        CL.state.sound_precache[i] = S.PrecacheSound(MSG.ReadString());
        Con.DPrint(`CL.ParseServerMessage: load sound "${CL.state.sound_precache[i].name}" (${CL.state.sound_precache[i].state}) on slot ${i}\n`);
        continue;
      case Protocol.svc.updatename: { // TODO: Client
          i = MSG.ReadByte();
          if (i >= CL.state.maxclients) {
            Host.Error('CL.ParseServerMessage: svc_updatename > MAX_SCOREBOARD');
          }
          const newName = MSG.ReadString();
          // make sure the current player is aware of name changes
          if (CL.state.scores[i].name !== '' && newName !== '' && newName !== CL.state.scores[i].name) {
            Con.Print(`${CL.state.scores[i].name} renamed to ${newName}\n`);
          }
          CL.state.scores[i].name = newName;
        }
        continue;
      case Protocol.svc.updatefrags: // TODO: Client
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          Host.Error('CL.ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD');
        }
        CL.state.scores[i].frags = MSG.ReadShort();
        continue;
      case Protocol.svc.updatecolors: // TODO: Client
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          Host.Error('CL.ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD');
        }
        CL.state.scores[i].colors = MSG.ReadByte();
        continue;
      case Protocol.svc.updatepings: // TODO: Client?
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          Host.Error('CL.ParseServerMessage: svc_updatepings > MAX_SCOREBOARD');
        }
        CL.state.scores[i].ping = MSG.ReadShort() / 10;
        continue;
      case Protocol.svc.particle: // TODO: Client
        R.ParseParticleEffect();
        continue;
      case Protocol.svc.spawnbaseline:
        Con.Print('spawnbaseline no longer implemented\n');
        continue;
      case Protocol.svc.spawnstatic:
        CL.ParseStaticEntity();
        continue;
      case Protocol.svc.temp_entity: // TODO: Client
        CL.ParseTemporaryEntity();
        continue;
      case Protocol.svc.setpause:
        CL.state.paused = MSG.ReadByte() !== 0;
        if (CL.state.paused === true) {
          CDAudio.Pause();
        } else {
          CDAudio.Resume();
        }
        continue;
      case Protocol.svc.signonnum:
        i = MSG.ReadByte();
        if (i <= CL.cls.signon) {
          Host.Error('Received signon ' + i + ' when at ' + CL.cls.signon);
        }
        CL.cls.signon = i;
        CL.SignonReply();
        continue;
      case Protocol.svc.killedmonster: // TODO: Client
        ++CL.state.stats[Def.stat.monsters];
        continue;
      case Protocol.svc.foundsecret: // TODO: Client
        ++CL.state.stats[Def.stat.secrets];
        continue;
      case Protocol.svc.updatestat: // TODO: Client
        i = MSG.ReadByte();
        console.assert(i >= 0 && i < CL.state.stats.length, 'updatestat must be in range');
        CL.state.stats[i] = MSG.ReadLong();
        continue;
      case Protocol.svc.spawnstaticsound: // TODO: Client
        CL.ParseStaticSound();
        continue;
      case Protocol.svc.cdtrack:
        CL.state.cdtrack = MSG.ReadByte();
        MSG.ReadByte();
        if (((CL.cls.demoplayback === true) || (CL.cls.demorecording === true)) && (CL.cls.forcetrack !== -1)) {
          CDAudio.Play(CL.cls.forcetrack, true);
        } else {
          CDAudio.Play(CL.state.cdtrack, true);
        }
        continue;
      case Protocol.svc.intermission: // TODO: Client
        CL.state.intermission = 1;
        CL.state.completed_time = CL.state.time;
        SCR.recalc_refdef = true;
        continue;
      case Protocol.svc.finale: // TODO: Client
        CL.state.intermission = 2;
        CL.state.completed_time = CL.state.time;
        SCR.recalc_refdef = true;
        SCR.CenterPrint(MSG.ReadString());
        continue;
      case Protocol.svc.cutscene:
        CL.state.intermission = 3;
        CL.state.completed_time = CL.state.time;
        SCR.recalc_refdef = true;
        SCR.CenterPrint(MSG.ReadString());
        continue;
      case Protocol.svc.sellscreen: // TODO: Client
        Cmd.ExecuteString('help');
        continue;
      case Protocol.svc.pmovevars:
        CL.ParsePmovevars();
        continue;
      case Protocol.svc.playerinfo:
        CL.ParsePlayerinfo();
        continue;
      case Protocol.svc.packetentities:
        entitiesReceived++;
        CL.ParsePacketEntities(false);
        continue;
      case Protocol.svc.deltapacketentities:
        entitiesReceived++;
        CL.ParsePacketEntities(true);
        continue;
      case Protocol.svc.cvar:
        CL.ParseServerCvars();
        continue;
    }
    CL._lastServerMessages.pop(); // discard the last added command as it was invalid anyway
    CL.PrintLastServerMessages();
    Host.Error(`CL.ParseServerMessage: Illegible server message\n`);
    return;
  }

  // CR: this is a hack to make sure we don't get stuck in the signon state
  // TODO: rewrite this signon nonsense
  if (entitiesReceived > 0) {
    if (CL.cls.signon === 3) {
      CL.cls.signon = 4;
      CL.SignonReply();
    }
  }
};

// tent

CL.temp_entities = [];

CL.InitTEnts = function() {
  CL.sfx_wizhit = S.PrecacheSound('wizard/hit.wav');
  CL.sfx_knighthit = S.PrecacheSound('hknight/hit.wav');
  CL.sfx_tink1 = S.PrecacheSound('weapons/tink1.wav');
  CL.sfx_ric1 = S.PrecacheSound('weapons/ric1.wav');
  CL.sfx_ric2 = S.PrecacheSound('weapons/ric2.wav');
  CL.sfx_ric3 = S.PrecacheSound('weapons/ric3.wav');
  CL.sfx_r_exp3 = S.PrecacheSound('weapons/r_exp3.wav');
};

CL.ParseBeam = function(m) {
  const ent = MSG.ReadShort();
  const start = MSG.ReadCoordVector();
  const end = MSG.ReadCoordVector();
  let i; let b;
  for (i = 0; i <= 23; ++i) {
    b = CL.beams[i];
    if (b.entity !== ent) {
      continue;
    }
    b.model = m;
    b.endtime = CL.state.time + 0.2;
    b.start = start.copy();
    b.end = end.copy();
    return;
  }
  for (i = 0; i <= 23; ++i) {
    b = CL.beams[i];
    if ((b.model != null) && (b.endtime >= CL.state.time)) {
      continue;
    }
    b.entity = ent;
    b.model = m;
    b.endtime = CL.state.time + 0.2;
    b.start = start.copy();
    b.end = end.copy();
    return;
  }
  Con.Print('beam list overflow!\n');
};

CL.ParseTemporaryEntity = function() { // TODO: move this to ClientAPI
  const type = MSG.ReadByte();

  switch (type) {
    case Protocol.te.lightning1:
      CL.ParseBeam(Mod.ForName('progs/bolt.mdl', true));
      return;
    case Protocol.te.lightning2:
      CL.ParseBeam(Mod.ForName('progs/bolt2.mdl', true));
      return;
    case Protocol.te.lightning3:
      CL.ParseBeam(Mod.ForName('progs/bolt3.mdl', true));
      return;
    case Protocol.te.beam:
      CL.ParseBeam(Mod.ForName('progs/beam.mdl', true));
      return;
  }

  const pos = MSG.ReadCoordVector();

  switch (type) {
    case Protocol.te.wizspike:
      R.RunParticleEffect(pos, Vector.origin, 20, 20);
      S.StartSound(-1, 0, CL.sfx_wizhit, pos, 1.0, 1.0);
      return;
    case Protocol.te.knightspike:
      R.RunParticleEffect(pos, Vector.origin, 226, 20);
      S.StartSound(-1, 0, CL.sfx_knighthit, pos, 1.0, 1.0);
      return;
    case Protocol.te.spike:
      R.RunParticleEffect(pos, Vector.origin, 0, 10);
      return;
    case Protocol.te.superspike:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.gunshot:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.explosion: {
        R.ParticleExplosion(pos);
        const dl = CL.AllocDlight(0);
        dl.origin = pos.copy();
        dl.radius = 350.0;
        dl.die = CL.state.time + 0.5;
        dl.decay = 300.0;
        S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.tarexplosion:
      R.BlobExplosion(pos);
      S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
      return;
    case Protocol.te.lavasplash:
      R.LavaSplash(pos);
      return;
    case Protocol.te.teleport:
      R.TeleportSplash(pos);
      return;
    case Protocol.te.explosion2: {
        const colorStart = MSG.ReadByte();
        const colorLength = MSG.ReadByte();
        R.ParticleExplosion2(pos, colorStart, colorLength);
        const dl = CL.AllocDlight(0);
        dl.origin = pos.copy();
        dl.radius = 350.0;
        dl.die = CL.state.time + 0.5;
        dl.decay = 300.0;
        S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
      }
      return;
  }

  Sys.Error(`CL.ParseTEnt: bad type ${type}`);
};

CL.NewTempEntity = function() {
  const ent = new CL.Entity(-1);
  CL.temp_entities[CL.num_temp_entities++] = ent;
  CL.visedicts[CL.numvisedicts++] = ent;
  return ent;
};

CL.UpdateTEnts = function() {
  CL.num_temp_entities = 0;
  let i; let b; let yaw; let pitch; let ent;
  for (i = 0; i <= 23; ++i) {
    b = CL.beams[i];
    if ((b.model == null) || (b.endtime < CL.state.time)) {
      continue;
    }
    if (b.entity === CL.state.viewentity) {
      b.start = CL.entities[CL.state.viewentity].origin.copy();
    }
    const dist = b.end.copy().subtract(b.start);
    if ((dist[0] === 0.0) && (dist[1] === 0.0)) {
      yaw = 0;
      pitch = dist[2] > 0.0 ? 90 : 270;
    } else {
      yaw = (Math.atan2(dist[1], dist[0]) * 180.0 / Math.PI) || 0;
      if (yaw < 0) {
        yaw += 360;
      }
      pitch = (Math.atan2(dist[2], Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1])) * 180.0 / Math.PI) || 0;
      if (pitch < 0) {
        pitch += 360;
      }
    }
    const org = b.start.copy();
    let d = dist.len();
    if (d !== 0.0) {
      dist.normalize();
    }
    for (; d > 0.0; ) {
      ent = CL.NewTempEntity();
      ent.origin = org.copy();
      ent.model = b.model;
      ent.angles = new Vector(pitch, yaw, Math.random() * 360.0);
      org[0] += dist[0] * 30.0;
      org[1] += dist[1] * 30.0;
      org[2] += dist[2] * 30.0;
      d -= 30.0;
    }
  }
};

CL.frames = [];
CL.parsecount = 0;

CL.PredictMove = function() {
  if (CL.nopred.value !== 0) {
    return;
  }

  // TODO
};

/**
 * @param {Pmove.PmovePlayer} pmove pmove for player
 * @param {CL.PlayerState} from previous state
 * @param {CL.PlayerState} to current state
 * @param {Protocol.UserCmd} u player commands
 */
CL.PredictUsercmd = function(pmove, from, to, u) {
  // split long commands
  if (u.msec > 50) {
    const temp = new CL.PlayerState();
    const split = u.copy();
    split.msec /= 2;
    CL.PredictUsercmd(from, temp, split);
    CL.PredictUsercmd(temp, to, split);
    return;
  }

  pmove.origin.set(from.origin);
  pmove.angles.set(u.angles);
  pmove.velocity.set(from.velocity);

  pmove.oldbuttons = from.oldbuttons;
  pmove.waterjumptime = from.waterjumptime;
  pmove.dead = false; // TODO: cl.stats[STAT_HEALTH] <= 0;
  pmove.spectator = false;

  pmove.cmd.set(u);

  pmove.move();

  to.waterjumptime = pmove.waterjumptime;
  to.oldbuttons = pmove.cmd.buttons;
  to.origin.set(pmove.origin);
  to.velocity.set(pmove.velocity);
  to.angles.set(pmove.angles);
  to.onground = pmove.onground;
  to.weaponframe = from.weaponframe;
};

/**
 * Calculate the new position of players, without other player clipping.
 * We do this to set up real player prediction.
 * Players are predicted twice, first without clipping other players,
 * then with clipping against them.
 * This sets up the first phase.
 * @param {boolean} dopred full prediction, if true
 */
CL.SetUpPlayerPrediction = function (dopred) {
  // const frame = CL.frames[CL.parsecount & Protocol.update_mask];
};

/**
 * Builds the visedicts list.
 * Made up of: clients, packet_entities, nails, and tents.
 */
CL.EmitEntities = function() {
  if (CL.cls.state !== CL.active.connected) {
    return;
  }

  // reset all visible entities
  CL.numvisedicts = 0;

  for (let i = 1; i < CL.entities.length; i++) {
    const clent = CL.entities[i];

    // freed entity
    if (clent.free) {
      continue;
    }

    // invisible entity
    if (!clent.model || (clent.effects & Mod.effects.nodraw)) {
      continue;
    }

    const oldorg = clent.origin_old ? clent.origin_old : clent.origin;

    // apply prediction for non-player entities
    clent.updatePosition(clent.num !== CL.state.viewentity);

    // do not render the view entity
    if (i === CL.state.viewentity) {
      continue;
    }

    // TODO: clent.emit()

    clent.emit();

    if ((clent.model.flags & Mod.flags.rotate) !== 0) {
      clent.angles[1] = Vector.anglemod(CL.state.time * 100.0);
    }
    if ((clent.effects & Mod.effects.brightfield) !== 0) {
      R.EntityParticles(clent);
    }
    if ((clent.effects & Mod.effects.muzzleflash) !== 0) {
      const dl = CL.AllocDlight(i);
      const fv = clent.angles.angleVectors().forward;
      dl.origin = new Vector(
        clent.origin[0] + 18.0 * fv[0],
        clent.origin[1] + 18.0 * fv[1],
        clent.origin[2] + 16.0 + 18.0 * fv[2],
      );
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.minlight = 32.0;
      dl.die = CL.state.mtime[0] + 0.1;
      // dl.color = new Vector(1.0, 0.95, 0.85);
    }
    if ((clent.effects & Mod.effects.brightlight) !== 0) {
      const dl = CL.AllocDlight(i);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2] + 16.0);
      dl.radius = 400.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
    }
    if ((clent.effects & Mod.effects.dimlight) !== 0) {
      const dl = CL.AllocDlight(i);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2] + 16.0);
      dl.radius = 200.0 + Math.random() * 32.0;
      dl.die = CL.state.time + 0.001;
      // dl.color = new Vector(0.5, 0.5, 1.0);
    }
    if ((clent.model.flags & Mod.flags.gib) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 2);
    } else if ((clent.model.flags & Mod.flags.zomgib) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 4);
    } else if ((clent.model.flags & Mod.flags.tracer) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 3);
    } else if ((clent.model.flags & Mod.flags.tracer2) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 5);
    } else if ((clent.model.flags & Mod.flags.rocket) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 0);
      const dl = CL.AllocDlight(i);
      dl.origin = new Vector(clent.origin[0], clent.origin[1], clent.origin[2]);
      dl.radius = 200.0;
      dl.die = CL.state.time + 0.01;
    } else if ((clent.model.flags & Mod.flags.grenade) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 1);
    } else if ((clent.model.flags & Mod.flags.tracer3) !== 0) {
      R.RocketTrail(oldorg, clent.origin, 6);
    }

    CL.visedicts[CL.numvisedicts++] = clent;
  }

  // TODO: projectiles
  // TODO: temporary entities
};

CL.ParsePacketEntities = function(isDeltaUpdate) {
  while (true) {
    const edictNum = MSG.ReadShort();

    if (edictNum === 0) {
      break;
    }

    /** @type {CL.Entity} */
    const clent = CL.EntityNum(edictNum);

    const bits = MSG.ReadShort();

    if (bits & Protocol.u.classname) {
      // TODO: initialize the right client entity class here
      clent.classname = MSG.ReadString();
    }

    if (bits & Protocol.u.free) {
      clent.free = MSG.ReadByte() !== 0;
    }

    if (bits & Protocol.u.model) {
      const modelindex = MSG.ReadByte();
      clent.model = CL.state.model_precache[modelindex] || null;

      if (clent.model) {
        clent.syncbase = clent.model.random ? Math.random() : 0.0;
      }
    }

    if (bits & Protocol.u.frame) {
      clent.frame = MSG.ReadByte();
    }

    if (bits & Protocol.u.colormap) {
      clent.colormap = MSG.ReadByte();
    }

    if (bits & Protocol.u.skin) {
      clent.skinnum = MSG.ReadByte();
    }

    if (bits & Protocol.u.effects) {
      clent.effects = MSG.ReadByte();
    }

    if (bits & Protocol.u.solid) {
      MSG.ReadByte(); // TODO: solid
    }

    const origin = clent.msg_origins[0];
    const angles = clent.msg_angles[0];

    const origin1 = clent.msg_origins[1];
    const angles1 = clent.msg_angles[1];

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        origin1[i] = origin[i];
        origin[i] = MSG.ReadCoord();
      }

      if (bits & (Protocol.u.angle1 << i)) {
        angles1[i] = angles[i];
        angles[i] = MSG.ReadAngle();
      }
    }

    clent.updatecount++;

    clent.msg_time[1] = clent.msg_time[0];
    clent.msg_time[0] = CL.state.mtime[0];

    if (!isDeltaUpdate) {
      clent.msg_origins[1].set(clent.msg_origins[0]);
      clent.msg_angles[1].set(clent.msg_angles[0]);
      clent.msg_time[1] = clent.msg_time[0];
    }

    if (clent.free) {
      // make sure that we clear this ClientEntity before we throw it back in
      clent.freeEdict();
    }
  }

  // TODO: send an acknowledge command back
};
