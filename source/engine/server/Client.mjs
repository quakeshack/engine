import { enumHelpers } from '../../shared/Q.mjs';
import { gameCapabilities } from '../../shared/Defs.ts';
import Vector from '../../shared/Vector.ts';
import { SzBuffer } from '../network/MSG.mjs';
import { QSocket } from '../network/NetworkDrivers.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ServerEntityState } from './Server.mjs';

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

/** @typedef {import('./Edict.mjs').ServerEdict} ServerEdict */
/** @typedef {import('../../shared/GameInterfaces').PlayerEntitySpawnParamsDynamic} PlayerEntitySpawnParamsDynamic */

export class ServerClient {
  static STATE = Object.freeze({
    /** drop client as soon as possible */
    DROPASAP: -1,
    /** free client slot, can be reused for a new connection */
    FREE: 0,
    /** client is connecting, but not yet fully connected (signon = 1) */
    CONNECTING: 1,
    /** has been assigned to a client, but not in game yet (signon = 2) */
    CONNECTED: 2,
    /** client is fully in game */
    SPAWNED: 3,

    ...enumHelpers,
  });

  /**
   * @param {number} num client number
   */
  constructor(num) {
    /** @type {number} @see {ServerClient.STATE} */
    this.state = ServerClient.STATE.FREE;
    this.num = num;
    /** @type {SzBuffer} messages sent after an entity update run */
    this.message = new SzBuffer(16000, 'ServerClient ' + num);
    this.message.allowoverflow = true;
    /** @type {SzBuffer} messages sent before an entity update run */
    this.expedited_message = new SzBuffer(4000, 'ServerClient expedited ' + num);
    this.expedited_message.allowoverflow = true;
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
    this.spawn_parms = null;

    this.cmd = new Protocol.UserCmd();
    this.lastcmd = new Protocol.UserCmd();
    this.frames = [];

    /**
     * Queued move commands received since the last physics tick.
     * In remote multiplayer the client may send several commands between
     * server frames, each is pushed here and drained by physicsClient
     * so that every command is simulated with its original msec,
     * matching client-side prediction exactly (QW-style).
     * @type {Protocol.UserCmd[]}
     */
    this.pendingCmds = [];

    /** @type {Map<string,ServerEntityState>} olds entity states for this player only @private */
    this._entityStates = new Map();

    this.wishdir = new Vector();

    /** @type {number} Q2-style player movement flags (PMF bitmask), persisted across frames */
    this.pmFlags = 0;
    /** @type {number} Q2-style timing counter for special states (msec/8 units) */
    this.pmTime = 0;
    /** @type {number} previous frame button state for edge detection */
    this.pmOldButtons = 0;
    /** @type {number} last received move command sequence (0-255, for prediction ack) */
    this.lastMoveSequence = 0;

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
    this.cmd.reset();
    this.lastcmd.reset();
    this.pendingCmds.length = 0;
    this.last_update = 0.0;
    this.sync_time = 0;
    this._entityStates = new Map();
    this.pmFlags = 0;
    this.pmTime = 0;
    this.pmOldButtons = 0;
    this.lastMoveSequence = 0;

    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_LEGACY)) {
      this.spawn_parms = new Array(16);
    } else {
      this.spawn_parms = null;
    }
  }

  /**
   * Issues a changelevel to the specified map for this client.
   * @param {string} mapname map name
   */
  changelevel(mapname) {
    const reconnect = new SzBuffer(128);
    reconnect.writeByte(Protocol.svc.changelevel);
    reconnect.writeString(mapname);
    this.netconnection.SendMessage(reconnect);

    this._entityStates.clear();
    this.cmd.reset();
    this.lastcmd.reset();
    this.pendingCmds.length = 0;
    this.pmFlags = 0;
    this.pmTime = 0;
    this.pmOldButtons = 0;
    this.lastMoveSequence = 0;
  }

  /**
   * @param {number} num edict Id
   * @returns {ServerEntityState} entity state
   */
  getEntityState(num) {
    const key = num.toString();

    if (!this._entityStates.has(key)) {
      this._entityStates.set(key, new ServerEntityState(num));
    }

    return this._entityStates.get(key);
  }

  set name(/** @type {string} */ name) {
    this.edict.entity.netname = name;
  }

  get name() {
    if (this.state !== ServerClient.STATE.CONNECTED && this.state !== ServerClient.STATE.SPAWNED) {
      return '';
    }

    console.assert('netname' in this.edict.entity, 'entity needs netname');

    return this.edict.entity.netname ?? `client #${this.num}`;
  }

  get uniqueId() {
    return 'N/A'; // TODO
  }

  get ping() {
    return Math.round((this.ping_times.reduce((sum, elem) => sum + elem) / this.ping_times.length) * 1000) || 0;
  }

  saveSpawnparms() {
    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_DYNAMIC)) {
      this.spawn_parms = (this.edict.entity).saveSpawnParameters();
      return;
    }

    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_LEGACY)) {
      SV.server.gameAPI.SetChangeParms(this.edict);

      this.spawn_parms = new Array(16);

      for (let i = 0; i < this.spawn_parms.length; i++) {
        this.spawn_parms[i] =  SV.server.gameAPI[`parm${i + 1}`];
      }

      return;
    }
  }

  consolePrint(/** @type {string} */ message) {
    this.message.writeByte(Protocol.svc.print);
    this.message.writeString(message);
  }

  centerPrint(/** @type {string} */ message) {
    this.message.writeByte(Protocol.svc.centerprint);
    this.message.writeString(message);
  }

  sendConsoleCommands(/** @type {string} */ commandline) {
    this.message.writeByte(Protocol.svc.stufftext);
    this.message.writeString(commandline);
  }
};
