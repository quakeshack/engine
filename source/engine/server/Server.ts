import type { ServerGameInterface } from '../../shared/GameInterfaces.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { QSocket } from '../network/NetworkDrivers.ts';

import Cvar from '../common/Cvar.ts';
import { MoveVars, Pmove } from '../common/Pmove.ts';
import { SzBuffer } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from './../common/Def.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import { ED, ServerEdict } from './Edict.ts';
import { EventBus, eventBus } from '../common/EventBus.ts';
import { requireActiveGameModule } from '../common/GameModule.ts';
import { ServerEngineAPI } from './ServerEngineAPI.ts';
import * as Defs from '../../shared/Defs.ts';
import { Navigation } from './Navigation.ts';
import { ServerPhysics } from './physics/ServerPhysics.ts';
import { ServerClientPhysics } from './physics/ServerClientPhysics.ts';
import { ServerMessages } from './ServerMessages.ts';
import { ServerMovement } from './physics/ServerMovement.ts';
import { ServerArea } from './physics/ServerArea.ts';
import { ServerCollision } from './physics/ServerCollision.ts';
import type { ServerDependencies } from './ServerDependencies.ts';
import { BrushModel, ModelScope } from '../common/Mod.ts';
import { ServerClient } from './Client.ts';

export { ServerEntityState } from './ServerEntityState.ts';

type BitsWriter = 'writeByte' | 'writeShort' | 'writeLong';
type ScheduledGameCommand = () => void;
type ServerClientSpawnParameters = ServerClient['spawn_parms'];
type ServerModel = BaseModel | null | Promise<BaseModel | null>;
type DynamicSpawnClientEntity = ServerClient['entity'] & {
  restoreSpawnParameters(data: string | null): void;
};
type PlayerClientdataEntity = ServerClient['entity'] & {
  clientdataFields: string[];
} & Record<string, unknown>;

interface ClientEntityFieldConfig {
  fields: string[];
  bitsWriter: BitsWriter | null;
}

interface ServerState {
  time: number;
  /** Seconds the current server frame advances the world by, set by `ServerHost.ServerFrame`. */
  frametime: number;
  num_edicts: number;
  datagram: SzBuffer;
  expedited_datagram: SzBuffer;
  reliable_datagram: SzBuffer;
  signon: SzBuffer;
  edicts: ServerEdict[];
  mapname: string | null;
  worldmodel: BrushModel | null;
  eventBus: EventBus;
  navigation: Navigation | null;
  gameAPI: ServerGameInterface | null;
  gameVersion: string | null;
  gameName: string | null;
  gameCapabilities: Defs.gameCapabilities[];
  clientdataFields: string[];
  clientdataFieldsBitsWriter: BitsWriter | null;
  clientEntityFields: Record<string, ClientEntityFieldConfig>;
  models: ServerModel[];
  soundPrecache: string[];
  modelPrecache: string[];
  lightstyles: string[];
  active: boolean;
  loading: boolean;
  paused: boolean;
  loadgame: boolean;
  lastcheck: number;
  lastchecktime: number;
}

interface ServerStaticState {
  /** Wall-clock seconds of the current server frame, for bookkeeping that is not simulation (ping updates). */
  realtime: number;
  changelevelIssued: boolean;
  clients: ServerClient[];
  maxclients: number;
  maxclientslimit: number;
  gamestate: null;
  maplist: string[];
  serverflags: number;
  spawnedClients(): Generator<ServerClient, void, void>;
}

const ALLOWED_CLIENT_COMMANDS = Object.freeze([
  'status',
  'god',
  'notarget',
  'fly',
  'name',
  'noclip',
  'say',
  'say_team',
  'tell',
  'color',
  'kill',
  'pause',
  'spawn',
  'begin',
  'prespawn',
  'kick',
  'ping',
  'give',
  'ban',
] as const);

/**
 * A running server: its state, the parts that simulate and serve it, and the services it depends on.
 * Built by whoever hosts it (see `ServerDependencies`), there is no global instance.
 */
export default class Server {
  readonly con: ServerDependencies['con'];
  readonly sys: ServerDependencies['sys'];
  readonly net: ServerDependencies['net'];
  readonly mod: ServerDependencies['mod'];
  readonly view: ServerDependencies['view'];
  readonly engineVersion: ServerDependencies['engineVersion'];
  readonly files: ServerDependencies['files'];
  readonly dedicated: boolean;

  /** What a game's server side sees of the engine. */
  readonly engineAPI: ServerEngineAPI;

  /** current server state */
  server: ServerState = {
    time: 0,
    frametime: 0,
    num_edicts: 0,
    datagram: new SzBuffer(16384, 'SV.server.datagram'),
    expedited_datagram: new SzBuffer(16384, 'SV.server.expedited_datagram'),
    reliable_datagram: new SzBuffer(16384, 'SV.server.reliable_datagram'),
    signon: new SzBuffer(16384, 'SV.server.signon'),
    edicts: [],
    mapname: null,
    worldmodel: null,
    eventBus: new EventBus('server-game'),
    navigation: null,
    gameAPI: null,
    gameVersion: null,
    gameName: null,
    gameCapabilities: [],
    clientdataFields: [],
    clientdataFieldsBitsWriter: null,
    clientEntityFields: {},
    models: [],
    soundPrecache: [],
    modelPrecache: [],
    lightstyles: [],
    active: false,
    loading: false,
    paused: false,
    loadgame: false,
    lastcheck: 0,
    lastchecktime: 0,
  };

  /** server static, state across maps */
  svs: ServerStaticState = {
    realtime: 0,
    changelevelIssued: false,
    clients: [],
    maxclients: 0,
    maxclientslimit: 32,
    gamestate: null,
    maplist: [],
    serverflags: 0,

    *spawnedClients() {
      for (const client of this.clients) {
        if (client.state === ServerClient.STATE.SPAWNED) {
          yield client;
        }
      }
    },
  };

  readonly physics: ServerPhysics;
  readonly clientPhysics: ServerClientPhysics;
  readonly messages: ServerMessages;
  readonly movement: ServerMovement;
  readonly area: ServerArea;
  readonly collision: ServerCollision;
  readonly ed: ED;

  /** shared player-move collision context */
  pmove: Pmove | null = null;

  maxvelocity: Cvar | null = null;
  edgefriction: Cvar | null = null;
  stopspeed: Cvar | null = null;
  accelerate: Cvar | null = null;
  idealpitchscale: Cvar | null = null;
  aim: Cvar | null = null;
  nostep: Cvar | null = null;
  cheats: Cvar | null = null;
  gravity: Cvar | null = null;
  friction: Cvar | null = null;
  maxspeed: Cvar | null = null;
  airaccelerate: Cvar | null = null;
  wateraccelerate: Cvar | null = null;
  spectatormaxspeed: Cvar | null = null;
  waterfriction: Cvar | null = null;
  rcon_password: Cvar | null = null;
  maplist: Cvar | null = null;
  nextmap: Cvar | null = null;
  pausable: Cvar | null = null;
  teamplay: Cvar | null = null;
  ['public']: Cvar | null = null;

  /** Scheduled game commands. */
  _scheduledGameCommands: ScheduledGameCommand[] = [];

  constructor(dependencies: ServerDependencies) {
    this.con = dependencies.con;
    this.sys = dependencies.sys;
    this.net = dependencies.net;
    this.mod = dependencies.mod;
    this.view = dependencies.view;
    this.engineVersion = dependencies.engineVersion;
    this.files = dependencies.files;
    this.dedicated = dependencies.dedicated;
    this.engineAPI = new ServerEngineAPI(this, dependencies.gameEdition);

    this.physics = new ServerPhysics(this);
    this.clientPhysics = new ServerClientPhysics(this);
    this.messages = new ServerMessages(this);
    this.movement = new ServerMovement(this);
    this.area = new ServerArea(this, dependencies.collisionModelSource);
    this.collision = new ServerCollision(this, dependencies.collisionModelSource);
    this.ed = new ED(this);

    dependencies.collisionModelSource.configureServer({
      getWorldEntity: () => this.server.edicts[0] ?? null,
      getWorldModel: () => this.server.worldmodel,
      getModels: () => this.server.models.map((model) => model instanceof Promise ? null : model),
    });
  }

  InitPmove(): void {
    this.pmove = new Pmove();
    this.pmove.movevars = new PlayerMoveCvars(this);
  }

  Init(): void {
    this.maxvelocity = new Cvar('sv_maxvelocity', '2000', Cvar.FLAG.SERVER);
    this.edgefriction = new Cvar('edgefriction', '2', Cvar.FLAG.SERVER);
    this.stopspeed = new Cvar('sv_stopspeed', '100', Cvar.FLAG.SERVER);
    this.accelerate = new Cvar('sv_accelerate', '10', Cvar.FLAG.SERVER);
    this.idealpitchscale = new Cvar('sv_idealpitchscale', '0.8');
    this.aim = new Cvar('sv_aim', '0.93');
    this.nostep = new Cvar('sv_nostep', '0');
    this.cheats = new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
    this.gravity = new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER);
    this.friction = new Cvar('sv_friction', '4', Cvar.FLAG.SERVER);
    this.maxspeed = new Cvar('sv_maxspeed', '320', Cvar.FLAG.SERVER);
    this.airaccelerate = new Cvar('sv_airaccelerate', '0.7', Cvar.FLAG.SERVER);
    this.wateraccelerate = new Cvar('sv_wateraccelerate', '10', Cvar.FLAG.SERVER);
    this.spectatormaxspeed = new Cvar('sv_spectatormaxspeed', '500', Cvar.FLAG.SERVER);
    this.waterfriction = new Cvar('sv_waterfriction', '4', Cvar.FLAG.SERVER);
    this.rcon_password = new Cvar('sv_rcon_password', '', Cvar.FLAG.ARCHIVE);
    this.public = new Cvar('sv_public', '1', Cvar.FLAG.ARCHIVE | Cvar.FLAG.SERVER, 'Make this server publicly listed in the master server');

    this.pausable = new Cvar('pausable', '1', Cvar.FLAG.SERVER);
    this.teamplay = new Cvar('teamplay', '0', Cvar.FLAG.SERVER); // actually a game cvar, but we need it here, since a bunch of server code is using it

    this.ed.Init();
    Navigation.Init(this, this.dedicated);

    const { server, con } = this;

    Cmd.AddCommand('nav', class NavCommand extends ConsoleCommand {
      run(): void {
        if (!server.navigation) {
          con.Print('navigation not initialized, you have to spawn a server first\n');
          return;
        }

        server.navigation.build();
      }
    });

    eventBus.subscribe('cvar.changed', (name: string) => {
      const cvar = Cvar.FindVar(name)!;

      if ((cvar.flags & Cvar.FLAG.SERVER) && this.server.active) {
        this.messages.cvarChanged(cvar);
      }
    });

    this.InitNextmapStuff();
    this.InitPmove();
    this.area.initBoxHull();
  }

  InitNextmapStuff(): void {
    this.maplist = new Cvar('sv_maplist', '', Cvar.FLAG.NONE, 'Comma-separated list of maps to cycle through after each map change');
    this.nextmap = new Cvar('sv_nextmap', '', Cvar.FLAG.SERVER, 'Next map to change to after the current one, will be autopopulated with the next map in sv_maplist after each map change');

    eventBus.subscribe('cvar.changed.sv_maplist', () => {
      if (this.maplist!.string.trim() === '') {
        this.svs.maplist.length = 0;
        return;
      }

      this.svs.maplist = this.maplist!.string.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
    });

    eventBus.subscribe('server.spawning', ({ mapname }: { mapname: string }) => {
      if (this.svs.maplist.length === 0) {
        return;
      }

      if (!this.svs.maplist.includes(mapname)) {
        this.nextmap!.set(this.svs.maplist[0]);
        return;
      }

      const currentIndex = this.svs.maplist.indexOf(mapname);
      const nextIndex = (currentIndex + 1) % this.svs.maplist.length;
      this.nextmap!.set(this.svs.maplist[nextIndex]);
    });

    eventBus.subscribe('server.shutdown', () => {
      this.nextmap!.reset();
    });
  }

  /** Sends a chat message packet to a single client. */
  sendChatMessageToClient(client: ServerClient, name: string, message: string, direct = false): void {
    client.message.writeByte(Protocol.svc.chatmsg);
    client.message.writeString(name);
    client.message.writeString(message);
    client.message.writeByte(direct ? 1 : 0);
  }

  /** Sends a plain print message to a single client. */
  clientPrint(client: ServerClient, text: string): void {
    client.message.writeByte(Protocol.svc.print);
    client.message.writeString(text);
  }

  /** Prints a message on the screen of every spawned client. */
  broadcastPrint(text: string): void {
    for (const client of this.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.print);
      client.message.writeString(text);
    }
  }

  /**
   * Removes a client from the server, tells it why, and tells the others that it is gone.
   * @param crash True when the client is dropped because of a failure, the game is not told it left.
   */
  dropClient(client: ServerClient, crash: boolean, reason: string): void { // TODO: refactor into ServerClient
    if (this.net.CanSendMessage(client.netconnection)) {
      client.message.writeByte(Protocol.svc.disconnect);
      client.message.writeString(reason);
      this.net.SendMessage(client.netconnection, client.message);
    }

    if (!crash) {
      if (client.edict && client.state === ServerClient.STATE.SPAWNED) {
        console.assert(this.server.gameAPI !== null, 'a spawned client requires a live server game API');
        this.server.gameAPI!.ClientDisconnect(client.edict);
      }

      this.sys.Print(`Client ${client.name} removed\n`);
    } else {
      client.state = ServerClient.STATE.DROPASAP;
      this.sys.Print(`Client ${client.name} dropped\n`);
    }

    this.net.Close(client.netconnection);

    const { name, num } = client;

    client.clear();
    this.net.activeconnections--;

    eventBus.publish('server.client.disconnected', num, name);

    for (let index = 0; index < this.svs.maxclients; index++) {
      const spawnedClient = this.svs.clients[index];

      if (spawnedClient.state <= ServerClient.STATE.CONNECTED) {
        continue;
      }

      // FIXME: consolidate into a single message.
      spawnedClient.message.writeByte(Protocol.svc.updatename);
      spawnedClient.message.writeByte(num);
      spawnedClient.message.writeByte(0);
      spawnedClient.message.writeByte(Protocol.svc.updatefrags);
      spawnedClient.message.writeByte(num);
      spawnedClient.message.writeShort(0);
      spawnedClient.message.writeByte(Protocol.svc.updatecolors);
      spawnedClient.message.writeByte(num);
      spawnedClient.message.writeByte(0);
      spawnedClient.message.writeByte(Protocol.svc.updatepings);
      spawnedClient.message.writeByte(num);
      spawnedClient.message.writeShort(0);
    }
  }

  RunScheduledGameCommands(): void {
    while (this._scheduledGameCommands.length > 0) {
      const command = this._scheduledGameCommands.shift();

      command?.();
    }
  }

  ScheduleGameCommand(command: ScheduledGameCommand): void {
    this._scheduledGameCommands.push(command);
  }

  ConnectClient(client: ServerClient, netconnection: QSocket): void {
    this.con.DPrint(`Client ${netconnection.address} connected\n`);

    const oldSpawnParms: ServerClientSpawnParameters = this.server.loadgame ? client.spawn_parms : null;

    client.clear();
    client.name = 'unconnected';
    client.netconnection = netconnection;
    client.state = ServerClient.STATE.CONNECTING;
    client.old_frags = Infinity;

    const entity = client.entity as DynamicSpawnClientEntity;
    console.assert(typeof entity.restoreSpawnParameters === 'function', 'player entity must implement restoreSpawnParameters');
    entity.restoreSpawnParameters(typeof oldSpawnParms === 'string' ? oldSpawnParms : null);

    this.messages.sendServerData(client);
  }

  CheckForNewClients(): void {
    while (true) {
      const ret = this.net.CheckNewConnections();

      if (!ret) {
        return;
      }

      let i: number;

      for (i = 0; i < this.svs.maxclients; i++) {
        if (this.svs.clients[i].state < ServerClient.STATE.CONNECTED) {
          break;
        }
      }

      if (i === this.svs.maxclients) {
        this.con.Print('SV.CheckForNewClients: Server is full\n');
        const message = new SzBuffer(32);
        message.writeByte(Protocol.svc.disconnect);
        message.writeString('Server is full');
        this.net.SendUnreliableMessage(ret, message);
        this.net.Close(ret);
        return;
      }

      const client = this.svs.clients[i];
      this.ConnectClient(client, ret);
      this.net.activeconnections++;
      eventBus.publish('server.client.connected', client.num, client.name);
    }
  }

  ModelIndex(name: string | null): number | null {
    if (!name) {
      return 0;
    }

    for (let i = 0; i < this.server.modelPrecache.length; i++) {
      if (this.server.modelPrecache[i] === name) {
        return i;
      }
    }

    console.assert(false, 'model must be precached', name);
    return null;
  }

  SaveSpawnparms(): void {
    console.assert(this.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = this.server.gameAPI!;

    this.svs.serverflags = gameAPI.serverflags;

    for (let i = 0; i < this.svs.maxclients; i++) {
      const client = this.svs.clients[i];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.saveSpawnparms();
    }
  }

  HasMap(mapname: string): boolean {
    console.trace('SV.HasMap called');
    return this.mod.known[`maps/${mapname}.bsp`] !== undefined;
  }

  async SpawnServer(mapname: string): Promise<boolean> {
    if (this.net.hostname.string.trim() === '') {
      this.net.hostname.set('UNNAMED');
    }

    eventBus.publish('server.spawning', { mapname });
    this.con.DPrint(`SpawnServer: ${mapname}\n`);

    if (this.server.active) {
      this.#notifyClientsOfMapChange(mapname);
    }

    this.con.DPrint('Clearing memory\n');
    this.mod.ClearAll(ModelScope.server);
    this.#loadGameProgs();

    this.#initializeEdicts();

    if (!await this.#loadWorldModel(mapname)) {
      return false;
    }

    console.assert(this.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = this.server.worldmodel!;
    console.assert(this.pmove !== null, 'SV.pmove is initialized');
    const pmove = this.pmove!;
    pmove.setWorldmodel(worldmodel);

    this.area.initOctree(worldmodel.mins, worldmodel.maxs);
    this.#setupModelPrecache();

    if (!this.#setupPlayerEntities()) {
      return false;
    }

    this.#initializeLightStyles();
    this.#setupClientDataFields();
    this.#setupExtendedEntityFields();

    this.server.eventBus.unsubscribeAll();
    this.server.navigation = new Navigation(worldmodel, { con: this.con, files: this.files, sv: this });

    console.assert(this.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = this.server.gameAPI!;
    gameAPI.init(mapname, this.svs.serverflags);

    if (!this.#spawnWorldspawnEntity()) {
      return false;
    }

    await this.WaitForPrecachedResources();
    await this.ed.LoadFromFile(worldmodel.entities!);
    this.#finalizeServerSpawn(mapname);
    this.svs.changelevelIssued = false;

    return true;
  }

  ShutdownServer(isCrashShutdown: boolean): void {
    this.server.gameAPI?.shutdown(isCrashShutdown);

    this.server.active = false;
    this.server.loading = false;
    this.server.worldmodel = null;
    this.server.gameAPI = null;

    for (const client of this.svs.clients) {
      client.clear();
    }

    for (const edict of this.server.edicts) {
      edict.clear();
      edict.freeEdict();
    }

    this.server.edicts.length = 0;
    this.server.num_edicts = 0;

    for (const model of this.server.models) {
      if (model instanceof Promise) {
        void model.then((loadedModel) => loadedModel?.reset());
        continue;
      }

      model?.reset();
    }

    this.server.models.length = 0;

    if (this.server.navigation) {
      this.server.navigation.shutdown();
      this.server.navigation = null;
    }

    this.server.eventBus.unsubscribeAll();
    this.svs.changelevelIssued = false;

    if (isCrashShutdown) {
      this.con.PrintWarning('Server shut down due to a crash!\n');
      return;
    }

    this.con.DPrint('Server shut down.\n');
  }

  ReadClientMove(client: ServerClient): void {
    const cmd = new Protocol.UserCmd();
    cmd.msec = this.net.message.readByte();
    cmd.angles = this.net.message.readAngleVector();
    cmd.forwardmove = this.net.message.readShort();
    cmd.sidemove = this.net.message.readShort();
    cmd.upmove = this.net.message.readShort();
    cmd.buttons = this.net.message.readByte();
    cmd.impulse = this.net.message.readByte();
    const seq = this.net.message.readByte();

    console.assert(client.edict.entity !== null, 'ServerClient.entity requires a linked edict entity');

    const entity = client.edict.entity as PlayerClientdataEntity;

    entity.button0 = (cmd.buttons & Protocol.button.attack) === 1;
    entity.button1 = ((cmd.buttons & Protocol.button.use) >> 2) === 1;
    entity.button2 = ((cmd.buttons & Protocol.button.jump) >> 1) === 1;
    entity.v_angle = cmd.angles;

    if (cmd.impulse !== 0) {
      entity.impulse = cmd.impulse;
    }

    if (this.server.paused) {
      client.cmd.set(cmd);
      client.lastMoveSequence = seq;
      return;
    }

    client.pendingCmds.push(cmd);
    client.cmd.set(cmd);
    client.lastMoveSequence = seq;
  }

  HandleRconRequest(client: ServerClient): void {
    const message = client.message;
    const netconnection = client.netconnection;

    if (netconnection === null) {
      return;
    }

    const password = this.net.message.readString();
    const cmd = this.net.message.readString();
    const rconPassword = this.rcon_password!.string;

    if (rconPassword === '' || rconPassword !== password) {
      message.writeByte(Protocol.svc.print);
      message.writeString('Wrong rcon password!\n');

      if (rconPassword === '') {
        this.con.Print(`SV.HandleRconRequest: rcon attempted by ${client.name} from ${netconnection.address}: ${cmd}\n`);
      }

      return;
    }

    this.con.Print(`[${client.name}@${netconnection.address}] ${cmd}\n`);

    this.con.StartCapturing();
    void Cmd.ExecuteString(cmd);

    const response = this.con.StopCapturing();
    message.writeByte(Protocol.svc.print);
    message.writeString(response);
  }

  ReadClientMessage(client: ServerClient): boolean {
    const netconnection = client.netconnection;

    if (netconnection === null) {
      return false;
    }

    while (true) {
      const ret = this.net.GetMessage(netconnection);

      if (ret === -1) {
        this.con.DPrint(`SV.ReadClientMessage: NET.GetMessage from ${client.name} (${netconnection.address}) failed\n`);
        return false;
      }

      if (ret === 0) {
        return true;
      }

      this.net.message.beginReading();

      while (true) {
        if (client.state < ServerClient.STATE.CONNECTED) {
          return false;
        }

        if (this.net.message.badread) {
          this.con.Print('SV.ReadClientMessage: badread\n');
          return false;
        }

        client.ping_times[client.num_pings++ % client.ping_times.length] = this.server.time - client.sync_time;

        const cmd = this.net.message.readChar();

        if (cmd === -1) {
          break;
        }

        if (!this.#processClientCommand(client, cmd)) {
          return false;
        }
      }
    }
  }

  RunClients(): void {
    for (let i = 0; i < this.svs.maxclients; i++) {
      const client = this.svs.clients[i];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (!this.ReadClientMessage(client)) {
        this.dropClient(client, false, 'Connectivity issues, failed to read message');
        continue;
      }

      if (client.state < ServerClient.STATE.CONNECTED) {
        client.cmd.reset();
        continue;
      }

      this.clientPhysics.clientThink(client.edict, client);
    }
  }

  FindClientByName(name: string): ServerClient | null {
    return this.svs.clients
      .filter((client) => client.state >= ServerClient.STATE.CONNECTED)
      .find((client) => client.name === name) ?? null;
  }

  #notifyClientsOfMapChange(mapname: string): void {
    for (const client of this.svs.clients) {
      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.changelevel(mapname);
    }

    if (this.server.navigation) {
      this.server.navigation.shutdown();
      this.server.navigation = null;
    }
  }

  #loadGameProgs(): void {
    const activeGameModule = requireActiveGameModule();
    this.server.gameAPI = new activeGameModule.ServerGameAPI(this.engineAPI);
    this.server.gameVersion = activeGameModule.identification.version.join('.');
    this.server.gameName = activeGameModule.identification.name;
    this.server.gameCapabilities = [...activeGameModule.identification.capabilities];

    this.con.DPrint('Game progs loaded\n');
  }

  #initializeEdicts(): void {
    this.server.edicts.length = 0;

    for (let i = 0; i < Def.limits.edicts; i++) {
      this.server.edicts[i] = new ServerEdict(i, this);
    }

    this.server.datagram.clear();
    this.server.reliable_datagram.clear();
    this.server.signon.clear();
    this.server.num_edicts = this.svs.maxclients + 1;
    this.server.loading = true;
    this.server.paused = false;
    this.server.loadgame = false;
    this.server.time = 1.0;
    this.server.lastcheck = 0;
    this.server.lastchecktime = 0.0;

    this.con.DPrint('Edicts initialized\n');
  }

  async #loadWorldModel(mapname: string): Promise<boolean> {
    this.server.mapname = mapname;
    this.server.worldmodel = await this.mod.ForNameAsync(`maps/${mapname}.bsp`, false, ModelScope.server) as BrushModel | null;

    if (this.server.worldmodel === null) {
      this.con.PrintWarning(`SV.SpawnServer: Cannot start server, unable to load map ${mapname}\n`);
      this.server.active = false;
      return false;
    }

    this.con.DPrint('World model loaded\n');
    return true;
  }

  #setupModelPrecache(): void {
    console.assert(this.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = this.server.worldmodel!;

    this.server.models.length = 2;
    this.server.models[0] = null;
    this.server.models[1] = worldmodel;

    this.server.soundPrecache.length = 1;
    this.server.soundPrecache[0] = '';

    this.server.modelPrecache.length = 2 + worldmodel.submodels.length;
    this.server.modelPrecache[0] = '';
    this.server.modelPrecache[1] = worldmodel.name;

    for (let i = 1; i <= worldmodel.submodels.length; i++) {
      this.server.modelPrecache[i + 1] = `*${i}`;
      this.server.models[i + 1] = this.mod.ForName(`*${i}`, ModelScope.server) as BaseModel;
    }

    this.con.DPrint('Model precache setup complete\n');
  }

  #setupPlayerEntities(): boolean {
    console.assert(this.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = this.server.gameAPI!;

    for (let i = 0; i < this.svs.maxclients; i++) {
      const ent = this.server.edicts[i + 1] as ServerEdict;

      if (!gameAPI.prepareEntity(ent, 'player')) {
        this.con.PrintWarning('SV.SpawnServer: Cannot start server, because game does not know what a player entity is.\n');
        this.server.active = false;
        return false;
      }
    }

    this.con.DPrint('Player entities setup complete\n');
    return true;
  }

  #initializeLightStyles(): void {
    this.server.lightstyles = [];

    for (let i = 0; i <= Def.limits.lightstyles; i++) {
      this.server.lightstyles[i] = '';
    }

    this.con.DPrint('Light styles initialized\n');
  }

  #setupClientDataFields(): void {
    const playerEntity = this.server.edicts[1]?.entity;

    console.assert(playerEntity !== null, 'GameModule player entity must exist');
    console.assert(playerEntity !== null && 'clientdataFields' in playerEntity, 'GameModule player entity must expose clientdataFields');

    const typedPlayerEntity = playerEntity as PlayerClientdataEntity;
    const fields = typedPlayerEntity.clientdataFields;

    console.assert(fields instanceof Array, 'clientdataFields must be an array');

    this.server.clientdataFields.length = 0;
    this.server.clientdataFields.push(...fields);
    console.assert(this.server.clientdataFields.length <= 32, 'clientdata must not have more than 32 fields');

    if (fields.length <= 8) {
      this.server.clientdataFieldsBitsWriter = 'writeByte';
    } else if (fields.length <= 16) {
      this.server.clientdataFieldsBitsWriter = 'writeShort';
    } else if (fields.length <= 32) {
      this.server.clientdataFieldsBitsWriter = 'writeLong';
    }

    for (const field of fields) {
      console.assert(typedPlayerEntity[field] !== undefined, `Undefined clientdata field ${field}`);
    }

    this.con.DPrint('Clientdata fields setup complete\n');
  }

  #setupExtendedEntityFields(): void {
    console.assert(this.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const fields = this.server.gameAPI!.getClientEntityFields();

    for (const key of Object.keys(this.server.clientEntityFields)) {
      delete this.server.clientEntityFields[key];
    }

    for (const [classname, extendedFields] of Object.entries(fields)) {
      const clientEntityField: ClientEntityFieldConfig = {
        fields: [],
        bitsWriter: null,
      };

      clientEntityField.fields.push(...extendedFields);

      if (extendedFields.length <= 8) {
        clientEntityField.bitsWriter = 'writeByte';
      } else if (extendedFields.length <= 16) {
        clientEntityField.bitsWriter = 'writeShort';
      } else if (extendedFields.length <= 32) {
        clientEntityField.bitsWriter = 'writeLong';
      }

      this.server.clientEntityFields[classname] = clientEntityField;
    }

    this.con.DPrint('Extended entity fields setup complete\n');
  }

  #spawnWorldspawnEntity(): boolean {
    const ent = this.server.edicts[0] as ServerEdict;
    console.assert(this.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = this.server.worldmodel!;
    console.assert(this.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = this.server.gameAPI!;

    if (!gameAPI.prepareEntity(ent, 'worldspawn', {
      model: worldmodel.name,
      modelindex: 1,
      solid: Defs.solid.SOLID_BSP,
      movetype: Defs.moveType.MOVETYPE_PUSH,
    })) {
      this.con.PrintWarning('SV.SpawnServer: Cannot start server, because the game does not know what a worldspawn entity is.\n');
      this.server.active = false;
      return false;
    }

    gameAPI.spawnPreparedEntity(ent);
    this.con.DPrint('Worldspawn entity spawned\n');
    return true;
  }

  async WaitForPrecachedResources(): Promise<void> {
    const resolvedModels: Array<BaseModel | null> = [];

    for (const model of this.server.models) {
      if (model instanceof Promise) {
        resolvedModels.push(await model);
        continue;
      }

      resolvedModels.push(model);
    }

    this.server.models.length = 0;

    for (const model of resolvedModels) {
      this.server.models.push(model);
    }

    this.con.DPrint('Pending precached resources loaded\n');
  }

  #finalizeServerSpawn(mapname: string): void {
    this.server.active = true;
    this.server.loading = false;

    this.server.frametime = 0.1;
    this.physics.physics();
    this.physics.physics();

    for (let i = 0; i < this.svs.maxclients; i++) {
      const client = this.svs.clients[i];

      if (client.state >= ServerClient.STATE.CONNECTED) {
        this.messages.sendServerData(client);
      }
    }

    console.assert(this.server.navigation !== null, 'SV.server.navigation is initialized');
    this.server.navigation!.init();
    eventBus.publish('server.spawned', { mapname });
    this.con.PrintSuccess('Server spawned.\n');
  }

  #handleClientStringCommand(client: ServerClient, input: string): void {
    const matchedCommand = ALLOWED_CLIENT_COMMANDS.find((command) => input.toLowerCase().startsWith(command));

    if (matchedCommand) {
      void Cmd.ExecuteString(input, client);
      return;
    }

    this.con.Print(`${client.name} tried to ${input}!\n`);
  }

  #processClientCommand(client: ServerClient, cmd: Protocol.clc): boolean {
    switch (cmd) {
      case Protocol.clc.nop:
        this.con.DPrint(`${client.netconnection?.address ?? 'unknown'} sent a nop\n`);
        return true;

      case Protocol.clc.stringcmd: {
        const input = this.net.message.readString();
        this.#handleClientStringCommand(client, input);
        return true;
      }

      case Protocol.clc.sync:
        client.sync_time = this.net.message.readFloat();
        return true;

      case Protocol.clc.rconcmd:
        this.HandleRconRequest(client);
        return true;

      case Protocol.clc.disconnect:
        return false;

      case Protocol.clc.move:
        this.ReadClientMove(client);
        return true;

      default:
        this.con.DPrint(`SV.ReadClientMessage: unknown command ${cmd} from ${client.netconnection?.address ?? 'unknown'}\n`);
        return false;
    }
  }
}

/**
 * Simple class hooking up all movevars with corresponding cvars.
 */
class PlayerMoveCvars extends MoveVars {
  readonly #sv: Server;

  constructor(sv: Server) {
    super();
    this.#sv = sv;
  }

  // @ts-ignore
  get gravity(): number { return this.#sv.gravity!.value; }
  // @ts-ignore
  get stopspeed(): number { return this.#sv.stopspeed!.value; }
  // @ts-ignore
  get maxspeed(): number { return this.#sv.maxspeed!.value; }
  // @ts-ignore
  get spectatormaxspeed(): number { return this.#sv.spectatormaxspeed!.value; }
  // @ts-ignore
  get accelerate(): number { return this.#sv.accelerate!.value; }
  // @ts-ignore
  get airaccelerate(): number { return this.#sv.airaccelerate!.value; }
  // @ts-ignore
  get wateraccelerate(): number { return this.#sv.wateraccelerate!.value; }
  // @ts-ignore
  get friction(): number { return this.#sv.friction!.value; }
  // @ts-ignore
  get waterfriction(): number { return this.#sv.waterfriction!.value; }
  // @ts-ignore
  get edgefriction(): number { return this.#sv.edgefriction!.value; }

  set gravity(_value: number) {}
  set stopspeed(_value: number) {}
  set maxspeed(_value: number) {}
  set spectatormaxspeed(_value: number) {}
  set accelerate(_value: number) {}
  set airaccelerate(_value: number) {}
  set wateraccelerate(_value: number) {}
  set friction(_value: number) {}
  set waterfriction(_value: number) {}
  set edgefriction(_value: number) {}

  /**
   * Writes the movevars to the client.
   */
  sendToClient(message: SzBuffer): void {
    message.writeFloat(this.gravity);
    message.writeFloat(this.stopspeed);
    message.writeFloat(this.maxspeed);
    message.writeFloat(this.spectatormaxspeed);
    message.writeFloat(this.accelerate);
    message.writeFloat(this.airaccelerate);
    message.writeFloat(this.wateraccelerate);
    message.writeFloat(this.friction);
    message.writeFloat(this.waterfriction);
    message.writeFloat(this.entgravity);
  }
}
