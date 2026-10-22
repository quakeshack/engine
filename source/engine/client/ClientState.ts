import { SzBuffer } from '../network/MSG.ts';
import { QSocket } from '../network/NetworkDrivers.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import Vector from '../../shared/Vector.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { BrushModel } from '../common/Mod.ts';
import type { SerializedParticle } from './renderer/effects/Particles.ts';
import type { ClientGameInterface, ClientSerializableType, SFX } from '../../shared/GameInterfaces.ts';
import type ClientDemos from './ClientDemos.ts';
import type { ServerController } from '../common/ServerController.ts';
import { type ClientGameEventMap, type GameEventBus, eventBus } from '../common/EventBus.ts';
import { Scope } from '../common/Scope.ts';
import { clientGameEventFamilies, clientGameEventNames } from '../../shared/EngineEvents.ts';
import ClientEntities, { ClientEdict, type SerializedClientEntity } from './ClientEntities.ts';
import { ClientMessages } from './ClientMessages.ts';

type ClientConnectionProgress = {
  message: string;
  percentage: number;
};

type ClientEntityFieldDefinition = {
  fields: string[];
  bitsReader: 'readByte' | 'readShort' | 'readLong';
};

type ClientMoveCommand = {
  cmd: Protocol.UserCmd;
  msec: number;
};

type ClientLoadData = [string | null, SerializedParticle[] | null, SerializedClientEntity[] | null];

/**
 * Create a stats array sized to the numeric legacy stat entries.
 * @returns Fresh zeroed stat slots.
 */
function createLegacyStatsArray(): number[] {
  return Object.values(Def.stat).filter((value) => typeof value === 'number').map(() => 0);
}

/** The engine events a client game receives, derived from `engineEventTable` (`shared/EngineEvents.ts`). */
const clientGameEvents = clientGameEventNames;

/**
 * The lifetime of the loaded game module (boot -> a hypothetical future `ClientGameAPI.Shutdown()`): its `events` bus
 * is `ClientEngineAPI.moduleEventBus`, never wiped by a disconnect or a reconnect -- for listeners that must survive
 * past a single connection, e.g. the menu system's `host.alert`/`host.quit-requested` handlers, which need to keep
 * working even for a connection that's rejected before ever finishing. It is given the same engine events as the
 * per-map scope inside it (not a separate list) so a developer doesn't need to remember which bus carries which event
 * -- only whether their own subscription needs to survive a reconnect.
 */
const clientModuleScope = new Scope<ClientGameEventMap>('module', {
  source: eventBus,
  names: clientGameEvents,
  families: clientGameEventFamilies,
});
clientModuleScope.begin();

/** `ClientEngineAPI.moduleEventBus`: the module scope's bus. */
const moduleEventBus = clientModuleScope.events;

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
  /** Control plane to the server this client hosts locally, installed by the launcher before the engine starts. */
  serverController: ServerController = null!;
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
    return clientRuntimeState.clientEntities.getEntity(this.index + 1);
  }
}

class ClientRuntimeState {
  // Created on first use: these classes read the client state themselves, and building them while this module is
  // still being evaluated would make the order modules load in matter.
  #clientEntities: ClientEntities | null = null;
  #clientMessages: ClientMessages | null = null;
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
  /** server-acknowledged pmType (PM_TYPE), seeds prediction with the same movement mode the server used */
  ackedPmType = 0;

  stats = createLegacyStatsArray();
  items = 0;
  item_gettime = new Array(32).fill(0.0);
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
  /** The lifetime of one map: from one `svc.serverdata` to the next. Its bus is `ClientEngineAPI.eventBus`. */
  readonly #mapScope: Scope<ClientGameEventMap>;
  /** stores client-game state waiting for signon 4 */
  loadClientData: ClientLoadData | null = null;
  /**
   * @returns Fresh command ring buffer.
   */
  static #createCmdBuffer(): ClientMoveCommand[] {
    return new Array(Protocol.CMD_BUFFER_SIZE).fill(null).map(() => ({
      cmd: new Protocol.UserCmd(),
      msec: 0,
    }));
  }

  constructor({ moduleScope }: { moduleScope: Scope<ClientGameEventMap> }) {
    this.#mapScope = new Scope<ClientGameEventMap>('map', {
      parent: moduleScope,
      source: eventBus,
      names: clientGameEvents,
      families: clientGameEventFamilies,
    });
  }

  /**
   * The bus solely for engine-game communication, valid for one map.
   * @returns The map scope's bus, the same object for every map.
   */
  get eventBus(): GameEventBus<ClientGameEventMap> {
    return this.#mapScope.events;
  }

  /**
   * The map scope, for engine code that holds something for as long as the map lives (`onDispose`).
   * @returns The scope that ends at the next `clear()`.
   */
  get mapScope(): Scope<ClientGameEventMap> {
    return this.#mapScope;
  }

  get clientEntities(): ClientEntities {
    return this.#clientEntities ??= new ClientEntities();
  }

  set clientEntities(clientEntities: ClientEntities) {
    this.#clientEntities = clientEntities;
  }

  get clientMessages(): ClientMessages {
    return this.#clientMessages ??= new ClientMessages();
  }

  set clientMessages(clientMessages: ClientMessages) {
    this.#clientMessages = clientMessages;
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
    this.ackedPmType = 0;
    this.stats = createLegacyStatsArray();
    this.items = 0;
    this.item_gettime.fill(0.0);
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
    this.#mapScope.restart();
  }

}

const clientStaticState = new ClientStaticState();
const clientRuntimeState = new ClientRuntimeState({ moduleScope: clientModuleScope });
clientStaticState.bindRuntimeState(clientRuntimeState);

export {
  ClientStaticState,
  ClientRuntimeState,
  clientStaticState,
  clientRuntimeState,
  clientGameEvents,
  moduleEventBus,
};
