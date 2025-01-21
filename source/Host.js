/* global Host, Con, Mod, COM, Host, CL, Cmd, Cvar, Vector, S, Q, NET, MSG, Protocol, SV, SCR, R, Chase, IN, Sys, Def, V, CDAudio, Sbar, Draw, VID, M, PR, Key, W, ED, SZ, Shack, Game */

// eslint-disable-next-line no-global-assign
Host = {};

Host.framecount = 0;

Host.EndGame = function(message) {
  Con.Print('Host.EndGame: ' + message + '\n');
  if (CL.cls.demonum !== -1) {
    CL.NextDemo();
  } else {
    CL.Disconnect();
  }
  M.Alert('Host.EndGame', message);
};

Host.Error = function(error) {
  if (Host.inerror === true) {
    Sys.Error('Host.Error: recursively entered');
  }
  Host.inerror = true;
  SCR.EndLoadingPlaque();
  Con.Print('Host.Error: ' + error + '\n');
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
    SV.svs.clients.push({ // TODO: Client class
      num: i,
      message: {data: new ArrayBuffer(8000), cursize: 0, allowoverflow: true},
      colors: 0,
      old_frags: 0,
      last_ping_update: 0,
      netconnection: null,
      name: '', // must be an empty string, otherwise Sbar is going to bug out
      edict: null, // connected to an edict upon server spawn

      clear() {
        this.edict = null;
        this.netconnection = null;
        this.message.cursize = 0;
        this.message.allowoverflow = false;
        this.colors = 0;
        this.old_frags = 0;
        this.last_ping_update = 0;
        this.active = false;
        this.name = '';
      },

      consolePrint(message) {
        MSG.WriteByte(this.message, Protocol.svc.print);
        MSG.WriteString(this.message, message);
      },

      centerPrint(message) {
        MSG.WriteByte(this.message, Protocol.svc.centerprint);
        MSG.WriteString(this.message, message);
      },

      sendConsoleCommands(commandline) {
        MSG.WriteByte(this.message, Protocol.svc.stufftext);
        MSG.WriteString(this.message, commandline);
      }
    });
  }
  Cvar.SetValue('deathmatch', 0);
};

Host.InitLocal = function(dedicated) {
  Host.InitCommands();
  Host.framerate = Cvar.RegisterVariable('host_framerate', '0');
  Host.speeds = Cvar.RegisterVariable('host_speeds', '0');
  Host.ticrate = Cvar.RegisterVariable('sys_ticrate', '0.05');
  Host.serverprofile = Cvar.RegisterVariable('serverprofile', '0');
  Host.fraglimit = Cvar.RegisterVariable('fraglimit', '0', false, true);
  Host.timelimit = Cvar.RegisterVariable('timelimit', '0', false, true);
  Host.teamplay = Cvar.RegisterVariable('teamplay', '0', false, true);
  Host.samelevel = Cvar.RegisterVariable('samelevel', '0');
  Host.noexit = Cvar.RegisterVariable('noexit', '0', false, true);
  Host.skill = Cvar.RegisterVariable('skill', '1');
  Host.developer = Cvar.RegisterVariable('developer', '0');
  Host.deathmatch = Cvar.RegisterVariable('deathmatch', '0');
  Host.coop = Cvar.RegisterVariable('coop', '0');
  Host.pausable = Cvar.RegisterVariable('pausable', '1');
  Host.temp1 = Cvar.RegisterVariable('temp1', '0');

  // dedicated server settings
  Host.dedicated = Cvar.RegisterVariable('dedicated', dedicated ? '1' : '0', false, true);

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
  let i; let client;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    if ((client.active !== true) || (client.spawned !== true)) {
      continue;
    }
    MSG.WriteByte(client.message, Protocol.svc.print);
    MSG.WriteString(client.message, string);
  }
};

Host.DropClient = function(client, crash, reason) {
  if (NET.CanSendMessage(client.netconnection) === true) {
    MSG.WriteByte(client.message, Protocol.svc.disconnect);
    MSG.WriteString(client.message, reason);
    NET.SendMessage(client.netconnection, client.message);
  }

  if (!crash) {
    if ((client.edict != null) && (client.spawned === true)) {
      const saveSelf = SV.server.gameAPI.self;
      SV.server.gameAPI.ClientDisconnect(client.edict);
      SV.server.gameAPI.self = saveSelf;
    }
    Sys.Print('Client ' + SV.GetClientName(client) + ' removed\n');
  }

  NET.Close(client.netconnection);

  client.netconnection = null;
  client.active = false;
  SV.SetClientName(client, '');
  client.old_frags = -999999;

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
        Host.client.message.cursize = 0;
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
  COM.WriteTextFile('config.cfg', (!Host.dedicated.value ? Key.WriteBindings() : '') + Cvar.WriteVariables());
};

Host.WriteConfiguration_f = function() {
  Con.Print('Writing configuration\n');
  Host.WriteConfiguration();
};

Host.ServerFrame = function() {
  SV.server.gameAPI.frametime = Host.frametime;
  SV.server.datagram.cursize = 0;
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
}

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

  while (Host._scheduledForNextFrame.length > 0) {
    const callback = Host._scheduledForNextFrame.shift();
    callback();
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

  CL.SendCmd();
  if (SV.server.active === true) {
    Host.ServerFrame();
  }

  if (CL.cls.state === CL.active.connected) {
    CL.ReadFromServer();
  }

  // TODO: add prediction code for player movements

  if (Host.speeds.value !== 0) {
    time1 = Sys.FloatTime();
  }
  SCR.UpdateScreen();
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

  V.Init(); // required for V.CalcRoll

  if (!dedicated) {
    Chase.Init();
  }

  await COM.Init();
  Host.InitLocal(dedicated);

  await W.LoadWadFile('gfx.wad');

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
    await VID.Init();
    await Draw.Init();
    SCR.Init();
    R.Init();
    S.Init();
    await M.Init();
    CDAudio.Init();
    Sbar.Init();
    CL.Init();
    IN.Init();
  } else {
    // we need a few frontend things for dedicated
    R.Init();
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
  if (Cmd.client !== true) {
    if (SV.server.active !== true) {
      Cmd.ForwardToServer();
      return;
    }
    print = Con.Print;
  } else {
    print = Host.ClientPrint;
  }
  print('host:    ' + NET.hostname.string + '\n');
  print('version: ' + Def.version + '\n');
  print('map:     ' + SV.server.gameAPI.mapname + '\n');
  print('players: ' + NET.activeconnections + ' active (' + SV.svs.maxclients + ' max)\n\n');
  let client; let str; let frags; let hours; let minutes; let seconds;
  for (let i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    if (!client.active) {
      continue;
    }
    frags = client.edict.api.frags.toFixed(0);
    if (frags.length === 1) {
      frags = '  ' + frags;
    } else if (frags.length === 2) {
      frags = ' ' + frags;
    }
    seconds = (NET.time - client.netconnection.connecttime) >> 0;
    minutes = (seconds / 60) >> 0;
    if (minutes !== 0) {
      seconds -= minutes * 60;
      hours = (minutes / 60) >> 0;
      if (hours !== 0) {
        minutes -= hours * 60;
      }
    } else {
      hours = 0;
    }
    str = '#' + (i + 1) + ' ';
    if (i <= 8) {
      str += ' ';
    }
    str += SV.GetClientName(client);
    for (; str.length <= 21; ) {
      str += ' ';
    }
    str += frags + '  ';
    if (hours <= 9) {
      str += ' ';
    }
    str += hours + ':';
    if (minutes <= 9) {
      str += '0';
    }
    str += minutes + ':';
    if (seconds <= 9) {
      str += '0';
    }
    print(str + seconds + '\n');
    print('    ' + client.netconnection.address + '\n');
  }
};

Host.God_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  SV.player.api.flags ^= SV.fl.godmode;
  if ((SV.player.api.flags & SV.fl.godmode) === 0) {
    Host.ClientPrint('godmode OFF\n');
  } else {
    Host.ClientPrint('godmode ON\n');
  }
};

Host.Notarget_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  SV.player.api.flags ^= SV.fl.notarget;
  if ((SV.player.api.flags & SV.fl.notarget) === 0) {
    Host.ClientPrint('notarget OFF\n');
  } else {
    Host.ClientPrint('notarget ON\n');
  }
};

Host.Noclip_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  if (SV.player.api.movetype !== SV.movetype.noclip) {
    Host.noclip_anglehack = true;
    SV.player.api.movetype = SV.movetype.noclip;
    Host.ClientPrint('noclip ON\n');
    return;
  }
  Host.noclip_anglehack = false;
  SV.player.api.movetype = SV.movetype.walk;
  Host.ClientPrint('noclip OFF\n');
};

Host.Fly_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }
  if (SV.player.api.movetype !== SV.movetype.fly) {
    SV.player.api.movetype = SV.movetype.fly;
    Host.ClientPrint('flymode ON\n');
    return;
  }
  SV.player.api.movetype = SV.movetype.walk;
  Host.ClientPrint('flymode OFF\n');
};

Host.Ping_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
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
    Host.ClientPrint(total + ' ' + SV.GetClientName(client) + '\n');
  }
};

Host.Map_f = function() {
  if (Cmd.argv.length <= 1) {
    Con.Print('USAGE: map <map>\n');
    return;
  }
  if (Cmd.client === true) {
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

  const mapname = Cmd.argv[1];

  if (!Host.dedicated.value) {
    CL.cls.spawnparms = '';
    for (let i = 2; i < Cmd.argv.length; ++i) {
      CL.cls.spawnparms += Cmd.argv[i] + ' ';
    }
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

Host.Changelevel_f = function() {
  if (Cmd.argv.length !== 2) {
    Con.Print('changelevel <levelname> : continue game on a new level\n');
    return;
  }
  if ((SV.server.active !== true) || (!Host.dedicated.value && CL.cls.demoplayback === true)) {
    Con.Print('Only the server may changelevel\n');
    return;
  }

  const mapname = Cmd.argv[1];

  if (!SV.HasMap(mapname)) {
    Con.Print(`No such map: ${mapname}\n`);
    return;
  }

  if (SV.svs.maxclients > 1) {
    Host.BroadcastPrint(`Changing level to ${mapname}!\n`);
  }

  if (!Host.dedicated.value) {
    CL.SetConnectingStep(5, `Changing level to ${mapname}`);
  } else {
    Con.Print(`Changing level to ${mapname}!\n`);
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
  if ((SV.server.active === true) && (Host.dedicated.value || (CL.cls.demoplayback !== true) && (Cmd.client !== true))) {
    SV.SpawnServer(SV.server.gameAPI.mapname);
  }
};

Host.Reconnect_f = function() {
  if (Host.dedicated.value) {
    Con.Print('cannot reconnect in dedicated server mode\n');
    return;
  }

  SCR.BeginLoadingPlaque();
  CL.cls.signon = 0;
};

Host.Connect_f = function() {
  if (Host.dedicated.value) {
    Con.Print('cannot connect to another server in dedicated server mode\n');
    return;
  }

  CL.cls.demonum = -1;
  if (CL.cls.demoplayback === true) {
    CL.StopPlayback();
    CL.Disconnect();
  }

  if (Cmd.argv[1] === 'self') {
    const url = new URL(location.href);
    CL.EstablishConnection(url.host + url.pathname + (!url.pathname.endsWith('/') ? '/' : '') + 'api/');
  } else {
    CL.EstablishConnection(Cmd.argv[1]);
  }

  CL.cls.signon = 0;
};

Host.SavegameComment = function() {
  let text = CL.state.levelname.replace(/\s/gm, '_');
  let i;
  for (i = CL.state.levelname.length; i <= 21; ++i) {
    text += '_';
  }

  text += 'kills:';
  let kills = CL.state.stats[Def.stat.monsters].toString();
  if (kills.length === 2) {
    text += '_';
  } else if (kills.length === 1) {
    text += '__';
  }
  text += kills + '/';
  kills = CL.state.stats[Def.stat.totalmonsters].toString();
  if (kills.length === 2) {
    text += '_';
  } else if (kills.length === 1) {
    text += '__';
  }
  text += kills;

  return text + '____';
};

Host.Savegame_f = function() {
  if (Cmd.client === true) {
    return;
  }
  if (SV.server.active !== true) {
    Con.Print('Not playing a local game.\n');
    return;
  }
  if (CL.state.intermission !== 0) {
    Con.Print('Can\'t save in intermission.\n');
    return;
  }
  if (SV.svs.maxclients !== 1) {
    Con.Print('Can\'t save multiplayer games.\n');
    return;
  }
  if (Cmd.argv.length !== 2) {
    Con.Print('save <savename> : save a game\n');
    return;
  }
  if (Cmd.argv[1].indexOf('..') !== -1) {
    Con.Print('Relative pathnames are not allowed.\n');
    return;
  }
  const client = SV.svs.clients[0];
  if (client.active === true) {
    if (client.edict.api.health <= 0.0) {
      Con.Print('Can\'t savegame with a dead player\n');
      return;
    }
  }
  const f = ['5\n' + Host.SavegameComment() + '\n'];
  let i;
  for (i = 0; i <= 15; ++i) {
    f[f.length] = client.spawn_parms[i].toFixed(6) + '\n';
  }
  f[f.length] = Host.current_skill + '\n' + SV.server.gameAPI.mapname + '\n' + SV.server.time.toFixed(6) + '\n';
  for (i = 0; i <= 63; ++i) {
    if (SV.server.lightstyles[i].length !== 0) {
      f[f.length] = SV.server.lightstyles[i] + '\n';
    } else {
      f[f.length] = 'm\n';
    }
  }
  f[f.length] = '{\n';
  let def; let type;
  for (i = 0; i < PR.globaldefs.length; ++i) {
    def = PR.globaldefs[i];
    type = def.type;
    if ((type & 0x8000) === 0) {
      continue;
    }
    type &= ~PR.saveglobal;
    if ((type !== PR.etype.ev_string) && (type !== PR.etype.ev_float) && (type !== PR.etype.entity)) {
      continue;
    }
    f[f.length] = '"' + PR.GetString(def.name) + '" "' + PR.UglyValueString(type, PR.globals, def.ofs) + '"\n';
  }
  f[f.length] = '}\n';
  let ed; let j; let name; let v;
  for (i = 0; i < SV.server.num_edicts; ++i) {
    ed = SV.server.edicts[i];
    if (ed.isFree() === true) {
      f[f.length] = '{\n}\n';
      continue;
    }
    f[f.length] = '{\n';
    for (j = 1; j < PR.fielddefs.length; ++j) {
      def = PR.fielddefs[j];
      name = PR.GetString(def.name);
      if (name.charCodeAt(name.length - 2) === 95) {
        continue;
      }
      type = def.type & ~PR.saveglobal;
      v = def.ofs;
      if (ed.v_int[v] === 0) {
        if (type === 3) {
          if ((ed.v_int[v + 1] === 0) && (ed.v_int[v + 2] === 0)) {
            continue;
          }
        } else {
          continue;
        }
      }
      f[f.length] = '"' + name + '" "' + PR.UglyValueString(type, ed.v, def.ofs) + '"\n';
    }
    f[f.length] = '}\n';
  }
  name = COM.DefaultExtension(Cmd.argv[1], '.sav');
  Con.Print('Saving game to ' + name + '...\n');
  if (COM.WriteTextFile(name, f.join('')) === true) {
    Con.Print('done.\n');
  } else {
    Con.Print('ERROR: couldn\'t open.\n');
  }
};

Host.Loadgame_f = function() { // TODO: schedule for next frame, add loading screen
  if (Cmd.client === true) {
    return;
  }
  if (Cmd.argv.length !== 2) {
    Con.Print('load <savename> : load a game\n');
    return;
  }
  CL.cls.demonum = -1;
  const name = COM.DefaultExtension(Cmd.argv[1], '.sav');
  Con.Print('Loading game from ' + name + '...\n');
  let f = COM.LoadTextFile(name);
  if (f == null) {
    Con.Print('ERROR: couldn\'t open.\n');
    return;
  }
  f = f.split('\n');

  let i;

  const tfloat = parseFloat(f[0]);
  if (tfloat !== 5) {
    Con.Print('Savegame is version ' + tfloat + ', not 5\n');
    return;
  }

  const spawn_parms = [];
  for (i = 0; i <= 15; ++i) {
    spawn_parms[i] = parseFloat(f[2 + i]);
  }

  Host.current_skill = (parseFloat(f[18]) + 0.1) >> 0;
  Cvar.SetValue('skill', Host.current_skill);

  const time = parseFloat(f[20]);
  CL.Disconnect();
  SV.SpawnServer(f[19]);
  if (SV.server.active !== true) {
    if (!Host.dedicated.value) {
      CL.SetConnectingStep(null, null);
    }
    Con.Print('Couldn\'t load map\n');
    return;
  }
  SV.server.paused = true;
  SV.server.loadgame = true;

  for (i = 0; i <= 63; ++i) {
    SV.server.lightstyles[i] = f[21 + i];
  }

  let token; let keyname; let key;

  if (f[85] !== '{') {
    Sys.Error('First token isn\'t a brace');
  }
  for (i = 86; i < f.length; ++i) {
    if (f[i] === '}') {
      ++i;
      break;
    }
    token = f[i].split('"');
    keyname = token[1];
    key = ED.FindGlobal(keyname);
    if (key == null) {
      Con.Print('\'' + keyname + '\' is not a global\n');
      continue;
    }
    if (ED.ParseEpair(PR.globals, key, token[3]) !== true) {
      Host.Error('Host.Loadgame_f: parse error');
    }
  }

  f[f.length] = '';
  let entnum = 0; let ent;
  let data = f.slice(i).join('\n');
  for (;;) {
    data = COM.Parse(data);
    if (data == null) {
      break;
    }
    if (COM.token.charCodeAt(0) !== 123) {
      Sys.Error('Host.Loadgame_f: found ' + COM.token + ' when expecting {');
    }
    ent = SV.server.edicts[entnum++];
    ent.clear();
    ent.free = false;
    data = ED.ParseEdict(data, ent);
    if (ent.isFree() !== true) {
      SV.LinkEdict(ent);
    }
  }
  SV.server.num_edicts = entnum;

  SV.server.time = time;
  const client = SV.svs.clients[0];
  client.spawn_parms = [];
  for (i = 0; i <= 15; ++i) {
    client.spawn_parms[i] = spawn_parms[i];
  }
  CL.EstablishConnection('local');
  Host.Reconnect_f();
};

Host.Name_f = function() { // signon 2, step 1
  if (Cmd.argv.length <= 1) {
    Con.Print('"name" is "' + CL.name.string + '"\n');
    return;
  }

  let newName;

  if (Cmd.argv.length === 2) {
    newName = Cmd.argv[1].substring(0, 15);
  } else {
    newName = Cmd.args.substring(0, 15);
  }

  newName = newName.trim();

  if (!Host.dedicated.value && Cmd.client !== true) {
    Cvar.Set('_cl_name', newName);
    if (CL.cls.state === CL.active.connected) {
      Cmd.ForwardToServer();
    }
    return;
  }

  const initialNewName = newName;
  let newNameCounter = 2;

  // make sure we have a somewhat unique name
  while (SV.FindClientByName(newName)) {
    newName = `${initialNewName}${newNameCounter++}`;
  }

  const name = SV.GetClientName(Host.client);
  if (Host.dedicated.value && name && (name.length !== 0) && (name !== 'unconnected') && (name !== newName)) {
    Con.Print(name + ' renamed to ' + newName + '\n');
  }

  SV.SetClientName(Host.client, newName);
  const msg = SV.server.reliable_datagram;
  MSG.WriteByte(msg, Protocol.svc.updatename);
  MSG.WriteByte(msg, Host.client.num);
  MSG.WriteString(msg, newName);
};

Host.Version_f = function() {
  Con.Print('Version ' + Def.version + '\n');
};

Host.Say_f = function(teamonly) {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (Cmd.argv.length <= 1) {
    return;
  }
  const save = Host.client;
  let message = Cmd.args;

  // Remove surrounding double quotes if present
  if (message.startsWith('"')) {
    message = message.slice(1, -1);
  }
  if (message.length > 140) {
    message = message.substring(0, 140) + '...';
  }

  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if ((client.active !== true) || (client.spawned !== true)) {
      continue;
    }
    if ((Host.teamplay.value !== 0) && (teamonly === true) && (client.api.team !== save.api.team)) {
      continue;
    }
    Host.SendChatMessageToClient(client, SV.GetClientName(save), message, false);
  }

  Host.client = save; // unsure whether I removed it or not

  Con.Print(`${SV.GetClientName(save)}: ${message}\n`);
};

Host.Say_Team_f = function() {
  Host.Say_f(true);
};

Host.Tell_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (Cmd.argv.length <= 2) {
    return;
  }

  let message = Cmd.args;

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
    if (SV.GetClientName(client).toLowerCase() !== Cmd.argv[1].toLowerCase()) {
      continue;
    }
    Host.SendChatMessageToClient(client, SV.GetClientName(save), message, true);
    Host.SendChatMessageToClient(Host.client, SV.GetClientName(save), message, true);
    break;
  }
  Host.client = save;
};

Host.Color_f = function() { // signon 2, step 2 // FIXME: Host.client
  if (Cmd.argv.length <= 1) {
    Con.Print('"color" is "' + (CL.color.value >> 4) + ' ' + (CL.color.value & 15) + '"\ncolor <0-13> [0-13]\n');
    return;
  }

  let top; let bottom;
  if (Cmd.argv.length === 2) {
    top = bottom = (Q.atoi(Cmd.argv[1]) & 15) >>> 0;
  } else {
    top = (Q.atoi(Cmd.argv[1]) & 15) >>> 0;
    bottom = (Q.atoi(Cmd.argv[2]) & 15) >>> 0;
  }
  if (top >= 14) {
    top = 13;
  }
  if (bottom >= 14) {
    bottom = 13;
  }
  const playercolor = (top << 4) + bottom;

  if (Cmd.client !== true) {
    Cvar.SetValue('_cl_color', playercolor);
    if (CL.cls.state === CL.active.connected) {
      Cmd.ForwardToServer();
    }
    return;
  }

  Host.client.colors = playercolor;
  Host.client.edict.api.team = bottom + 1;
  const msg = SV.server.reliable_datagram;
  MSG.WriteByte(msg, Protocol.svc.updatecolors);
  MSG.WriteByte(msg, Host.client.num);
  MSG.WriteByte(msg, playercolor);
};

Host.Kill_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (SV.player.api.health <= 0.0) {
    Host.ClientPrint('Can\'t suicide -- already dead!\n');
    return;
  }
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.ClientKill(SV.player);
};

Host.Pause_f = function() {
  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }
  if (Host.pausable.value === 0) {
    Host.ClientPrint('Pause not allowed.\n');
    return;
  }
  SV.server.paused = !SV.server.paused;
  Host.BroadcastPrint(SV.GetClientName(Host.client) + (SV.server.paused === true ? ' paused the game\n' : ' unpaused the game\n'));
  MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.setpause);
  MSG.WriteByte(SV.server.reliable_datagram, SV.server.paused === true ? 1 : 0);
};

Host.PreSpawn_f = function() { // signon 1, step 1
  if (Cmd.client !== true) {
    Con.Print('prespawn is not valid from the console\n');
    return;
  }
  const client = Host.client;
  if (client.spawned === true) {
    Con.Print('prespawn not valid -- already spawned\n');
    return;
  }
  SZ.Write(client.message, new Uint8Array(SV.server.signon.data), SV.server.signon.cursize);
  MSG.WriteByte(client.message, Protocol.svc.signonnum);
  MSG.WriteByte(client.message, 2);
  client.sendsignon = true;
};

Host.Spawn_f = function() { // signon 2, step 3
  if (Cmd.client !== true) {
    Con.Print('spawn is not valid from the console\n');
    return;
  }
  let client = Host.client;
  if (client.spawned === true) {
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
      netname: SV.GetClientName(client),
      colormap: ent.num, // the num, not the entity
      team: (client.colors & 15) + 1,
    });
    for (i = 0; i <= 15; ++i) {
      SV.server.gameAPI[`parm${i + 1}`] = client.spawn_parms[i];
    }
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.ClientConnect(ent);
    if ((Sys.FloatTime() - client.netconnection.connecttime) <= SV.server.time) {
      Sys.Print(SV.GetClientName(client) + ' entered the game\n');
    }
    SV.server.gameAPI.PutClientInServer(ent);
  }

  const message = client.message;
  message.cursize = 0;
  MSG.WriteByte(message, Protocol.svc.time);
  MSG.WriteFloat(message, SV.server.time);
  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    MSG.WriteByte(message, Protocol.svc.updatename);
    MSG.WriteByte(message, i);
    MSG.WriteString(message, SV.GetClientName(client));
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
  const angles = ent.api.angles;
  MSG.WriteAngle(message, angles[0]);
  MSG.WriteAngle(message, angles[1]);
  MSG.WriteAngle(message, 0.0);
  SV.WriteClientdataToMessage(ent, message);
  MSG.WriteByte(message, Protocol.svc.signonnum);
  MSG.WriteByte(message, 3);
  Host.client.sendsignon = true;
};

Host.Begin_f = function() {  // signon 3, step 1
  if (Cmd.client !== true) {
    Con.Print('begin is not valid from the console\n');
    return;
  }
  Host.client.spawned = true;
};

Host.Kick_f = function() { // FIXME: Host.client
  if (Cmd.client !== true) {
    if (SV.server.active !== true) {
      Cmd.ForwardToServer();
      return;
    }
  } else if (SV.server.gameAPI.deathmatch !== 0.0) {
    return;
  }
  if (Cmd.argv.length <= 1) {
    return;
  }
  const save = Host.client;
  const s = Cmd.argv[1].toLowerCase();
  let i; let byNumber;
  if ((Cmd.argv.length >= 3) && (s === '#')) {
    i = Q.atoi(Cmd.argv[2]) - 1;
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
      if (SV.GetClientName(Host.client).toLowerCase() === s) {
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
  if (Cmd.client !== true) {
    if (Host.dedicated.value) {
      who = NET.hostname.string;
    } else {
      who = CL.name.string;
    }
  } else {
    if (Host.client === save) {
      return;
    }
    who = SV.GetClientName(save);
  }
  let message;
  if (Cmd.argv.length >= 3) {
    message = COM.Parse(Cmd.args);
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
      p += Cmd.argv[2].length;
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

Host.Give_f = function() {
  // CR:  commented this out for now, it’s only noise…
  //      unsure if I want a “give item_shells” approach or
  //      if I want to push this piece of code into PR/PF and let
  //      the game handle this instead

  if (Cmd.client !== true) {
    Cmd.ForwardToServer();
    return;
  }

  if (SV.server.gameAPI.deathmatch !== 0) {
    return;
  }

  if (Cmd.argv.length <= 1) {
    Host.ClientPrint('give <classname>\n');
    return;
  }

  const entityClassname = Cmd.argv[1];
  const player = SV.player;

  if (!entityClassname.startsWith('item_') && !entityClassname.startsWith('weapon_')) {
    Host.ClientPrint('Only entity classes item_* and weapon_* are allowed!\n');
    return;
  }

  // wait for the next server frame
  SV.ScheduleGameCommand(() => {
    const { forward } = player.api.v_angle.angleVectors();
    const origin = forward.multiply(64.0).add(player.api.origin);

    Game.EngineInterface.SpawnEntity(entityClassname, {
      origin,
    });

    // // playing around with Quake logic:
    // self.api.nextthink = 0; // disable PlaceItem
    // self.api.mdl = self.api.model; // so it can be restored on respawn
    // self.api.flags = 256; // make extra wide
    // self.api.solid = SV.solid.trigger;
    // self.api.movetype = SV.movetype.toss;
    // self.api.velocity = Vector.origin;

  });
  // /* old code below */
  // if ((t >= 48) && (t <= 57)) {
  //   if (COM.hipnotic !== true) {
  //     if (t >= 50) {
  //       ent.api.items |= Def.it.shotgun << (t - 50);
  //     }
  //     return;
  //   }
  //   if (t === 54) {
  //     if (Cmd.argv[1].charCodeAt(1) === 97) {
  //       ent.api.items |= Def.hit.proximity_gun;
  //     } else {
  //       ent.api.items |= Def.it.grenade_launcher;
  //     }
  //     return;
  //   }
  //   if (t === 57) {
  //     ent.api.items |= Def.hit.laser_cannon;
  //   } else if (t === 48) {
  //     ent.api.items |= Def.hit.mjolnir;
  //   } else if (t >= 50) {
  //     ent.api.items |= Def.it.shotgun << (t - 50);
  //   }
  //   return;
  // }
  // const v = Q.atoi(Cmd.argv[2]);
  // if (t === 104) {
  //   ent.api.health = v;
  //   return;
  // }
  // if (COM.rogue !== true) {
  //   switch (t) {
  //     case 115:
  //       ent.api.ammo_shells = v;
  //       return;
  //     case 110:
  //       ent.api.ammo_nails = v;
  //       return;
  //     case 114:
  //       ent.api.ammo_rockets = v;
  //       return;
  //     case 99:
  //       ent.api.ammo_cells = v;
  //   }
  //   return;
  // }
  // switch (t) {
  //   case 115:
  //     if (PR.entvars.ammo_shells1 != null) {
  //       ent.v_float[PR.entvars.ammo_shells1] = v;
  //       ent.api.ammo_shells1
  //     }
  //     ent.api.ammo_shells = v;
  //     return;
  //   case 110:
  //     if (PR.entvars.ammo_nails1 != null) {
  //       ent.v_float[PR.entvars.ammo_nails1] = v;
  //       if (ent.api.weapon <= Def.it.lightning) {
  //         ent.api.ammo_nails = v;
  //       }
  //     }
  //     return;
  //   case 108:
  //     if (PR.entvars.ammo_lava_nails != null) {
  //       ent.api.ammo_lava_nails = v;
  //       if (ent.api.weapon > Def.it.lightning) {
  //         ent.api.ammo_nails = v;
  //       }
  //     }
  //     return;
  //   case 114:
  //     if (PR.entvars.ammo_rockets1 != null) {
  //       ent.v_float[PR.entvars.ammo_rockets1] = v;
  //       if (ent.api.weapon <= Def.it.lightning) {
  //         ent.api.ammo_rockets = v;
  //       }
  //     }
  //     return;
  //   case 109:
  //     if (PR.entvars.ammo_multi_rockets != null) {
  //       ent.api.ammo_multi_rockets = v;
  //       if (ent.api.weapon > Def.it.lightning) {
  //         ent.api.ammo_rockets = v;
  //       }
  //     }
  //     return;
  //   case 99:
  //     if (PR.entvars.ammo_cells1 != null) {
  //       ent.v_float[PR.entvars.ammo_cells1] = v;
  //       if (ent.api.weapon <= Def.it.lightning) {
  //         ent.api.ammo_cells = v;
  //       }
  //     }
  //     return;
  //   case 112:
  //     if (PR.entvars.ammo_plasma != null) {
  //       ent.api.ammo_plasma = v;
  //       if (ent.api.weapon > Def.it.lightning) {
  //         ent.api.ammo_cells = v;
  //       }
  //     }
  // }
};

Host.FindViewthing = function() {
  let i; let e;
  if (SV.server.active === true) {
    for (i = 0; i < SV.server.num_edicts; ++i) {
      e = SV.server.edicts[i];
      if (e.api.classname === 'viewthing') {
        return e;
      }
    }
  }
  Con.Print('No viewthing on map\n');
  return null;
};

Host.Viewmodel_f = function() {
  if (Cmd.argv.length !== 2) {
    return;
  }
  const ent = Host.FindViewthing();
  if (ent == null) {
    return;
  }
  const m = Mod.ForName(Cmd.argv[1]);
  if (m == null) {
    Con.Print('Can\'t load ' + Cmd.argv[1] + '\n');
    return;
  }
  ent.api.frame = 0.0;
  CL.state.model_precache[ent.api.modelindex >> 0] = m;
};

Host.Viewframe_f = function() {
  const ent = Host.FindViewthing();
  if (ent == null) {
    return;
  }
  const m = CL.state.model_precache[ent.api.modelindex >> 0];
  let f = Q.atoi(Cmd.argv[1]);
  if (f >= m.frames.length) {
    f = m.frames.length - 1;
  }
  ent.api.frame = f;
};

Host.Viewnext_f = function() {
  const ent = Host.FindViewthing();
  if (ent == null) {
    return;
  }
  const m = CL.state.model_precache[ent.api.modelindex >> 0];
  let f = (ent.api.frame >> 0) + 1;
  if (f >= m.frames.length) {
    f = m.frames.length - 1;
  }
  ent.api.frame = f;
  Con.Print('frame ' + f + ': ' + m.frames[f].name + '\n');
};

Host.Viewprev_f = function() {
  const ent = Host.FindViewthing();
  if (ent == null) {
    return;
  }
  const m = CL.state.model_precache[ent.api.modelindex >> 0];
  let f = (ent.api.frame >> 0) - 1;
  if (f < 0) {
    f = 0;
  }
  ent.api.frame = f;
  Con.Print('frame ' + f + ': ' + m.frames[f].name + '\n');
};

Host.Startdemos_f = function() {
  if (Host.dedicated.value) {
    Con.Print('cannot play demos in dedicated server mode\n');
    return;
  }

  Con.Print((Cmd.argv.length - 1) + ' demo(s) in loop\n');
  CL.cls.demos = [];
  let i;
  for (i = 1; i < Cmd.argv.length; ++i) {
    CL.cls.demos[i - 1] = Cmd.argv[i];
  }
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

Host.InitCommands = function() {
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
  Cmd.AddCommand('say', Host.Say_f);
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
