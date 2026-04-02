import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../../shared/Q.ts';
import { eventBus, registry } from '../registry.mjs';
import { SzBuffer } from './MSG.ts';
import { BaseDriver, LoopDriver, QSocket, WebRTCDriver, WebSocketDriver } from './NetworkDrivers.mjs';
import { DriverRegistry } from './DriverRegistry.mjs';
import { InviteCommand } from './ConsoleCommands.mjs';
import { clientConnectionState } from '../common/Def.mjs';

const NET = {};

export default NET;

let { CL, Con, SV, Sys } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  SV = registry.SV;
  Sys = registry.Sys;
});

NET.activeSockets = /** @type {QSocket[]} */ ([]);
NET.message = new SzBuffer(16384, 'NET.message');
NET.activeconnections = 0;
NET.listening = false;
NET.driverRegistry = /** @type {DriverRegistry} */ (null);

/**
 * @param {BaseDriver} driver responsible driver
 * @returns {QSocket} new QSocket
 */
NET.NewQSocket = function(driver) {
  let i;
  for (i = 0; i < NET.activeSockets.length; i++) {
    if (NET.activeSockets[i].state === QSocket.STATE_DISCONNECTED) {
      break;
    }
  }
  NET.activeSockets[i] = new QSocket(driver, NET.time);
  return NET.activeSockets[i];
};

/**
 * @param {string} address server address
 * @returns {QSocket|null} socket or null on failure
 */
NET.Connect = function(address) {
  NET.time = Sys.FloatTime();

  const driver = NET.driverRegistry.getClientDriver(address);

  if (!driver) {
    Con.PrintWarning(`No suitable network driver found for host: ${address}\n`);
    return null;
  }

  const ret = driver.Connect(address);

  if (ret === 0) {
    CL.cls.state = clientConnectionState.connecting;
    Con.Print('trying...\n');
    NET.start_time = NET.time;
    NET.reps = 0;
  }

  return ret;
};

/**
 * Checks all initialized drivers for new connections to handle
 * @returns {QSocket|null} new connection socket or null if none
 */
NET.CheckNewConnections = function() {
  NET.time = Sys.FloatTime();

  // Check all initialized drivers for new connections
  for (const driver of NET.driverRegistry.getInitializedDrivers()) {
    const ret = driver.CheckNewConnections();
    if (ret !== null) {
      return ret;
    }
  }

  return null;
};

/**
 * @param {QSocket} sock connection handle
 */
NET.Close = function(sock) {
  if (!sock) {
    return;
  }
  if (sock.state === QSocket.STATE_DISCONNECTED) {
    return;
  }
  NET.time = Sys.FloatTime();
  sock.Close();
};

/**
 * @param {QSocket} sock connection handle
 * @returns {number} channel number or -1 on failure
 */
NET.GetMessage = function(sock) {
  if (sock === null) {
    return -1;
  }
  if (sock.state === QSocket.STATE_DISCONNECTED) {
    Con.DPrint('NET.GetMessage: disconnected socket\n');
    return -1;
  }
  NET.time = Sys.FloatTime();
  const ret = sock.GetMessage();
  if (sock.driver instanceof LoopDriver) { // FIXME: hardcoded check for loopback driver
    if (ret === 0) {
      if ((NET.time - sock.lastMessageTime) > NET.messagetimeout.value) {
        Con.DPrint(`NET.GetMessage: message timeout for ${sock.address}\n`);
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
  if (!sock) {
    return -1;
  }
  if (sock.state === QSocket.STATE_DISCONNECTED) {
    Con.DPrint('NET.SendMessage: disconnected socket\n');
    return -1;
  }
  NET.time = Sys.FloatTime();
  sock.lastMessageTime = NET.time;
  return sock.SendMessage(data);
};

/**
 * @param {QSocket} sock socket
 * @param {SzBuffer} data message
 * @returns {number} -1 on failure, 1 on success
 */
NET.SendUnreliableMessage = function(sock, data) {
  if (sock === null) {
    return -1;
  }
  if (sock.state === QSocket.STATE_DISCONNECTED) {
    Con.DPrint('NET.SendUnreliableMessage: disconnected socket\n');
    return -1;
  }
  // console.debug(`NET.SendUnreliableMessage: ${sock.address} ${data.cursize}`, data.toHexString());
  NET.time = Sys.FloatTime();
  sock.lastMessageTime = NET.time;
  return sock.SendUnreliableMessage(data);
};

/**
 * Check if a socket can send messages
 * @param {QSocket} sock - The socket to check
 * @returns {boolean} true if the socket can send messages, false otherwise
 */
NET.CanSendMessage = function(sock) {
  if (!sock) {
    return false;
  }
  if (sock.state === QSocket.STATE_DISCONNECTED) {
    return false;
  }
  NET.time = Sys.FloatTime();
  return sock.CanSendMessage();
};

NET.Init = function() {
  NET.time = Sys.FloatTime();

  NET.messagetimeout = new Cvar('net_messagetimeout', '60');
  NET.hostname = new Cvar('hostname', 'UNNAMED', Cvar.FLAG.SERVER, 'Descriptive name of the server.');

  NET.delay_send = new Cvar('net_delay_send', '0', Cvar.FLAG.NONE, 'Delay sending messages to the network. Useful for debugging.');
  NET.delay_send_jitter = new Cvar('net_delay_send_jitter', '0', Cvar.FLAG.NONE, 'Jitter for the delay sending messages to the network. Useful for debugging.');

  NET.delay_receive = new Cvar('net_delay_receive', '0', Cvar.FLAG.NONE, 'Delay receiving messages from the network. Useful for debugging.');
  NET.delay_receive_jitter = new Cvar('net_delay_receive_jitter', '0', Cvar.FLAG.NONE, 'Jitter for the delay receiving messages from the network. Useful for debugging.');

  Cmd.AddCommand('maxplayers', NET.MaxPlayers_f);
  Cmd.AddCommand('listen', NET.Listen_f);

  if (!registry.isDedicatedServer) {
    Cmd.AddCommand('invite', InviteCommand);
  }

  if (!registry.isDedicatedServer) { // TODO: move this to the client code path, nothing to do with networking
    const Key = registry.Key; // client code path

    eventBus.subscribe('server.spawned', async () => {
      await Q.sleep(5000);

      if (!NET.listening) {
        return;
      }

      Con.PrintSuccess('Online multiplayer game has been created!\n');
    });

    eventBus.subscribe('client.signon', async (signon) => {
      if (signon !== 4) {
        return;
      }

      await Q.sleep(5000);

      if (!NET.listening) {
        return;
      }

      const key = Key.BindingToString('invite');

      if (key) {
        Con.Print(`Press "${key}" to invite others.\n`);
      } else {
        Con.Print('Use "invite" command to print the invite message.\n');
      }
    });
  }

  NET.driverRegistry = new DriverRegistry();
  NET.driverRegistry.register('loopback', new LoopDriver());
  NET.driverRegistry.register('websocket', new WebSocketDriver());
  NET.driverRegistry.register('webrtc', new WebRTCDriver());
  NET.driverRegistry.initialize();
};

NET.Shutdown = function() {
  NET.time = Sys.FloatTime();

  for (let i = 0; i < NET.activeSockets.length; i++) {
    NET.Close(NET.activeSockets[i]);
  }

  NET.driverRegistry.shutdown();
};

NET.Listen_f = function(isListening) { // TODO: turn into Cvar with hooks
  if (isListening === undefined) {
    Con.Print('"listen" is "' + (NET.listening ? 1 : 0) + '"\n');
    return;
  }

  NET.listening = +isListening ? true : false;

  for (const driver of NET.driverRegistry.getInitializedDrivers()) {
    if (driver.ShouldListen()) {
      driver.Listen(NET.listening);
    }
  }
};

/**
 * @returns {string|null} listen address or null if not listening
 */
NET.GetListenAddress = function() {
  // Try to get listen address from any driver that's listening
  for (const driver of NET.driverRegistry.getInitializedDrivers()) {
    const addr = driver.GetListenAddress();
    if (addr) {
      return addr;
    }
  }

  return null;
};

NET.MaxPlayers_f = function(maxplayers) { // TODO: turn into Cvar with hooks
  if (maxplayers === undefined) {
    Con.Print('"maxplayers" is "' + SV.svs.maxclients + '"\n');
    return;
  }

  if (SV.server.active) {
    Con.Print('maxplayers can not be changed while a server is running.\n');
    return;
  }

  let n = Q.atoi(maxplayers);
  if (n < 1) {
    n = 1;
  }
  if (n > SV.svs.maxclientslimit) {
    n = SV.svs.maxclientslimit;
    Con.Print('"maxplayers" set to "' + n + '"\n');
  }

  SV.svs.maxclients = n;
};

eventBus.subscribe('server.spawned', () => {
  if (SV.svs.maxclients === 1 && NET.listening) {
    Cmd.ExecuteString('listen 0');
  }

  if (SV.svs.maxclients > 1 && !NET.listening) {
    Cmd.ExecuteString('listen 1');
  }
});

eventBus.subscribe('server.shutdown', () => {
  if (NET.listening) {
    Cmd.ExecuteString('listen 0');
  }
});
