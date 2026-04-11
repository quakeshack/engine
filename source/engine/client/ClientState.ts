import { SzBuffer } from '../network/MSG.ts';
import { QSocket } from '../network/NetworkDrivers.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import Vector from '../../shared/Vector.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { BrushModel } from '../common/Mod.ts';
import type { SerializedParticle } from './R.ts';
import type { ClientGameInterface, ClientSerializableType, SFX } from '../../shared/GameInterfaces.ts';
import type ClientDemos from './ClientDemos.ts';
import { EventBus, eventBus, getClientRegistry } from '../registry.ts';
import ClientEntities, { ClientEdict } from './ClientEntities.ts';
import { ClientMessages } from './ClientMessages.ts';

type ClientConnectionProgress = {
  message: string;
  percentage: number;
};

type ClientChatMessage = {
  name: string;
  message: string;
  direct: boolean;
};

type ClientEntityFieldDefinition = {
  fields: string[];
  bitsReader: 'readByte' | 'readShort' | 'readLong';
};

type ClientMoveCommand = {
  cmd: Protocol.UserCmd;
  msec: number;
};

type ClientLoadData = [string | null, SerializedParticle[] | null];

let { CL } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL } = getClientRegistry());
});

/**
 * Create a stats array sized to the numeric legacy stat entries.
 * @returns Fresh zeroed stat slots.
 */
function createLegacyStatsArray(): number[] {
  return Object.values(Def.stat).filter((value) => typeof value === 'number').map(() => 0);
}

const clientGameEvents = [
  'vid.resize',
  'cvar.changed',
  'client.paused',
  'client.unpaused',
  'client.cdtrack',
  'client.players.name-changed',
  'client.players.frags-updated',
  'client.players.colors-updated',
  'client.server-info.ready',
  'client.server-info.updated',
  'client.damage',
  'client.chat.message',
] as const;

class ClientStaticState {
  signon = 0;
  state: Def.clientConnectionState = Def.clientConnectionState.disconnected;
  spawnparms = '';
  changelevel = false;
  message = new SzBuffer(8192, 'CL.cls.message');
  netcon: QSocket | null = null;
  connecting: ClientConnectionProgress | null = null;
  serverInfo: Record<string, string> = {};
  lastcmdsent = 0;
  isLocalGame = false;
  movearound: ReturnType<typeof setInterval> | null = null;
  #clientDemos: ClientDemos | null = null;
  #runtimeState: ClientRuntimeState | null = null;

  bindClientDemos(clientDemos: ClientDemos): void {
    this.#clientDemos = clientDemos;
  }

  bindRuntimeState(runtimeState: ClientRuntimeState): void {
    this.#runtimeState = runtimeState;
  }

  get demoplayback(): boolean {
    return this.#clientDemos?.demoplayback ?? false;
  }

  get demorecording(): boolean {
    return this.#clientDemos?.demorecording ?? false;
  }

  get demonum(): number {
    return this.#clientDemos?.demonum ?? -1;
  }

  set demonum(value: number) {
    if (this.#clientDemos !== null) {
      this.#clientDemos.demonum = value;
    }
  }

  get forcetrack(): number {
    return this.#clientDemos?.forcetrack ?? -1;
  }

  set forcetrack(value: number) {
    if (this.#clientDemos !== null) {
      this.#clientDemos.forcetrack = value;
    }
  }

  get latency(): number {
    if (this.#runtimeState === null) {
      return 0;
    }

    const player = this.#runtimeState.playernum;
    const slot = this.#runtimeState.scores[player];
    return slot?.ping ?? 0;
  }

  clear(): void {
    this.message.clear();
    this.serverInfo = {};
    this.lastcmdsent = 0;
    if (this.movearound !== null) {
      clearInterval(this.movearound);
      this.movearound = null;
    }
  }
}

export class ScoreSlot {
  index: number;
  name = '';
  entertime = 0.0;
  frags = 0;
  colors = 0;
  ping = 0;

  constructor(index: number) {
    this.index = index;
  }

  get isActive(): boolean {
    return this.name !== '';
  }

  get entity(): ClientEdict | null {
    return CL.state.clientEntities.getEntity(this.index + 1);
  }
}

class ClientRuntimeState {
  clientEntities = new ClientEntities();
  clientMessages = new ClientMessages();
  clientEntityFields: Record<string, ClientEntityFieldDefinition> = {};
  clientdata: Record<string, ClientSerializableType> = {};
  movemessages = 0;
  cmd = new Protocol.UserCmd();
  lastcmd = new Protocol.UserCmd();

  // --- prediction state ---
  /** incrementing move sequence counter (wraps at 256) */
  moveSequence = 0;
  /** last move sequence acknowledged by the server */
  acknowledgedMoveSequence = 0;
  /** ring buffer of commands indexed by (moveSequence & CMD_BUFFER_MASK) */
  cmdBuffer = ClientRuntimeState.#createCmdBuffer();
  /** true when prediction ran this frame (prevents emit from overwriting) */
  predicted = false;

  /** server-acknowledged pmFlags (PMF bitmask) */
  ackedPmFlags = 0;
  /** server-acknowledged pmTime (timing counter) */
  ackedPmTime = 0;
  /** server-acknowledged old button state */
  ackedPmOldButtons = 0;

  stats = createLegacyStatsArray();
  items = 0;
  item_gettime = new Array(32).fill(0.0);
  cshifts = Array.from({ length: 8 }, () => [0.0, 0.0, 0.0, 0.0]);
  faceanimtime = 0.0;
  viewangles = new Vector();
  punchangle = new Vector();
  idealpitch = 0.0;
  pitchvel = 0.0;
  driftmove = 0.0;
  laststop = 0.0;
  intermission = 0;
  completed_time = 0;
  time = 0.0;
  latency = 0.0;
  last_received_message = 0.0;
  /** effectively the player’s edict number */
  viewentity = 0;
  /** view model reference (TODO: rename to viewmodel) */
  viewent: ClientEdict | null = null;
  cdtrack = 0;
  looptrack = 0;
  chatlog: ClientChatMessage[] = [];
  model_precache: BaseModel[] = [];
  sound_precache: SFX[] = [];
  levelname: string | null = null;
  gametype = 0;
  onground = false;
  maxclients = 1;
  scores: ScoreSlot[] = [];
  worldmodel: BrushModel | null = null;
  viewheight = 0;
  inwater = false;
  nodrift = false;
  gameAPI: ClientGameInterface | null = null;
  paused = false;
  /** event bus solely for engine-game communication */
  eventBus = new EventBus('client-game');
  #proxyEventListeners: Array<() => void> = [];
  /** stores client-game state waiting for signon 4 */
  loadClientData: ClientLoadData | null = null;
  #clientGameEvents: readonly string[];

  /**
   * @returns Fresh command ring buffer.
   */
  static #createCmdBuffer(): ClientMoveCommand[] {
    return new Array(Protocol.CMD_BUFFER_SIZE).fill(null).map(() => ({
      cmd: new Protocol.UserCmd(),
      msec: 0,
    }));
  }

  constructor({ clientGameEvents }: { clientGameEvents: readonly string[] }) {
    this.#clientGameEvents = clientGameEvents;
  }

  get playernum(): number {
    return this.viewentity - 1;
  }

  /**
   * @returns Current player state for prediction.
   */
  get playerstate() {
    return this.clientMessages.playerstates[this.playernum];
  }

  get playerentity(): ClientEdict | null {
    return this.clientEntities.getEntity(this.viewentity);
  }

  get velocity(): Vector {
    const entity = this.playerentity;
    return entity ? entity.velocity : Vector.origin;
  }

  clear(): void {
    this.clientMessages.clear();
    this.clientEntities.clear();
    this.movemessages = 0;
    this.cmd = new Protocol.UserCmd();
    this.lastcmd = new Protocol.UserCmd();
    this.moveSequence = 0;
    this.acknowledgedMoveSequence = 0;
    this.cmdBuffer = ClientRuntimeState.#createCmdBuffer();
    this.predicted = false;
    this.ackedPmFlags = 0;
    this.ackedPmTime = 0;
    this.ackedPmOldButtons = 0;
    this.stats = createLegacyStatsArray();
    this.items = 0;
    this.item_gettime.fill(0.0);
    for (const cshift of this.cshifts) {
      cshift.fill(0.0);
    }
    this.faceanimtime = 0.0;
    this.viewangles = new Vector();
    this.punchangle = new Vector();
    this.idealpitch = 0.0;
    this.pitchvel = 0.0;
    this.driftmove = 0.0;
    this.laststop = 0.0;
    this.intermission = 0;
    this.completed_time = 0;
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
    for (const key of Object.keys(this.clientEntityFields)) {
      delete this.clientEntityFields[key];
    }
    this.eventBus.unsubscribeAll();
    for (const unsubscribe of this.#proxyEventListeners) {
      unsubscribe();
    }
    this.#proxyEventListeners.length = 0;
    this.#configureProxyEvents();
  }

  #configureProxyEvents(): void {
    for (const event of this.#clientGameEvents) {
      this.#proxyEventListeners.push(eventBus.subscribe(event, (...args) => { this.eventBus.publish(event, ...args); }));
    }
  }
}

const clientStaticState = new ClientStaticState();
const clientRuntimeState = new ClientRuntimeState({ clientGameEvents });
clientStaticState.bindRuntimeState(clientRuntimeState);

export {
  ClientStaticState,
  ClientRuntimeState,
  clientStaticState,
  clientRuntimeState,
  clientGameEvents,
};
