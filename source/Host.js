/* global Host, Con, Mod, COM, Host, CL, Cmd, Cvar, Vector, S, Q, NET, MSG, Protocol, SV, SCR, R, Chase, IN, Sys, Def, V, CDAudio, Sbar, Draw, VID, M, PR, Key, W, Shack, Game */

// eslint-disable-next-line no-global-assign
Host = {};

Host.framecount = 0;

Host.EndGame = function(message) {
  Con.PrintSuccess('Host.EndGame: ' + message + '\n');
  if (CL.cls.demonum !== -1) {
    CL.NextDemo();
  } else {
    CL.Disconnect();
  }
  M.Alert('Host.EndGame', message);
};

Host.Error = function(error) {
  debugger;

  if (Host.inerror === true) {
    Sys.Error('Host.Error: recursively entered');
  }
  Host.inerror = true;
  if (!Host.dedicated.value) {
    SCR.EndLoadingPlaque();
  }
  Con.PrintError('Host.Error: ' + error + '\n');
  if (SV.server.active === true) {
    Host.ShutdownServer();
  }
  CL.Disconnect();
  CL.cls.demonum = -1;
  Host.inerror = false;
  M.Alert('Host.Error', error);
};

Host.FindMaxClients = function() {
  SV.svs.maxclients = 1;
  SV.svs.maxclientslimit = Def.max_clients;
  SV.svs.clients = [];
  if (!Host.dedicated.value) {
    CL.cls.state = CL.active.disconnected;
  }
  for (let i = 0; i < SV.svs.maxclientslimit; i++) {
    SV.svs.clients.push(new SV.Client(i));
  }
  Cvar.SetValue('deathmatch', 0);
};

Host.InitLocal = function(dedicated) {
  Host.InitCommands(dedicated);
  Host.framerate = new Cvar('host_framerate', '0');
  Host.speeds = new Cvar('host_speeds', '0');
  Host.ticrate = new Cvar('sys_ticrate', '0.05');
  Host.serverprofile = new Cvar('serverprofile', '0');
  Host.fraglimit = new Cvar('fraglimit', '0', Cvar.FLAG.SERVER);
  Host.timelimit = new Cvar('timelimit', '0', Cvar.FLAG.SERVER);
  Host.teamplay = new Cvar('teamplay', '0', Cvar.FLAG.SERVER);
  Host.samelevel = new Cvar('samelevel', '0', Cvar.FLAG.SERVER, 'Set to 1 to stay on the same map even the map is over');
  Host.noexit = new Cvar('noexit', '0', Cvar.FLAG.SERVER);
  Host.skill = new Cvar('skill', '1');
  Host.developer = new Cvar('developer', '0');
  Host.deathmatch = new Cvar('deathmatch', '0', Cvar.FLAG.SERVER);
  Host.coop = new Cvar('coop', '0', Cvar.FLAG.SERVER);
  Host.pausable = new Cvar('pausable', '1', Cvar.FLAG.SERVER);

  // dedicated server settings
  Host.dedicated = new Cvar('dedicated', dedicated ? '1' : '0', Cvar.FLAG.READONLY, 'Set to 1, if running in dedicated server mode.');

  Host.FindMaxClients();
};

Host.SendChatMessageToClient = function(client, name, message, direct = false) {
  MSG.WriteByte(client.message, Protocol.svc.chatmsg);
  MSG.WriteString(client.message, name);
  MSG.WriteString(client.message, message);
  MSG.WriteByte(client.message, direct ? 1 : 0);
};

Host.ClientPrint = function(string) { // FIXME: Host.client
  MSG.WriteByte(Host.client.message, Protocol.svc.print);
  MSG.WriteString(Host.client.message, string);
};

Host.BroadcastPrint = function(string) {
  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (!client.active || !client.spawned) {
      continue;
    }
    MSG.WriteByte(client.message, Protocol.svc.print);
    MSG.WriteString(client.message, string);
  }
};

/**
 *
 * @param {SV.ServerClient} client
 * @param {boolean} crash
 * @param {string} reason
 */
Host.DropClient = function(client, crash, reason) {
  if (NET.CanSendMessage(client.netconnection)) {
    MSG.WriteByte(client.message, Protocol.svc.disconnect);
    MSG.WriteString(client.message, reason);
    NET.SendMessage(client.netconnection, client.message);
  }

  if (!crash) {
    if (client.edict && client.spawned) {
      const saveSelf = SV.server.gameAPI.self;
      SV.server.gameAPI.ClientDisconnect(client.edict);
      SV.server.gameAPI.self = saveSelf;
    }
    Sys.Print('Client ' + client.name + ' removed\n');
  } else {
    client.dropasap = true;
    Sys.Print('Client ' + client.name + ' dropped\n');
  }

  NET.Close(client.netconnection);

  client.clear();

  --NET.activeconnections;
  let i; const num = client.num;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    if (!client.active) {
      continue;
    }
    // FIXME: consolidate into a single message
    MSG.WriteByte(client.message, Protocol.svc.updatename);
    MSG.WriteByte(client.message, num);
    MSG.WriteByte(client.message, 0);
    MSG.WriteByte(client.message, Protocol.svc.updatefrags);
    MSG.WriteByte(client.message, num);
    MSG.WriteShort(client.message, 0);
    MSG.WriteByte(client.message, Protocol.svc.updatecolors);
    MSG.WriteByte(client.message, num);
    MSG.WriteByte(client.message, 0);
    MSG.WriteByte(client.message, Protocol.svc.updatepings);
    MSG.WriteByte(client.message, num);
    MSG.WriteShort(client.message, 0);
  }
};

Host.ShutdownServer = function(isCrashShutdown) { // TODO: SV duties
  if (SV.server.active !== true) {
    return;
  }
  SV.server.active = false;
  if (!Host.dedicated.value && CL.cls.state === CL.active.connected) {
    CL.Disconnect();
  }
  const start = Sys.FloatTime(); let count; let i;
  do {
    count = 0;
    for (i = 0; i < SV.svs.maxclients; ++i) {
      Host.client = SV.svs.clients[i];
      if ((Host.client.active !== true) || (Host.client.message.cursize === 0)) {
        continue;
      }
      if (NET.CanSendMessage(Host.client.netconnection) === true) {
        NET.SendMessage(Host.client.netconnection, Host.client.message);
        Host.client.message.clear();
        continue;
      }
      NET.GetMessage(Host.client.netconnection);
      ++count;
    }
    if ((Sys.FloatTime() - start) > 3.0) {
      break;
    }
  } while (count !== 0);
  // const buf = {data: new ArrayBuffer(4), cursize: 1};
  // (new Uint8Array(buf.data))[0] = Protocol.svc.disconnect;
  // count = NET.SendToAll(buf);
  // if (count !== 0) {
  //   Con.Print('Host.ShutdownServer: NET.SendToAll failed for ' + count + ' clients\n');
  // }
  for (i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if (client.active) {
      Host.DropClient(client, isCrashShutdown, 'Server shutting down');
    }
  }
  SV.ShutdownServer(isCrashShutdown);
};

Host.WriteConfiguration = function() {
  Host.ScheduleInFuture('Host.WriteConfiguration', () => {
    COM.WriteTextFile('config.cfg', (!Host.dedicated.value ? Key.WriteBindings() + '\n\n\n': '') + Cvar.WriteVariables());
    Con.DPrint('Wrote configuration\n');
  }, 5.000);
};

Host.WriteConfiguration_f = function() {
  Con.Print('Writing configuration\n');
  Host.WriteConfiguration();
};

Host.ServerFrame = function() { // TODO: SV duties
  SV.server.gameAPI.frametime = Host.frametime;
  SV.server.datagram.clear();
  SV.CheckForNewClients();
  SV.RunClients();
  if ((SV.server.paused !== true) && ((SV.svs.maxclients >= 2) || (!Host.dedicated.value && Key.dest.value === Key.dest.game))) {
    SV.Physics();
  }
  SV.RunScheduledGameCommands();
  SV.SendClientMessages();
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

Host.time3 = 0.0;
Host._Frame = function() {
  // Math.random();

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
    callback();
  }

  // check what’s scheduled in future
  for (const [name, { time, callback }] of Host._scheduleInFuture.entries()) {
    if (time > Host.realtime) {
      continue;
    }

    callback();
    Host._scheduleInFuture.delete(name);
  }

  if (Host.dedicated.value) {
    Cmd.Execute();

    if (SV.server.active === true) {
      Host.ServerFrame();
    }

    // TODO: add times

    ++Host.framecount;

    return;
  }

  if (CL.cls.state === CL.active.connecting) {
    NET.CheckForResend();
    SCR.UpdateScreen();
    return;
  }

  let time1; let time2; let pass1; let pass2; let pass3; let tot;

  Cmd.Execute();

  if (CL.cls.state === CL.active.connected) {
    CL.ReadFromServer();
  }

  CL.SendCmd();

  if (SV.server.active === true) {
    Host.ServerFrame();
  }

  // Set up prediction for other players
  CL.SetUpPlayerPrediction(false);

  // do client side motion prediction
  CL.PredictMove();

  // Set up prediction for other players
  CL.SetUpPlayerPrediction(true);

  // build a refresh entity list
  CL.EmitEntities();

  if (Host.speeds.value !== 0) {
    time1 = Sys.FloatTime();
  }
  SCR.UpdateScreen();
  // FIXME: time2 is no longer accurrate, because SCR.UpdateScreen uses requestAnimationFrame to render at the next best opportunity
  if (Host.speeds.value !== 0) {
    time2 = Sys.FloatTime();
  }

  if (CL.cls.signon === 4) {
    S.Update(R.refdef.vieworg, R.vpn, R.vright, R.vup);
    CL.DecayLights();
  } else {
    S.Update(Vector.origin, Vector.origin, Vector.origin, Vector.origin);
  }
  CDAudio.Update();

  if (Host.speeds.value !== 0) {
    pass1 = (time1 - Host.time3) * 1000.0;
    Host.time3 = Sys.FloatTime();
    pass2 = (time2 - time1) * 1000.0;
    pass3 = (Host.time3 - time2) * 1000.0;
    tot = Math.floor(pass1 + pass2 + pass3);
    Con.Print((tot <= 99 ? (tot <= 9 ? '  ' : ' ') : '') +
			tot + ' tot ' +
			(pass1 < 100.0 ? (pass1 < 10.0 ? '  ' : ' ') : '') +
			Math.floor(pass1) + ' server ' +
			(pass2 < 100.0 ? (pass2 < 10.0 ? '  ' : ' ') : '') +
			Math.floor(pass2) + ' gfx ' +
			(pass3 < 100.0 ? (pass3 < 10.0 ? '  ' : ' ') : '') +
			Math.floor(pass3) + ' snd\n');
  }

  if (Host.startdemos === true) {
    CL.NextDemo();
    Host.startdemos = false;
  }

  ++Host.framecount;
};

Host.timetotal = 0.0;
Host.timecount = 0;
Host.Frame = function() {
  if (Host.serverprofile.value === 0) {
    Host._Frame();
    return;
  }
  const time1 = Sys.FloatTime();
  Host._Frame();
  Host.timetotal += Sys.FloatTime() - time1;
  if (++Host.timecount <= 999) {
    return;
  }
  const m = (Host.timetotal * 1000.0 / Host.timecount) >> 0;
  Host.timecount = 0;
  Host.timetotal = 0.0;
  let i; let c = 0;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    if (SV.svs.clients[i].active === true) {
      ++c;
    }
  }
  Con.Print('serverprofile: ' + (c <= 9 ? ' ' : '') + c + ' clients ' + (m <= 9 ? ' ' : '') + m + ' msec\n');
};

Host.Init = async function(dedicated) {
  Host.oldrealtime = Sys.FloatTime();
  Cmd.Init();
  Cvar.Init();

  V.Init(); // required for V.CalcRoll

  if (!dedicated) {
    Chase.Init();
  }

  await COM.Init();
  Host.InitLocal(dedicated);

  if (!dedicated) {
    Key.Init();
  }

  Con.Init();
  await PR.Init();
  Mod.Init();
  NET.Init();
  SV.Init();
  Shack.Init();

  if (!dedicated) {
    S.Init();
    await VID.Init();
    await Draw.Init();
    await R.Init();
    await M.Init();
    await CL.Init();
    SCR.Init();
    CDAudio.Init();
    Sbar.Init();
    IN.Init();
  } else {
    // we need a few frontend things for dedicated
    await R.Init();
  }

  Cmd.text = 'exec better-quake.rc\n' + Cmd.text;

  Host.initialized = true;
  Sys.Print('========Quake Initialized=========\n');

  if (dedicated) {
    return;
  }

  try {
    if (parent.saveGameToUpload!=null) {
      const name = COM.DefaultExtension('s0', '.sav');
      COM.WriteTextFile(name, parent.saveGameToUpload);
    }
  } catch (err) {
    Con.DPrint(err);
  }
};

Host.Shutdown = function() {
  if (Host.isdown === true) {
    Sys.Print('recursive shutdown\n');
    return;
  }
  Host.isdown = true;
  Host.WriteConfiguration();
  if (!Host.dedicated.value) {
    S.Shutdown();
    CDAudio.Stop();
  }
  NET.Shutdown();
  if (!Host.dedicated.value) {
    IN.Shutdown();
    VID.Shutdown();
  }
  Cmd.Shutdown();
  Cvar.Shutdown();
};

// Commands

Host.Quit_f = function() {
  if (!Host.dedicated.value) {
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
  let print;
  if (!this.client) {
    if (!SV.server.active) {
      this.forward();
      return;
    }
    print = Con.Print;
  } else {
    print = Host.ClientPrint;
  }
  print('hostname: ' + NET.hostname.string + '\n');
  print('version : ' + Def.version + '\n');
  print('map     : ' + SV.server.gameAPI.mapname + '\n');
  print('edicts  : ' + SV.server.num_edicts + ' used of ' + SV.server.edicts.length + ' max\n');
  print('players : ' + NET.activeconnections + ' active (' + SV.svs.maxclients + ' max)\n\n');

  print('# userid name                uniqueid            connected ping loss state  adr\n');

  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if (!client.active) {
      continue;
    }

    let seconds = Math.floor(NET.time - client.netconnection.connecttime);
    let minutes = Math.floor(seconds / 60);
    let hours = 0;
    if (minutes > 0) {
      seconds -= minutes * 60;
      hours = Math.floor(minutes / 60);
      if (hours !== 0) {
        minutes -= hours * 60;
      }
    }

    const parts = [
      '#',
      client.num.toString().padStart(6),
      client.name.substring(0, 19).padEnd(19),
      client.uniqueId.substring(0, 19).padEnd(19),
      `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`.padEnd(9),
      client.ping.toString().padStart(4),
      '0   ',
      'active',
      client.netconnection.address,
    ];

    print(parts.join(' ') + '\n');
  }
};

Host.God_f = function() {
  if (this.forward()) {
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  SV.player.entity.flags ^= SV.fl.godmode;
  if ((SV.player.entity.flags & SV.fl.godmode) === 0) {
    Host.ClientPrint('godmode OFF\n');
  } else {
    Host.ClientPrint('godmode ON\n');
  }
};

Host.Notarget_f = function() {
  if (this.forward()) {
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  SV.player.entity.flags ^= SV.fl.notarget;
  if ((SV.player.entity.flags & SV.fl.notarget) === 0) {
    Host.ClientPrint('notarget OFF\n');
  } else {
    Host.ClientPrint('notarget ON\n');
  }
};

Host.Noclip_f = function() {
  if (this.forward()) {
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  if (SV.player.entity.movetype !== SV.movetype.noclip) {
    Host.noclip_anglehack = true;
    SV.player.entity.movetype = SV.movetype.noclip;
    Host.ClientPrint('noclip ON\n');
    return;
  }
  Host.noclip_anglehack = false;
  SV.player.entity.movetype = SV.movetype.walk;
  Host.ClientPrint('noclip OFF\n');
};

Host.Fly_f = function() {
  if (this.forward()) {
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  if (SV.player.entity.movetype !== SV.movetype.fly) {
    SV.player.entity.movetype = SV.movetype.fly;
    Host.ClientPrint('flymode ON\n');
    return;
  }
  SV.player.entity.movetype = SV.movetype.walk;
  Host.ClientPrint('flymode OFF\n');
};

Host.Ping_f = function() {
  if (this.forward()) {
    return;
  }
  Host.ClientPrint('Client ping times:\n');
  let i; let client; let total; let j;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    if (client.active !== true) {
      continue;
    }
    total = 0;
    for (j = 0; j <= 15; ++j) {
      total += client.ping_times[j];
    }
    total = (total * 62.5).toFixed(0);
    if (total.length === 1) {
      total = '   ' + total;
    } else if (total.length === 2) {
      total = '  ' + total;
    } else if (total.length === 3) {
      total = ' ' + total;
    }
    Host.ClientPrint(total + ' ' + client.name + '\n');
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
  if (!SV.HasMap(mapname)) {
    Con.Print(`No such map: ${mapname}\n`);
    return;
  }
  if (!Host.dedicated.value) {
    CL.cls.demonum = -1;
    CL.Disconnect();
  }
  Host.ShutdownServer(); // CR: this is the reason why you would need to use changelevel on Counter-Strike 1.6 etc.
  if (!Host.dedicated.value) {
    Key.dest.value = Key.dest.game;
    SCR.BeginLoadingPlaque();
  }
  SV.svs.serverflags = 0;

  if (!Host.dedicated.value) {
    CL.SetConnectingStep(5, 'Spawning server');
  }

  if (!Host.dedicated.value) {
    CL.cls.spawnparms = spawnparms.join(' ');
  }

  Host.ScheduleForNextFrame(() => {
    SV.SpawnServer(mapname);

    if (!Host.dedicated.value) {
      CL.SetConnectingStep(null, null);
    }

    if (SV.server.active !== true) {
      return;
    }

    if (!Host.dedicated.value) {
      Cmd.ExecuteString('connect local');
    }
  });
};

Host.Changelevel_f = function(mapname) {
  if (mapname === undefined) {
    Con.Print('Usage: changelevel <levelname>\n');
    return;
  }

  if (!SV.server.active || (!Host.dedicated.value && CL.cls.demoplayback)) {
    Con.Print('Only the server may changelevel\n');
    return;
  }

  if (!SV.HasMap(mapname)) {
    Con.Print(`No such map: ${mapname}\n`);
    return;
  }

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (!client.active || !client.spawned) {
      continue;
    }
    MSG.WriteByte(client.message, Protocol.svc.changelevel);
    MSG.WriteString(client.message, mapname);
  }

  Host.ScheduleForNextFrame(() => {
    SV.SaveSpawnparms();
    SV.SpawnServer(mapname);
    if (!Host.dedicated.value) {
      CL.SetConnectingStep(null, null);
    }
  });
};

Host.Restart_f = function() {
  if ((SV.server.active) && (Host.dedicated.value || !CL.cls.demoplayback && !this.client)) {
    Cmd.ExecuteString(`map ${SV.server.gameAPI.mapname}`);
  }
};

Host.Reconnect_f = function() {
  if (Host.dedicated.value) {
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

  if (Host.dedicated.value) {
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
    CL.EstablishConnection(url.host + url.pathname + (!url.pathname.endsWith('/') ? '/' : '') + 'api/');
  } else {
    CL.EstablishConnection(address);
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
  if (client.active === true) {
    if (client.edict.entity.health <= 0.0) {
      Con.PrintWarning('Can\'t savegame with a dead player\n');
      return;
    }
  }

  const gamestate = {
    version: 1,
    gameversion: SV.server.gameVersion,
    comment: CL.state.levelname, // TODO: ask the game for a comment
    spawn_parms: client.spawn_parms,
    current_skill: Host.current_skill,
    mapname: SV.server.gameAPI.mapname,
    time: SV.server.time,
    lightstyles: SV.server.lightstyles,
    globals: null,
    edicts: [],
    num_edicts: SV.server.num_edicts,
  };

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

Host.Loadgame_f = function (savename) {
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
  const data = COM.LoadTextFile(name);
  if (data == null) {
    Con.PrintError('ERROR: couldn\'t open.\n');
    return;
  }

  const gamestate = JSON.parse(data);

  if (gamestate.version !== 1) {
    Host.Error(`Savegame is version ${gamestate.version}, not 1\n`);
    return;
  }

  Host.current_skill = gamestate.current_skill;
  Cvar.SetValue('skill', Host.current_skill);

  CL.Disconnect();
  SV.SpawnServer(gamestate.mapname);

  if (!SV.server.active) {
    if (!Host.dedicated.value) {
      CL.SetConnectingStep(null, null);
    }
    Host.Error(`Couldn't load map: ${gamestate.mapname}\n`);
    return;
  }

  if (gamestate.gameversion !== SV.server.gameVersion) {
    SV.ShutdownServer(false);
    Host.Error(`Game is version ${gamestate.gameversion}, not ${SV.server.gameVersion}\n`);
    return;
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

  CL.EstablishConnection('local');
  Host.Reconnect_f();
};

Host.Name_f = function(...names) { // signon 2, step 1
  Con.DPrint(`Host.Name_f: ${this.client}\n`);
  if (names.length < 1) {
    Con.Print('"name" is "' + CL.name.string + '"\n');
    return;
  }

  let newName = names.join(' ').trim().substring(0, 15);

  if (!Host.dedicated.value && !this.client) {
    Cvar.Set('_cl_name', newName);
    if (CL.cls.state === CL.active.connected) {
      this.forward();
    }
    return;
  }

  const initialNewName = newName;
  let newNameCounter = 2;

  // make sure we have a somewhat unique name
  while (SV.FindClientByName(newName)) {
    newName = `${initialNewName}${newNameCounter++}`;
  }

  const name = Host.client.name;
  if (Host.dedicated.value && name && (name.length !== 0) && (name !== 'unconnected') && (name !== newName)) {
    Con.Print(name + ' renamed to ' + newName + '\n');
  }

  Host.client.name = newName;
  const msg = SV.server.reliable_datagram;
  MSG.WriteByte(msg, Protocol.svc.updatename);
  MSG.WriteByte(msg, Host.client.num);
  MSG.WriteString(msg, newName);
};

Host.Version_f = function() {
  Con.Print('Version ' + Def.version + '\n');
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

  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if ((client.active !== true) || (client.spawned !== true)) {
      continue;
    }
    if ((Host.teamplay.value !== 0) && (teamonly === true) && (client.entity.team !== save.entity.team)) {
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
  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if ((client.active !== true) || (client.spawned !== true)) {
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

  if (!this.client) {
    Cvar.SetValue('_cl_color', playercolor);
    if (CL.cls.state === CL.active.connected) {
      this.forward();
    }
    return;
  }

  Host.client.colors = playercolor;
  Host.client.edict.entity.team = bottom + 1;
  const msg = SV.server.reliable_datagram;
  MSG.WriteByte(msg, Protocol.svc.updatecolors);
  MSG.WriteByte(msg, Host.client.num);
  MSG.WriteByte(msg, playercolor);
};

Host.Kill_f = function() {
  if (this.forward()) {
    return;
  }

  if (SV.player.entity.health <= 0.0) {
    Host.ClientPrint('Can\'t suicide -- already dead!\n');
    return;
  }

  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.ClientKill(SV.player);
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
  MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.setpause);
  MSG.WriteByte(SV.server.reliable_datagram, SV.server.paused === true ? 1 : 0);
};

Host.PreSpawn_f = function() { // signon 1, step 1
  Con.DPrint(`Host.PreSpawn_f: ${this.client}\n`);
  if (!this.client) {
    Con.Print('prespawn is not valid from the console\n');
    return;
  }
  const client = Host.client;
  if (client.spawned) {
    Con.Print('prespawn not valid -- already spawned\n');
    return;
  }
  // CR: SV.server.signon is a special buffer that is used to send the signon messages (make static as well as baseline information)
  client.message.write(new Uint8Array(SV.server.signon.data), SV.server.signon.cursize);
  MSG.WriteByte(client.message, Protocol.svc.signonnum);
  MSG.WriteByte(client.message, 2);
  client.sendsignon = true;
};

Host.Spawn_f = function() { // signon 2, step 3
  Con.DPrint(`Host.Spawn_f: ${this.client}\n`);
  if (!this.client) {
    Con.Print('spawn is not valid from the console\n');
    return;
  }
  let client = Host.client;
  if (client.spawned) {
    Con.Print('Spawn not valid -- already spawned\n');
    return;
  }

  let i;

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
    for (i = 0; i <= 15; ++i) {
      SV.server.gameAPI[`parm${i + 1}`] = client.spawn_parms[i];
    }
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.ClientConnect(ent);
    if ((Sys.FloatTime() - client.netconnection.connecttime) <= SV.server.time) {
      Sys.Print(client.name + ' entered the game\n');
    }
    SV.server.gameAPI.PutClientInServer(ent);
  }

  const message = client.message;
  message.clear();
  MSG.WriteByte(message, Protocol.svc.time);
  MSG.WriteFloat(message, SV.server.time);
  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    MSG.WriteByte(message, Protocol.svc.updatename);
    MSG.WriteByte(message, i);
    MSG.WriteString(message, client.name);
    MSG.WriteByte(message, Protocol.svc.updatefrags);
    MSG.WriteByte(message, i);
    MSG.WriteShort(message, client.old_frags);
    MSG.WriteByte(message, Protocol.svc.updatecolors);
    MSG.WriteByte(message, i);
    MSG.WriteByte(message, client.colors);
  }
  for (i = 0; i <= 63; ++i) {
    MSG.WriteByte(message, Protocol.svc.lightstyle);
    MSG.WriteByte(message, i);
    MSG.WriteString(message, SV.server.lightstyles[i]);
  }
  MSG.WriteByte(message, Protocol.svc.updatestat);
  MSG.WriteByte(message, Def.stat.totalsecrets);
  MSG.WriteLong(message, SV.server.gameAPI.total_secrets);
  MSG.WriteByte(message, Protocol.svc.updatestat);
  MSG.WriteByte(message, Def.stat.totalmonsters);
  MSG.WriteLong(message, SV.server.gameAPI.total_monsters);
  MSG.WriteByte(message, Protocol.svc.updatestat);
  MSG.WriteByte(message, Def.stat.secrets);
  MSG.WriteLong(message, SV.server.gameAPI.found_secrets);
  MSG.WriteByte(message, Protocol.svc.updatestat);
  MSG.WriteByte(message, Def.stat.monsters);
  MSG.WriteLong(message, SV.server.gameAPI.killed_monsters);
  MSG.WriteByte(message, Protocol.svc.setangle);
  const angles = ent.entity.angles;
  MSG.WriteAngle(message, angles[0]);
  MSG.WriteAngle(message, angles[1]);
  MSG.WriteAngle(message, 0.0);
  SV.WriteClientdataToMessage(ent, message);
  MSG.WriteByte(message, Protocol.svc.signonnum);
  MSG.WriteByte(message, 3);
  Host.client.sendsignon = true;
};

Host.Begin_f = function() {  // signon 3, step 1
  Con.DPrint(`Host.Begin_f: ${this.client}\n`);
  if (!this.client) {
    Con.Print('begin is not valid from the console\n');
    return;
  }
  this.client.spawned = true;
};

Host.Kick_f = function(...argv) { // FIXME: Host.client
  if (!this.client) {
    if (!SV.server.active) {
      this.forward();
      return;
    }
  } else if (SV.server.gameAPI.deathmatch !== 0.0) {
    return;
  }
  if (argv.length <= 1) {
    return;
  }
  const save = Host.client;
  const s = argv[1].toLowerCase();
  let i; let byNumber;
  if ((argv.length >= 3) && (s === '#')) {
    i = Q.atoi(argv[2]) - 1;
    if ((i < 0) || (i >= SV.svs.maxclients)) {
      return;
    }
    if (SV.svs.clients[i].active !== true) {
      return;
    }
    Host.client = SV.svs.clients[i];
    byNumber = true;
  } else {
    for (i = 0; i < SV.svs.maxclients; ++i) {
      Host.client = SV.svs.clients[i];
      if (Host.client.active !== true) {
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
    if (Host.dedicated.value) {
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
  if (message != null) {
    let p = 0;
    if (byNumber === true) {
      ++p;
      for (; p < message.length; ++p) {
        if (message.charCodeAt(p) !== 32) {
          break;
        }
      }
      p += argv[2].length;
    }
    for (; p < message.length; ++p) {
      if (message.charCodeAt(p) !== 32) {
        break;
      }
    }
    dropReason = 'Kicked by ' + who + ': ' + message.substring(p);
  }
  Host.DropClient(Host.client, false, dropReason);
  Host.client = save;
};

Host.Give_f = function(classname) {
  // CR:  commented this out for now, it’s only noise…
  //      unsure if I want a “give item_shells” approach or
  //      if I want to push this piece of code into PR/PF and let
  //      the game handle this instead

  if (this.forward()) {
    return;
  }

  if (SV.server.gameAPI.deathmatch !== 0) {
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

    const trace = Game.EngineInterface.Traceline(start, end, false, player, mins, maxs);

    const origin = trace.point.subtract(forward.multiply(16.0)).add(new Vector(0.0, 0.0, 16.0));

    if (![Mod.contents.empty, Mod.contents.water].includes(Game.EngineInterface.DeterminePointContents(origin))) {
      Host.ClientPrint('Item would spawn out of world!\n');
      return;
    }

    Game.EngineInterface.SpawnEntity(classname, {
      origin,
    });
  });
  // /* old code below, should be handled by either the server game or client game */
  // if ((t >= 48) && (t <= 57)) {
  //   if (COM.hipnotic !== true) {
  //     if (t >= 50) {
  //       ent.entity.items |= Def.it.shotgun << (t - 50);
  //     }
  //     return;
  //   }
  //   if (t === 54) {
  //     if (Cmd.argv[1].charCodeAt(1) === 97) {
  //       ent.entity.items |= Def.hit.proximity_gun;
  //     } else {
  //       ent.entity.items |= Def.it.grenade_launcher;
  //     }
  //     return;
  //   }
  //   if (t === 57) {
  //     ent.entity.items |= Def.hit.laser_cannon;
  //   } else if (t === 48) {
  //     ent.entity.items |= Def.hit.mjolnir;
  //   } else if (t >= 50) {
  //     ent.entity.items |= Def.it.shotgun << (t - 50);
  //   }
  //   return;
  // }
  // const v = Q.atoi(Cmd.argv[2]);
  // if (t === 104) {
  //   ent.entity.health = v;
  //   return;
  // }
  // if (COM.rogue !== true) {
  //   switch (t) {
  //     case 115:
  //       ent.entity.ammo_shells = v;
  //       return;
  //     case 110:
  //       ent.entity.ammo_nails = v;
  //       return;
  //     case 114:
  //       ent.entity.ammo_rockets = v;
  //       return;
  //     case 99:
  //       ent.entity.ammo_cells = v;
  //   }
  //   return;
  // }
  // switch (t) {
  //   case 115:
  //     if (PR.entvars.ammo_shells1 != null) {
  //       ent.v_float[PR.entvars.ammo_shells1] = v;
  //       ent.entity.ammo_shells1
  //     }
  //     ent.entity.ammo_shells = v;
  //     return;
  //   case 110:
  //     if (PR.entvars.ammo_nails1 != null) {
  //       ent.v_float[PR.entvars.ammo_nails1] = v;
  //       if (ent.entity.weapon <= Def.it.lightning) {
  //         ent.entity.ammo_nails = v;
  //       }
  //     }
  //     return;
  //   case 108:
  //     if (PR.entvars.ammo_lava_nails != null) {
  //       ent.entity.ammo_lava_nails = v;
  //       if (ent.entity.weapon > Def.it.lightning) {
  //         ent.entity.ammo_nails = v;
  //       }
  //     }
  //     return;
  //   case 114:
  //     if (PR.entvars.ammo_rockets1 != null) {
  //       ent.v_float[PR.entvars.ammo_rockets1] = v;
  //       if (ent.entity.weapon <= Def.it.lightning) {
  //         ent.entity.ammo_rockets = v;
  //       }
  //     }
  //     return;
  //   case 109:
  //     if (PR.entvars.ammo_multi_rockets != null) {
  //       ent.entity.ammo_multi_rockets = v;
  //       if (ent.entity.weapon > Def.it.lightning) {
  //         ent.entity.ammo_rockets = v;
  //       }
  //     }
  //     return;
  //   case 99:
  //     if (PR.entvars.ammo_cells1 != null) {
  //       ent.v_float[PR.entvars.ammo_cells1] = v;
  //       if (ent.entity.weapon <= Def.it.lightning) {
  //         ent.entity.ammo_cells = v;
  //       }
  //     }
  //     return;
  //   case 112:
  //     if (PR.entvars.ammo_plasma != null) {
  //       ent.entity.ammo_plasma = v;
  //       if (ent.entity.weapon > Def.it.lightning) {
  //         ent.entity.ammo_cells = v;
  //       }
  //     }
  // }
};

Host.FindViewthing = function() {
  if (SV.server.active) {
    for (let i = 0; i < SV.server.num_edicts; ++i) {
      const e = SV.server.edicts[i];
      if (!e.isFree() && e.entity.classname === 'viewthing') {
        return e;
      }
    }
  }
  Con.Print('No viewthing on map\n');
  return null;
};

Host.Viewmodel_f = function(model) {
  if (model === undefined) {
    Con.Print('Usage: viewmodel <model>\n');
    return;
  }
  const ent = Host.FindViewthing();
  if (ent == null) {
    return;
  }
  const m = Mod.ForName(model);
  if (m == null) {
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
  if (ent == null) {
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
  if (ent == null) {
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
  if (ent == null) {
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

Host.Startdemos_f = function(...demos) {
  if (Host.dedicated.value) {
    Con.Print('cannot play demos in dedicated server mode\n');
    return;
  }
  if (demos.length === 0) {
    Con.Print('Usage: startdemos <demo1> <demo2> ...\n');
    return;
  }
  Con.Print(demos.length + ' demo(s) in loop\n');
  CL.cls.demos = [...demos];
  if ((CL.cls.demonum !== -1) && (CL.cls.demoplayback !== true)) {
    CL.cls.demonum = 0;
    if (Host.framecount !== 0) {
      CL.NextDemo();
    } else {
      Host.startdemos = true;
    }
  } else {
    CL.cls.demonum = -1;
  }
};

Host.Demos_f = function() {
  if (CL.cls.demonum === -1) {
    CL.cls.demonum = 1;
  }
  CL.Disconnect();
  CL.NextDemo();
};

Host.Stopdemo_f = function() {
  if (CL.cls.demoplayback !== true) {
    return;
  }
  CL.StopPlayback();
  CL.Disconnect();
};

Host.InitCommands = function(dedicated) {
  if (dedicated) { // TODO: move this to a dedicated stub for IN
    Cmd.AddCommand('bind', () => {});
    Cmd.AddCommand('unbind', () => {});
    Cmd.AddCommand('unbindall', () => {});
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
  Cmd.AddCommand('version', Host.Version_f);
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
  Cmd.AddCommand('load', Host.Loadgame_f);
  Cmd.AddCommand('save', Host.Savegame_f);
  Cmd.AddCommand('give', Host.Give_f);
  Cmd.AddCommand('startdemos', Host.Startdemos_f);
  Cmd.AddCommand('demos', Host.Demos_f);
  Cmd.AddCommand('stopdemo', Host.Stopdemo_f);
  Cmd.AddCommand('viewmodel', Host.Viewmodel_f);
  Cmd.AddCommand('viewframe', Host.Viewframe_f);
  Cmd.AddCommand('viewnext', Host.Viewnext_f);
  Cmd.AddCommand('viewprev', Host.Viewprev_f);
  Cmd.AddCommand('mcache', Mod.Print);
  Cmd.AddCommand('writeconfig', Host.WriteConfiguration_f);
};
