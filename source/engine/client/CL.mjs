import MSG, { SzBuffer } from '../network/MSG.mjs';
import Q from '../common/Q.mjs';
import * as Def from '../common/Def.mjs';
import * as Protocol from '../network/Protocol.mjs';
import Vector from '../../shared/Vector.mjs';
import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { MoveVars, Pmove, PmovePlayer } from '../common/Pmove.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';
import { solid } from '../../shared/Defs.mjs';
import { QSocket } from '../network/NetworkDrivers.mjs';
import ClientDemos from './ClientDemos.mjs';
import ClientInput from './ClientInput.mjs';
import { HostError } from '../common/Errors.mjs';
import ClientEntities, { ClientDlight, ClientEdict } from './ClientEntities.mjs';
import { ClientMessages, ClientPlayerState } from './ClientMessages.mjs';

/** @typedef {import('./Sound.mjs').SFX} SFX */

let { COM, Con, Draw, Host, IN, Mod, NET, PR, R, S, SCR, SV, Sbar, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
  IN = registry.IN;
  Mod = registry.Mod;
  NET = registry.NET;
  PR = registry.PR;
  R = registry.R;
  S = registry.S;
  SCR = registry.SCR;
  SV = registry.SV;
  Sbar = registry.Sbar;
  V = registry.V;
});

export default class CL {
  /** @deprecated – use Def */
  static cshift = Def.contentShift;

  /** @deprecated – use Def */
  static active = Def.clientConnectionState;

  /** @type {Pmove} */
  static pmove = new Pmove();

  static #clientDemos = new ClientDemos();

  /** Client Static State – everything here persists across multiple maps or are not directly game related */
  static cls = class ClientStaticState { // forced to be a class to make eslint/tslint scream about issues
    /**
     * Connection signon state:
     * - 0 = when connecting, waiting for server data, precache, cvars
     * - 1 = connected, received things to load the map, prespawn
     * - 2 = received prespawn (statics, baseline), sending name, color
     * - 3 = spawning the player in game, sending stats
     * - 4 = connected, in game, ready to play
     * @type {0|1|2|3|4}
     */
    static signon = 0;
    static state = 0;
    static spawnparms = '';

    /** @type {SzBuffer} outgoing client messages */
    static message = new SzBuffer(8192, 'CL.cls.message');
    /** @type {QSocket} current connection */
    static netcon = null;
    /** @type {{ message: string, percentage: number }?} */
    static connecting = null;

    /** @type {{[key: string]: string}} keeps track of Server Cvars (sv_cheats, etc.) */
    static serverInfo = {};

    static lastcmdsent = 0;

    /** interval to simulate movement */
    static movearound = null;

    static get demoplayback() {
      return CL.#clientDemos.demoplayback;
    }

    static get demorecording() {
      return CL.#clientDemos.demorecording;
    }

    static get demonum() {
      return CL.#clientDemos.demonum;
    }

    static set demonum(value) {
      CL.#clientDemos.demonum = value;
    }

    static get latency() {
      return CL.state.scores[CL.state.playernum].ping;
    }

    static clear() {
      this.message.clear();
      this.serverInfo = {};
      this.lastcmdsent = 0;

      if (this.movearound) {
        clearInterval(this.movearound);
        this.movearound = null;
      }
    }
  };

  static state = class ClientState {
    static clientEntities = new ClientEntities();
    static clientMessages = new ClientMessages();
    static movemessages = 0;
    static cmd = new Protocol.UserCmd();
    static lastcmd = new Protocol.UserCmd();
    /** @type {number[]} */
    static stats = Object.values(Def.stat).fill(0);
    static items = 0;
    static item_gettime = new Array(32).fill(0.0);
    static faceanimtime = 0.0;
    static cshifts = [
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
      [0.0, 0.0, 0.0, 0.0],
    ];
    static viewangles = new Vector();
    // static velocity = new Vector();
    static get velocity() { return this.playerentity.velocity; }
    static punchangle = new Vector();
    static idealpitch = 0.0;
    static pitchvel = 0.0;
    static driftmove = 0.0;
    static laststop = 0.0;
    static intermission = 0;
    /** @type {number} time when the level was completed */
    static completed_time = 0;
    static mtime = [0.0, 0.0];
    /** @type {number} current time */
    static time = 0.0;
    /** @type {number} latency */
    static latency = 0.0;
    /** @type {number} last received message from server time */
    static last_received_message = 0.0;
    static viewentity = 0;
    /** @type {ClientEdict} */
    static viewent = null;
    static cdtrack = 0;
    static looptrack = 0;
    /** @type {{name: string, message: string, direct: boolean}[]} chat messages */
    static chatlog = [];
    /** @type {string[]} */
    static model_precache = [];
    /** @type {SFX[]} */
    static sound_precache = [];
    static levelname = null;
    static gametype = 0;
    static onground = false;
    /** @type {number} maxplayers of the current game */
    static maxclients = 1;
    /** @type {CL.ScoreSlot[]} */
    static scores = [];
    static worldmodel = null;
    static viewheight = 0;
    static inwater = false;
    static nodrift = false;
    static get playernum() {
      return this.viewentity - 1;
    }
    /** @type {ClientPlayerState} */
    static get playerstate() {
      return this.clientMessages.playerstates[CL.state.playernum];
    }
    /** @type {ClientEdict} */
    static get playerentity() {
      return this.clientEntities.getEntity(CL.state.viewentity);
    }
    static gameAPI = null;
    static paused = false;

    static clear() {
      this.clientMessages.clear();
      this.clientEntities.clear();
      this.movemessages = 0;
      this.cmd = new Protocol.UserCmd();
      this.lastcmd = new Protocol.UserCmd();
      this.stats = Object.values(Def.stat).map(() => 0);
      this.items = 0;
      this.item_gettime.fill(0.0);
      this.faceanimtime = 0.0;
      this.cshifts = [
        [0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0],
      ];
      this.viewangles = new Vector();
      this.punchangle = new Vector();
      this.idealpitch = 0.0;
      this.pitchvel = 0.0;
      this.driftmove = 0.0;
      this.laststop = 0.0;
      this.intermission = 0;
      this.completed_time = 0;
      this.mtime.fill(0.0);
      this.time = 0.0;
      this.last_received_message = 0.0;
      this.viewentity = 0;
      this.viewent = new ClientEdict(-1);
      this.cdtrack = 0;
      this.looptrack = 0;
      this.chatlog.length = 0;
      this.model_precache.length = 0;
      this.sound_precache.length = 0;
      this.levelname = null;
      this.gametype = 0;
      this.onground = false;
      this.maxclients = 1;
      this.scores.length = 0;
      this.worldmodel = null;
      this.viewheight = 0;
      this.inwater = false;
      this.nodrift = false;
      this.paused = false;
    }
  };

  /** @type {Cvar} */ static nolerp = null;
  /** @type {Cvar} */ static rcon_password = null;
  /** @type {Cvar} */ static shownet = null;
  /** @type {Cvar} */ static name = null;
  /** @type {Cvar} */ static color = null;
  /** @type {Cvar} */ static upspeed = null;
  /** @type {Cvar} */ static forwardspeed = null;
  /** @type {Cvar} */ static backspeed = null;
  /** @type {Cvar} */ static sidespeed = null;
  /** @type {Cvar} */ static movespeedkey = null;
  /** @type {Cvar} */ static yawspeed = null;
  /** @type {Cvar} */ static pitchspeed = null;
  /** @type {Cvar} */ static anglespeedkey = null;
  /** @type {Cvar} */ static lookspring = null;
  /** @type {Cvar} */ static lookstrafe = null;
  /** @type {Cvar} */ static sensitivity = null;
  /** @type {Cvar} */ static m_pitch = null;
  /** @type {Cvar} */ static m_yaw = null;
  /** @type {Cvar} */ static m_forward = null;
  /** @type {Cvar} */ static m_side = null;
  /** @type {Cvar} */ static nopred = null;

  /** @type {SFX} */ static sfx_wizhit = null;
  /** @type {SFX} */ static sfx_knighthit = null;
  /** @type {SFX} */ static sfx_tink1 = null;
  /** @type {SFX} */ static sfx_ric1 = null;
  /** @type {SFX} */ static sfx_ric2 = null;
  /** @type {SFX} */ static sfx_ric3 = null;
  /** @type {SFX} */ static sfx_r_exp3 = null;
  /** @type {SFX} */ static sfx_talk = null;

  static StartDemos(demos) {
    this.#clientDemos.startDemos(demos);
  }

  static StartPlayback(demoname, timedemo = false) {
    this.#clientDemos.startPlayback(demoname, timedemo);
  }

  static StopPlayback() { // public, by Host.js
    this.#clientDemos.stopPlayback();
  }

  static StartRecording(demoname, forcetrack = -1) {
    this.#clientDemos.startRecording(demoname, forcetrack);
  }

  static StopRecording() {
    this.#clientDemos.stopRecording();
  }

  static NextDemo() { // public, by Host.js, M.js
    this.#clientDemos.playNext();
  };

  static Stop_f = class StopRecordingCommand extends ConsoleCommand { // private
    run() {
      if (this.client) {
        return;
      }

      CL.StopRecording();
    }
  };

  static Record_f = class StartRecordingCommand extends ConsoleCommand { // private
    run(demoname, map, track) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: record <demoname> [<map> [cd track]]\n');
        return;
      }

      if (demoname.indexOf('..') !== -1) {
        Con.PrintWarning('Relative pathnames are not allowed.\n');
        return;
      }

      if (map === undefined && CL.cls.state === Def.clientConnectionState.connected) {
        Con.PrintWarning('Can not record - already connected to server\nClient demo recording must be started before connecting\n');
        return;
      }

      Cmd.ExecuteString('map ' + map);

      CL.StartRecording(demoname, Q.atoi(track));
    }
  };

  static StartDemos_f = class StartDemosCommand extends ConsoleCommand {
    run(...demos) {
      if (this.client) {
        return;
      }

      if (demos.length === 0) {
        Con.Print('Usage: startdemos <demoname1> [<demoname2> ...]\n');
        return;
      }

      Con.Print(demos.length + ' demo(s) in loop\n');

      Host.ScheduleForNextFrame(() => {
        CL.StartDemos(demos);
      });
    }
  };

  static Demos_f = class NextDemoCommand extends ConsoleCommand {
    run() {
      if (CL.#clientDemos.demonum === -1) {
        CL.#clientDemos.demonum = 1;
      }

      CL.Disconnect();
      CL.#clientDemos.playNext();
    }
  };

  static StopDemo_f = class StopPlaybackCommand extends ConsoleCommand {
    run() {
      if (this.client) {
        return;
      }

      if (!CL.#clientDemos.demoplayback) {
        return;
      }

      CL.StopPlayback();
    }
  };

  static PlayDemo_f = class StartPlaybackCommand extends ConsoleCommand {
    run(demoname) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: playdemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      CL.StartPlayback(demoname);
    }
  };

  static TimeDemo_f = class TimeDemoCommand extends ConsoleCommand { // private
    run(demoname) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: timedemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      CL.StartPlayback(demoname, true);
    }
  };

  /**
   * @private
   * @returns {number}
   */
  static GetMessage() { // private
    // demos are basically recorded server messages
    if (this.#clientDemos.demoplayback === true) {
      return this.#clientDemos.getMessage();
    };

    let r = null;

    while (true) {
      r = NET.GetMessage(CL.cls.netcon);

      if (r !== 1 && r !== 2) {
        return r;
      }

      if (NET.message.cursize === 1 && (new Uint8Array(NET.message.data, 0, 1))[0] === Protocol.svc.nop) {
        Con.Print('<-- server to client keepalive\n');
      } else {
        break;
      }
    }

    if (this.#clientDemos.demorecording) {
      this.#clientDemos.writeDemoMessage();
    }

    return r;
  }

  /**
   * @param {number} percentage percentage of the connection step
   * @param {string} message loading message
   */
  static SetConnectingStep(percentage, message) { // public, by Host.js, probably cleaning up required
    if (percentage === null && message === null) {
      this.cls.connecting = null;
      return;
    }

    Con.DPrint(`${percentage.toFixed(0).padStart(3, ' ')}% ${message}\n`);

    SCR.con_current = 0; // force Console to disappear

    percentage = Math.round(percentage);

    this.cls.connecting = {
      percentage,
      message,
    };
  }

  static Rcon_f = class extends ConsoleCommand {
    run(...args) { // private
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
      MSG.WriteString(CL.cls.message, this.args.substring(5));
    }
  };

  static Draw() { // public, called by SCR.js // FIXME: maybe put that into M?, called by SCR
    if (this.cls.connecting !== null && this.cls.state !== Def.clientConnectionState.disconnected) {
      const x0 = 32, y0 = 32;
      Draw.BlackScreen();
      Draw.String(x0, y0, 'Connecting', 2);
      Draw.StringWhite(x0, y0 + 32, this.cls.connecting.message);

      const len = 30;
      const p = this.cls.connecting.percentage;
      Draw.String(x0, y0 + 48, `[${'#'.repeat(p / 100 * len).padEnd(len, '_')}] ${p.toFixed(0).padStart(0, ' ')}%`);
    }
  }

  static DrawHUD() {
    if (this.state.gameAPI) {
      this.state.gameAPI.draw();
    }

    Sbar.Draw(); // TODO: let Client decide whether it wants to draw the statusbar or not
  }

  static RunThink() {
    this.state.clientEntities.think();
  }

  static ResetCheatCvars() { // private
    for (const cvar of Cvar.Filter((/** @type {Cvar} */cvar) => (cvar.flags & Cvar.FLAG.CHEAT) !== 0)) {
      cvar.reset();
    }
  };

  static ClearState() { // private
    if (!SV.server.active) {
      Con.DPrint('Clearing memory\n');
      Mod.ClearAll();
      this.cls.signon = 0;
    }

    CL.SetConnectingStep(null, null);

    this.state.clear();
    this.cls.clear();
  }

  static ParseLightstylePacket() { // private
    const i = MSG.ReadByte();
    if (i >= Def.limits.lightstyles) {
      throw new HostError('svc_lightstyle > MAX_LIGHTSTYLES');
    }

    this.state.clientEntities.setLightstyle(i, MSG.ReadString());
  }

  /**
   * Will get the client entity by its edict number.
   * If it’s not found, it will return a new ClientEdict with the given number.
   * This should never be called to allocate entities explictly, use `ClientEntities.allocateClientEntity` instead.
   * @param {number} num edict Id
   * @returns {ClientEdict} client entity
   */
  static EntityNum(num) {
    return this.state.clientEntities.getEntity(num);
  };

  /**
   * Allocates a dynamic light for the given entity Id.
   * @param {number} num edict Id, can be 0
   * @returns {ClientDlight} dynamic light
   */
  static AllocDlight(num) {
    return this.state.clientEntities.allocateDynamicLight(num);
  }

  /**
   * Builds the visedicts list.
   * Made up of: clients, packet_entities, nails, and tents.
   */
  static EmitEntities() { // public, by Host.js
    if (this.cls.state !== Def.clientConnectionState.connected) {
      return;
    }

    this.state.clientEntities.emit();
  }

  static SetSolidEntities() {
    this.pmove.clearEntities();

    // NOTE: not adding world, it’s already in pmove AND we are not adding static entities, they are never affecting the game play

    for (const clent of this.state.clientEntities.getEntities()) {
      if (clent.num === 0 || !clent.model) {
        continue;
      }

      CL.pmove.addEntity(clent, clent.solid === solid.SOLID_BSP ? clent.model : null);
    }
  }
};

CL.Disconnect = function() { // public, by Host.js
  CL.SetConnectingStep(null, null);
  S.StopAllSounds();
  if (CL.state.gameAPI) {
    CL.state.gameAPI.shutdown();
  }
  if (CL.cls.demoplayback === true) {
    CL.StopPlayback();
  } else if (CL.cls.state === CL.active.connecting) {
    CL.cls.state = CL.active.disconnected;
    CL.cls.message.clear();
  } else if (CL.cls.state === CL.active.connected) {
    if (CL.cls.demorecording === true) {
      Cmd.ExecuteString('stopdemo\n');
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
  // CL.cls.demoplayback = CL.cls.timedemo = false;
  CL.cls.signon = 0;
  CL.ResetCheatCvars();
};

CL.Connect = function(sock) { // public, by NET.js, deprecated
  CL.cls.netcon = sock;
  Con.DPrint('CL.Connect: connected to ' + sock.address + '\n');
  CL.cls.demonum = -1;
  CL.cls.state = CL.active.connected;
  CL.cls.signon = 0;
  CL.SetConnectingStep(10, 'Connected to ' + sock.address);
};

CL.EstablishConnection = function(host) { // public, by Host.js
  if (CL.cls.demoplayback === true) {
    return;
  }
  CL.Disconnect();
  CL.SetConnectingStep(5, 'Connecting to ' + host);

  const sock = NET.Connect(host);

  if (sock === null) {
    throw new HostError('CL.EstablishConnection: connect failed\n');
  }

  CL.Connect(sock);
};

CL.SignonReply = function() { // private
  Con.DPrint('CL.SignonReply: ' + CL.cls.signon + '\n');
  switch (CL.cls.signon) {
    case 1:
      CL.SetConnectingStep(90, 'Waiting for server data');
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

CL.PrintEntities_f = function() { // private
  Con.Print('Entities:\n');
  for (const ent of CL.state.clientEntities.getEntities()) {
    if (ent.model === null) {
      continue;
    }

    Con.Print(`${ent}\n`);
  }
};

CL.ReadFromServer = function() { // public, by Host.js
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
        throw new HostError('CL.ReadFromServer: lost server connection');
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

  // CL.RelinkEntities();
  // CL.UpdateTEnts();
};

CL.SendCmd = function() { // public, by Host.js
  if (CL.cls.state !== CL.active.connected) {
    return;
  }

  if (CL.cls.signon === 4) {
    ClientInput.BaseMove();
    IN.Move();
    ClientInput.SendMove();

    // always include a read back of the time
    MSG.WriteByte(CL.cls.message, Protocol.clc.sync);
    MSG.WriteFloat(CL.cls.message, CL.state.clientMessages.mtime[0]);
  }

  if (CL.cls.demoplayback) {
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
    throw new HostError('CL.SendCmd: lost server connection');
  }

  // Con.DPrint('CL.SendCmd: sent ' + CL.cls.message.cursize + ' bytes, clearing\n');
  CL.cls.message.clear(); // CR: this clear during a local connect will break everything, make sure to only send an clear after signon 4

  CL.cls.lastcmdsent = Host.realtime;
};

CL.ServerInfo_f = function() { // private
  if (CL.cls.state !== CL.active.connected) {
    Con.Print(`Can't "${this.command}", not connected\n`);
    return;
  }

  for (const [key, value] of Object.entries(CL.cls.serverInfo)) {
    Con.Print(`${key}: ${value}\n`);
  }
};

CL.MoveAround_f = function() { // private
  if (CL.cls.state !== CL.active.connected) {
    Con.Print(`Can't "${this.command}", not connected\n`);
    return;
  }

  if (CL.cls.signon !== 4) {
    Con.Print('You must wait for the server to send you the map before moving around.\n');
    return;
  }

  if (CL.cls.movearound !== null) {
    clearInterval(CL.cls.movearound);
    CL.cls.movearound = null;
    Con.Print('Stopped moving around.\n');
    return;
  }

  CL.cls.movearound = setInterval(() => {
    if (CL.cls.state !== CL.active.connected) {
      Con.Print('No longer connected, stopped moving around.\n');
      clearInterval(CL.cls.movearound);
      CL.cls.movearound = null;
      return;
    }

    if (Math.random() < 0.1) {
      if (Math.random() < 0.5) {
        Cmd.text += '+back; wait; -back;\n';
      } else {
        Cmd.text += '+forward; wait; -forward;\n';
      }
    }

    if (Math.random() < 0.5) {
      Cmd.text += '+jump; wait; -jump;\n';
    }

    if (Math.random() < 0.2) {
      Cmd.text += '+attack; wait; -attack;\n';
    }
  }, 1000);

  Con.Print('Started moving around.\n');
};

CL.InitPmove = function() { // private
  CL.pmove = new Pmove();
  CL.pmove.movevars = new MoveVars();
};

CL.Init = async function() { // public, by Host.js
  CL.ClearState();
  ClientInput.Init();
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
  CL.nolerp = new Cvar('cl_nolerp', '0', Cvar.FLAG.ARCHIVE);
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
  Cmd.AddCommand('startdemos', CL.StartDemos_f);
  Cmd.AddCommand('demos', CL.Demos_f);
  Cmd.AddCommand('stopdemo', CL.StopDemo_f);
  Cmd.AddCommand('rcon', CL.Rcon_f);
  Cmd.AddCommand('serverinfo', CL.ServerInfo_f);
  Cmd.AddCommand('movearound', CL.MoveAround_f);
  CL.svc_strings = Object.keys(Protocol.svc); // FIXME: turn into a map

  CL.sfx_talk = S.PrecacheSound('misc/talk.wav');

  if (!PR.QuakeJS?.ClientGameAPI) {
    return;
  }

  try {
    if (COM.CheckParm('-noquakejs')) {
      throw new Error('QuakeJS disabled');
    }

    PR.QuakeJS.ClientGameAPI.Init(ClientEngineAPI);
  } catch (e) {
    Con.PrintError('CL.Init: Failed to import QuakeJS client code, ' + e.message + '.\n');
  }
};

// parse

CL.svc_strings = [];

CL.ParseStartSoundPacket = function() { // private
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

CL.ParsePmovevars = function() { // private
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

CL.ParseServerData = function() { // private
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = MSG.ReadByte();

  if (version !== Protocol.version) {
    throw new HostError('Server returned protocol version ' + version + ', not ' + Protocol.version + '\n');
  }

  const isHavingClientQuakeJS = MSG.ReadByte() === 1;

  // check if client is actually compatible with the server
  if (isHavingClientQuakeJS) {
    Con.DPrint('Server is running QuakeJS with ClientGameAPI provided.\n');

    if (!PR.QuakeJS?.ClientGameAPI) {
      throw new HostError('Server is running QuakeJS with client code provided,\nbut client code is not imported.\nTry clearing your cache and connect again.');
    }

    const name = MSG.ReadString();
    const author = MSG.ReadString();
    const version = [MSG.ReadByte(), MSG.ReadByte(), MSG.ReadByte()];

    const identification = PR.QuakeJS.identification;

    if (identification.name !== name || identification.author !== author) {
      throw new HostError(`Cannot connect, because the server is running ${name} by ${author} and you are running ${name} by ${author}.`);
    }

    if (!PR.QuakeJS.ClientGameAPI.IsServerCompatible(version)) {
      // TODO: show different message for demo playback
      throw new HostError(`Server (v${version.join('.')}) is not compatible. You are running v${identification.version.join('.')}.\nTry clearing your cache and connect again.`);
    }

    CL.state.gameAPI = new PR.QuakeJS.ClientGameAPI(ClientEngineAPI);
  }

  CL.state.maxclients = MSG.ReadByte();
  if ((CL.state.maxclients <= 0) || (CL.state.maxclients > 32)) {
    throw new HostError('Bad maxclients (' + CL.state.maxclients + ') from server!');
  }

  CL.state.scores.length = 0;

  for (let i = 0; i < CL.state.maxclients; i++) {
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

  CL.state.model_precache.length = 0;
  CL.state.sound_precache.length = 0;

  CL._processingServerDataState = 1;

  (async () => {
    let lastYield = Host.realtime;

    for (let i = 1; i < nummodels; i++) {
      CL.SetConnectingStep(25 + (i / nummodels) * 20, 'Loading model: ' + model_precache[i]);
      CL.state.model_precache[i] = Mod.ForName(model_precache[i]);
      if (CL.state.model_precache[i] === null) {
        Con.Print('Model ' + model_precache[i] + ' not found\n');
        return;
      }

      if (Host.realtime - lastYield > 0.1) {
        await Q.yield();
        lastYield = Host.realtime;
      }
    }

    for (let i = 1; i < numsounds; i++) {
      CL.SetConnectingStep(45 + (i / numsounds) * 20, 'Loading sound: ' + sound_precache[i]);
      // eslint-disable-next-line require-atomic-updates
      CL.state.sound_precache[i] = await S.PrecacheSoundAsync(sound_precache[i]);

      if (Host.realtime - lastYield > 0.1) {
        await Q.yield();
        lastYield = Host.realtime;
      }
    }
  })().then(() => {
    CL._processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1];
    CL.pmove.setWorldmodel(CL.state.worldmodel);
    const ent = CL.EntityNum(0);
    ent.classname = 'worldspawn';
    ent.loadHandler();
    ent.model = CL.state.worldmodel;
    ent.spawn();
    CL.SetConnectingStep(66, 'Preparing map');
    R.NewMap();
    Host.noclip_anglehack = false;
    if (CL.state.gameAPI) {
      CL.state.gameAPI.init();
    }
  });
};

CL.nullcmd = new Protocol.UserCmd();

CL.ParseStaticEntity = function() { // private
  const ent = CL.state.clientEntities.allocateClientEntity(MSG.ReadString());
  ent.model = CL.state.model_precache[MSG.ReadByte()];
  ent.frame = MSG.ReadByte();
  ent.colormap = MSG.ReadByte();
  ent.skinnum = MSG.ReadByte();
  ent.effects = MSG.ReadByte();
  ent.solid = MSG.ReadByte();
  ent.angles.set(MSG.ReadAngleVector());
  ent.setOrigin(MSG.ReadCoordVector());
  ent.spawn();
};

CL.ParseStaticSound = function() { // private
  const org = MSG.ReadCoordVector();
  const soundId = MSG.ReadByte();
  const vol = MSG.ReadByte();
  const attn = MSG.ReadByte();
  S.StaticSound(CL.state.sound_precache[soundId], org, vol / 255.0, attn);
};

CL.AppendChatMessage = function(name, message, direct) { // private // TODO: Client
  if (CL.state.chatlog.length > 5) {
    CL.state.chatlog.shift();
  }

  CL.state.chatlog.push({name, message, direct});
};

CL.PublishObituary = function(killerEdictId, victimEdictId, killerWeapon, killerItems) { // private // TODO: Client
  if (!CL.state.scores[killerEdictId + 1] || !CL.state.scores[victimEdictId + 1]) {
    return;
  }

  const killer = CL.state.scores[killerEdictId - 1].name;
  const victim = CL.state.scores[victimEdictId - 1].name;

  CL.AppendChatMessage(killer, `killed ${victim} using ${killerWeapon} (${killerItems})`, true);
};

CL.ParseServerCvars = function () { // private
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

CL.PrintLastServerMessages = function() { // private
  if (CL._lastServerMessages.length > 0) {
    Con.Print('Last server messages:\n');
    for (const cmd of CL._lastServerMessages) {
      Con.Print(' ' + cmd + '\n');
    }
  }
};

/**
 * as long as we do not have a fully async architecture, we have to cheat
 * processingServerInfoState will hold off parsing and processing any further command
 * - 0 = normal operation
 * - 1 = we entered parsing serverdata, holding off any further processing
 * - 2 = we are done processing, we can continue processing the rest
 * - 3 = we need to re-enter the loop, but not reset the MSG pointer
 * @type {number}
 */
CL._processingServerDataState = 0;
CL._lastServerMessages = [];

CL.ParseServerMessage = function() { // private
  if (CL.shownet.value === 1) {
    Con.Print(NET.message.cursize + ' ');
  } else if (CL.shownet.value === 2) {
    Con.Print('------------------\n');
  }

  let entitiesReceived = 0;

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
      throw new HostError('CL.ParseServerMessage: Bad server message');
    }

    const cmd = MSG.ReadByte();

    if (cmd === -1) {
      // End of message
      break;
    }

    CL._lastServerMessages.push(CL.svc_strings[cmd]);
    if (CL._lastServerMessages.length > 10) {
      CL._lastServerMessages.shift();
    }

    Con.DPrint('CL.ParseServerMessage: parsing ' + CL.svc_strings[cmd] + ' ' + cmd + '\n');

    const parser = CL.state.clientMessages;

    switch (cmd) {
      case Protocol.svc.nop:
        continue;
      case Protocol.svc.time:
        parser.parseTime();
        continue;
      case Protocol.svc.clientdata:
        parser.parseClient();
        continue;
      case Protocol.svc.version:
        i = MSG.ReadLong();
        if (i !== Protocol.version) {
          throw new HostError('CL.ParseServerMessage: Server is protocol ' + i + ' instead of ' + Protocol.version + '\n');
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
        S.LocalSound(CL.sfx_talk);
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
        CL.ParseLightstylePacket();
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
            throw new HostError('CL.ParseServerMessage: svc_updatename > MAX_SCOREBOARD');
          }
          const newName = MSG.ReadString();
          // make sure the current player is aware of name changes
          if (CL.state.scores[i].name !== '' && newName !== '' && newName !== CL.state.scores[i].name) {
            Con.Print(`${CL.state.scores[i].name} renamed to ${newName}\n`);
          }
          CL.state.scores[i].name = newName;
        }
        continue;
      case Protocol.svc.updatefrags: // TODO: Client Legacy
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          throw new HostError('CL.ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD');
        }
        CL.state.scores[i].frags = MSG.ReadShort();
        continue;
      case Protocol.svc.updatecolors: // TODO: Client
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          throw new HostError('CL.ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD');
        }
        CL.state.scores[i].colors = MSG.ReadByte();
        continue;
      case Protocol.svc.updatepings: // TODO: Client?
        i = MSG.ReadByte();
        if (i >= CL.state.maxclients) {
          throw new HostError('CL.ParseServerMessage: svc_updatepings > MAX_SCOREBOARD');
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
      case Protocol.svc.temp_entity: // TODO: Client Legacy
        CL.ParseTemporaryEntity();
        continue;
      case Protocol.svc.setpause:
        CL.state.paused = MSG.ReadByte() !== 0;
        if (CL.state.paused) {
          eventBus.publish('client.paused');
        } else {
          eventBus.publish('client.unpaused');
        }
        continue;
      case Protocol.svc.signonnum:
        i = MSG.ReadByte();
        if (i <= CL.cls.signon) {
          throw new HostError('Received signon ' + i + ' when at ' + CL.cls.signon);
        }
        console.assert(i >= 0 && i <= 4, 'signon must be in range 0-4');
        CL.cls.signon = /** @type {0|1|2|3|4} */(i);
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
          eventBus.publish('client.cdtrack', CL.cls.forcetrack);
        } else {
          eventBus.publish('client.cdtrack', CL.state.cdtrack);
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
        parser.parsePlayer();
        // CL.ParsePlayerinfo();
        continue;
      case Protocol.svc.deltapacketentities:
        entitiesReceived++;
        CL.ParsePacketEntities();
        continue;
      case Protocol.svc.cvar:
        CL.ParseServerCvars();
        continue;
    }
    CL._lastServerMessages.pop(); // discard the last added command as it was invalid anyway
    CL.PrintLastServerMessages();
    throw new HostError('CL.ParseServerMessage: Illegible server message\n');
  }

  // CR: this is a hack to make sure we don't get stuck in the signon state
  // TODO: rewrite this signon nonsense
  if (entitiesReceived > 0) {
    if (CL.cls.signon === 3) {
      CL.cls.signon = 4;
      CL.SignonReply();
    }
  }

  CL.SetSolidEntities();
};

// tent

CL.InitTEnts = function() { // private // TODO: move this to ClientAPI / ClientLegacy
  CL.sfx_wizhit = S.PrecacheSound('wizard/hit.wav');
  CL.sfx_knighthit = S.PrecacheSound('hknight/hit.wav');
  CL.sfx_tink1 = S.PrecacheSound('weapons/tink1.wav');
  CL.sfx_ric1 = S.PrecacheSound('weapons/ric1.wav');
  CL.sfx_ric2 = S.PrecacheSound('weapons/ric2.wav');
  CL.sfx_ric3 = S.PrecacheSound('weapons/ric3.wav');
  CL.sfx_r_exp3 = S.PrecacheSound('weapons/r_exp3.wav');
};

CL.ParseBeam = function(m) { // private // TODO: move this to ClientAPI / ClientLegacy
  const ent = MSG.ReadShort();
  const start = MSG.ReadCoordVector();
  const end = MSG.ReadCoordVector();
  for (let i = 0; i < Def.limits.beams; i++) {
    const b = CL.state.clientEntities.beams[i];
    if (b.entity !== ent) {
      continue;
    }
    b.model = m;
    b.endtime = CL.state.time + 0.2;
    b.start = start.copy();
    b.end = end.copy();
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const b = CL.state.clientEntities.beams[i];
    if ((b.model !== null) && (b.endtime >= CL.state.time)) {
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

CL.ParseTemporaryEntity = function() { // private // TODO: move this to ClientAPI / ClientLegacy
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

  throw new Error(`CL.ParseTEnt: bad type ${type}`);
};

CL.PredictMove = function() { // public, by Host.js
  CL.state.time = Host.realtime - CL.state.latency;

  if (CL.nopred.value !== 0) {
    return;
  }

  // const playerEntity = CL.state.playerentity;
  // if (!playerEntity) { // no player entity, nothing to predict
  //   return;
  // }

  // const from = CL.state.playerstate;
  // if (!from) { // no player state, nothing to predict
  //   return;
  // }

  // from.origin.set(playerEntity.origin);
  // from.angles.set(playerEntity.angles);
  // from.velocity.set(playerEntity.velocity);

  // const to = new ClientPlayerState(from.pmove);

  // to.origin.set(playerEntity.msg_origins[0]);
  // to.angles.set(playerEntity.msg_angles[0]);
  // to.velocity.set(playerEntity.msg_velocity[0]);

  // CL.PredictUsercmd(from.pmove, from, to, CL.state.cmd);

  // const f = 1;

  // // console.log('f', f);

  // if (playerEntity.origin.distanceTo(to.origin) > 100) {
  //   Con.PrintWarning(`CL.PredictMove: player origin too far away from predicted origin: ${to.origin.toString()}, ${playerEntity.origin.toString()}\n`);
  //   // return;
  // }

  // const o0 = playerEntity.origin;
  // const o1 = to.origin;

  // playerEntity.origin.setTo(
  //   o1[0] + (o0[0] - o1[0]) * f,
  //   o1[1] + (o0[1] - o1[1]) * f,
  //   o1[2] + (o0[2] - o1[2]) * f,
  // );

  // playerEntity.origin.set(to.origin);
  // playerEntity.angles.set(to.angles);
  // playerEntity.velocity.set(to.velocity);
};

/**
 * @param {PmovePlayer} pmove pmove for player
 * @param {ClientPlayerState} from previous state
 * @param {ClientPlayerState} to current state
 * @param {Protocol.UserCmd} u player commands
 */
CL.PredictUsercmd = function(pmove, from, to, u) { // private
  // split long commands
  if (u.msec > 50) {
    const mid = new ClientPlayerState(pmove);
    const split = u.copy();
    split.msec /= 2;
    CL.PredictUsercmd(pmove, from, mid, split);
    CL.PredictUsercmd(pmove, mid, to, split);
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
CL.SetUpPlayerPrediction = function (dopred) { // public, by Host.js
  const playerEntity = CL.state.playerentity;


};

CL.ParsePacketEntities = function() { // private
  while (true) {
    const edictNum = MSG.ReadShort();

    if (edictNum === 0) {
      break;
    }

    /** @type {ClientEdict} */
    const clent = CL.EntityNum(edictNum);

    const bits = MSG.ReadShort();

    // CR:  this step is important, it will initialize the client-side code for the entity
    //      if there’s no classname, the client entity will be remain pretty dumb, since it wont’t have a handler
    if (bits & Protocol.u.classname) {
      clent.classname = MSG.ReadString();
      clent.loadHandler();
      clent.spawn(); // changing the classname also means we need to spawn the entity again
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
      clent.solid = MSG.ReadByte();
    }

    const origin = clent.msg_origins[0];
    const angles = clent.msg_angles[0];
    const velocity = clent.msg_velocity[0];

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        origin[i] = MSG.ReadCoord();
      }

      if (bits & (Protocol.u.angle1 << i)) {
        angles[i] = MSG.ReadAngle();
        velocity[i] = MSG.ReadCoord();
      }
    }

    // if ((bits & (Protocol.u.origin1 | Protocol.u.origin2 | Protocol.u.origin3)) && clent.classname === 'player') {
    //   console.log('CL.ParsePacketEntities: receiving origin', clent.num, origin.toString());
    // }

    if (bits & Protocol.u.size) {
      clent.maxs.set(MSG.ReadCoordVector());
      clent.mins.set(MSG.ReadCoordVector());
    }

    clent.updatecount++;

    clent.msg_time[1] = clent.msg_time[0];
    clent.msg_time[0] = CL.state.mtime[0];

    clent.msg_origins[1].set(clent.msg_origins[0]);
    clent.msg_angles[1].set(clent.msg_angles[0]);
    clent.msg_velocity[1].set(clent.msg_velocity[0]);

    if (clent.free) {
      // make sure that we clear this ClientEntity before we throw it back in
      clent.freeEdict();
    }
  }

  // TODO: send an acknowledge command back
};
