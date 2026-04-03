import type { PlayerEntitySpawnParamsDynamic } from '../../shared/GameInterfaces.ts';
import type { QSocket } from '../network/NetworkDrivers.ts';
import type { BaseEntity, ServerEdict } from './Edict.ts';

import { gameCapabilities } from '../../shared/Defs.ts';
import Vector from '../../shared/Vector.ts';
import { SzBuffer } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import { eventBus, getCommonRegistry } from '../registry.mjs';
import { ServerEntityState } from './ServerEntityState.ts';

interface LegacySpawnParmsGameAPI {
  SetChangeParms(clientEdict: ServerEdict): void;
  [key: `parm${number}`]: number;
}

let { SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ SV } = getCommonRegistry());
});

export enum ServerClientState {
  /** drop client as soon as possible */
  DROPASAP = -1,
  /** free client slot, can be reused for a new connection */
  FREE = 0,
  /** client is connecting, but not yet fully connected (signon = 1) */
  CONNECTING = 1,
  /** has been assigned to a client, but not in game yet (signon = 2) */
  CONNECTED = 2,
  /** client is fully in game */
  SPAWNED = 3,
}

type ServerClientSpawnParameters = number[] | ReturnType<PlayerEntitySpawnParamsDynamic['saveSpawnParameters']> | null;
type ServerClientEntity = BaseEntity & { netname?: string | null };
type DynamicSpawnClientEntity = ServerClientEntity & PlayerEntitySpawnParamsDynamic;

/**
 * Runtime state for one connected or connectable server client slot.
 */
export class ServerClient {
  static readonly STATE = ServerClientState;

  state: ServerClientState;
  readonly num: number;
  readonly message: SzBuffer;
  readonly expedited_message: SzBuffer;
  colors: number;
  old_frags: number;
  last_update: number;
  last_ping_update: number;
  readonly ping_times: number[];
  num_pings: number;
  netconnection: QSocket | null;
  local_time: number;
  sync_time: number;
  spawn_parms: ServerClientSpawnParameters;
  readonly cmd: Protocol.UserCmd;
  readonly lastcmd: Protocol.UserCmd;
  readonly frames: number[];
  readonly pendingCmds: Protocol.UserCmd[];
  protected _entityStates: Map<string, ServerEntityState>;
  readonly wishdir: Vector;
  pmFlags: number;
  pmTime: number;
  pmOldButtons: number;
  lastMoveSequence: number;

  constructor(num: number) {
    this.state = ServerClient.STATE.FREE;
    this.num = num;
    this.message = new SzBuffer(16000, `ServerClient ${num}`);
    this.message.allowoverflow = true;
    this.expedited_message = new SzBuffer(4000, `ServerClient expedited ${num}`);
    this.expedited_message.allowoverflow = true;
    this.colors = 0;
    this.old_frags = 0;
    this.last_update = 0;
    this.last_ping_update = 0;
    this.ping_times = new Array(16);
    this.num_pings = 0;
    this.netconnection = null;
    this.local_time = 0.0;
    this.sync_time = 0.0;
    this.spawn_parms = null;
    this.cmd = new Protocol.UserCmd();
    this.lastcmd = new Protocol.UserCmd();
    this.frames = [];
    this.pendingCmds = [];
    this._entityStates = new Map();
    this.wishdir = new Vector();
    this.pmFlags = 0;
    this.pmTime = 0;
    this.pmOldButtons = 0;
    this.lastMoveSequence = 0;
  }

  toString(): string {
    return `ServerClient (${this.num}, ${this.netconnection})`;
  }

  /**
   * Returns the player edict assigned to this client slot.
   * @returns The client edict.
   */
  get edict(): ServerEdict {
    return SV.server.edicts[this.num + 1] as ServerEdict;
  }

  /**
   * Returns the game entity owned by this client slot.
   * @returns The linked game entity.
   */
  get entity(): ServerClientEntity {
    const entity = this.edict.entity;

    console.assert(entity !== null, 'ServerClient.entity requires a linked edict entity');

    return entity as ServerClientEntity;
  }

  clear(): void {
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
   */
  changelevel(mapname: string): void {
    const reconnect = new SzBuffer(128);
    reconnect.writeByte(Protocol.svc.changelevel);
    reconnect.writeString(mapname);

    console.assert(this.netconnection !== null, 'ServerClient.changelevel requires a live connection');
    this.netconnection?.SendMessage(reconnect);

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
   * Returns the per-entity delta baseline for this client.
   * @returns The cached state for the requested entity.
   */
  getEntityState(num: number): ServerEntityState {
    const key = num.toString();

    if (!this._entityStates.has(key)) {
      this._entityStates.set(key, new ServerEntityState(num));
    }

    return this._entityStates.get(key) as ServerEntityState;
  }

  set name(name: string) {
    this.entity.netname = name;
  }

  get name(): string {
    if (this.state !== ServerClient.STATE.CONNECTED && this.state !== ServerClient.STATE.SPAWNED) {
      return '';
    }

    console.assert('netname' in this.entity, 'entity needs netname');

    return this.entity.netname ?? `client #${this.num}`;
  }

  get uniqueId(): string {
    return 'N/A';
  }

  get ping(): number {
    return Math.round((this.ping_times.reduce((sum, elem) => sum + elem) / this.ping_times.length) * 1000) || 0;
  }

  saveSpawnparms(): void {
    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_DYNAMIC)) {
      this.spawn_parms = (this.entity as DynamicSpawnClientEntity).saveSpawnParameters();
      return;
    }

    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_LEGACY)) {
      const gameAPI = SV.server.gameAPI as unknown as LegacySpawnParmsGameAPI;
      gameAPI.SetChangeParms(this.edict);

      this.spawn_parms = new Array(16);

      for (let i = 0; i < this.spawn_parms.length; i++) {
        this.spawn_parms[i] = gameAPI[`parm${i + 1}`];
      }
    }
  }

  /**
   * Queues a console print for this client.
   */
  consolePrint(message: string): void {
    this.message.writeByte(Protocol.svc.print);
    this.message.writeString(message);
  }

  /**
   * Queues a centerprint for this client.
   */
  centerPrint(message: string): void {
    this.message.writeByte(Protocol.svc.centerprint);
    this.message.writeString(message);
  }

  /**
   * Queues server-issued console commands for this client.
   */
  sendConsoleCommands(commandline: string): void {
    this.message.writeByte(Protocol.svc.stufftext);
    this.message.writeString(commandline);
  }
}
