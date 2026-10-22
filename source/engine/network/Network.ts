import type { Server as HttpServer } from 'node:http';

import type { URLs } from '../build-config';
import type { ConsoleOutput, SystemServices } from '../common/Services.ts';

import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { SzBuffer } from './MSG.ts';
import { DriverRegistry } from './DriverRegistry.ts';
import { BaseDriver, LoopDriver, QSocket, WebRTCDriver, WebSocketDriver } from './NetworkDrivers.ts';

type NetworkPayload = SzBuffer;

/** Facts about the hosted server that are advertised to the master server. */
export interface HostedServerInfo {
  readonly maxPlayers: number;
  readonly mapname: string;
  /** Game (mod) directory the server runs. */
  readonly game: string;
}

/** What a `Network` depends on. */
export interface NetworkDependencies {
  readonly con: ConsoleOutput;
  readonly sys: SystemServices;
  /** Whether this is a dedicated server, with no local player. */
  readonly dedicated: boolean;
  /** Where signaling and master servers are reached, read when needed because it may be completed late. */
  readonly urls: () => URLs | undefined;
  /** Reads what the hosted server advertises. */
  readonly serverInfo: () => HostedServerInfo;
  /** The WebSocket implementation of the platform: the browser's, or the `ws` module on a server. */
  readonly webSocketModule: () => unknown;
  /**
   * The transports to use, in the order a client picks them. Without it the loopback, WebSocket and
   * WebRTC drivers are used; a realm that talks to a server in another thread supplies its own.
   */
  readonly createDrivers?: (net: NET) => ReadonlyArray<readonly [name: string, driver: BaseDriver]>;
}

export default class NET {
  readonly con: ConsoleOutput;
  readonly sys: SystemServices;
  readonly dedicated: boolean;
  readonly urls: NetworkDependencies['urls'];
  readonly serverInfo: NetworkDependencies['serverInfo'];
  readonly webSocketModule: NetworkDependencies['webSocketModule'];
  readonly #createDrivers: NetworkDependencies['createDrivers'];

  constructor(dependencies: NetworkDependencies) {
    this.con = dependencies.con;
    this.sys = dependencies.sys;
    this.dedicated = dependencies.dedicated;
    this.urls = dependencies.urls;
    this.serverInfo = dependencies.serverInfo;
    this.webSocketModule = dependencies.webSocketModule;
    this.#createDrivers = dependencies.createDrivers;
  }

  activeSockets: QSocket[] = [];
  message = new SzBuffer(1048576, 'this.message');
  activeconnections = 0;
  listening = false;
  driverRegistry = new DriverRegistry();
  server: HttpServer | null = null;
  time = 0;
  start_time = 0;
  reps = 0;
  messagetimeout!: Cvar;
  hostname!: Cvar;
  delay_send!: Cvar;
  delay_send_jitter!: Cvar;
  delay_receive!: Cvar;
  delay_receive_jitter!: Cvar;

  NewQSocket(driver: BaseDriver): QSocket {
    let index = 0;

    for (; index < this.activeSockets.length; index++) {
      if (this.activeSockets[index].state === QSocket.STATE_DISCONNECTED) {
        break;
      }
    }

    this.activeSockets[index] = new QSocket(driver, this.time);
    return this.activeSockets[index];
  }

  Connect(address: string): QSocket | null {
    this.time = this.sys.FloatTime();

    const driver = this.driverRegistry.getClientDriver(address);

    if (driver === null) {
      this.con.PrintWarning(`No suitable network driver found for host: ${address}\n`);
      return null;
    }

    const sock = driver.Connect(address);

    if (sock !== null) {
      this.con.DPrint(`trying to connect to ${address}...\n`);
      this.start_time = this.time;
      this.reps = 0;
    }

    return sock;
  }

  CheckNewConnections(): QSocket | null {
    this.time = this.sys.FloatTime();

    for (const driver of this.driverRegistry.getInitializedDrivers()) {
      const sock = driver.CheckNewConnections();

      if (sock !== null) {
        return sock;
      }
    }

    return null;
  }

  Close(sock: QSocket | null): void {
    if (sock === null || sock.state === QSocket.STATE_DISCONNECTED) {
      return;
    }

    this.time = this.sys.FloatTime();
    sock.Close();
  }

  GetMessage(sock: QSocket | null): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      this.con.DPrint('this.GetMessage: disconnected socket\n');
      return -1;
    }

    this.time = this.sys.FloatTime();
    const result = sock.GetMessage();

    if (sock.driver instanceof LoopDriver) {
      if (result === 0) {
        if ((this.time - sock.lastMessageTime) > this.messagetimeout.value) {
          this.con.DPrint(`this.GetMessage: message timeout for ${sock.address}\n`);
          this.Close(sock);
          return -1;
        }
      } else if (result > 0) {
        sock.lastMessageTime = this.time;
      }
    }

    return result;
  }

  SendMessage(sock: QSocket | null, data: NetworkPayload): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      this.con.DPrint('this.SendMessage: disconnected socket\n');
      return -1;
    }

    this.time = this.sys.FloatTime();
    sock.lastMessageTime = this.time;
    return sock.SendMessage(data);
  }

  SendUnreliableMessage(sock: QSocket | null, data: SzBuffer): number {
    if (sock === null) {
      return -1;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      this.con.DPrint('this.SendUnreliableMessage: disconnected socket\n');
      return -1;
    }

    this.time = this.sys.FloatTime();
    sock.lastMessageTime = this.time;
    return sock.SendUnreliableMessage(data);
  }

  CanSendMessage(sock: QSocket | null): boolean {
    if (sock === null || sock.state === QSocket.STATE_DISCONNECTED) {
      return false;
    }

    this.time = this.sys.FloatTime();
    return sock.CanSendMessage();
  }

  Init(): void {
    this.time = this.sys.FloatTime();

    this.messagetimeout = new Cvar('net_messagetimeout', '60');
    this.hostname = new Cvar('hostname', 'UNNAMED', Cvar.FLAG.SERVER, 'Descriptive name of the server.');

    this.delay_send = new Cvar('net_delay_send', '0', Cvar.FLAG.NONE, 'Delay sending messages to the network. Useful for debugging.');
    this.delay_send_jitter = new Cvar('net_delay_send_jitter', '0', Cvar.FLAG.NONE, 'Jitter for the delay sending messages to the network. Useful for debugging.');

    this.delay_receive = new Cvar('net_delay_receive', '0', Cvar.FLAG.NONE, 'Delay receiving messages from the network. Useful for debugging.');
    this.delay_receive_jitter = new Cvar('net_delay_receive_jitter', '0', Cvar.FLAG.NONE, 'Jitter for the delay receiving messages from the network. Useful for debugging.');

    Cmd.AddCommand('listen', (isListening?: string | number) => { this.Listen_f(isListening); });

    this.driverRegistry = new DriverRegistry();

    const drivers = this.#createDrivers?.(this) ?? [
      ['loopback', new LoopDriver(this)],
      ['websocket', new WebSocketDriver(this)],
      ['webrtc', new WebRTCDriver(this)],
    ] as const;

    for (const [name, driver] of drivers) {
      this.driverRegistry.register(name, driver);
    }

    this.driverRegistry.initialize();
  }

  Shutdown(): void {
    this.time = this.sys.FloatTime();

    for (const sock of this.activeSockets) {
      this.Close(sock);
    }

    this.driverRegistry.shutdown();
  }

  Listen_f(isListening?: string | number): void {
    if (isListening === undefined) {
      this.con.Print(`"listen" is "${this.listening ? 1 : 0}"\n`);
      return;
    }

    this.listening = Number(isListening) !== 0;

    for (const driver of this.driverRegistry.getInitializedDrivers()) {
      if (driver.ShouldListen()) {
        driver.Listen(this.listening);
      }
    }
  }

  GetListenAddress(): string | null {
    for (const driver of this.driverRegistry.getInitializedDrivers()) {
      const address = driver.GetListenAddress();

      if (address !== null) {
        return address;
      }
    }

    return null;
  }
}

