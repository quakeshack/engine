import type { ClientEdict, ServerGameInterface } from '../../shared/GameInterfaces.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { QSocket } from '../network/NetworkDrivers.ts';

import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';
import { MoveVars, Pmove } from '../common/Pmove.ts';
import { SzBuffer } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from './../common/Def.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import { ED, ServerEdict } from './Edict.ts';
import { EventBus, eventBus, getCommonRegistry } from '../registry.ts';
import { requireActiveGameModule } from '../common/GameModule.ts';
import { ServerEngineAPI } from '../common/GameAPIs.ts';
import * as Defs from '../../shared/Defs.ts';
import { Navigation } from './Navigation.ts';
import { ServerPhysics } from './physics/ServerPhysics.ts';
import { ServerClientPhysics } from './physics/ServerClientPhysics.ts';
import { ServerMessages } from './ServerMessages.ts';
import { ServerMovement } from './physics/ServerMovement.ts';
import { ServerArea } from './physics/ServerArea.ts';
import { ServerCollision } from './physics/ServerCollision.ts';
import { sharedCollisionModelSource } from '../common/CollisionModelSource.ts';
import { BrushModel, ModelScope } from '../common/Mod.ts';
import { ServerClient } from './Client.ts';

export { ServerEntityState } from './ServerEntityState.ts';

let { Con, Host, Mod, NET } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Host, Mod, NET } = getCommonRegistry());
});

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

/**
 * Runtime view of the active game API owned by the server.
 *
 * This extends the public game-module contract with mutable state that the
 * server frame loop and QuakeC builtin layer exchange at runtime, such as
 * trace results, orientation vectors, and legacy global values like `self`.
 * Keeping that widened shape local to the server preserves the stable
 * `ServerGameInterface` boundary while still giving engine code a typed place
 * for the extra per-frame data that does not belong in the public API.
 */
interface ServerRuntimeGameAPI extends ServerGameInterface {
  coop?: number;
  deathmatch?: number;
  force_retouch?: number;
  frametime: number;
  mapname?: string | null;
  msg_entity?: ServerEdict | null;
  self?: ServerEdict | null;
  time: number;
  serverflags?: number;
  trace_allsolid?: number;
  trace_endpos?: Vector;
  trace_ent?: { readonly entity: ClientEdict | NonNullable<ServerEdict['entity']> } | null;
  trace_fraction?: number;
  trace_inopen?: number;
  trace_inwater?: number;
  trace_plane_dist?: number;
  trace_plane_normal?: Vector;
  trace_startsolid?: number;
  v_forward?: Vector;
  v_right?: Vector;
  v_up?: Vector;
}

interface ClientEntityFieldConfig {
  fields: string[];
  bitsWriter: BitsWriter | null;
}

interface ServerState {
  time: number;
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
  gameAPI: ServerRuntimeGameAPI | null;
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
 * Main server class with all server-related functionality.
 * All properties and methods are static.
 */
export default class SV {
  /** current server state */
  static server: ServerState = {
    time: 0,
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
  static svs: ServerStaticState = {
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

  static physics = new ServerPhysics();
  static clientPhysics = new ServerClientPhysics();
  static messages = new ServerMessages();
  static movement = new ServerMovement();
  static area = new ServerArea(sharedCollisionModelSource);
  static collision = new ServerCollision(sharedCollisionModelSource);

  /** shared player-move collision context */
  static pmove: Pmove | null = null;

  static maxvelocity: Cvar | null = null;
  static edgefriction: Cvar | null = null;
  static stopspeed: Cvar | null = null;
  static accelerate: Cvar | null = null;
  static idealpitchscale: Cvar | null = null;
  static aim: Cvar | null = null;
  static nostep: Cvar | null = null;
  static cheats: Cvar | null = null;
  static gravity: Cvar | null = null;
  static friction: Cvar | null = null;
  static maxspeed: Cvar | null = null;
  static airaccelerate: Cvar | null = null;
  static wateraccelerate: Cvar | null = null;
  static spectatormaxspeed: Cvar | null = null;
  static waterfriction: Cvar | null = null;
  static rcon_password: Cvar | null = null;
  static maplist: Cvar | null = null;
  static nextmap: Cvar | null = null;
  static ['public']: Cvar | null = null;

  /** Scheduled game commands. */
  static _scheduledGameCommands: ScheduledGameCommand[] = [];

  static InitPmove(): void {
    SV.pmove = new Pmove();
    SV.pmove.movevars = new PlayerMoveCvars();
  }

  static Init(): void {
    SV.maxvelocity = new Cvar('sv_maxvelocity', '2000', Cvar.FLAG.SERVER);
    SV.edgefriction = new Cvar('edgefriction', '2', Cvar.FLAG.SERVER);
    SV.stopspeed = new Cvar('sv_stopspeed', '100', Cvar.FLAG.SERVER);
    SV.accelerate = new Cvar('sv_accelerate', '10', Cvar.FLAG.SERVER);
    SV.idealpitchscale = new Cvar('sv_idealpitchscale', '0.8');
    SV.aim = new Cvar('sv_aim', '0.93');
    SV.nostep = new Cvar('sv_nostep', '0');
    SV.cheats = new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
    SV.gravity = new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER);
    SV.friction = new Cvar('sv_friction', '4', Cvar.FLAG.SERVER);
    SV.maxspeed = new Cvar('sv_maxspeed', '320', Cvar.FLAG.SERVER);
    SV.airaccelerate = new Cvar('sv_airaccelerate', '0.7', Cvar.FLAG.SERVER);
    SV.wateraccelerate = new Cvar('sv_wateraccelerate', '10', Cvar.FLAG.SERVER);
    SV.spectatormaxspeed = new Cvar('sv_spectatormaxspeed', '500', Cvar.FLAG.SERVER);
    SV.waterfriction = new Cvar('sv_waterfriction', '4', Cvar.FLAG.SERVER);
    SV.rcon_password = new Cvar('sv_rcon_password', '', Cvar.FLAG.ARCHIVE);
    SV.public = new Cvar('sv_public', '1', Cvar.FLAG.ARCHIVE | Cvar.FLAG.SERVER, 'Make this server publicly listed in the master server');

    Navigation.Init();

    Cmd.AddCommand('nav', class NavCommand extends ConsoleCommand {
      run(): void {
        if (!SV.server.navigation) {
          Con.Print('navigation not initialized, you have to spawn a server first\n');
          return;
        }

        SV.server.navigation.build();
      }
    });

    eventBus.subscribe('cvar.changed', (name: string) => {
      const cvar = Cvar.FindVar(name)!;

      if ((cvar.flags & Cvar.FLAG.SERVER) && SV.server.active) {
        SV.messages.cvarChanged(cvar);
      }
    });

    SV.InitNextmapStuff();
    SV.InitPmove();
    SV.area.initBoxHull();
  }

  static InitNextmapStuff(): void {
    SV.maplist = new Cvar('sv_maplist', '', Cvar.FLAG.NONE, 'Comma-separated list of maps to cycle through after each map change');
    SV.nextmap = new Cvar('sv_nextmap', '', Cvar.FLAG.SERVER, 'Next map to change to after the current one, will be autopopulated with the next map in sv_maplist after each map change');

    eventBus.subscribe('cvar.changed.sv_maplist', () => {
      if (SV.maplist!.string.trim() === '') {
        SV.svs.maplist.length = 0;
        return;
      }

      SV.svs.maplist = SV.maplist!.string.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
    });

    eventBus.subscribe('server.spawning', ({ mapname }: { mapname: string }) => {
      if (SV.svs.maplist.length === 0) {
        return;
      }

      if (!SV.svs.maplist.includes(mapname)) {
        SV.nextmap!.set(SV.svs.maplist[0]);
        return;
      }

      const currentIndex = SV.svs.maplist.indexOf(mapname);
      const nextIndex = (currentIndex + 1) % SV.svs.maplist.length;
      SV.nextmap!.set(SV.svs.maplist[nextIndex]);
    });

    eventBus.subscribe('server.shutdown', () => {
      SV.nextmap!.reset();
    });
  }

  static RunScheduledGameCommands(): void {
    while (SV._scheduledGameCommands.length > 0) {
      const command = SV._scheduledGameCommands.shift();

      command?.();
    }
  }

  static ScheduleGameCommand(command: ScheduledGameCommand): void {
    SV._scheduledGameCommands.push(command);
  }

  static ConnectClient(client: ServerClient, netconnection: QSocket): void {
    Con.DPrint(`Client ${netconnection.address} connected\n`);

    const oldSpawnParms: ServerClientSpawnParameters = SV.server.loadgame ? client.spawn_parms : null;

    client.clear();
    client.name = 'unconnected';
    client.netconnection = netconnection;
    client.state = ServerClient.STATE.CONNECTING;
    client.old_frags = Infinity;

    const entity = client.entity as DynamicSpawnClientEntity;
    console.assert(typeof entity.restoreSpawnParameters === 'function', 'player entity must implement restoreSpawnParameters');
    entity.restoreSpawnParameters(typeof oldSpawnParms === 'string' ? oldSpawnParms : null);

    SV.messages.sendServerData(client);
  }

  static CheckForNewClients(): void {
    while (true) {
      const ret = NET.CheckNewConnections();

      if (!ret) {
        return;
      }

      let i: number;

      for (i = 0; i < SV.svs.maxclients; i++) {
        if (SV.svs.clients[i].state < ServerClient.STATE.CONNECTED) {
          break;
        }
      }

      if (i === SV.svs.maxclients) {
        Con.Print('SV.CheckForNewClients: Server is full\n');
        const message = new SzBuffer(32);
        message.writeByte(Protocol.svc.disconnect);
        message.writeString('Server is full');
        NET.SendUnreliableMessage(ret, message);
        NET.Close(ret);
        return;
      }

      const client = SV.svs.clients[i];
      SV.ConnectClient(client, ret);
      NET.activeconnections++;
      eventBus.publish('server.client.connected', client.num, client.name);
    }
  }

  static ModelIndex(name: string | null): number | null {
    if (!name) {
      return 0;
    }

    for (let i = 0; i < SV.server.modelPrecache.length; i++) {
      if (SV.server.modelPrecache[i] === name) {
        return i;
      }
    }

    console.assert(false, 'model must be precached', name);
    return null;
  }

  static SaveSpawnparms(): void {
    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = SV.server.gameAPI!;

    if ('serverflags' in gameAPI) {
      SV.svs.serverflags = gameAPI.serverflags ?? 0;
    }

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.saveSpawnparms();
    }
  }

  static HasMap(mapname: string): boolean {
    console.trace('SV.HasMap called');
    return Mod.known[`maps/${mapname}.bsp`] !== undefined;
  }

  static async SpawnServer(mapname: string): Promise<boolean> {
    if (NET.hostname.string.trim() === '') {
      NET.hostname.set('UNNAMED');
    }

    eventBus.publish('server.spawning', { mapname });
    Con.DPrint(`SpawnServer: ${mapname}\n`);

    if (SV.server.active) {
      SV.#notifyClientsOfMapChange(mapname);
    }

    Con.DPrint('Clearing memory\n');
    Mod.ClearAll(ModelScope.server);
    SV.#loadGameProgs();

    SV.#initializeEdicts();

    if (!await SV.#loadWorldModel(mapname)) {
      return false;
    }

    console.assert(SV.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = SV.server.worldmodel!;
    console.assert(SV.pmove !== null, 'SV.pmove is initialized');
    const pmove = SV.pmove!;
    pmove.setWorldmodel(worldmodel);

    SV.area.initOctree(worldmodel.mins, worldmodel.maxs);
    SV.#setupModelPrecache();

    if (!SV.#setupPlayerEntities()) {
      return false;
    }

    SV.#initializeLightStyles();
    SV.#setupClientDataFields();
    SV.#setupExtendedEntityFields();

    SV.server.eventBus.unsubscribeAll();
    SV.server.navigation = new Navigation(worldmodel);

    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = SV.server.gameAPI!;
    gameAPI.init(mapname, SV.svs.serverflags);

    if (!SV.#spawnWorldspawnEntity()) {
      return false;
    }

    await SV.WaitForPrecachedResources();
    await ED.LoadFromFile(worldmodel.entities!);
    SV.#finalizeServerSpawn(mapname);
    SV.svs.changelevelIssued = false;

    return true;
  }

  static ShutdownServer(isCrashShutdown: boolean): void {
    SV.server.gameAPI?.shutdown(isCrashShutdown);

    SV.server.active = false;
    SV.server.loading = false;
    SV.server.worldmodel = null;
    SV.server.gameAPI = null;

    for (const client of SV.svs.clients) {
      client.clear();
    }

    for (const edict of SV.server.edicts) {
      edict.clear();
      edict.freeEdict();
    }

    SV.server.edicts.length = 0;
    SV.server.num_edicts = 0;

    for (const model of SV.server.models) {
      if (model instanceof Promise) {
        void model.then((loadedModel) => loadedModel?.reset());
        continue;
      }

      model?.reset();
    }

    SV.server.models.length = 0;

    if (SV.server.navigation) {
      SV.server.navigation.shutdown();
      SV.server.navigation = null;
    }

    SV.server.eventBus.unsubscribeAll();
    SV.svs.changelevelIssued = false;

    if (isCrashShutdown) {
      Con.PrintWarning('Server shut down due to a crash!\n');
      return;
    }

    Con.DPrint('Server shut down.\n');
  }

  static ReadClientMove(client: ServerClient): void {
    const cmd = new Protocol.UserCmd();
    cmd.msec = NET.message.readByte();
    cmd.angles = NET.message.readAngleVector();
    cmd.forwardmove = NET.message.readShort();
    cmd.sidemove = NET.message.readShort();
    cmd.upmove = NET.message.readShort();
    cmd.buttons = NET.message.readByte();
    cmd.impulse = NET.message.readByte();
    const seq = NET.message.readByte();

    console.assert(client.edict.entity !== null, 'ServerClient.entity requires a linked edict entity');

    const entity = client.edict.entity as PlayerClientdataEntity;

    entity.button0 = (cmd.buttons & Protocol.button.attack) === 1;
    entity.button1 = ((cmd.buttons & Protocol.button.use) >> 2) === 1;
    entity.button2 = ((cmd.buttons & Protocol.button.jump) >> 1) === 1;
    entity.v_angle = cmd.angles;

    if (cmd.impulse !== 0) {
      entity.impulse = cmd.impulse;
    }

    if (SV.server.paused) {
      client.cmd.set(cmd);
      client.lastMoveSequence = seq;
      return;
    }

    client.pendingCmds.push(cmd);
    client.cmd.set(cmd);
    client.lastMoveSequence = seq;
  }

  static HandleRconRequest(client: ServerClient): void {
    const message = client.message;
    const netconnection = client.netconnection;

    if (netconnection === null) {
      return;
    }

    const password = NET.message.readString();
    const cmd = NET.message.readString();
    const rconPassword = SV.rcon_password!.string;

    if (rconPassword === '' || rconPassword !== password) {
      message.writeByte(Protocol.svc.print);
      message.writeString('Wrong rcon password!\n');

      if (rconPassword === '') {
        Con.Print(`SV.HandleRconRequest: rcon attempted by ${client.name} from ${netconnection.address}: ${cmd}\n`);
      }

      return;
    }

    Con.Print(`[${client.name}@${netconnection.address}] ${cmd}\n`);

    Con.StartCapturing();
    void Cmd.ExecuteString(cmd);

    const response = Con.StopCapturing();
    message.writeByte(Protocol.svc.print);
    message.writeString(response);
  }

  static ReadClientMessage(client: ServerClient): boolean {
    const netconnection = client.netconnection;

    if (netconnection === null) {
      return false;
    }

    while (true) {
      const ret = NET.GetMessage(netconnection);

      if (ret === -1) {
        Con.DPrint(`SV.ReadClientMessage: NET.GetMessage from ${client.name} (${netconnection.address}) failed\n`);
        return false;
      }

      if (ret === 0) {
        return true;
      }

      NET.message.beginReading();

      while (true) {
        if (client.state < ServerClient.STATE.CONNECTED) {
          return false;
        }

        if (NET.message.badread) {
          Con.Print('SV.ReadClientMessage: badread\n');
          return false;
        }

        client.ping_times[client.num_pings++ % client.ping_times.length] = SV.server.time - client.sync_time;

        const cmd = NET.message.readChar();

        if (cmd === -1) {
          break;
        }

        if (!SV.#processClientCommand(client, cmd)) {
          return false;
        }
      }
    }
  }

  static RunClients(): void {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (!SV.ReadClientMessage(client)) {
        Host.DropClient(client, false, 'Connectivity issues, failed to read message');
        continue;
      }

      if (client.state < ServerClient.STATE.CONNECTED) {
        client.cmd.reset();
        continue;
      }

      SV.clientPhysics.clientThink(client.edict, client);
    }
  }

  static FindClientByName(name: string): ServerClient | null {
    return SV.svs.clients
      .filter((client) => client.state >= ServerClient.STATE.CONNECTED)
      .find((client) => client.name === name) ?? null;
  }

  static #notifyClientsOfMapChange(mapname: string): void {
    for (const client of SV.svs.clients) {
      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.changelevel(mapname);
    }

    if (SV.server.navigation) {
      SV.server.navigation.shutdown();
      SV.server.navigation = null;
    }
  }

  static #loadGameProgs(): void {
    const activeGameModule = requireActiveGameModule();
    const gameAPI = Reflect.construct(activeGameModule.ServerGameAPI, [ServerEngineAPI]) as ServerRuntimeGameAPI;

    SV.server.gameAPI = gameAPI as ServerRuntimeGameAPI;
    SV.server.gameVersion = activeGameModule.identification.version.join('.');
    SV.server.gameName = activeGameModule.identification.name;
    SV.server.gameCapabilities = [...activeGameModule.identification.capabilities];

    Con.DPrint('Game progs loaded\n');
  }

  static #initializeEdicts(): void {
    SV.server.edicts.length = 0;

    for (let i = 0; i < Def.limits.edicts; i++) {
      SV.server.edicts[i] = new ServerEdict(i);
    }

    SV.server.datagram.clear();
    SV.server.reliable_datagram.clear();
    SV.server.signon.clear();
    SV.server.num_edicts = SV.svs.maxclients + 1;
    SV.server.loading = true;
    SV.server.paused = false;
    SV.server.loadgame = false;
    SV.server.time = 1.0;
    SV.server.lastcheck = 0;
    SV.server.lastchecktime = 0.0;

    Con.DPrint('Edicts initialized\n');
  }

  static async #loadWorldModel(mapname: string): Promise<boolean> {
    SV.server.mapname = mapname;
    SV.server.worldmodel = await Mod.ForNameAsync(`maps/${mapname}.bsp`, false, ModelScope.server) as BrushModel | null;

    if (SV.server.worldmodel === null) {
      Con.PrintWarning(`SV.SpawnServer: Cannot start server, unable to load map ${mapname}\n`);
      SV.server.active = false;
      return false;
    }

    Con.DPrint('World model loaded\n');
    return true;
  }

  static #setupModelPrecache(): void {
    console.assert(SV.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = SV.server.worldmodel!;

    SV.server.models.length = 2;
    SV.server.models[0] = null;
    SV.server.models[1] = worldmodel;

    SV.server.soundPrecache.length = 1;
    SV.server.soundPrecache[0] = '';

    SV.server.modelPrecache.length = 2 + worldmodel.submodels.length;
    SV.server.modelPrecache[0] = '';
    SV.server.modelPrecache[1] = worldmodel.name;

    for (let i = 1; i <= worldmodel.submodels.length; i++) {
      SV.server.modelPrecache[i + 1] = `*${i}`;
      SV.server.models[i + 1] = Mod.ForName(`*${i}`, ModelScope.server) as BaseModel;
    }

    Con.DPrint('Model precache setup complete\n');
  }

  static #setupPlayerEntities(): boolean {
    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = SV.server.gameAPI!;

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const ent = SV.server.edicts[i + 1] as ServerEdict;

      if (!gameAPI.prepareEntity(ent, 'player')) {
        Con.PrintWarning('SV.SpawnServer: Cannot start server, because game does not know what a player entity is.\n');
        SV.server.active = false;
        return false;
      }
    }

    Con.DPrint('Player entities setup complete\n');
    return true;
  }

  static #initializeLightStyles(): void {
    SV.server.lightstyles = [];

    for (let i = 0; i <= Def.limits.lightstyles; i++) {
      SV.server.lightstyles[i] = '';
    }

    Con.DPrint('Light styles initialized\n');
  }

  static #setupClientDataFields(): void {
    const playerEntity = SV.server.edicts[1]?.entity;

    console.assert(playerEntity !== null, 'GameModule player entity must exist');
    console.assert(playerEntity !== null && 'clientdataFields' in playerEntity, 'GameModule player entity must expose clientdataFields');

    const typedPlayerEntity = playerEntity as PlayerClientdataEntity;
    const fields = typedPlayerEntity.clientdataFields;

    console.assert(fields instanceof Array, 'clientdataFields must be an array');

    SV.server.clientdataFields.length = 0;
    SV.server.clientdataFields.push(...fields);
    console.assert(SV.server.clientdataFields.length <= 32, 'clientdata must not have more than 32 fields');

    if (fields.length <= 8) {
      SV.server.clientdataFieldsBitsWriter = 'writeByte';
    } else if (fields.length <= 16) {
      SV.server.clientdataFieldsBitsWriter = 'writeShort';
    } else if (fields.length <= 32) {
      SV.server.clientdataFieldsBitsWriter = 'writeLong';
    }

    for (const field of fields) {
      console.assert(typedPlayerEntity[field] !== undefined, `Undefined clientdata field ${field}`);
    }

    Con.DPrint('Clientdata fields setup complete\n');
  }

  static #setupExtendedEntityFields(): void {
    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const fields = SV.server.gameAPI!.getClientEntityFields();

    for (const key of Object.keys(SV.server.clientEntityFields)) {
      delete SV.server.clientEntityFields[key];
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

      SV.server.clientEntityFields[classname] = clientEntityField;
    }

    Con.DPrint('Extended entity fields setup complete\n');
  }

  static #spawnWorldspawnEntity(): boolean {
    const ent = SV.server.edicts[0] as ServerEdict;
    console.assert(SV.server.worldmodel !== null, 'SV.server.worldmodel is initialized');
    const worldmodel = SV.server.worldmodel!;
    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is initialized');
    const gameAPI = SV.server.gameAPI!;

    if (!gameAPI.prepareEntity(ent, 'worldspawn', {
      model: worldmodel.name,
      modelindex: 1,
      solid: Defs.solid.SOLID_BSP,
      movetype: Defs.moveType.MOVETYPE_PUSH,
    })) {
      Con.PrintWarning('SV.SpawnServer: Cannot start server, because the game does not know what a worldspawn entity is.\n');
      SV.server.active = false;
      return false;
    }

    gameAPI.spawnPreparedEntity(ent);
    Con.DPrint('Worldspawn entity spawned\n');
    return true;
  }

  static async WaitForPrecachedResources(): Promise<void> {
    const resolvedModels: Array<BaseModel | null> = [];

    for (const model of SV.server.models) {
      if (model instanceof Promise) {
        resolvedModels.push(await model);
        continue;
      }

      resolvedModels.push(model);
    }

    SV.server.models.length = 0;

    for (const model of resolvedModels) {
      SV.server.models.push(model);
    }

    Con.DPrint('Pending precached resources loaded\n');
  }

  static #finalizeServerSpawn(mapname: string): void {
    SV.server.active = true;
    SV.server.loading = false;

    Host.frametime = 0.1;
    SV.physics.physics();
    SV.physics.physics();

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];

      if (client.state >= ServerClient.STATE.CONNECTED) {
        SV.messages.sendServerData(client);
      }
    }

    console.assert(SV.server.navigation !== null, 'SV.server.navigation is initialized');
    SV.server.navigation!.init();
    eventBus.publish('server.spawned', { mapname });
    Con.PrintSuccess('Server spawned.\n');
  }

  static #handleClientStringCommand(client: ServerClient, input: string): void {
    const matchedCommand = ALLOWED_CLIENT_COMMANDS.find((command) => input.toLowerCase().startsWith(command));

    if (matchedCommand) {
      void Cmd.ExecuteString(input, client);
      return;
    }

    Con.Print(`${client.name} tried to ${input}!\n`);
  }

  static #processClientCommand(client: ServerClient, cmd: Protocol.clc): boolean {
    switch (cmd) {
      case Protocol.clc.nop:
        Con.DPrint(`${client.netconnection?.address ?? 'unknown'} sent a nop\n`);
        return true;

      case Protocol.clc.stringcmd: {
        const input = NET.message.readString();
        SV.#handleClientStringCommand(client, input);
        return true;
      }

      case Protocol.clc.sync:
        client.sync_time = NET.message.readFloat();
        return true;

      case Protocol.clc.rconcmd:
        SV.HandleRconRequest(client);
        return true;

      case Protocol.clc.disconnect:
        return false;

      case Protocol.clc.move:
        SV.ReadClientMove(client);
        return true;

      default:
        Con.DPrint(`SV.ReadClientMessage: unknown command ${cmd} from ${client.netconnection?.address ?? 'unknown'}\n`);
        return false;
    }
  }
}

/**
 * Simple class hooking up all movevars with corresponding cvars.
 */
class PlayerMoveCvars extends MoveVars {
  // @ts-ignore
  get gravity(): number { return SV.gravity!.value; }
  // @ts-ignore
  get stopspeed(): number { return SV.stopspeed!.value; }
  // @ts-ignore
  get maxspeed(): number { return SV.maxspeed!.value; }
  // @ts-ignore
  get spectatormaxspeed(): number { return SV.spectatormaxspeed!.value; }
  // @ts-ignore
  get accelerate(): number { return SV.accelerate!.value; }
  // @ts-ignore
  get airaccelerate(): number { return SV.airaccelerate!.value; }
  // @ts-ignore
  get wateraccelerate(): number { return SV.wateraccelerate!.value; }
  // @ts-ignore
  get friction(): number { return SV.friction!.value; }
  // @ts-ignore
  get waterfriction(): number { return SV.waterfriction!.value; }
  // @ts-ignore
  get edgefriction(): number { return SV.edgefriction!.value; }

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

sharedCollisionModelSource.configureServer({
  getWorldEntity: () => SV.server.edicts[0] ?? null,
  getWorldModel: () => SV.server.worldmodel,
  getModels: () => SV.server.models.map((model) => model instanceof Promise ? null : model),
});
