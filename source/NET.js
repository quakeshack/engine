NET = {};

NET.BaseDriver = class BaseDriver {
  constructor() {
    this.initialized = false;
  }

  Init() {
    return false;
  }

  Connect(host) {
    return null;
  }

  CheckNewConnections() {
    return null;
  }

  CheckForResend() {
    return -1;
  }

  GetMessage() {
    return 0;
  }

  SendMessage() {
    return -1;
  }

  SendUnreliableMessage() {
    return -1;
  }

  CanSendMessage() {
    return false;
  }

  Close() {
  }

  Listen() {
  }
};

NET.activeSockets = [];
NET.message = {data: new ArrayBuffer(8192), cursize: 0};
NET.activeconnections = 0;
NET.listening = false;

NET.NewQSocket = function() {
  let i;
  for (i = 0; i < NET.activeSockets.length; ++i) {
    if (NET.activeSockets[i].disconnected === true) {
      break;
    }
  }
  NET.activeSockets[i] = {
    connecttime: NET.time,
    lastMessageTime: NET.time,
    driver: NET.driverlevel,
    address: 'UNSET ADDRESS',
  };
  return NET.activeSockets[i];
};

NET.Connect = function(host) {
  NET.time = Sys.FloatTime();

  if (host === 'local') {
    NET.driverlevel = 0; // Loop Driver
    return NET.drivers[NET.driverlevel].Connect(host);
  }

  let dfunc; let ret;
  for (NET.driverlevel = 1; NET.driverlevel < NET.drivers.length; ++NET.driverlevel) {
    dfunc = NET.drivers[NET.driverlevel];
    if (dfunc.initialized !== true) {
      continue;
    }
    ret = dfunc.Connect(host);
    if (ret === 0) {
      CL.cls.state = CL.active.connecting;
      Con.Print('trying...\n');
      NET.start_time = NET.time;
      NET.reps = 0;
    }
    if (ret != null) {
      return ret;
    }
  }
};

NET.CheckForResend = function() {
  NET.time = Sys.FloatTime();
  const dfunc = NET.drivers[NET.newsocket.driver];
  if (NET.reps <= 2) {
    if ((NET.time - NET.start_time) >= (2.5 * (NET.reps + 1))) {
      Con.Print('still trying...\n');
      ++NET.reps;
    }
  } else if (NET.reps === 3) {
    if ((NET.time - NET.start_time) >= 10.0) {
      NET.Close(NET.newsocket);
      CL.cls.state = CL.active.disconnected;
      Con.Print('No Response\n');
      Host.Error('NET.CheckForResend: connect failed\n');
    }
  }
  const ret = dfunc.CheckForResend();
  if (ret === 1) {
    NET.newsocket.disconnected = false;
    CL.Connect(NET.newsocket);
  } else if (ret === -1) {
    NET.newsocket.disconnected = false;
    NET.Close(NET.newsocket);
    CL.cls.state = CL.active.disconnected;
    Con.Print('Network Error\n');
    Host.Error('NET.CheckForResend: connect failed\n');
  }

  Con.DPrint(`NET.CheckForResend: invalid CheckForResend response ${ret} by ${dfunc.constructor.name}`);
};

NET.CheckNewConnections = function() {
  NET.time = Sys.FloatTime();
  let dfunc; let ret;
  for (NET.driverlevel = 0; NET.driverlevel < NET.drivers.length; ++NET.driverlevel) {
    dfunc = NET.drivers[NET.driverlevel];
    if (dfunc.initialized !== true) {
      continue;
    }
    ret = dfunc.CheckNewConnections();
    if (ret != null) {
      return ret;
    }
  }
};

NET.Close = function(sock) {
  if (sock == null) {
    return;
  }
  if (sock.disconnected === true) {
    return;
  }
  NET.time = Sys.FloatTime();
  NET.drivers[sock.driver].Close(sock);
  sock.disconnected = true;
};

NET.GetMessage = function(sock) {
  if (sock == null) {
    return -1;
  }
  if (sock.disconnected === true) {
    Con.Print('NET.GetMessage: disconnected socket\n');
    return -1;
  }
  NET.time = Sys.FloatTime();
  const ret = NET.drivers[sock.driver].GetMessage(sock);
  if (sock.driver !== 0) {
    if (ret === 0) {
      if ((NET.time - sock.lastMessageTime) > NET.messagetimeout.value) {
        NET.Close(sock);
        return -1;
      }
    } else if (ret > 0) {
      sock.lastMessageTime = NET.time;
    }
  }
  return ret;
};

NET.SendMessage = function(sock, data) {
  if (sock == null) {
    return -1;
  }
  if (sock.disconnected === true) {
    Con.Print('NET.SendMessage: disconnected socket\n');
    return -1;
  }
  NET.time = Sys.FloatTime();
  return NET.drivers[sock.driver].SendMessage(sock, data);
};

NET.SendUnreliableMessage = function(sock, data) {
  if (sock == null) {
    return -1;
  }
  if (sock.disconnected === true) {
    Con.Print('NET.SendUnreliableMessage: disconnected socket\n');
    return -1;
  }
  NET.time = Sys.FloatTime();
  return NET.drivers[sock.driver].SendUnreliableMessage(sock, data);
};

NET.CanSendMessage = function(sock) {
  if (sock == null) {
    return;
  }
  if (sock.disconnected === true) {
    return;
  }
  NET.time = Sys.FloatTime();
  return NET.drivers[sock.driver].CanSendMessage(sock);
};

NET.SendToAll = function(data) {
  let i; let count = 0; const state1 = []; const state2 = [];
  for (i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = SV.svs.clients[i];
    if (Host.client.netconnection == null) {
      continue;
    }
    if (Host.client.active !== true) {
      state1[i] = state2[i] = true;
      continue;
    }
    if (Host.client.netconnection.driver === 0) {
      NET.SendMessage(Host.client.netconnection, data);
      state1[i] = state2[i] = true;
      continue;
    }
    ++count;
    state1[i] = state2[i] = false;
  }
  const start = Sys.FloatTime();
  for (; count !== 0; ) {
    count = 0;
    for (i = 0; i < SV.svs.maxclients; ++i) {
      Host.client = SV.svs.clients[i];
      if (state1[i] !== true) {
        if (NET.CanSendMessage(Host.client.netconnection)) {
          state1[i] = true;
          NET.SendMessage(Host.client.netconnection, data);
        } else {
          NET.GetMessage(Host.client.netconnection);
        }
        ++count;
        continue;
      }
      if (state2[i] !== true) {
        if (NET.CanSendMessage(Host.client.netconnection)) {
          state2[i] = true;
        } else {
          NET.GetMessage(Host.client.netconnection);
        }
        ++count;
      }
    }
    if ((Sys.FloatTime() - start) > 5.0) {
      return count;
    }
  }
  return count;
};

NET.Init = function() {
  NET.time = Sys.FloatTime();

  NET.messagetimeout = Cvar.RegisterVariable('net_messagetimeout', '300');
  NET.hostname = Cvar.RegisterVariable('hostname', 'UNNAMED');

  Cmd.AddCommand('maxplayers', NET.MaxPlayers_f);
  Cmd.AddCommand('listen', NET.Listen_f);
  Cmd.AddCommand('net_drivers', NET.Drivers_f);

  NET.drivers = [new Loop.LoopDriver()]; // TODO: add back WS
  for (NET.driverlevel = 0; NET.driverlevel < NET.drivers.length; ++NET.driverlevel) {
    NET.drivers[NET.driverlevel].Init();
  }
};

NET.Shutdown = function() {
  NET.time = Sys.FloatTime();
  for (i = 0; i < NET.activeSockets.length; ++i) {
    NET.Close(NET.activeSockets[i]);
  }
};

NET.Drivers_f = function() {
  for (const driver of NET.drivers) {
    Con.Print(`${driver.constructor.name}\n`);
    Con.Print(`...initialized: ${driver.initialized ? 'yes' : 'no'}\n`);
    Con.Print('\n');
  }
};

NET.Listen_f = function() {
  if (Cmd.argv.length < 2) {
    Con.Print('"listen" is "' + (NET.listening ? 1 : 0) + '"\n');
    return;
  }

  NET.listening = Q.atoi(Cmd.argv[1]) ? true : false;

  for (NET.driverlevel = 0; NET.driverlevel < NET.drivers.length; ++NET.driverlevel) {
    if (!NET.drivers[NET.driverlevel].initialized) {
      continue;
    }

    NET.drivers[NET.driverlevel].Listen(NET.listening);
  }
};

NET.MaxPlayers_f = function() {
  if (Cmd.argv.length < 2) {
    Con.Print('"maxplayers" is "' + SV.svs.maxclients + '"\n');
    return;
  }

  if (SV.server.active) {
    Con.Print('maxplayers can not be changed while a server is running.\n');
    return;
  }

  let n = Q.atoi(Cmd.argv[1]);
  if (n < 1) {
    n = 1;
  }
  if (n > SV.svs.maxclientslimit) {
    n = SV.svs.maxclientslimit;
    Con.Print('"maxplayers" set to "' + n + '"\n');
  }

  if ((n == 1) && NET.listening) {
    Cmd.ExecuteString('listen 0');
  }

  if ((n > 1) && (!NET.listening)) {
    Cmd.ExecuteString('listen 1');
  }

  SV.svs.maxclients = n;
  if (n == 1) {
    Cvar.Set('deathmatch', '0');
  } else {
    Cvar.Set('deathmatch', '1');
  }
};
