/*
 * Host: shared engine lifecycle coordinator for both browser and dedicated
 * runtimes.
 *
 * Owns startup and shutdown sequencing, the main frame loop, server lifecycle
 * transitions, and the classic host and gameplay console commands.
 */

/* eslint-disable jsdoc/require-returns */

import type { ServerEdict } from '../server/Edict.ts';

import Cvar from './Cvar.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from './Def.ts';
import Cmd, { ConsoleCommand } from './Cmd.ts';
import { eventBus, getClientRegistry, getCommonRegistry, registry } from '../registry.ts';
import Vector from '../../shared/Vector.ts';
import Q from '../../shared/Q.ts';
import { ServerClient } from '../server/Client.ts';
import { ServerEngineAPI } from './GameAPIs.ts';
import Chase from '../client/Chase.ts';
import VID from '../client/VID.ts';
import { HostError } from './Errors.ts';
import CDAudio from '../client/CDAudio.ts';
import * as Defs from '../../shared/Defs.ts';
import { content, gameCapabilities } from '../../shared/Defs.ts';
import ClientLifecycle from '../client/ClientLifecycle.ts';
import { Pmove } from './Pmove.ts';

let { COM, Con, Mod, NET, PR, SV, Sys, V } = getCommonRegistry();
let { CL, Draw, IN, Key, M, R, S, SCR, Sbar } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, Mod, NET, PR, SV, Sys, V } = getCommonRegistry());
  ({ CL, Draw, IN, Key, M, R, S, SCR, Sbar } = getClientRegistry());
});

type DeferredCallback = () => void | Promise<void>;
interface ScheduledFutureEntry {
  readonly time: number;
  readonly callback: DeferredCallback;
}
type PrintFunction = (text: string) => void;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type SavegameEdictEntry = [classname: string, data: JsonValue] | null;
type SpawnParameters = ServerClient['spawn_parms'];
type CrashLike =
  | Error
  | string
  | null
  | undefined
  | {
      readonly name?: string;
      readonly message?: string;
      readonly constructor?: { readonly name?: string };
    };

interface SavegameState {
  readonly version: number;
  readonly gameversion: string;
  readonly comment: string | null;
  readonly spawn_parms: SpawnParameters;
  readonly mapname: string;
  readonly time: number;
  readonly lightstyles: string[];
  readonly globals: JsonValue;
  readonly cvars: Array<[name: string, value: string]>;
  readonly clientdata: JsonValue | null;
  readonly edicts: SavegameEdictEntry[];
  readonly num_edicts: number;
  readonly particles: JsonValue;
}

/** Extracts a display name from a CrashLike value. */
function crashName(error: CrashLike): string {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error === 'string') {
    return 'Error';
  }

  return error?.name ?? error?.constructor?.name ?? 'Error';
}

/** Extracts a human-readable message from a CrashLike value. */
function crashMessage(error: CrashLike): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return error?.message ?? 'Unknown error';
}

class HostConsoleCommand extends ConsoleCommand {
  /**
   * Returns true when the command must abort because cheats are disabled.
   */
  cheat(): boolean {
    if (SV.cheats.value) {
      return false;
    }

    const client = this.client;

    if (client !== null) {
      Host.ClientPrint(client, 'Cheats are not enabled on this server.\n');
    }

    return true;
  }
}

/**
 * Host lifecycle singleton.
 *
 * Historically this module was a mutable namespace object. It now uses a real
 * class with static state and methods so the engine can keep the existing
 * `Host.X` call sites while gaining native TypeScript typing.
 */
export default class Host {
  static developer: Cvar | null = null;
  static dedicated: Cvar | null = null;
  static framecount = 0;
  static framerate: Cvar | null = null;
  static frametime = 0.0;
  static initialized = false;
  static inerror = false;
  static isdown = false;
  static noclip_anglehack = false;
  static oldrealtime = 0.0;
  static pausable: Cvar | null = null;
  static realtime = 0.0;
  static refreshrate: Cvar | null = null;
  static speeds: Cvar | null = null;
  static teamplay: Cvar | null = null;
  static ticrate: Cvar | null = null;
  static version: Cvar | null = null;

  /** Callbacks that must run before the next frame body starts. */
  static readonly _scheduledForNextFrame: DeferredCallback[] = [];

  /** Named deferred tasks used to coalesce repeated requests. */
  static readonly _scheduleInFuture = new Map<string, ScheduledFutureEntry>();

  static #inHandleCrash = false;

  static EndGame(message: string): void {
    Con.PrintSuccess(`Host.EndGame: ${message}\n`);

    if (CL.cls.demonum !== -1) {
      CL.NextDemo();
      return;
    }

    CL.Disconnect();
    M.Alert('Host.EndGame', message);
  }

  static Error(error: string): never | void {
    if (Host.inerror) {
      throw new Error('throw new HostError: recursively entered');
    }

    Host.inerror = true;

    if (!registry.isDedicatedServer) {
      SCR.EndLoadingPlaque();
    }

    Con.PrintError(`Host Error: ${error}\n`);

    if (SV.server.active) {
      Host.ShutdownServer();
    }

    CL.Disconnect();
    CL.cls.demonum = -1;
    Host.inerror = false;
    M.Alert('Host Error', error);
  }

  static FindMaxClients(): void {
    SV.svs.maxclients = 1;
    SV.svs.maxclientslimit = Def.limits.clients;
    SV.svs.clients.length = 0;

    if (!registry.isDedicatedServer) {
      CL.cls.state = Def.clientConnectionState.disconnected;
    }

    for (let index = 0; index < SV.svs.maxclientslimit; index++) {
      SV.svs.clients.push(new ServerClient(index));
    }
  }

  static InitLocal(): void {
    const commitHash = registry.buildConfig?.commitHash;
    const version = commitHash ? `${Def.productVersion}+${commitHash}` : Def.productVersion;

    Host.version = new Cvar('version', version, Cvar.FLAG.READONLY);

    Host.InitCommands();
    Host.refreshrate = new Cvar('host_refreshrate', '0', Cvar.FLAG.ARCHIVE, 'Affects main loop sleep time, keep it at 0 for vsync-based timing. Vanilla recommendation is 60.');
    Host.framerate = new Cvar('host_framerate', '0');
    Host.speeds = new Cvar('host_speeds', '0');
    Host.ticrate = new Cvar('sys_ticrate', '0.05');
    Host.developer = new Cvar('developer', '0');
    Host.pausable = new Cvar('pausable', '1', Cvar.FLAG.SERVER);
    Host.teamplay = new Cvar('teamplay', '0', Cvar.FLAG.SERVER); // actually a game cvar, but we need it here, since a bunch of server code is using it

    /** @deprecated use registry.isDedicatedServer instead, this is only made available to the game code */
    Host.dedicated = new Cvar('dedicated', registry.isDedicatedServer ? '1' : '0', Cvar.FLAG.READONLY, 'Set to 1, if running in dedicated server mode.');

    eventBus.subscribe('cvar.changed', (name: string) => {
      const cvar = Cvar.FindVar(name);

      if (cvar === null) {
        return;
      }

      // Automatically save when an archive Cvar changed.
      if ((cvar.flags & Cvar.FLAG.ARCHIVE) && Host.initialized) {
        Host.WriteConfiguration();
      }
    });

    Host.FindMaxClients();
  }

  /** Sends a chat message packet to a single client. */
  static SendChatMessageToClient(client: ServerClient, name: string, message: string, direct = false): void {
    client.message.writeByte(Protocol.svc.chatmsg);
    client.message.writeString(name);
    client.message.writeString(message);
    client.message.writeByte(direct ? 1 : 0);
  }

  /** Sends a plain print message to a single client. */
  static ClientPrint(client: ServerClient, text: string): void {
    client.message.writeByte(Protocol.svc.print);
    client.message.writeString(text);
  }

  static BroadcastPrint(text: string): void {
    for (const client of SV.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.print);
      client.message.writeString(text);
    }
  }

  static DropClient(client: ServerClient, crash: boolean, reason: string): void { // TODO: refactor into ServerClient
    if (NET.CanSendMessage(client.netconnection)) {
      client.message.writeByte(Protocol.svc.disconnect);
      client.message.writeString(reason);
      NET.SendMessage(client.netconnection, client.message);
    }

    if (!crash) {
      if (client.edict && client.state === ServerClient.STATE.SPAWNED) {
        const gameAPI = SV.server.gameAPI as typeof SV.server.gameAPI & { self?: ServerClient['edict'] };
        const savedSelf = gameAPI.self;

        gameAPI.ClientDisconnect(client.edict);

        if (savedSelf !== undefined) {
          gameAPI.self = savedSelf;
        }
      }

      Sys.Print(`Client ${client.name} removed\n`);
    } else {
      client.state = ServerClient.STATE.DROPASAP;
      Sys.Print(`Client ${client.name} dropped\n`);
    }

    NET.Close(client.netconnection);

    const { name, num } = client;

    client.clear();
    NET.activeconnections--;

    eventBus.publish('server.client.disconnected', num, name);

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const spawnedClient = SV.svs.clients[index];

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

  static ShutdownServer(isCrashShutdown = false): void { // TODO: SV duties
    if (!SV.server.active) {
      return;
    }

    eventBus.publish('server.shutting-down');
    SV.server.active = false;

    if (!registry.isDedicatedServer && CL.cls.state === Def.clientConnectionState.connected) {
      CL.Disconnect();
    }

    const start = Sys.FloatTime();
    let count = 0;

    do {
      count = 0;

      for (let index = 0; index < SV.svs.maxclients; index++) { // FIXME: this is completely broken, it won’t properly close connections
        const client = SV.svs.clients[index];

        if (client.state < ServerClient.STATE.CONNECTED || client.message.cursize === 0) {
          continue;
        }

        if (NET.CanSendMessage(client.netconnection)) {
          NET.SendMessage(client.netconnection, client.message);
          client.message.clear();
          continue;
        }

        NET.GetMessage(client.netconnection);
        count++;
      }

      if ((Sys.FloatTime() - start) > 3.0) {
        break;
      }
    } while (count !== 0);

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state >= ServerClient.STATE.CONNECTED) {
        Host.DropClient(client, isCrashShutdown, 'Server shutting down');
      }
    }

    SV.ShutdownServer(isCrashShutdown);
    eventBus.publish('server.shutdown');
  }

  static ConfigReady_f(): void {
    eventBus.publish('host.config.loaded');
    Con.DPrint('Loaded configuration\n');
  }

  static WriteConfiguration(): void {
    Host.ScheduleInFuture('Host.WriteConfiguration', () => {
      // Never save a config during pending commands.
      if (Cmd.HasPendingCommands()) {
        Con.PrintWarning('Writing configuration dismissed, pending commands outstanding. Try again later.\n');
        return;
      }

      const config = `
  ${!registry.isDedicatedServer ? `${Key.WriteBindings()}\n\n\n` : ''}

  ${Cvar.WriteVariables()}

  configready
  `;

      COM.WriteTextFile('config.cfg', config);
      Con.DPrint('Wrote configuration\n');
    }, 5.0);
  }

  static WriteConfiguration_f(): void {
    Con.Print('Writing configuration\n');
    Host.WriteConfiguration();
  }

  static ServerFrame(): void { // TODO: move to SV.ServerFrame
    SV.server.gameAPI.frametime = Host.frametime;
    SV.server.datagram.clear();
    SV.server.expedited_datagram.clear();
    SV.CheckForNewClients();
    SV.RunClients();

    if (SV.server.paused !== true && (SV.svs.maxclients >= 2 || (!registry.isDedicatedServer && Key.dest.value === Key.dest.game))) {
      SV.physics.physics();
    }

    SV.RunScheduledGameCommands();
    SV.messages.sendClientMessages();
  }

  static ScheduleForNextFrame(callback: DeferredCallback): void {
    Host._scheduledForNextFrame.push(callback);
  }

  static ScheduleInFuture(name: string, callback: DeferredCallback, whenInSeconds: number): void {
    if (Host.isdown) {
      // There’s no future when shutting down.
      void callback();
      return;
    }

    if (Host._scheduleInFuture.has(name)) {
      return;
    }

    Host._scheduleInFuture.set(name, {
      time: Host.realtime + whenInSeconds,
      callback,
    });
  }

  static async _Frame(): Promise<void> {
    Host.realtime = Sys.FloatTime();
    Host.frametime = Host.realtime - Host.oldrealtime;
    Host.oldrealtime = Host.realtime;

    if (Host.framerate !== null && Host.framerate.value > 0) {
      Host.frametime = Host.framerate.value;
    } else if (Host.frametime > 0.1) {
      Host.frametime = 0.1;
    } else if (Host.frametime < 0.001) {
      Host.frametime = 0.001;
    }

    // Check all scheduled things for the next frame.
    while (Host._scheduledForNextFrame.length > 0) {
      const callback = Host._scheduledForNextFrame.shift();

      if (callback === undefined) {
        break;
      }

      await callback();
    }

    // Check what’s scheduled in the future.
    for (const [name, { time, callback }] of Host._scheduleInFuture.entries()) {
      if (time > Host.realtime) {
        continue;
      }

      await callback();
      Host._scheduleInFuture.delete(name);
    }

    if (registry.isDedicatedServer) {
      Cmd.Execute();

      if (SV.server.active) {
        if (Host.speeds !== null && Host.speeds.value !== 0) {
          console.profile('Host.ServerFrame');
        }

        Host.ServerFrame();

        if (Host.speeds !== null && Host.speeds.value !== 0) {
          console.profileEnd('Host.ServerFrame');
        }
      }

      Host.framecount++;
      return;
    }

    if (CL.cls.state === Def.clientConnectionState.connecting) {
      CL.CheckConnectingState();
      SCR.UpdateScreen();
      return;
    }

    Cmd.Execute();

    if (CL.cls.state === Def.clientConnectionState.connected) {
      CL.ReadFromServer();
    }

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profile('CL.ClientFrame');
    }

    CL.ClientFrame();

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profileEnd('CL.ClientFrame');
    }

    CL.SendCmd();

    if (SV.server.active && !SV.svs.changelevelIssued) {
      if (Host.speeds !== null && Host.speeds.value !== 0) {
        console.profile('Host.ServerFrame');
      }

      Host.ServerFrame();

      if (Host.speeds !== null && Host.speeds.value !== 0) {
        console.profileEnd('Host.ServerFrame');
      }
    }

    // Set up prediction for other players.
    CL.SetUpPlayerPrediction(false);

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profile('CL.PredictMove');
    }

    // Do client-side motion prediction.
    CL.PredictMove();

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profileEnd('CL.PredictMove');
    }

    // Set up prediction for other players.
    CL.SetUpPlayerPrediction(true);

    // Build a refresh entity list.
    CL.state.clientEntities.emit();

    SCR.UpdateScreen();

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profile('S.Update');
    }

    if (CL.cls.signon === 4) {
      S.Update(R.refdef.vieworg, R.vpn, R.vright, R.vup, R.viewleaf ? R.viewleaf.contents <= content.CONTENT_WATER : false);
    } else {
      S.Update(Vector.origin, Vector.origin, Vector.origin, Vector.origin, false);
    }

    CDAudio.Update();

    if (Host.speeds !== null && Host.speeds.value !== 0) {
      console.profileEnd('S.Update');
    }

    Host.framecount++;
  }

  // TODO: Sys.Init can handle a crash now since we are main looping without setInterval.
  static HandleCrash(error: CrashLike): void {
    if (error instanceof HostError) {
      Host.Error(error.message);
      return;
    }

    if (Host.#inHandleCrash) {
      console.error(error);
      // eslint-disable-next-line no-debugger
      debugger;
      return;
    }

    Host.#inHandleCrash = true;
    Con.PrintError(`${crashName(error)}: ${crashMessage(error)}\n`);
    eventBus.publish('host.crash', error);
    Sys.Quit();
  }

  static async Frame(): Promise<void> {
    if (Host.#inHandleCrash) {
      return;
    }

    try {
      await Host._Frame();
    } catch (error) {
      Host.HandleCrash(error as CrashLike);
    }
  }

  static async Init(): Promise<void> {
    Host.oldrealtime = Sys.FloatTime();
    Cmd.Init();
    Cvar.Init();

    V.Init(); // required for V.CalcRoll

    if (!registry.isDedicatedServer) {
      Chase.Init();
    }

    await COM.Init();
    Host.InitLocal();

    if (!registry.isDedicatedServer) {
      Key.Init();
    }

    Con.Init();
    await PR.Init();
    Mod.Init();
    NET.Init();
    Pmove.Init();
    SV.Init();

    if (!registry.isDedicatedServer) {
      S.Init();
      VID.Init();
      await Draw.Init();
      await R.Init();
      await M.Init();
      await CL.Init();
      SCR.Init();
      CDAudio.Init();

      if (!CL.gameCapabilities.includes(gameCapabilities.CAP_HUD_INCLUDES_SBAR)) {
        await Sbar.Init();
      }

      IN.Init();
    }

    Cmd.text = `exec better-quake.rc\n${Cmd.text}`;
    // eslint-disable-next-line require-atomic-updates
    Host.initialized = true;
    Sys.Print('========Host Initialized=========\n');

    eventBus.publish('host.ready');
  }

  static Shutdown(): void {
    if (Host.isdown) {
      Sys.Print('recursive shutdown\n');
      return;
    }

    eventBus.publish('host.shutting-down');
    Host.isdown = true;
    Host.WriteConfiguration();

    if (!registry.isDedicatedServer) {
      S.Shutdown();
      CDAudio.Shutdown();
    }

    NET.Shutdown();

    if (!registry.isDedicatedServer) {
      IN.Shutdown();
      VID.Shutdown();
    }

    Pmove.Shutdown();
    Cmd.Shutdown();
    Cvar.Shutdown();
    eventBus.publish('host.shutdown');
  }

  // Commands

  static Quit_f(): void {
    if (!registry.isDedicatedServer && Key.dest.value !== Key.dest.console) {
      M.Menu_Quit_f();
      return;
    }

    if (SV.server.active) {
      Host.ShutdownServer();
    }

    COM.Shutdown();
    Sys.Quit();
  }

  static Status_f(this: ConsoleCommand): void {
    let print: PrintFunction;

    if (this.client === null) {
      if (!SV.server.active) {
        if (registry.isDedicatedServer) {
          Con.Print('No active server\n');
          return;
        }

        this.forward();
        return;
      }

      print = Con.Print;
    } else {
      const client = this.client;
      print = (text: string) => {
        Host.ClientPrint(client, text);
      };
    }

    print(`hostname: ${NET.hostname.string}\n`);
    print(`address : ${NET.GetListenAddress()}\n`);
    print(`version : ${Host.version!.string} (${SV.server.gameVersion})\n`);
    print(`map     : ${SV.server.mapname}\n`);
    print(`game    : ${SV.server.gameName}\n`);
    print(`edicts  : ${SV.server.num_edicts} used of ${SV.server.edicts.length} allocated\n`);
    print(`players : ${NET.activeconnections} active (${SV.svs.maxclients} max)\n\n`);

    const lines: string[] = [];

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED || client.netconnection === null) {
        continue;
      }

      const parts = [
        client.num.toString().padStart(3),
        client.name.substring(0, 19).padEnd(19),
        client.uniqueId.substring(0, 19).padEnd(19),
        Q.secsToTime(NET.time - client.netconnection.connecttime).padEnd(9),
        client.ping.toFixed(0).padStart(4),
        Number(0).toFixed(0).padStart(4), // TODO: add loss
        (ServerClient.STATE[client.state] ?? `unknown (${client.state})`).padEnd(10),
        client.netconnection.address,
      ];

      lines.push(`${parts.join(' | ')}\n`);
    }

    if (lines.length === 0) {
      return;
    }

    print('id  | name                | unique id           | play time | ping | loss | state      | adr\n');
    print('----|---------------------|---------------------|-----------|------|------|------------|-----\n');

    for (const line of lines) {
      print(line);
    }
  }

  static God_f = class extends HostConsoleCommand {
    override run(): void {
      if (this.forward() || this.cheat()) {
        return;
      }

      const client = this.client;

      if (client === null) {
        return;
      }

      client.edict.entity.flags ^= Defs.flags.FL_GODMODE;

      if ((client.edict.entity.flags & Defs.flags.FL_GODMODE) === 0) {
        Host.ClientPrint(client, 'godmode OFF\n');
        return;
      }

      Host.ClientPrint(client, 'godmode ON\n');
    }
  };

  static Notarget_f = class extends HostConsoleCommand {
    override run(): void {
      if (this.forward() || this.cheat()) {
        return;
      }

      const client = this.client;

      if (client === null) {
        return;
      }

      client.edict.entity.flags ^= Defs.flags.FL_NOTARGET;

      if ((client.edict.entity.flags & Defs.flags.FL_NOTARGET) === 0) {
        Host.ClientPrint(client, 'notarget OFF\n');
        return;
      }

      Host.ClientPrint(client, 'notarget ON\n');
    }
  };

  static Noclip_f = class extends HostConsoleCommand {
    override run(): void {
      if (this.forward() || this.cheat()) {
        return;
      }

      const client = this.client;

      if (client === null) {
        return;
      }

      if (client.edict.entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP) {
        Host.noclip_anglehack = true;
        client.edict.entity.movetype = Defs.moveType.MOVETYPE_NOCLIP;
        Host.ClientPrint(client, 'noclip ON\n');
        return;
      }

      Host.noclip_anglehack = false;
      client.edict.entity.movetype = Defs.moveType.MOVETYPE_WALK;
      Host.ClientPrint(client, 'noclip OFF\n');
    }
  };

  static Fly_f = class extends HostConsoleCommand {
    override run(): void {
      if (this.forward() || this.cheat()) {
        return;
      }

      const client = this.client;

      if (client === null) {
        return;
      }

      if (client.edict.entity.movetype !== Defs.moveType.MOVETYPE_FLY) {
        client.edict.entity.movetype = Defs.moveType.MOVETYPE_FLY;
        Host.ClientPrint(client, 'flymode ON\n');
        return;
      }

      client.edict.entity.movetype = Defs.moveType.MOVETYPE_WALK;
      Host.ClientPrint(client, 'flymode OFF\n');
    }
  };

  static Ping_f(this: ConsoleCommand): void {
    if (this.forward()) {
      return;
    }

    const recipientClient = this.client;

    if (recipientClient === null) {
      return;
    }

    Host.ClientPrint(recipientClient, 'Client ping times:\n');

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      let total = 0;

      for (let pingIndex = 0; pingIndex < client.ping_times.length; pingIndex++) {
        total += client.ping_times[pingIndex];
      }

      Host.ClientPrint(recipientClient, `${(total * 62.5).toFixed(0).padStart(3)} ${client.name}\n`);
    }
  }

  static Map_f(this: ConsoleCommand, mapname?: string, ...spawnparms: string[]): void {
    if (mapname === undefined) {
      Con.Print('Usage: map <map>\n');
      return;
    }

    if (this.client !== null) {
      return;
    }

    // if (!SV.HasMap(mapname)) {
    //   Con.Print(`No such map: ${mapname}\n`);
    //   return;
    // }

    if (!registry.isDedicatedServer) {
      CL.cls.demonum = -1;
      CL.Disconnect();
    }

    Host.ShutdownServer(); // CR: this is the reason why you would need to use changelevel on Counter-Strike 1.6 etc.

    if (!registry.isDedicatedServer) {
      Key.dest.value = Key.dest.game;
      SCR.BeginLoadingPlaque();
      CL.SetConnectingStep(5, 'Spawning server');
      CL.cls.spawnparms = spawnparms.join(' ');
    }

    SV.svs.serverflags = 0;

    Host.ScheduleForNextFrame(async () => {
      if (!await SV.SpawnServer(mapname)) {
        SV.ShutdownServer(false);
        throw new HostError(`Could not spawn server with map ${mapname}`);
      }

      if (!registry.isDedicatedServer) {
        CL.SetConnectingStep(null, null);
        CL.Connect('local');
      }
    });
  }

  static Changelevel_f(mapname?: string): void {
    if (mapname === undefined) {
      Con.Print('Usage: changelevel <levelname>\n');
      return;
    }

    if (!SV.server.active || (!registry.isDedicatedServer && CL.cls.demoplayback)) {
      Con.Print('Only the server may changelevel\n');
      return;
    }

    // if (!SV.HasMap(mapname)) {
    //   throw new HostError(`No such map: ${mapname}`);
    // }

    SV.svs.changelevelIssued = true;

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.message.writeByte(Protocol.svc.changelevel);
      client.message.writeString(mapname);
    }

    if (!registry.isDedicatedServer) {
      // This hack allows us to show the loading plaque while resetting the client renderer.
      CL.cls.changelevel = true;
      CL.cls.signon = 0;
    }

    Host.ScheduleForNextFrame(async () => {
      SV.SaveSpawnparms();
      Con.DPrint(`Host.Changelevel_f: changing level to ${mapname}\n`);

      if (!await SV.SpawnServer(mapname)) {
        SV.ShutdownServer(false);
        throw new HostError(`Could not spawn server for changelevel to ${mapname}`);
      }

      Con.DPrint(`Host.Changelevel_f: spawned server for changelevel to ${mapname}\n`);

      if (!registry.isDedicatedServer) {
        CL.SetConnectingStep(null, null);
      }
    });
  }

  static Restart_f(this: ConsoleCommand): void {
    if (SV.server.active && (registry.isDedicatedServer || (!CL.cls.demoplayback && this.client === null))) {
      void Cmd.ExecuteString(`map ${SV.server.mapname}`);
    }
  }

  // NOTE: this is the dedicated server version of disconnect.
  static Disconnect_f(): void {
    if (!SV.server.active) {
      Con.Print('No active server\n');
      return;
    }

    Host.ShutdownServer();
  }

  static Reconnect_f(): void {
    if (registry.isDedicatedServer) {
      Con.Print('cannot reconnect in dedicated server mode\n');
      return;
    }

    Con.PrintWarning('NOT IMPLEMENTED: reconnect\n'); // TODO: reimplement reconnect here
  }

  static Connect_f(address?: string): void {
    if (address === undefined) {
      Con.Print('Usage: connect <address>\n');
      Con.Print(' - <address> can be "self", connecting to the current domain name\n');
      return;
    }

    if (registry.isDedicatedServer) {
      Con.Print('cannot connect to another server in dedicated server mode\n');
      return;
    }

    CL.cls.demonum = -1;

    if (CL.cls.demoplayback) {
      CL.StopPlayback();
      CL.Disconnect();
    }

    if (address === 'self') {
      const url = new URL(location.href);
      const path = !url.pathname.endsWith('/') ? `${url.pathname}/` : url.pathname;
      CL.Connect(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${path}api/`);
    } else {
      CL.Connect(address);
    }

    CL.cls.signon = 0;
  }

  static Savegame_f(this: ConsoleCommand, savename?: string): void {
    if (this.client !== null) {
      return;
    }

    if (savename === undefined) {
      Con.Print('Usage: save <savename>\n');
      return;
    }

    if (!SV.server.active) {
      Con.PrintWarning('Not playing a local game.\n');
      return;
    }

    if (CL.state.intermission !== 0) {
      Con.PrintWarning('Can\'t save in intermission.\n');
      return;
    }

    if (SV.svs.maxclients !== 1) {
      Con.PrintWarning('Can\'t save multiplayer games.\n');
      return;
    }

    if (savename.includes('..')) {
      Con.PrintWarning('Relative pathnames are not allowed.\n');
      return;
    }

    const client = SV.svs.clients[0];

    if (client.state >= ServerClient.STATE.CONNECTED && client.edict.entity.health <= 0.0) {
      Con.PrintWarning('Can\'t savegame with a dead player\n');
      return;
    }

    const clientdata = CL.state.gameAPI ? CL.state.gameAPI.saveGame() as JsonValue : null;

    // IDEA: we could actually compress this by using a list of common fields.
    const edicts: SavegameEdictEntry[] = [];

    for (const edict of SV.server.edicts) {
      edicts.push(edict.isFree() ? null : [edict.entity.classname, edict.entity.serialize() as JsonValue]);
    }

    const globals = SV.server.gameAPI.serialize() as JsonValue;

    const gamestate: SavegameState = {
      version: Def.gamestateVersion,
      gameversion: SV.server.gameVersion,
      comment: CL.state.levelname,
      spawn_parms: client.spawn_parms,
      mapname: SV.server.mapname,
      time: SV.server.time,
      lightstyles: SV.server.lightstyles,
      globals,
      cvars: [...Cvar.Filter((cvar) => (cvar.flags & (Cvar.FLAG.SERVER | Cvar.FLAG.GAME)) !== 0)].map((cvar) => [cvar.name, cvar.string]),
      clientdata,
      edicts,
      num_edicts: SV.server.num_edicts,
      particles: R.SerializeParticles() as JsonValue,
    };

    const filename = COM.DefaultExtension(savename, '.json');

    Con.Print(`Saving game to ${filename}...\n`);

    if (COM.WriteTextFile(filename, JSON.stringify(gamestate))) {
      Con.PrintSuccess('done.\n');
      return;
    }

    Con.PrintError('ERROR: couldn\'t open.\n');
  }

  static async Loadgame_f(this: ConsoleCommand, savename?: string): Promise<void> {
    if (this.client !== null) {
      return;
    }

    if (savename === undefined) {
      Con.Print('Usage: load <savename>\n');
      return;
    }

    if (savename.includes('..')) {
      Con.PrintWarning('Relative pathnames are not allowed.\n');
      return;
    }

    CL.cls.demonum = -1;

    const filename = COM.DefaultExtension(savename, '.json');

    Con.Print(`Loading game from ${filename}...\n`);

    const data = await COM.LoadTextFile(filename);

    if (data === null) {
      Con.PrintError('ERROR: couldn\'t open.\n');
      return;
    }

    const gamestate = JSON.parse(data) as SavegameState;

    if (gamestate.version !== Def.gamestateVersion) {
      throw new HostError(`Savegame is version ${gamestate.version}, not ${Def.gamestateVersion}\n`);
    }

    CL.Disconnect();

    // Restore all server and game cvars.
    for (const [name, value] of gamestate.cvars) {
      const cvar = Cvar.FindVar(name);

      if (cvar !== null) {
        cvar.set(value);
        continue;
      }

      Con.PrintWarning(`Saved cvar ${name} not found, skipping\n`);
    }

    if (!await SV.SpawnServer(gamestate.mapname)) {
      if (!registry.isDedicatedServer) {
        CL.SetConnectingStep(null, null);
      }

      SV.ShutdownServer(false);
      throw new HostError(`Couldn't load map ${gamestate.mapname} for save game ${filename}\n`);
    }

    if (gamestate.gameversion !== SV.server.gameVersion) {
      SV.ShutdownServer(false);
      throw new HostError(`Game is version ${gamestate.gameversion}, not ${SV.server.gameVersion}\n`);
    }

    SV.server.paused = true;
    SV.server.loadgame = true;

    SV.server.lightstyles = gamestate.lightstyles;
    SV.server.gameAPI.deserialize(gamestate.globals);

    SV.server.num_edicts = gamestate.num_edicts;
    console.assert(SV.server.num_edicts <= SV.server.edicts.length, 'resizing edicts not supported yet'); // TODO: alloc more edicts

    // First run through all edicts to make sure the entity structures get initialized.
    for (let index = 0; index < SV.server.edicts.length; index++) {
      const edict = SV.server.edicts[index];
      const serializedEdict = gamestate.edicts[index];

      if (serializedEdict === undefined || serializedEdict === null) {
        // FIXME: QuakeC doesn’t like it at all when edicts suddenly disappear, we should offload this code to the GameAPI.
        edict.freeEdict();
        continue;
      }

      const [classname] = serializedEdict;
      console.assert(SV.server.gameAPI.prepareEntity(edict, classname), 'no entity for classname');
    }

    // Second run: we can start deserializing now that entity classes exist.
    for (let index = 0; index < SV.server.edicts.length; index++) {
      const edict = SV.server.edicts[index];
      const serializedEdict = gamestate.edicts[index];

      if (edict.isFree() || serializedEdict === undefined || serializedEdict === null) {
        continue;
      }

      const [, entityData] = serializedEdict;
      edict.entity.deserialize(entityData);
      edict.linkEdict();
    }

    SV.server.time = gamestate.time;

    const client = SV.svs.clients[0];
    client.spawn_parms = gamestate.spawn_parms;

    ClientLifecycle.resumeGame(gamestate.clientdata, gamestate.particles);
  }

  static Name_f(this: ConsoleCommand, ...names: string[]): void { // signon 2, step 1
    Con.DPrint(`Host.Name_f: ${this.client}\n`);

    if (names.length < 1) {
      Con.Print(`"name" is "${CL.name.string}"\n`);
      return;
    }

    if (!SV.server.active) {
      return;
    }

    let newName = names.join(' ').trim().substring(0, 15);

    if (!registry.isDedicatedServer && this.client === null) {
      Cvar.Set('_cl_name', newName);

      if (CL.cls.state === Def.clientConnectionState.connected) {
        this.forward();
      }

      return;
    }

    if (this.client === null) {
      return;
    }

    const initialNewName = newName;
    let newNameCounter = 2;

    // Make sure we have a somewhat unique name.
    while (SV.FindClientByName(newName)) {
      newName = `${initialNewName}${newNameCounter++}`;
    }

    const previousName = this.client.name;

    if (registry.isDedicatedServer && previousName.length !== 0 && previousName !== 'unconnected' && previousName !== newName) {
      Con.Print(`${previousName} renamed to ${newName}\n`);
    }

    this.client.name = newName;

    const message = SV.server.reliable_datagram;
    message.writeByte(Protocol.svc.updatename);
    message.writeByte(this.client.num);
    message.writeString(newName);
  }

  static Say_f(this: ConsoleCommand, teamonly: boolean, message?: string): void {
    if (this.forward() || !message || this.client === null) {
      return;
    }

    const sender = this.client;
    const formattedMessage = message.length > 140 ? `${message.substring(0, 140)}...` : message;

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (Host.teamplay !== null && Host.teamplay.value !== 0 && teamonly && client.entity.team !== sender.entity.team) {
        continue;
      }

      Host.SendChatMessageToClient(client, sender.name, formattedMessage, false);
    }

    Con.Print(`${sender.name}: ${formattedMessage}\n`);
  }

  static Say_Team_f(this: ConsoleCommand, message?: string): void {
    Host.Say_f.call(this, true, message);
  }

  static Say_All_f(this: ConsoleCommand, message?: string): void {
    Host.Say_f.call(this, false, message);
  }

  static Tell_f(this: ConsoleCommand, recipient?: string, message?: string): void {
    if (this.forward() || !recipient || !message || this.client === null) {
      if (!recipient || !message) {
        Con.Print('Usage: tell <recipient> <message>\n');
      }

      return;
    }

    let formattedMessage = message.trim();

    // Remove surrounding double quotes if present.
    if (formattedMessage.startsWith('"')) {
      formattedMessage = formattedMessage.slice(1, -1);
    }

    if (formattedMessage.length > 140) {
      formattedMessage = `${formattedMessage.substring(0, 140)}...`;
    }

    const sender = this.client;

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const client = SV.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (client.name.toLowerCase() !== recipient.toLowerCase()) {
        continue;
      }

      Host.SendChatMessageToClient(client, sender.name, formattedMessage, true);
      Host.SendChatMessageToClient(sender, sender.name, formattedMessage, true);
      break;
    }
  }

  static Color_f(this: ConsoleCommand, ...argv: string[]): void { // signon 2, step 2
    Con.DPrint(`Host.Color_f: ${this.client}\n`);

    if (argv.length <= 1) {
      Con.Print(`"color" is "${CL.color.value >> 4} ${CL.color.value & 15}"\ncolor <0-13> [0-13]\n`);
      return;
    }

    let top: number;
    let bottom: number;

    if (argv.length === 2) {
      top = bottom = (Q.atoi(argv[1]) & 15) >>> 0;
    } else {
      top = (Q.atoi(argv[1]) & 15) >>> 0;
      bottom = (Q.atoi(argv[2]) & 15) >>> 0;
    }

    if (top >= 14) {
      top = 13;
    }

    if (bottom >= 14) {
      bottom = 13;
    }

    const playercolor = (top << 4) + bottom;

    if (!registry.isDedicatedServer && this.client === null) {
      Cvar.Set('_cl_color', playercolor);

      if (CL.cls.state === Def.clientConnectionState.connected) {
        this.forward();
      }

      return;
    }

    if (this.client === null) {
      return;
    }

    this.client.colors = playercolor;
    this.client.edict.entity.team = bottom + 1;

    const message = SV.server.reliable_datagram;
    message.writeByte(Protocol.svc.updatecolors);
    message.writeByte(this.client.num);
    message.writeByte(playercolor);
  }

  static Kill_f(this: ConsoleCommand): void {
    if (this.forward() || this.client === null) {
      return;
    }

    const client = this.client;

    if (client.edict.entity.health <= 0.0) {
      Host.ClientPrint(client, 'Can\'t suicide -- already dead!\n');
      return;
    }

    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.ClientKill(client.edict);
  }

  static Pause_f(this: ConsoleCommand): void {
    if (this.forward() || this.client === null) {
      return;
    }

    const client = this.client;

    if (Host.pausable === null || Host.pausable.value === 0) {
      Host.ClientPrint(client, 'Pause not allowed.\n');
      return;
    }

    SV.server.paused = !SV.server.paused;
    Host.BroadcastPrint(`${client.name}${SV.server.paused === true ? ' paused the game\n' : ' unpaused the game\n'}`);
    SV.server.reliable_datagram.writeByte(Protocol.svc.setpause);
    SV.server.reliable_datagram.writeByte(SV.server.paused === true ? 1 : 0);
  }

  static PreSpawn_f(this: ConsoleCommand): void { // signon 1, step 1
    if (this.client === null) {
      Con.Print('prespawn is not valid from the console\n');
      return;
    }

    Con.DPrint(`Host.PreSpawn_f: ${this.client}\n`);

    const client = this.client;

    if (client.state === ServerClient.STATE.SPAWNED) {
      Con.Print('prespawn not valid -- already spawned\n');
      return;
    }

    // CR: SV.server.signon is a special buffer that is used to send the signon messages.
    client.message.write(new Uint8Array(SV.server.signon.data), SV.server.signon.cursize);
    client.message.writeByte(Protocol.svc.signonnum);
    client.message.writeByte(2);
  }

  static Spawn_f(this: ConsoleCommand): void { // signon 2, step 3
    Con.DPrint(`Host.Spawn_f: ${this.client}\n`);

    if (this.client === null) {
      Con.Print('spawn is not valid from the console\n');
      return;
    }

    const client = this.client;

    if (client.state === ServerClient.STATE.SPAWNED) {
      Con.Print('Spawn not valid -- already spawned\n');
      return;
    }

    const message = client.message;
    message.clear();

    message.writeByte(Protocol.svc.time);
    message.writeFloat(SV.server.time);

    const entity = client.edict;

    if (SV.server.loadgame) {
      SV.server.paused = false;
    } else {
      SV.server.gameAPI.prepareEntity(entity, 'player', {
        netname: client.name,
        colormap: entity.num, // the num, not the entity
        team: (client.colors & 15) + 1,
      });

      // Load legacy spawn parameters.
      if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_LEGACY) && Array.isArray(client.spawn_parms)) {
        for (let index = 0; index <= 15; index++) {
          SV.server.gameAPI[`parm${index + 1}`] = client.spawn_parms[index];
        }
      }

      // Load dynamic spawn parameters.
      if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_DYNAMIC)) {
        entity.entity.restoreSpawnParameters(client.spawn_parms);
      }

      SV.server.gameAPI.time = SV.server.time;
      SV.server.gameAPI.ClientConnect(entity);
      SV.server.gameAPI.time = SV.server.time;
      SV.server.gameAPI.PutClientInServer(entity);
    }

    for (let index = 0; index < SV.svs.maxclients; index++) {
      const otherClient = SV.svs.clients[index];
      message.writeByte(Protocol.svc.updatename);
      message.writeByte(index);
      message.writeString(otherClient.name);
      message.writeByte(Protocol.svc.updatefrags);
      message.writeByte(index);
      message.writeShort(otherClient.old_frags);
      message.writeByte(Protocol.svc.updatecolors);
      message.writeByte(index);
      message.writeByte(otherClient.colors);
    }

    for (let index = 0; index < Def.limits.lightstyles; index++) {
      message.writeByte(Protocol.svc.lightstyle);
      message.writeByte(index);
      message.writeString(SV.server.lightstyles[index]);
    }

    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT)) {
      message.writeByte(Protocol.svc.updatestat);
      message.writeByte(Def.stat.totalsecrets);
      message.writeLong(SV.server.gameAPI.total_secrets);
      message.writeByte(Protocol.svc.updatestat);
      message.writeByte(Def.stat.totalmonsters);
      message.writeLong(SV.server.gameAPI.total_monsters);
      message.writeByte(Protocol.svc.updatestat);
      message.writeByte(Def.stat.secrets);
      message.writeLong(SV.server.gameAPI.found_secrets);
      message.writeByte(Protocol.svc.updatestat);
      message.writeByte(Def.stat.monsters);
      message.writeLong(SV.server.gameAPI.killed_monsters);
    }

    message.writeByte(Protocol.svc.setangle);
    message.writeAngleVector(entity.entity.angles);
    SV.messages.writeClientdataToMessage(client, message);
    message.writeByte(Protocol.svc.signonnum);
    message.writeByte(3);
  }

  static Begin_f(this: ConsoleCommand): void { // signon 3, step 1
    Con.DPrint(`Host.Begin_f: ${this.client}\n`);

    if (this.client === null) {
      Con.Print('begin is not valid from the console\n');
      return;
    }

    // Send all portal states before the client is officially spawned and gets updates incrementally.
    const areaPortals = SV.server.worldmodel.areaPortals;

    for (let portalIndex = 0; portalIndex < areaPortals.numPortals; portalIndex++) {
      this.client.message.writeByte(Protocol.svc.setportalstate);
      this.client.message.writeShort(portalIndex);
      this.client.message.writeByte(areaPortals.isPortalOpen(portalIndex) ? 1 : 0);
    }

    this.client.state = ServerClient.STATE.SPAWNED;

    if (SV.server.gameAPI.ClientBegin) {
      SV.server.gameAPI.time = SV.server.time;
      SV.server.gameAPI.ClientBegin(this.client.edict);
    }
  }

  static Kick_f(this: ConsoleCommand): void {
    const argv = this.argv;

    if (this.client === null && !SV.server.active) {
      this.forward();
      return;
    }

    if (argv.length < 2) {
      return;
    }

    const selection = argv[1].toLowerCase();
    const invokingClient = this.client;
    let clientIndex = 0;
    let byNumber = false;
    let targetClient: ServerClient | null = null;

    if (argv.length >= 3 && selection === '#') {
      clientIndex = Q.atoi(argv[2]) - 1;

      if (clientIndex < 0 || clientIndex >= SV.svs.maxclients) {
        return;
      }

      if (SV.svs.clients[clientIndex].state !== ServerClient.STATE.SPAWNED) {
        return;
      }

      targetClient = SV.svs.clients[clientIndex];
      byNumber = true;
    } else {
      for (clientIndex = 0; clientIndex < SV.svs.maxclients; clientIndex++) {
        const client = SV.svs.clients[clientIndex];

        if (client.state < ServerClient.STATE.CONNECTED) {
          continue;
        }

        if (client.name.toLowerCase() === selection) {
          targetClient = client;
          break;
        }
      }
    }

    if (targetClient === null || targetClient === invokingClient) {
      return;
    }

    const who = invokingClient === null
      ? (registry.isDedicatedServer ? NET.hostname.string : CL.name.string)
      : invokingClient.name;
    const parsedMessage = argv.length >= 3 && this.args !== null ? COM.Parse(this.args) : null;
    let dropReason = `Kicked by ${who}`;

    if (parsedMessage !== null && parsedMessage.data !== null) {
      let offset = 0;

      if (byNumber) {
        offset++;

        for (; offset < parsedMessage.data.length; offset++) {
          if (parsedMessage.data.charCodeAt(offset) !== 32) {
            break;
          }
        }

        offset += argv[2].length;
      }

      for (; offset < parsedMessage.data.length; offset++) {
        if (parsedMessage.data.charCodeAt(offset) !== 32) {
          break;
        }
      }

      dropReason = `Kicked by ${who}: ${parsedMessage.data.substring(offset)}`;
    }

    Host.DropClient(targetClient, false, dropReason);
  }

  static Give_f = class extends HostConsoleCommand { // TODO: move to game
    override run(classname?: string): void {
      // CR: unsure if I want a “give item_shells” approach or if I want to push
      // this piece of code into PR/PF and let the game handle this instead.

      if (this.forward() || this.cheat()) {
        return;
      }

      const client = this.client;

      if (client === null) {
        return;
      }

      if (!classname) {
        Host.ClientPrint(client, 'give <classname>\n');
        return;
      }

      const player = client.edict;

      if (!classname.startsWith('item_') && !classname.startsWith('weapon_')) {
        Host.ClientPrint(client, 'Only entity classes item_* and weapon_* are allowed!\n');
        return;
      }

      // Wait for the next server frame.
      SV.ScheduleGameCommand(() => {
        const { forward } = player.entity.v_angle.angleVectors();
        const start = player.entity.origin;
        const end = forward.copy().multiply(64.0).add(start);
        const mins = new Vector(-16.0, -16.0, -24.0);
        const maxs = new Vector(16.0, 16.0, 32.0);
        const trace = ServerEngineAPI.Traceline(start, end, false, player, mins, maxs);
        const origin = trace.point.subtract(forward.multiply(16.0)).add(new Vector(0.0, 0.0, 16.0));

        if (![content.CONTENT_EMPTY, content.CONTENT_WATER].includes(ServerEngineAPI.DetermineStaticWorldContents(origin))) {
          Host.ClientPrint(client, 'Item would spawn out of world!\n');
          return;
        }

        ServerEngineAPI.SpawnEntity(classname, {
          origin,
        });
      });
    }
  };

  static FindViewthing(): ServerEdict | null {
    if (SV.server.active) {
      for (let index = 0; index < SV.server.num_edicts; index++) {
        const edict = SV.server.edicts[index];

        if (!edict.isFree() && edict.entity.classname === 'viewthing') {
          return edict;
        }
      }
    }

    Con.Print('No viewthing on map\n');
    return null;
  }

  static async Viewmodel_f(model?: string): Promise<void> {
    if (model === undefined) {
      Con.Print('Usage: viewmodel <model>\n');
      return;
    }

    const entity = Host.FindViewthing();

    if (entity === null) {
      return;
    }

    const loadedModel = await Mod.ForNameAsync(model, false, Mod.scope.client);

    if (!loadedModel) {
      Con.Print(`Can't load ${model}\n`);
      return;
    }

    entity.entity.frame = 0;
    CL.state.model_precache[entity.entity.modelindex] = loadedModel;
  }

  static Viewframe_f(frame?: string): void {
    if (frame === undefined) {
      Con.Print('Usage: viewframe <frame>\n');
      return;
    }

    const entity = Host.FindViewthing();

    if (entity === null) {
      return;
    }

    const model = CL.state.model_precache[entity.entity.modelindex >> 0];

    if (!model) {
      return;
    }

    let nextFrame = Q.atoi(frame);

    if (nextFrame >= model.frames.length) {
      nextFrame = model.frames.length - 1;
    }

    entity.entity.frame = nextFrame;
  }

  static Viewnext_f(): void {
    const entity = Host.FindViewthing();

    if (entity === null) {
      return;
    }

    const model = CL.state.model_precache[entity.entity.modelindex >> 0];

    if (!model) {
      return;
    }

    let nextFrame = (entity.entity.frame >> 0) + 1;

    if (nextFrame >= model.frames.length) {
      nextFrame = model.frames.length - 1;
    }

    entity.entity.frame = nextFrame;
    Con.Print(`frame ${nextFrame}: ${model.frames[nextFrame].name}\n`);
  }

  static Viewprev_f(): void {
    const entity = Host.FindViewthing();

    if (entity === null) {
      return;
    }

    const model = CL.state.model_precache[entity.entity.modelindex >> 0];

    if (!model) {
      return;
    }

    let nextFrame = (entity.entity.frame >> 0) - 1;

    if (nextFrame < 0) {
      nextFrame = 0;
    }

    entity.entity.frame = nextFrame;
    Con.Print(`frame ${nextFrame}: ${model.frames[nextFrame].name}\n`);
  }

  static InitCommands(): void {
    if (registry.isDedicatedServer) { // TODO: move this to a dedicated stub for IN
      Cmd.AddCommand('bind', () => {});
      Cmd.AddCommand('unbind', () => {});
      Cmd.AddCommand('unbindall', () => {});
      Cmd.AddCommand('disconnect', Host.Disconnect_f);
    }

    Cmd.AddCommand('status', Host.Status_f);
    Cmd.AddCommand('quit', Host.Quit_f);
    Cmd.AddCommand('god', Host.God_f);
    Cmd.AddCommand('notarget', Host.Notarget_f);
    Cmd.AddCommand('fly', Host.Fly_f);
    Cmd.AddCommand('map', Host.Map_f);
    Cmd.AddCommand('restart', Host.Restart_f);
    Cmd.AddCommand('changelevel', Host.Changelevel_f);
    Cmd.AddCommand('connect', Host.Connect_f);
    Cmd.AddCommand('reconnect', Host.Reconnect_f);
    Cmd.AddCommand('name', Host.Name_f);
    Cmd.AddCommand('noclip', Host.Noclip_f);
    Cmd.AddCommand('say', Host.Say_All_f);
    Cmd.AddCommand('say_team', Host.Say_Team_f);
    Cmd.AddCommand('tell', Host.Tell_f);
    Cmd.AddCommand('color', Host.Color_f);
    Cmd.AddCommand('kill', Host.Kill_f);
    Cmd.AddCommand('pause', Host.Pause_f);
    Cmd.AddCommand('spawn', Host.Spawn_f);
    Cmd.AddCommand('begin', Host.Begin_f);
    Cmd.AddCommand('prespawn', Host.PreSpawn_f);
    Cmd.AddCommand('kick', Host.Kick_f);
    Cmd.AddCommand('ping', Host.Ping_f);

    if (!registry.isDedicatedServer) {
      Cmd.AddCommand('load', Host.Loadgame_f);
      Cmd.AddCommand('save', Host.Savegame_f);
    }

    Cmd.AddCommand('give', Host.Give_f);
    Cmd.AddCommand('viewmodel', Host.Viewmodel_f);
    Cmd.AddCommand('viewframe', Host.Viewframe_f);
    Cmd.AddCommand('viewnext', Host.Viewnext_f);
    Cmd.AddCommand('viewprev', Host.Viewprev_f);
    Cmd.AddCommand('writeconfig', Host.WriteConfiguration_f);
    Cmd.AddCommand('configready', Host.ConfigReady_f);

    Cmd.AddCommand('error', class HostErrorCommand extends ConsoleCommand {
      override run(message = ''): void {
        throw new HostError(message);
      }
    });

    Cmd.AddCommand('fatalerror', class HostFatalErrorCommand extends ConsoleCommand {
      override run(message = ''): void {
        throw new Error(message);
      }
    });

    Cmd.AddCommand('eb_topics', class HostEventBusTopicsCommand extends ConsoleCommand {
      override run(): void {
        // TODO: do not allow this command when server is having cheats disabled.
        for (const topic of eventBus.topics.sort()) {
          Con.Print(`${topic}\n`);
        }
      }
    });

    Cmd.AddCommand('eb_publish', class HostEventBusPublishCommand extends ConsoleCommand {
      override run(eventName?: string, ...args: string[]): void {
        // TODO: do not allow this command when server is having cheats disabled.
        if (!eventName) {
          Con.Print(`Usage: ${this.command} <eventName> [args...]\n`);
          return;
        }

        if (!eventBus.topics.includes(eventName)) {
          Con.PrintError(`No such event topic: ${eventName}\n`);
          return;
        }

        eventBus.publish(eventName, ...args);
      }
    });
  }
}
