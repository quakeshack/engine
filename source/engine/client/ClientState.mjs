import { SzBuffer } from '../network/MSG.mjs';
import { QSocket } from '../network/NetworkDrivers.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import Vector from '../../shared/Vector.ts';
import { EventBus, eventBus, registry } from '../registry.mjs';
import ClientEntities, { ClientEdict } from './ClientEntities.mjs';
import { ClientMessages } from './ClientMessages.mjs';
import { BrushModel } from '../common/Mod.mjs';

let { CL } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
});

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
];

class ClientStaticState {
  signon = 0;
  /** @type {Def.clientConnectionState} */
  state = 0;
  spawnparms = '';
  changelevel = false;
  message = new SzBuffer(8192, 'CL.cls.message');
  /** @type {QSocket|null} */
  netcon = null;
  /** @type {{ message: string, percentage: number } | null} */
  connecting = null;
  /** @type {Record<string, string>} */
  serverInfo = {};
  lastcmdsent = 0;
  isLocalGame = false;
  movearound = null;
  /** @type {boolean} will enable the legacy network protocol (15) for old demos */
  legacy_demo = false;
  /** @type {import('./ClientDemos.mjs').default|null} */
  #clientDemos = null;
  /** @type {ClientRuntimeState|null} */
  #runtimeState = null;

  bindClientDemos(clientDemos) {
    this.#clientDemos = clientDemos;
  }

  bindRuntimeState(runtimeState) {
    this.#runtimeState = runtimeState;
  }

  get demoplayback() {
    return this.#clientDemos?.demoplayback ?? false;
  }

  get demorecording() {
    return this.#clientDemos?.demorecording ?? false;
  }

  get demonum() {
    return this.#clientDemos?.demonum ?? -1;
  }

  set demonum(value) {
    if (this.#clientDemos) {
      this.#clientDemos.demonum = value;
    }
  }

  get forcetrack() {
    return this.#clientDemos?.forcetrack ?? -1;
  }

  set forcetrack(value) {
    if (this.#clientDemos) {
      this.#clientDemos.forcetrack = value;
    }
  }

  get latency() {
    if (!this.#runtimeState) {
      return 0;
    }
    const player = this.#runtimeState.playernum;
    const slot = this.#runtimeState.scores[player];
    return slot?.ping ?? 0;
  }

  clear() {
    this.message.clear();
    this.serverInfo = {};
    this.lastcmdsent = 0;
    this.legacy_demo = false;
    if (this.movearound) {
      clearInterval(this.movearound);
      this.movearound = null;
    }
  }
}

export class ScoreSlot {
  constructor(index) {
    this.index = index;
  }

  name = '';
  entertime = 0.0;
  frags = 0;
  colors = 0;
  ping = 0;

  get isActive() {
    return this.name !== '';
  }

  get entity() {
    return CL.state.clientEntities.getEntity(this.index + 1);
  }
}

class ClientRuntimeState {
  clientEntities = new ClientEntities();
  clientMessages = new ClientMessages();
  /** @type {Record<string,{fields: string[], bitsReader: 'readByte' | 'readShort' | 'readLong'}>} */
  clientEntityFields = {};
  /** @type {Record<string, import('../../shared/GameInterfaces').SerializableType>} */
  clientdata = {};
  movemessages = 0;
  cmd = new Protocol.UserCmd();
  lastcmd = new Protocol.UserCmd();

  // --- prediction state ---
  /** @type {number} incrementing move sequence counter (wraps at 256) */
  moveSequence = 0;
  /** @type {number} last move sequence acknowledged by the server */
  acknowledgedMoveSequence = 0;
  /** @type {{cmd: Protocol.UserCmd, msec: number}[]} ring buffer of commands indexed by (moveSequence & CMD_BUFFER_MASK) */
  cmdBuffer = ClientRuntimeState.#createCmdBuffer();
  /** @type {boolean} true when prediction ran this frame (prevents emit from overwriting) */
  predicted = false;

  /** @type {number} server-acknowledged pmFlags (PMF bitmask) */
  ackedPmFlags = 0;
  /** @type {number} server-acknowledged pmTime (timing counter) */
  ackedPmTime = 0;
  /** @type {number} server-acknowledged old button state */
  ackedPmOldButtons = 0;

  stats = Object.values(Def.stat).map(() => 0);
  items = 0;
  item_gettime = new Array(32).fill(0.0);
  faceanimtime = 0.0;
  cshifts = Array.from({ length: 8 }, () => [0.0, 0.0, 0.0, 0.0]);
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
  /** @type {number} effectively the player’s edict number */
  viewentity = 0;
  /** @type {ClientEdict|null} view model reference (TODO: rename to viewmodel) */
  viewent = null;
  cdtrack = 0;
  looptrack = 0;
  chatlog = [];
  model_precache = [];
  sound_precache = [];
  levelname = null;
  gametype = 0;
  onground = false;
  maxclients = 1;
  /** @type {ScoreSlot[]} */
  scores = [];
  /** @type {BrushModel|null} */
  worldmodel = null;
  viewheight = 0;
  inwater = false;
  nodrift = false;
  /** @type {import('../../shared/GameInterfaces').ClientGameInterface|null} */
  gameAPI = null;

  /** @returns {{cmd: Protocol.UserCmd, msec: number}[]} fresh command ring buffer */
  static #createCmdBuffer() {
    return new Array(Protocol.CMD_BUFFER_SIZE).fill(null).map(() => ({
      cmd: new Protocol.UserCmd(),
      msec: 0,
    }));
  }
  paused = false;
  /** event bus solely for engine-game communication */
  eventBus = new EventBus('client-game');
  /** @type {Function[]} */
  #proxyEventListeners = [];
  /** stores client-game state waiting for signon 4 */
  loadClientData = null;
  /** @type {string[]} */
  #clientGameEvents;

  constructor({ clientGameEvents }) {
    this.#clientGameEvents = clientGameEvents;
  }

  get playernum() {
    return this.viewentity - 1;
  }

  get playerstate() {
    return this.clientMessages.playerstates[this.playernum];
  }

  get playerentity() {
    return this.clientEntities.getEntity(this.viewentity);
  }

  get velocity() {
    const entity = this.playerentity;
    return entity ? entity.velocity : Vector.origin;
  }

  clear() {
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
    this.stats = Object.values(Def.stat).map(() => 0);
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
    for (const cshift of this.cshifts) {
      cshift.fill(0.0);
    }
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

  #configureProxyEvents() {
    for (const event of this.#clientGameEvents) {
      this.#proxyEventListeners.push(eventBus.subscribe(event, (...args) => this.eventBus.publish(event, ...args)));
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
