import type { Server as HttpServer } from 'node:http';

import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { clientConnectionState } from '../common/Def.mjs';
import Q from '../../shared/Q.ts';
import { eventBus, getClientRegistry, getCommonRegistry, registry } from '../registry.mjs';
import { SzBuffer } from './MSG.ts';
import { InviteCommand } from './ConsoleCommands.ts';
import { DriverRegistry } from './DriverRegistry.ts';
import { BaseDriver, LoopDriver, QSocket, WebRTCDriver, WebSocketDriver } from './NetworkDrivers.ts';

type NetworkPayload = Pick<SzBuffer, 'cursize' | 'data'>;

let { Con, SV, Sys } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, SV, Sys } = getCommonRegistry());
});

export default class NET {
  static activeSockets: QSocket[] = [];
  static message = new SzBuffer(16384, 'NET.message');
  static activeconnections = 0;
  static listening = false;
  static driverRegistry = new DriverRegistry();
  static server: HttpServer | null = null;
  static time = 0;
  static start_time = 0;
  static reps = 0;
  static messagetimeout: Cvar;
  static hostname: Cvar;
  static delay_send: Cvar;
  static delay_send_jitter: Cvar;
  static delay_receive: Cvar;
  static delay_receive_jitter: Cvar;

  static NewQSocket(driver: BaseDriver): QSocket {
    let index = 0;

    for (; index < NET.activeSockets.length; index++) {
      if (NET.activeSockets[index].state === QSocket.STATE_DISCONNECTED) {
        break;
      }
    }

    NET.activeSockets[index] = new QSocket(driver, NET.time);
    return NET.activeSockets[index];
  }

  static Connect(address: string): QSocket | null {
    NET.time = Sys.FloatTime();

    const driver = NET.driverRegistry.getClientDriver(address);

    if (driver === null) {
      Con.PrintWarning(`No suitable network driver found for host: ${address}\n`);
      return null;
    }

    const sock = driver.Connect(address);

    if (sock !== null) {
      const { CL } = getClientRegistry();

      CL.cls.state = clientConnectionState.connecting;
      Con.Print('trying...\n');
      NET.start_time = NET.time;
      NET.reps = 0;
    }

    return sock;
  }

  static CheckNewConnections(): QSocket | null {
    NET.time = Sys.FloatTime();

    for (const driver of NET.driverRegistry.getInitializedDrivers()) {
      const sock = driver.CheckNewConnections();

      if (sock !== null) {
        return sock;
      }
    }

    return null;
  }

  static Close(sock: QSocket | null): void {
    if (sock === null || sock.state === QSocket.STATE_DISCONNECTED) {
      return;
    }

    NET.time = Sys.FloatTime();
    sock.Close();
  }

  static GetMessage(sock: QSocket | null): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      Con.DPrint('NET.GetMessage: disconnected socket\n');
      return -1;
    }

    NET.time = Sys.FloatTime();
    const result = sock.GetMessage();

    if (sock.driver instanceof LoopDriver) {
      if (result === 0) {
        if ((NET.time - sock.lastMessageTime) > NET.messagetimeout.value) {
          Con.DPrint(`NET.GetMessage: message timeout for ${sock.address}\n`);
          NET.Close(sock);
          return -1;
        }
      } else if (result > 0) {
        sock.lastMessageTime = NET.time;
      }
    }

    return result;
  }

  static SendMessage(sock: QSocket | null, data: NetworkPayload): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      Con.DPrint('NET.SendMessage: disconnected socket\n');
      return -1;
    }

    NET.time = Sys.FloatTime();
    sock.lastMessageTime = NET.time;
    return sock.SendMessage(data);
  }

  static SendUnreliableMessage(sock: QSocket | null, data: SzBuffer): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      Con.DPrint('NET.SendUnreliableMessage: disconnected socket\n');
      return -1;
    }

    NET.time = Sys.FloatTime();
    sock.lastMessageTime = NET.time;
    return sock.SendUnreliableMessage(data);
  }

  static CanSendMessage(sock: QSocket | null): boolean {
    if (sock === null || sock.state === QSocket.STATE_DISCONNECTED) {
      return false;
    }

    NET.time = Sys.FloatTime();
    return sock.CanSendMessage();
  }

  static Init(): void {
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

    if (!registry.isDedicatedServer) {
      const { Key } = getClientRegistry();

      eventBus.subscribe('server.spawned', async () => {
        await Q.sleep(5000);

        if (!NET.listening) {
          return;
        }

        Con.PrintSuccess('Online multiplayer game has been created!\n');
      });

      eventBus.subscribe('client.signon', async (signon: number) => {
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
          return;
        }

        Con.Print('Use "invite" command to print the invite message.\n');
      });
    }

    NET.driverRegistry = new DriverRegistry();
    NET.driverRegistry.register('loopback', new LoopDriver());
    NET.driverRegistry.register('websocket', new WebSocketDriver());
    NET.driverRegistry.register('webrtc', new WebRTCDriver());
    NET.driverRegistry.initialize();
  }

  static Shutdown(): void {
    NET.time = Sys.FloatTime();

    for (const sock of NET.activeSockets) {
      NET.Close(sock);
    }

    NET.driverRegistry.shutdown();
  }

  static Listen_f(isListening?: string | number): void {
    if (isListening === undefined) {
      Con.Print(`"listen" is "${NET.listening ? 1 : 0}"\n`);
      return;
    }

    NET.listening = Number(isListening) !== 0;

    for (const driver of NET.driverRegistry.getInitializedDrivers()) {
      if (driver.ShouldListen()) {
        driver.Listen(NET.listening);
      }
    }
  }

  static GetListenAddress(): string | null {
    for (const driver of NET.driverRegistry.getInitializedDrivers()) {
      const address = driver.GetListenAddress();

      if (address !== null) {
        return address;
      }
    }

    return null;
  }

  static MaxPlayers_f(maxplayers?: string | number): void {
    if (maxplayers === undefined) {
      Con.Print(`"maxplayers" is "${SV.svs.maxclients}"\n`);
      return;
    }

    if (SV.server.active) {
      Con.Print('maxplayers can not be changed while a server is running.\n');
      return;
    }

    let value = Q.atoi(String(maxplayers));

    if (value < 1) {
      value = 1;
    }

    if (value > SV.svs.maxclientslimit) {
      value = SV.svs.maxclientslimit;
      Con.Print(`"maxplayers" set to "${value}"\n`);
    }

    SV.svs.maxclients = value;
  }
}

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
