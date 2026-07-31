import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import Cvar from '../common/Cvar.ts';
import Cmd from '../common/Cmd.ts';
import ClientInput from './ClientInput.ts';
import type ClientDemos from './ClientDemos.ts';
import { clientRuntimeState, clientStaticState, type ClientRuntimeState, type ClientStaticState } from './ClientState.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { HostError } from '../common/Errors.ts';
import { QSocket } from '../network/NetworkDrivers.ts';
import { parseServerMessage as parseServerCommandMessage } from './ClientServerCommandHandlers.ts';
import { ModelScope } from '../common/Mod.ts';

export type IdentityCvars = {
  name: Cvar | null;
  color: Cvar | null;
  rcon_password: Cvar | null;
};

let { Con, Host, IN, Mod, NET, SCR, S, SV } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Host, IN, Mod, NET, SCR, S, SV } = getClientRegistry());
});

export default class ClientConnection {
  cls: ClientStaticState;
  state: ClientRuntimeState;
  clientDemos: ClientDemos;
  identityCvars: IdentityCvars;
  processingServerDataState: number;
  lastServerMessages: string[];

  constructor({ clientDemos }: { clientDemos: ClientDemos }) {
    this.cls = clientStaticState;
    this.state = clientRuntimeState;
    this.clientDemos = clientDemos;
    this.identityCvars = {
      name: null,
      color: null,
      rcon_password: null,
    };
    this.processingServerDataState = 0;
    this.lastServerMessages = [];
  }

  configureIdentityCvars({ name, color, rcon_password }: IdentityCvars): void {
    this.identityCvars.name = name;
    this.identityCvars.color = color;
    this.identityCvars.rcon_password = rcon_password;
  }

  setConnectingStep(percentage: number | null, message: string | null): void {
    if (percentage === null && message === null) {
      this.cls.connecting = null;
      return;
    }

    if (percentage === null || message === null) {
      throw new HostError('Connecting step percentage and message must both be provided');
    }

    Con.DPrint(`${percentage.toFixed(0).padStart(3, ' ')}% ${message}\n`);
    SCR.con_current = 0;

    const normalized = Math.round(percentage);

    this.cls.connecting = {
      percentage: normalized,
      message,
    };
  }

  getMessage(): number {
    if (this.clientDemos.demoplayback) {
      return this.clientDemos.getMessage();
    }

    const netcon = this.cls.netcon;

    if (netcon === null) {
      throw new HostError('CL.GetMessage: no active connection');
    }

    let result = 0;

    while (true) {
      result = NET.GetMessage(netcon);

      if (result !== 1 && result !== 2) {
        return result;
      }

      if (NET.message.cursize === 1 && new Uint8Array(NET.message.data, 0, 1)[0] === Protocol.svc.nop) {
        Con.DPrint('<-- server to client keepalive\n');
      } else {
        break;
      }
    }

    if (this.clientDemos.demorecording) {
      this.clientDemos.writeDemoMessage();
    }

    return result;
  }

  sendCmd(): void {
    if (this.cls.state === Def.clientConnectionState.disconnected) {
      return;
    }

    if (this.cls.signon === 4) {
      ClientInput.BaseMove();
      IN.Move();
      ClientInput.SendMove();

      this.cls.message.writeByte(Protocol.clc.sync);
      this.cls.message.writeFloat(this.state.clientMessages.mtime[0]);
    } else if (!this.cls.isLocalGame && Host.realtime - this.cls.lastcmdsent > 10.0) {
      Con.DPrint('<-- client to server keepalive\n');
    }

    if (this.cls.demoplayback) {
      this.cls.message.clear();
      return;
    }

    if (this.cls.message.cursize === 0) {
      return;
    }

    const netcon = this.cls.netcon;

    if (netcon === null) {
      throw new HostError('CL.SendCmd: no active connection');
    }

    if (!NET.CanSendMessage(netcon)) {
      Con.DPrint('CL.SendCmd: can\'t send\n');
      return;
    }

    if (NET.SendMessage(netcon, this.cls.message) === -1) {
      throw new HostError('CL.SendCmd: lost server connection');
    }

    this.cls.message.clear();
    this.cls.lastcmdsent = Host.realtime;
  }

  resetCheatCvars(): void {
    for (const cvar of Cvar.Filter((candidate) => (candidate.flags & Cvar.FLAG.CHEAT) !== 0)) {
      cvar.reset();
    }
  }

  clearState(): void {
    S.StopAllSounds();

    Con.DPrint('Clearing client model views\n');
    Mod.ClearAll(ModelScope.client);
    this.cls.signon = 0;

    this.setConnectingStep(null, null);

    this.state.clear();
    this.cls.clear();
    this.processingServerDataState = 0;
    this.lastServerMessages.length = 0;
  }

  disconnect(): void {
    this.setConnectingStep(null, null);
    S.StopAllSounds();

    if (this.state.gameAPI !== null) {
      this.state.gameAPI.shutdown();
      this.state.gameAPI = null;
    }

    if (this.cls.demoplayback) {
      this.clientDemos.stopPlayback();
    } else if (this.cls.state === Def.clientConnectionState.connecting) {
      this.cls.state = Def.clientConnectionState.disconnected;
      this.cls.message.clear();
    } else if (this.cls.state === Def.clientConnectionState.connected) {
      if (this.cls.demorecording) {
        void Cmd.ExecuteString('stopdemo\n');
      }
      Con.DPrint('Sending clc_disconnect\n');
      this.cls.message.clear();
      this.cls.message.writeByte(Protocol.clc.disconnect);
      if (this.cls.netcon !== null) {
        NET.SendUnreliableMessage(this.cls.netcon, this.cls.message);
      }
      this.cls.message.clear();
      if (this.cls.netcon !== null) {
        NET.Close(this.cls.netcon);
      }
      this.cls.state = Def.clientConnectionState.disconnected;
      if (SV.server.active) {
        Host.ShutdownServer();
      }
    }

    this.clearState();
    this.cls.signon = 0;
    this.cls.changelevel = false;
    this.resetCheatCvars();
    eventBus.publish('client.disconnected');
  }

  checkConnectingState(): void {
    const sock = this.cls.netcon;

    if (sock === null) {
      throw new HostError('CL.CheckConnectingState: no active connection');
    }

    switch (sock.state) {
      case QSocket.STATE_CONNECTED:
        this.cls.lastcmdsent = Host.realtime;
        Con.DPrint(`CL.Connect: connected to ${sock.address}\n`);
        this.cls.demonum = -1;
        this.cls.state = Def.clientConnectionState.connected;
        this.cls.signon = 0;
        this.setConnectingStep(10, `Connecting to ${sock.address}`);
        eventBus.publish('client.connected', sock.address);
        break;

      case QSocket.STATE_CONNECTING:
        break;

      case QSocket.STATE_DISCONNECTED:
        throw new HostError('CL.CheckConnectingState: connection failed');
    }
  }

  connect(host: string): void {
    if (this.cls.demoplayback) {
      return;
    }

    this.disconnect();
    this.setConnectingStep(5, `Connecting to ${host}`);

    this.cls.isLocalGame = host === 'local';
    this.cls.state = Def.clientConnectionState.connecting;
    this.cls.lastcmdsent = Host.realtime;

    eventBus.publish('client.connecting', host);

    const sock = NET.Connect(host);

    if (sock === null) {
      throw new HostError('CL.Connect: connect failed\n');
    }

    this.cls.netcon = sock;
  }

  signonReply(): void {
    Con.DPrint(`CL.SignonReply: ${this.cls.signon}\n`);

    switch (this.cls.signon) {
      case 1:
        this.setConnectingStep(90, 'Waiting for server data');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('prespawn');
        break;
      case 2: {
        const name = this.identityCvars.name;
        const color = this.identityCvars.color;

        if (name === null || color === null) {
          throw new HostError('Client identity cvars must be configured before signon');
        }

        eventBus.publish('client.server-info.ready', Object.assign({}, this.cls.serverInfo));
        this.setConnectingStep(95, 'Setting client state');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString(`name "${name.string}"\n`);
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString(`color ${color.value >> 4} ${color.value & 15}\n`);
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString(`spawn ${this.cls.spawnparms}`);
        break;
      }
      case 3:
        this.setConnectingStep(100, 'Joining the game!');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('begin');
        break;
      case 4:
        this.setConnectingStep(null, null);
        SCR.EndLoadingPlaque();
        Con.forcedup = true;
        SCR.con_current = 0;
        this.cls.changelevel = false;
        S.LoadPendingFiles();
        break;
      default:
        throw new HostError(`Received invalid signon state: ${this.cls.signon}`);
    }

    eventBus.publish('client.signon', this.cls.signon);
  }

  readFromServer(): void {
    while (true) {
      if (this.processingServerDataState === 1) {
        return;
      }

      let ret = 0;
      if (this.processingServerDataState === 2) {
        this.processingServerDataState = 3;
      } else {
        ret = this.getMessage();
        if (ret === -1) {
          throw new HostError('CL.ReadFromServer: lost server connection');
        }
        if (ret === 0) {
          break;
        }
      }

      this.state.last_received_message = Host.realtime;
      this.parseServerMessage();
      if (this.cls.state !== Def.clientConnectionState.connected) {
        break;
      }
    }
  }

  parseServerMessage(): void {
    parseServerCommandMessage();
  }

  printLastServerMessages(): void {
    if (this.lastServerMessages.length === 0) {
      return;
    }

    Con.Print('Last server messages:\n');
    for (const cmd of this.lastServerMessages) {
      Con.Print(` ${cmd}\n`);
    }
  }
}
