import Cvar from './Cvar.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from './Def.mjs';
import Cmd, { ConsoleCommand } from './Cmd.mjs';
import { eventBus, registry } from '../registry.mjs';
import Vector from '../../shared/Vector.ts';
import Q from '../../shared/Q.ts';
import { ServerClient } from '../server/Client.mjs';
import { ServerEngineAPI } from './GameAPIs.mjs';
import Chase from '../client/Chase.mjs';
import VID from '../client/VID.mjs';
import { HostError } from './Errors.mjs';
import CDAudio from '../client/CDAudio.mjs';
import * as Defs from '../../shared/Defs.ts';
import { content, gameCapabilities } from '../../shared/Defs.ts';
import ClientLifecycle from '../client/ClientLifecycle.mjs';
import { Pmove } from './Pmove.mjs';

const Host = {};

export default Host;

let { CL, COM, Con, Draw, IN, Key, M, Mod, NET, PR, R, S, SCR, SV, Sbar, Sys, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Draw = registry.Draw;
  IN = registry.IN;
  Key = registry.Key;
  M = registry.M;
  Mod = registry.Mod;
  NET = registry.NET;
  PR = registry.PR;
  R = registry.R;
  S = registry.S;
  SCR = registry.SCR;
  SV = registry.SV;
  Sbar = registry.Sbar;
  Sys = registry.Sys;
  V = registry.V;
});

Host.framecount = 0;

Host.EndGame = function(message) {
  Con.PrintSuccess('Host.EndGame: ' + message + '\n');
  if (CL.cls.demonum !== -1) {
    CL.NextDemo();
  } else {
    CL.Disconnect();
    M.Alert('Host.EndGame', message);
  }
};

Host.Error = function(error) {
  if (Host.inerror === true) {
    throw new Error('throw new HostError: recursively entered');
  }
  Host.inerror = true;
  if (!registry.isDedicatedServer) {
    SCR.EndLoadingPlaque();
  }
  Con.PrintError('Host Error: ' + error + '\n');
  if (SV.server.active === true) {
    Host.ShutdownServer();
  }
  CL.Disconnect();
  CL.cls.demonum = -1;
  Host.inerror = false;
  M.Alert('Host Error', error);
};

Host.FindMaxClients = function() {
  SV.svs.maxclients = 1;
  SV.svs.maxclientslimit = Def.limits.clients;
  SV.svs.clients.length = 0;
  if (!registry.isDedicatedServer) {
    CL.cls.state = Def.clientConnectionState.disconnected;
  }
  for (let i = 0; i < SV.svs.maxclientslimit; i++) {
    SV.svs.clients.push(new ServerClient(i));
  }
};

Host.InitLocal = function() {
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

  eventBus.subscribe('cvar.changed', (name) => {
    const cvar = Cvar.FindVar(name);

    // Automatically save when an archive Cvar changed
    if ((cvar.flags & Cvar.FLAG.ARCHIVE) && Host.initialized) {
      Host.WriteConfiguration();
    }
  });

  Host.FindMaxClients();
};

Host.SendChatMessageToClient = function(client, name, message, direct = false) {
  client.message.writeByte(Protocol.svc.chatmsg);
  client.message.writeString(name);
  client.message.writeString(message);
  client.message.writeByte(direct ? 1 : 0);
};

Host.ClientPrint = function(string) { // FIXME: Host.client
  Host.client.message.writeByte(Protocol.svc.print);
  Host.client.message.writeString(string);
};

Host.BroadcastPrint = function(string) {
  for (const client of SV.svs.spawnedClients()) {
    client.message.writeByte(Protocol.svc.print);
    client.message.writeString(string);
  }
};

/**
 *
 * @param {ServerClient} client
 * @param {boolean} crash
 * @param {string} reason
 */
Host.DropClient = function(client, crash, reason) { // TODO: refactor into ServerClient
  if (NET.CanSendMessage(client.netconnection)) {
    client.message.writeByte(Protocol.svc.disconnect);
    client.message.writeString(reason);
    NET.SendMessage(client.netconnection, client.message);
  }

  if (!crash) {
    if (client.edict && client.state === ServerClient.STATE.SPAWNED) {
      const saveSelf = SV.server.gameAPI.self;
      SV.server.gameAPI.ClientDisconnect(client.edict);
      if (saveSelf !== undefined) {
        SV.server.gameAPI.self = saveSelf;
      }
    }
    Sys.Print('Client ' + client.name + ' removed\n');
  } else {
    client.state = ServerClient.STATE.DROPASAP;
    Sys.Print('Client ' + client.name + ' dropped\n');
  }

  NET.Close(client.netconnection);

  const { name, num } = client;

  client.clear();

  NET.activeconnections--;

  eventBus.publish('server.client.disconnected', num, name);

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.state <= ServerClient.STATE.CONNECTED) {
      continue;
    }
    // FIXME: consolidate into a single message
    client.message.writeByte(Protocol.svc.updatename);
    client.message.writeByte(num);
    client.message.writeByte(0);
    client.message.writeByte(Protocol.svc.updatefrags);
    client.message.writeByte(num);
    client.message.writeShort(0);
    client.message.writeByte(Protocol.svc.updatecolors);
    client.message.writeByte(num);
    client.message.writeByte(0);
    client.message.writeByte(Protocol.svc.updatepings);
    client.message.writeByte(num);
    client.message.writeShort(0);
  }
};

Host.ShutdownServer = function(isCrashShutdown = false) { // TODO: SV duties
  if (SV.server.active !== true) {
    return;
  }
  eventBus.publish('server.shutting-down');
  SV.server.active = false;
  if (!registry.isDedicatedServer && CL.cls.state === Def.clientConnectionState.connected) {
    CL.Disconnect();
  }
  const start = Sys.FloatTime(); let count; let i;
  do {
    count = 0;
    for (i = 0; i < SV.svs.maxclients; i++) { // FIXME: this 1is completely broken, it won’t properly close connections
      Host.client = SV.svs.clients[i];
      if (Host.client.state < ServerClient.STATE.CONNECTED || Host.client.message.cursize === 0) {
        continue;
      }
      if (NET.CanSendMessage(Host.client.netconnection)) {
        NET.SendMessage(Host.client.netconnection, Host.client.message);
        Host.client.message.clear();
        continue;
      }
      NET.GetMessage(Host.client.netconnection);
      count++;
    }
    if ((Sys.FloatTime() - start) > 3.0) { // this breaks a loop when the stuff on the top is stuck
      break;
    }
  } while (count !== 0);
  for (i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.state >= ServerClient.STATE.CONNECTED) {
      Host.DropClient(client, isCrashShutdown, 'Server shutting down');
    }
  }
  SV.ShutdownServer(isCrashShutdown);
  eventBus.publish('server.shutdown');
};

Host.ConfigReady_f = function() {
  eventBus.publish('host.config.loaded');
  Con.DPrint('Loaded configuration\n');
};

Host.WriteConfiguration = function() {
  Host.ScheduleInFuture('Host.WriteConfiguration', () => {
    // never save a config during pending commands
    if (Cmd.HasPendingCommands()) {
      Con.PrintWarning('Writing configuration dismissed, pending commands outstanding. Try again later.\n');
      return;
    }

    const config = `
${(!registry.isDedicatedServer ? Key.WriteBindings() + '\n\n\n': '')}

${Cvar.WriteVariables()}

configready
`;

    COM.WriteTextFile('config.cfg', config);
    Con.DPrint('Wrote configuration\n');
  }, 5.000);
};

Host.WriteConfiguration_f = function() {
  Con.Print('Writing configuration\n');
  Host.WriteConfiguration();
};

Host.ServerFrame = function() { // TODO: move to SV.ServerFrame
  SV.server.gameAPI.frametime = Host.frametime;
  SV.server.datagram.clear();
  SV.server.expedited_datagram.clear();
  SV.CheckForNewClients();
  SV.RunClients();
  if ((SV.server.paused !== true) && ((SV.svs.maxclients >= 2) || (!registry.isDedicatedServer && Key.dest.value === Key.dest.game))) {
    SV.physics.physics();
  }
  SV.RunScheduledGameCommands();
  SV.messages.sendClientMessages();
};

Host._scheduledForNextFrame = [];
Host.ScheduleForNextFrame = function(callback) {
  Host._scheduledForNextFrame.push(callback);
};

Host._scheduleInFuture = new Map();
Host.ScheduleInFuture = function(name, callback, whenInSeconds) {
  if (Host.isdown) {
    // there’s no future when shutting down
    callback();
    return;
  }

  if (Host._scheduleInFuture.has(name)) {
    return;
  }

  Host._scheduleInFuture.set(name, {
    time: Host.realtime + whenInSeconds,
    callback,
  });
};

Host._Frame = async function() {
  Host.realtime = Sys.FloatTime();
  Host.frametime = Host.realtime - Host.oldrealtime;
  Host.oldrealtime = Host.realtime;
  if (Host.framerate.value > 0) {
    Host.frametime = Host.framerate.value;
  } else {
    if (Host.frametime > 0.1) {
      Host.frametime = 0.1;
    } else if (Host.frametime < 0.001) {
      Host.frametime = 0.001;
    }
  }

  // check all scheduled things for the next frame
  while (Host._scheduledForNextFrame.length > 0) {
    const callback = Host._scheduledForNextFrame.shift();
    await callback();
  }

  // check what’s scheduled in future
  for (const [name, { time, callback }] of Host._scheduleInFuture.entries()) {
    if (time > Host.realtime) {
      continue;
    }

    await callback();
    Host._scheduleInFuture.delete(name);
  }

  if (registry.isDedicatedServer) {
    Cmd.Execute();

    if (SV.server.active === true) {
      if (Host.speeds.value !== 0) {
        console.profile('Host.ServerFrame');
      }

      Host.ServerFrame();

      if (Host.speeds.value !== 0) {
        console.profileEnd('Host.ServerFrame');
      }
    }

    // TODO: add times

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

  if (Host.speeds.value !== 0) {
    console.profile('CL.ClientFrame');
  }
  CL.ClientFrame();
  if (Host.speeds.value !== 0) {
    console.profileEnd('CL.ClientFrame');
  }

  CL.SendCmd();

  if (SV.server.active && !SV.svs.changelevelIssued) {
    if (Host.speeds.value !== 0) {
      console.profile('Host.ServerFrame');
    }

    Host.ServerFrame();

    if (Host.speeds.value !== 0) {
      console.profileEnd('Host.ServerFrame');
    }
  }

  // Set up prediction for other players
  CL.SetUpPlayerPrediction(false);

  if (Host.speeds.value !== 0) {
    console.profile('CL.PredictMove');
  }

  // do client side motion prediction
  CL.PredictMove();

  if (Host.speeds.value !== 0) {
    console.profileEnd('CL.PredictMove');
  }

  // Set up prediction for other players
  CL.SetUpPlayerPrediction(true);

  // build a refresh entity list
  CL.state.clientEntities.emit();

  SCR.UpdateScreen();

  if (Host.speeds.value !== 0) {
    console.profile('S.Update');
  }

  if (CL.cls.signon === 4) {
    S.Update(R.refdef.vieworg, R.vpn, R.vright, R.vup, R.viewleaf ? R.viewleaf.contents <= content.CONTENT_WATER : false);
  } else {
    S.Update(Vector.origin, Vector.origin, Vector.origin, Vector.origin, false);
  }
  CDAudio.Update();

  if (Host.speeds.value !== 0) {
    console.profileEnd('S.Update');
  }

  Host.framecount++;
};

let inHandleCrash = false;

// TODO: Sys.Init can handle a crash now since we are main looping without setInterval
Host.HandleCrash = function(e) {
  if (e instanceof HostError) {
    Host.Error(e.message);
    return;
  }
  if (inHandleCrash) {
    console.error(e);
    // eslint-disable-next-line no-debugger
    debugger;
    return;
  }
  inHandleCrash = true;
  Con.PrintError((e.name ?? e.constructor.name) + ': ' + e.message + '\n');
  eventBus.publish('host.crash', e);
  Sys.Quit();
};

Host.Frame = async function() {
  if (inHandleCrash) {
    return;
  }

  try {
    await Host._Frame();
  } catch (e) {
    Host.HandleCrash(e);
  }
};

Host.Init = async function() {
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

  Cmd.text = 'exec better-quake.rc\n' + Cmd.text;

  // eslint-disable-next-line require-atomic-updates
  Host.initialized = true;
  Sys.Print('========Host Initialized=========\n');

  eventBus.publish('host.ready');
};

Host.Shutdown = function() {
  if (Host.isdown === true) {
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
};

// Commands

Host.Quit_f = function() {
  if (!registry.isDedicatedServer) {
    if (Key.dest.value !== Key.dest.console) {
      M.Menu_Quit_f();
      return;
    }
  }

  if (SV.server.active === true) {
    Host.ShutdownServer();
  }

  COM.Shutdown();
  Sys.Quit();
};

Host.Status_f = function() {
  /** @type {Function} */
  let print;
  if (!this.client) {
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
    print = Host.ClientPrint;
  }
  print('hostname: ' + NET.hostname.string + '\n');
  print('address : ' + NET.GetListenAddress() + '\n');
  print('version : ' + Host.version.string + ' (' + SV.server.gameVersion + ')\n');
  print('map     : ' + SV.server.mapname + '\n');
  print('game    : ' + SV.server.gameName + '\n');
  print('edicts  : ' + SV.server.num_edicts + ' used of ' + SV.server.edicts.length + ' allocated\n');
  print('players : ' + NET.activeconnections + ' active (' + SV.svs.maxclients + ' max)\n\n');

  const lines = [];

  for (let i = 0; i < SV.svs.maxclients; i++) {
    /** @type {ServerClient} */
    const client = SV.svs.clients[i];

    if (client.state < ServerClient.STATE.CONNECTED) {
      continue;
    }

    const parts = [
      client.num.toString().padStart(3),
      client.name.substring(0, 19).padEnd(19),
      client.uniqueId.substring(0, 19).padEnd(19),
      Q.secsToTime(NET.time - client.netconnection.connecttime).padEnd(9),
      client.ping.toFixed(0).padStart(4),
      new Number(0).toFixed(0).padStart(4),   // TODO: add loss
      ServerClient.STATE.toKey(client.state).padEnd(10),
      client.netconnection.address,
    ];

    lines.push(parts.join(' | ') + '\n');
  }

  if (lines.length === 0) {
    return;
  }

  print('id  | name                | unique id           | play time | ping | loss | state      | adr\n');
  print('----|---------------------|---------------------|-----------|------|------|------------|-----\n');

  for (const line of lines) {
    print(line);
  }
};

class HostConsoleCommand extends ConsoleCommand {
  /**
   * @protected
   * @returns {boolean} true, if it’s a cheat and cannot be invoked
   */
  cheat() {
    if (!SV.cheats.value) {
      Host.ClientPrint('Cheats are not enabled on this server.\n');
      return true;
    }

    return false;
  }
}

Host.God_f = class extends HostConsoleCommand {
  run() {
    if (this.forward()) {
      return;
    }
    if (this.cheat()) {
      return;
    }
    const client = this.client;
    client.edict.entity.flags ^= Defs.flags.FL_GODMODE;
    if ((client.edict.entity.flags & Defs.flags.FL_GODMODE) === 0) {
      Host.ClientPrint('godmode OFF\n');
    } else {
      Host.ClientPrint('godmode ON\n');
    }
  }
};

Host.Notarget_f = class extends HostConsoleCommand {
  run() {
    if (this.forward()) {
      return;
    }
    if (this.cheat()) {
      return;
    }
    const client = this.client;
    client.edict.entity.flags ^= Defs.flags.FL_NOTARGET;
    if ((client.edict.entity.flags & Defs.flags.FL_NOTARGET) === 0) {
      Host.ClientPrint('notarget OFF\n');
    } else {
      Host.ClientPrint('notarget ON\n');
    }
  }
};

Host.Noclip_f = class extends HostConsoleCommand {
  run() {
    if (this.forward()) {
      return;
    }
    if (this.cheat()) {
      return;
    }
    const client = this.client;
    if (client.edict.entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP) {
      Host.noclip_anglehack = true;
      client.edict.entity.movetype = Defs.moveType.MOVETYPE_NOCLIP;
      Host.ClientPrint('noclip ON\n');
      return;
    }
    Host.noclip_anglehack = false;
    client.edict.entity.movetype = Defs.moveType.MOVETYPE_WALK;
    Host.ClientPrint('noclip OFF\n');
  }
};

Host.Fly_f = class extends HostConsoleCommand {
  run() {
    if (this.forward()) {
      return;
    }
    if (this.cheat()) {
      return;
    }
    const client = this.client;
    if (client.edict.entity.movetype !== Defs.moveType.MOVETYPE_FLY) {
      client.edict.entity.movetype = Defs.moveType.MOVETYPE_FLY;
      Host.ClientPrint('flymode ON\n');
      return;
    }
    client.edict.entity.movetype = Defs.moveType.MOVETYPE_WALK;
    Host.ClientPrint('flymode OFF\n');
  }
};

Host.Ping_f = function() {
  if (this.forward()) {
    return;
  }

  Host.ClientPrint('Client ping times:\n');

  for (let i = 0; i < SV.svs.maxclients; i++) {
    /** @type {ServerClient} */
    const client = SV.svs.clients[i];

    if (client.state < ServerClient.STATE.CONNECTED) {
      continue;
    }

    let total = 0;

    for (let j = 0; j < client.ping_times.length; j++) {
      total += client.ping_times[j];
    }

    Host.ClientPrint((total * 62.5).toFixed(0).padStart(3) + ' ' + client.name + '\n');
  }
};

Host.Map_f = function(mapname, ...spawnparms) {
  if (mapname === undefined) {
    Con.Print('Usage: map <map>\n');
    return;
  }
  if (this.client) {
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
  }
  SV.svs.serverflags = 0;

  if (!registry.isDedicatedServer) {
    CL.SetConnectingStep(5, 'Spawning server');
  }

  if (!registry.isDedicatedServer) {
    CL.cls.spawnparms = spawnparms.join(' ');
  }

  Host.ScheduleForNextFrame(async () => {
    if (!await SV.SpawnServer(mapname)) {
      SV.ShutdownServer(false);
      throw new HostError('Could not spawn server with map ' + mapname);
    }

    if (!registry.isDedicatedServer) {
      CL.SetConnectingStep(null, null);
    }

    if (!registry.isDedicatedServer) {
      CL.Connect('local');
    }
  });
};

Host.Changelevel_f = function(mapname) {
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

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.state < ServerClient.STATE.CONNECTED) {
      continue;
    }
    client.message.writeByte(Protocol.svc.changelevel);
    client.message.writeString(mapname);
  }

  if (!registry.isDedicatedServer) {
    // this hack allows us to show the loading plaque and resetting the client renderer
    CL.cls.changelevel = true;
    CL.cls.signon = 0;
  }

  Host.ScheduleForNextFrame(async () => {
    SV.SaveSpawnparms();

    Con.DPrint('Host.Changelevel_f: changing level to ' + mapname + '\n');

    if (!await SV.SpawnServer(mapname)) {
      SV.ShutdownServer(false);
      throw new HostError('Could not spawn server for changelevel to ' + mapname);
    }

    Con.DPrint('Host.Changelevel_f: spawned server for changelevel to ' + mapname + '\n');

    if (!registry.isDedicatedServer) {
      CL.SetConnectingStep(null, null);
    }
  });
};

Host.Restart_f = function() {
  if ((SV.server.active) && (registry.isDedicatedServer || !CL.cls.demoplayback && !this.client)) {
    Cmd.ExecuteString(`map ${SV.server.mapname}`);
  }
};

// NOTE: this is the dedicated server version of disconnect
Host.Disconnect_f = function() {
  if (!SV.server.active) {
    Con.Print('No active server\n');
    return;
  }

  Host.ShutdownServer();
};

Host.Reconnect_f = function() {
  if (registry.isDedicatedServer) {
    Con.Print('cannot reconnect in dedicated server mode\n');
    return;
  }

  Con.PrintWarning('NOT IMPLEMENTED: reconnect\n'); // TODO: reimplement reconnect here
};

Host.Connect_f = function(address) {
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
  if (CL.cls.demoplayback === true) {
    CL.StopPlayback();
    CL.Disconnect();
  }

  if (address === 'self') {
    const url = new URL(location.href);
    CL.Connect((url.protocol === 'https:' ? 'wss' : 'ws') + '://' + url.host + url.pathname + (!url.pathname.endsWith('/') ? '/' : '') + 'api/');
  } else {
    CL.Connect(address);
  }

  CL.cls.signon = 0;
};

Host.Savegame_f = function(savename) {
  if (this.client) {
    return;
  }
  if (savename === undefined) {
    Con.Print('Usage: save <savename>\n');
    return;
  }
  if (SV.server.active !== true) {
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
  if (savename.indexOf('..') !== -1) {
    Con.PrintWarning('Relative pathnames are not allowed.\n');
    return;
  }
  const client = SV.svs.clients[0];
  if (client.state >= ServerClient.STATE.CONNECTED) {
    if (client.edict.entity.health <= 0.0) {
      Con.PrintWarning('Can\'t savegame with a dead player\n');
      return;
    }
  }

  const gamestate = {
    version: Def.gamestateVersion,
    gameversion: SV.server.gameVersion,
    comment: CL.state.levelname, // TODO: ask the game for a comment
    spawn_parms: client.spawn_parms,
    mapname: SV.server.mapname,
    time: SV.server.time,
    lightstyles: SV.server.lightstyles,
    globals: null,
    cvars: [...Cvar.Filter((cvar) => cvar.flags & (Cvar.FLAG.SERVER | Cvar.FLAG.GAME))].map((cvar) => [cvar.name, cvar.string]),
    clientdata: null,
    edicts: [],
    num_edicts: SV.server.num_edicts,
    // TODO: client entities
    particles: R.SerializeParticles(),
  };

  if (CL.state.gameAPI) {
    gamestate.clientdata = CL.state.gameAPI.saveGame();
  }

  // IDEA: we could actually compress this by using a list of common fields
  for (const edict of SV.server.edicts) {
    if (edict.isFree()) {
      gamestate.edicts.push(null);
      continue;
    }

    gamestate.edicts.push([edict.entity.classname, edict.entity.serialize()]);
  }

  gamestate.globals = SV.server.gameAPI.serialize();

  const name = COM.DefaultExtension(savename, '.json');
  Con.Print('Saving game to ' + name + '...\n');
  if (COM.WriteTextFile(name, JSON.stringify(gamestate))) {
    Con.PrintSuccess('done.\n');
  } else {
    Con.PrintError('ERROR: couldn\'t open.\n');
  }
};

Host.Loadgame_f = async function (savename) {
  if (this.client) {
    return;
  }
  if (savename === undefined) {
    Con.Print('Usage: load <savename>\n');
    return;
  }
  if (savename.indexOf('..') !== -1) {
    Con.PrintWarning('Relative pathnames are not allowed.\n');
    return;
  }
  CL.cls.demonum = -1;
  const name = COM.DefaultExtension(savename, '.json');
  Con.Print('Loading game from ' + name + '...\n');
  const data = await COM.LoadTextFile(name);
  if (data === null) {
    Con.PrintError('ERROR: couldn\'t open.\n');
    return;
  }

  const gamestate = JSON.parse(data);

  if (gamestate.version !== Def.gamestateVersion) {
    throw new HostError(`Savegame is version ${gamestate.version}, not ${Def.gamestateVersion}\n`);
  }

  CL.Disconnect();

  // restore all server/game cvars
  for (const [name, value] of gamestate.cvars) {
    const cvar = Cvar.FindVar(name);
    if (cvar) {
      cvar.set(value);
    } else {
      Con.PrintWarning(`Saved cvar ${name} not found, skipping\n`);
    }
  }

  if (!await SV.SpawnServer(gamestate.mapname)) {
    if (!registry.isDedicatedServer) {
      CL.SetConnectingStep(null, null);
    }

    SV.ShutdownServer(false);
    throw new HostError(`Couldn't load map ${gamestate.mapname} for save game ${name}\n`);
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

  // first run through all edicts to make sure the entity structures get initialized
  for (let i = 0; i < SV.server.edicts.length; i++) {
    const edict = SV.server.edicts[i];

    if (!gamestate.edicts[i]) { // freed edict
      // FIXME: QuakeC doesn’t like it at all when edicts suddenly disappear, we should offload this code to the GameAPI
      edict.freeEdict();
      continue;
    }

    const [classname] = gamestate.edicts[i];
    console.assert(SV.server.gameAPI.prepareEntity(edict, classname), 'no entity for classname');
  }

  // second run we can start deserializing
  for (let i = 0; i < SV.server.edicts.length; i++) {
    const edict = SV.server.edicts[i];

    if (edict.isFree()) { // freed edict
      continue;
    }

    const [, data] = gamestate.edicts[i];
    edict.entity.deserialize(data);
    edict.linkEdict();
  }

  SV.server.time = gamestate.time;

  const client = SV.svs.clients[0];
  client.spawn_parms = gamestate.spawn_parms;

  ClientLifecycle.resumeGame(gamestate.clientdata, gamestate.particles);
};

Host.Name_f = function(...names) { // signon 2, step 1
  Con.DPrint(`Host.Name_f: ${this.client}\n`);
  if (names.length < 1) {
    Con.Print('"name" is "' + CL.name.string + '"\n');
    return;
  }

  if (!SV.server.active) { // ???
    return;
  }

  let newName = names.join(' ').trim().substring(0, 15);

  if (!registry.isDedicatedServer && !this.client) {
    Cvar.Set('_cl_name', newName);
    if (CL.cls.state === Def.clientConnectionState.connected) {
      this.forward();
    }
    return;
  }

  if (!this.client) {
    return;
  }

  const initialNewName = newName;
  let newNameCounter = 2;

  // make sure we have a somewhat unique name
  while (SV.FindClientByName(newName)) {
    newName = `${initialNewName}${newNameCounter++}`;
  }

  const name = this.client.name;
  if (registry.isDedicatedServer && name && (name.length !== 0) && (name !== 'unconnected') && (name !== newName)) {
    Con.Print(name + ' renamed to ' + newName + '\n');
  }

  this.client.name = newName;
  const msg = SV.server.reliable_datagram;
  msg.writeByte(Protocol.svc.updatename);
  msg.writeByte(this.client.num);
  msg.writeString(newName);
};

Host.Say_f = function(teamonly, message) {
  if (this.forward()) {
    return;
  }

  if (!message) {
    return;
  }

  const save = Host.client;

  if (message.length > 140) {
    message = message.substring(0, 140) + '...';
  }

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.state < ServerClient.STATE.CONNECTED) {
      continue;
    }
    if ((Host.teamplay.value !== 0) && (teamonly === true) && (client.entity.team !== save.entity.team)) { // Legacy cvars
      continue;
    }
    Host.SendChatMessageToClient(client, save.name, message, false);
  }

  Host.client = save; // unsure whether I removed it or not

  Con.Print(`${save.name}: ${message}\n`);
};

Host.Say_Team_f = function(message) {
  Host.Say_f.call(this, true, message);
};

Host.Say_All_f = function(message) {
  Host.Say_f.call(this, false, message);
};

Host.Tell_f = function(recipient, message) {
  if (this.forward()) {
    return;
  }

  if (!recipient || !message) {
    Con.Print('Usage: tell <recipient> <message>\n');
    return;
  }

  message = message.trim();

  // Remove surrounding double quotes if present
  if (message.startsWith('"')) {
    message = message.slice(1, -1);
  }
  if (message.length > 140) {
    message = message.substring(0, 140) + '...';
  }

  const save = Host.client;
  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.state < ServerClient.STATE.CONNECTED) {
      continue;
    }
    if (client.name.toLowerCase() !== recipient.toLowerCase()) {
      continue;
    }
    Host.SendChatMessageToClient(client, save.name, message, true);
    Host.SendChatMessageToClient(Host.client, save.name, message, true);
    break;
  }
  Host.client = save;
};

Host.Color_f = function(...argv) { // signon 2, step 2 // FIXME: Host.client
  Con.DPrint(`Host.Color_f: ${this.client}\n`);
  if (argv.length <= 1) {
    Con.Print('"color" is "' + (CL.color.value >> 4) + ' ' + (CL.color.value & 15) + '"\ncolor <0-13> [0-13]\n');
    return;
  }

  let top; let bottom;
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

  if (!registry.isDedicatedServer && !this.client) {
    Cvar.Set('_cl_color', playercolor);
    if (CL.cls.state === Def.clientConnectionState.connected) {
      this.forward();
    }
    return;
  }

  if (!this.client) {
    return;
  }

  this.client.colors = playercolor;
  this.client.edict.entity.team = bottom + 1;
  const msg = SV.server.reliable_datagram;
  msg.writeByte(Protocol.svc.updatecolors);
  msg.writeByte(this.client.num);
  msg.writeByte(playercolor);
};

Host.Kill_f = function() {
  if (this.forward()) {
    return;
  }

  const client = this.client;
  if (client.edict.entity.health <= 0.0) {
    Host.ClientPrint('Can\'t suicide -- already dead!\n');
    return;
  }

  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.ClientKill(client.edict);
};

Host.Pause_f = function() {
  if (this.forward()) {
    return;
  }

  if (Host.pausable.value === 0) {
    Host.ClientPrint('Pause not allowed.\n');
    return;
  }
  SV.server.paused = !SV.server.paused;
  Host.BroadcastPrint(Host.client.name + (SV.server.paused === true ? ' paused the game\n' : ' unpaused the game\n'));
  SV.server.reliable_datagram.writeByte(Protocol.svc.setpause);
  SV.server.reliable_datagram.writeByte(SV.server.paused === true ? 1 : 0);
};

Host.PreSpawn_f = function() { // signon 1, step 1
  if (!this.client) {
    Con.Print('prespawn is not valid from the console\n');
    return;
  }
  Con.DPrint(`Host.PreSpawn_f: ${this.client}\n`);
  const client = this.client;
  if (client.state === ServerClient.STATE.SPAWNED) {
    Con.Print('prespawn not valid -- already spawned\n');
    return;
  }
  // CR: SV.server.signon is a special buffer that is used to send the signon messages (make static as well as baseline information)
  client.message.write(new Uint8Array(SV.server.signon.data), SV.server.signon.cursize);
  client.message.writeByte(Protocol.svc.signonnum);
  client.message.writeByte(2);
};

Host.Spawn_f = function() { // signon 2, step 3
  Con.DPrint(`Host.Spawn_f: ${this.client}\n`);
  if (!this.client) {
    Con.Print('spawn is not valid from the console\n');
    return;
  }
  let client = this.client;
  if (client.state === ServerClient.STATE.SPAWNED) {
    Con.Print('Spawn not valid -- already spawned\n');
    return;
  }

  const message = client.message;
  message.clear();

  message.writeByte(Protocol.svc.time);
  message.writeFloat(SV.server.time);

  const ent = client.edict;
  if (SV.server.loadgame === true) {
    SV.server.paused = false;
  } else {
    // ent.clear(); // FIXME: there’s a weird edge case
    SV.server.gameAPI.prepareEntity(ent, 'player', {
      netname: client.name,
      colormap: ent.num, // the num, not the entity
      team: (client.colors & 15) + 1,
    });

    // load in spawn parameters (legacy)
    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_LEGACY)) {
      for (let i = 0; i <= 15; i++) {
        SV.server.gameAPI[`parm${i + 1}`] = client.spawn_parms[i];
      }
    }

    // load in spawn parameters
    if (SV.server.gameCapabilities.includes(gameCapabilities.CAP_SPAWNPARMS_DYNAMIC)) {
      ent.entity.restoreSpawnParameters(client.spawn_parms);
    }

    // call the spawn function
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.ClientConnect(ent);

    // actually spawn the player
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.PutClientInServer(ent);
  }

  for (let i = 0; i < SV.svs.maxclients; i++) {
    client = SV.svs.clients[i];
    message.writeByte(Protocol.svc.updatename);
    message.writeByte(i);
    message.writeString(client.name);
    message.writeByte(Protocol.svc.updatefrags);
    message.writeByte(i);
    message.writeShort(client.old_frags);
    message.writeByte(Protocol.svc.updatecolors);
    message.writeByte(i);
    message.writeByte(client.colors);
  }

  for (let i = 0; i < Def.limits.lightstyles; i++) {
    message.writeByte(Protocol.svc.lightstyle);
    message.writeByte(i);
    message.writeString(SV.server.lightstyles[i]);
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
  message.writeAngleVector(ent.entity.angles);

  SV.messages.writeClientdataToMessage(client, message);

  message.writeByte(Protocol.svc.signonnum);
  message.writeByte(3);
};

Host.Begin_f = function() {  // signon 3, step 1
  Con.DPrint(`Host.Begin_f: ${this.client}\n`);
  if (!this.client) {
    Con.Print('begin is not valid from the console\n');
    return;
  }

  // Send all portal states before the client is offically spawned and gets updates incrementally
  const areaPortals = SV.server.worldmodel.areaPortals;

  for (let p = 0; p < areaPortals.numPortals; p++) {
    this.client.message.writeByte(Protocol.svc.setportalstate);
    this.client.message.writeShort(p);
    this.client.message.writeByte(areaPortals.isPortalOpen(p) ? 1 : 0);
  }

  this.client.state = ServerClient.STATE.SPAWNED;

  if (SV.server.gameAPI.ClientBegin) {
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.ClientBegin(this.client.edict);
  }
};

Host.Kick_f = function() { // FIXME: Host.client
  const argv = this.argv;
  if (!this.client) {
    if (!SV.server.active) {
      this.forward();
      return;
    }
  }
  if (argv.length < 2) {
    return;
  }
  const save = Host.client;
  const s = argv[1].toLowerCase();
  let i; let byNumber = false;
  if ((argv.length >= 3) && (s === '#')) {
    i = Q.atoi(argv[2]) - 1;
    if ((i < 0) || (i >= SV.svs.maxclients)) {
      return;
    }
    if (SV.svs.clients[i].state !== ServerClient.STATE.SPAWNED) {
      return;
    }
    Host.client = SV.svs.clients[i];
    byNumber = true;
  } else {
    for (i = 0; i < SV.svs.maxclients; i++) {
      Host.client = SV.svs.clients[i];
      if (Host.client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }
      if (Host.client.name.toLowerCase() === s) {
        break;
      }
    }
  }
  if (i >= SV.svs.maxclients) {
    Host.client = save;
    return;
  }
  if (Host.client === save) {
    return;
  }
  let who;
  if (!this.client) {
    if (registry.isDedicatedServer) {
      who = NET.hostname.string;
    } else {
      who = CL.name.string;
    }
  } else {
    if (Host.client === save) {
      return;
    }
    who = save.name;
  }
  let message;
  if (argv.length >= 3) {
    message = COM.Parse(this.args);
  }
  let dropReason = 'Kicked by ' + who;
  if (message.data !== null) {
    let p = 0;
    if (byNumber) {
      p++;
      for (; p < message.data.length; p++) {
        if (message.data.charCodeAt(p) !== 32) {
          break;
        }
      }
      p += argv[2].length;
    }
    for (; p < message.data.length; p++) {
      if (message.data.charCodeAt(p) !== 32) {
        break;
      }
    }
    dropReason = 'Kicked by ' + who + ': ' + message.data.substring(p);
  }
  Host.DropClient(Host.client, false, dropReason);
  Host.client = save;
};

Host.Give_f = class extends HostConsoleCommand { // TODO: move to game
  run(classname) {
    // CR:  unsure if I want a “give item_shells” approach or
    //      if I want to push this piece of code into PR/PF and let
    //      the game handle this instead

    if (this.forward()) {
      return;
    }

    if (this.cheat()) {
      return;
    }

    if (!classname) {
      Host.ClientPrint('give <classname>\n');
      return;
    }

    const player = this.client.edict;

    if (!classname.startsWith('item_') && !classname.startsWith('weapon_')) {
      Host.ClientPrint('Only entity classes item_* and weapon_* are allowed!\n');
      return;
    }

    // wait for the next server frame
    SV.ScheduleGameCommand(() => {
      const { forward } = player.entity.v_angle.angleVectors();

      const start = player.entity.origin;
      const end = forward.copy().multiply(64.0).add(start);

      const mins = new Vector(-16.0, -16.0, -24.0);
      const maxs = new Vector(16.0, 16.0, 32.0);

      const trace = ServerEngineAPI.Traceline(start, end, false, player, mins, maxs);

      const origin = trace.point.subtract(forward.multiply(16.0)).add(new Vector(0.0, 0.0, 16.0));

      if (![content.CONTENT_EMPTY, content.CONTENT_WATER].includes(ServerEngineAPI.DetermineStaticWorldContents(origin))) {
        Host.ClientPrint('Item would spawn out of world!\n');
        return;
      }

      ServerEngineAPI.SpawnEntity(classname, {
        origin,
      });
    });
  }
};

Host.FindViewthing = function() {
  if (SV.server.active) {
    for (let i = 0; i < SV.server.num_edicts; i++) {
      const e = SV.server.edicts[i];
      if (!e.isFree() && e.entity.classname === 'viewthing') {
        return e;
      }
    }
  }
  Con.Print('No viewthing on map\n');
  return null;
};

Host.Viewmodel_f = async function(model) {
  if (model === undefined) {
    Con.Print('Usage: viewmodel <model>\n');
    return;
  }
  const ent = Host.FindViewthing();
  if (ent) {
    return;
  }
  const m = await Mod.ForNameAsync(model, false, Mod.scope.client);
  if (!m) {
    Con.Print('Can\'t load ' + model + '\n');
    return;
  }
  ent.entity.frame = 0;
  CL.state.model_precache[ent.entity.modelindex] = m;
};

Host.Viewframe_f = function(frame) {
  if (frame === undefined) {
    Con.Print('Usage: viewframe <frame>\n');
    return;
  }
  const ent = Host.FindViewthing();
  if (!ent) {
    return;
  }
  const m = CL.state.model_precache[ent.entity.modelindex >> 0];
  let f = Q.atoi(frame);
  if (f >= m.frames.length) {
    f = m.frames.length - 1;
  }
  ent.entity.frame = f;
};

Host.Viewnext_f = function() {
  const ent = Host.FindViewthing();
  if (!ent) {
    return;
  }
  const m = CL.state.model_precache[ent.entity.modelindex >> 0];
  let f = (ent.entity.frame >> 0) + 1;
  if (f >= m.frames.length) {
    f = m.frames.length - 1;
  }
  ent.entity.frame = f;
  Con.Print('frame ' + f + ': ' + m.frames[f].name + '\n');
};

Host.Viewprev_f = function() {
  const ent = Host.FindViewthing();
  if (!ent) {
    return;
  }
  const m = CL.state.model_precache[ent.entity.modelindex >> 0];
  let f = (ent.entity.frame >> 0) - 1;
  if (f < 0) {
    f = 0;
  }
  ent.entity.frame = f;
  Con.Print('frame ' + f + ': ' + m.frames[f].name + '\n');
};

Host.InitCommands = function() {
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
  // Cmd.AddCommand('mcache', Mod.Print);
  Cmd.AddCommand('writeconfig', Host.WriteConfiguration_f);
  Cmd.AddCommand('configready', Host.ConfigReady_f);

  Cmd.AddCommand('error', class extends ConsoleCommand {
    run(message) {
      throw new HostError(message);
    }
  });

  Cmd.AddCommand('fatalerror', class extends ConsoleCommand {
    run(message) {
      throw new Error(message);
    }
  });

  Cmd.AddCommand('eb_topics', class extends ConsoleCommand {
    run() {
      // TODO: do not allow this command when server is having cheats disabled

      for (const topic of eventBus.topics.sort()) {
        Con.Print(topic + '\n');
      }
    }
  });

  Cmd.AddCommand('eb_publish', class extends ConsoleCommand {
    run(eventName, ...args) {
      // TODO: do not allow this command when server is having cheats disabled

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
};
