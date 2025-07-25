import Vector from '../../shared/Vector.mjs';
import MSG, { SzBuffer } from '../network/MSG.mjs';
import { QSocket } from '../network/NetworkDrivers.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { eventBus, registry } from '../registry.mjs';

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

/** @typedef {import('./Edict.mjs').ServerEdict} ServerEdict */
/** @typedef {import('./Server.mjs').ServerEntityState} ServerEntityState */

export class ServerClient {
  static STATE = {
    /** can be reused for a new connection */
    FREE: 0,
    /** client has been disconnected, but don’t reuse connection for a couple seconds */
    ZOMBIE: 1,
    /** has been assigned to a client, but not in game yet */
    CONNECTED: 2,
    /** client is fully in game */
    SPAWNED: 3,
  };

  /**
   * @param {number} num client number
   */
  constructor(num) {
    this.state = ServerClient.STATE.FREE;
    this.num = num;
    this.message = new SzBuffer(8000, 'ServerClient ' + num);
    this.message.allowoverflow = true;
    this.colors = 0;
    this.old_frags = 0;
    /** @type {number} last update sent to the client */
    this.last_update = 0;
    /** @type {number} last Host.realtime when all ping times have been sent */
    this.last_ping_update = 0;
    this.ping_times = new Array(16);
    this.num_pings = 0;
    /** @type {?QSocket} */
    this.netconnection = null;

    /** @type {number} the SV.server.time when the last command was processed */
    this.local_time = 0.0;

    /** @type {number} SV.server.time read back from the client */
    this.sync_time = 0.0;

    /** spawn parms are carried from level to level */
    this.spawn_parms = new Array(16);

    this.cmd = new Protocol.UserCmd();
    this.lastcmd = new Protocol.UserCmd();
    this.frames = [];

    /** @type {Map<string,ServerEntityState>} olds entity states for this player only @private */
    this._entityStates = new Map();

    this.active = false;
    this.dropasap = false;
    this.spawned = false;
    this.sendsignon = false;

    this.wishdir = new Vector();

    // Object.seal(this);
  }

  toString() {
    return `ServerClient (${this.num}, ${this.netconnection})`;
  }

  /** @type {ServerEdict} */
  get edict() {
    // clients are mapped to edicts with ids from 1 to maxclients
    return SV.server.edicts[this.num + 1];
  }

  get entity() {
    return this.edict.entity;
  }

  clear() {
    this.state = ServerClient.STATE.FREE;
    this.netconnection = null;
    this.message.clear();
    this.wishdir.clear();
    this.colors = 0;
    this.old_frags = 0;
    this.last_ping_update = 0.0;
    this.num_pings = 0;
    this.ping_times.fill(0);
    this.spawn_parms.fill(0);
    this.cmd.reset();
    this.lastcmd.reset();
    this.last_update = 0.0;
    this.sync_time = 0;
    this._entityStates = new Map();
    this.active = false;
    this.dropasap = false;
    this.spawned = false;
    this.sendsignon = false;
  }

  /**
   * @param {number} num edict Id
   * @returns {ServerEntityState} entity state
   */
  getEntityState(num) {
    const key = num.toString();

    if (!this._entityStates.has(key)) {
      this._entityStates.set(key, new SV.EntityState(num));
    }

    return this._entityStates.get(key);
  }

  /**
   * @param {string} name name
   */
  set name(name) {
    this.edict.entity.netname = name;
  }

  get name() {
    if (!this.active) {
      return '';
    }

    return this.edict.entity.netname || '';
  }

  get uniqueId() {
    return 'pending'; // TODO
  }

  get ping() {
    return Math.round((this.ping_times.reduce((sum, elem) => sum + elem) / this.ping_times.length) * 1000) || 0;
  }

  saveSpawnparms() { // FIXME: should game handle this?
    SV.server.gameAPI.SetChangeParms(this.edict);

    for (let i = 0; i < this.spawn_parms.length; i++) {
      this.spawn_parms[i] =  SV.server.gameAPI[`parm${i + 1}`];
    }
  }

  consolePrint(message) {
    MSG.WriteByte(this.message, Protocol.svc.print);
    MSG.WriteString(this.message, message);
  }

  centerPrint(message) {
    MSG.WriteByte(this.message, Protocol.svc.centerprint);
    MSG.WriteString(this.message, message);
  }

  sendConsoleCommands(commandline) {
    MSG.WriteByte(this.message, Protocol.svc.stufftext);
    MSG.WriteString(this.message, commandline);
  }
};
