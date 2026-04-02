import * as Protocol from '../network/Protocol.ts';
import { HostError } from '../common/Errors.mjs';
import Cvar from '../common/Cvar.mjs';
import Cmd from '../common/Cmd.mjs';
import ClientInput from './ClientInput.mjs';
import { clientRuntimeState, clientStaticState } from './ClientState.mjs';
import { eventBus, registry } from '../registry.mjs';
import * as Def from '../common/Def.mjs';
import { QSocket } from '../network/NetworkDrivers.ts';
import { parseServerMessage as parseServerCommandMessage } from './ClientServerCommandHandlers.mjs';

let { Con, Host, IN, Mod, NET, SCR, S, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Host = registry.Host;
  IN = registry.IN;
  Mod = registry.Mod;
  NET = registry.NET;
  SCR = registry.SCR;
  S = registry.S;
  SV = registry.SV;
});

export default class ClientConnection {
  constructor({ clientDemos }) {
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

  configureIdentityCvars({ name, color, rcon_password }) {
    this.identityCvars.name = name;
    this.identityCvars.color = color;
    this.identityCvars.rcon_password = rcon_password;
  }

  setConnectingStep(percentage, message) {
    if (percentage === null && message === null) {
      this.cls.connecting = null;
      return;
    }

    Con.DPrint(`${percentage.toFixed(0).padStart(3, ' ')}% ${message}\n`);
    SCR.con_current = 0;

    const normalized = Math.round(percentage);

    this.cls.connecting = {
      percentage: normalized,
      message,
    };
  }

  getMessage() {
    if (this.clientDemos.demoplayback === true) {
      return this.clientDemos.getMessage();
    }

    let r = null;

    while (true) {
      r = NET.GetMessage(this.cls.netcon);

      if (r !== 1 && r !== 2) {
        return r;
      }

      if (NET.message.cursize === 1 && (new Uint8Array(NET.message.data, 0, 1))[0] === Protocol.svc.nop) {
        Con.DPrint('<-- server to client keepalive\n');
      } else {
        break;
      }
    }

    if (this.clientDemos.demorecording) {
      this.clientDemos.writeDemoMessage();
    }

    return r;
  }

  sendCmd() {
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

    if (NET.CanSendMessage(this.cls.netcon) !== true) {
      Con.DPrint('CL.SendCmd: can\'t send\n');
      return;
    }

    if (NET.SendMessage(this.cls.netcon, this.cls.message) === -1) {
      throw new HostError('CL.SendCmd: lost server connection');
    }

    this.cls.message.clear();
    this.cls.lastcmdsent = Host.realtime;
  }

  resetCheatCvars() {
    for (const cvar of Cvar.Filter((cvar) => (cvar.flags & Cvar.FLAG.CHEAT) !== 0)) {
      cvar.reset();
    }
  }

  clearState() {
    S.StopAllSounds();

    Con.DPrint('Clearing client model views\n');
    Mod.ClearAll(Mod.scope.client);
    this.cls.signon = 0;

    this.setConnectingStep(null, null);

    this.state.clear();
    this.cls.clear();
    this.processingServerDataState = 0;
    this.lastServerMessages.length = 0;
  }

  disconnect() {
    this.setConnectingStep(null, null);
    S.StopAllSounds();

    if (this.state.gameAPI) {
      this.state.gameAPI.shutdown();
      this.state.gameAPI = null;
    }

    if (this.cls.demoplayback === true) {
      this.clientDemos.stopPlayback();
    } else if (this.cls.state === Def.clientConnectionState.connecting) {
      this.cls.state = Def.clientConnectionState.disconnected;
      this.cls.message.clear();
    } else if (this.cls.state === Def.clientConnectionState.connected) {
      if (this.cls.demorecording === true) {
        Cmd.ExecuteString('stopdemo\n');
      }
      Con.DPrint('Sending clc_disconnect\n');
      this.cls.message.clear();
      this.cls.message.writeByte(Protocol.clc.disconnect);
      NET.SendUnreliableMessage(this.cls.netcon, this.cls.message);
      this.cls.message.clear();
      NET.Close(this.cls.netcon);
      this.cls.state = Def.clientConnectionState.disconnected;
      if (SV.server.active === true) {
        Host.ShutdownServer();
      }
    }

    this.clearState();
    this.cls.signon = 0;
    this.cls.changelevel = false;
    this.resetCheatCvars();
    eventBus.publish('client.disconnected');
  }

  checkConnectingState() {
    const sock = this.cls.netcon;

    switch (sock.state) {
      case QSocket.STATE_CONNECTED:
        this.cls.lastcmdsent = Host.realtime;
        Con.DPrint('CL.Connect: connected to ' + sock.address + '\n');
        this.cls.demonum = -1;
        this.cls.state = Def.clientConnectionState.connected;
        this.cls.signon = 0;
        this.setConnectingStep(10, 'Connecting to ' + sock.address);
        eventBus.publish('client.connected', sock.address);
        break;

      case QSocket.STATE_CONNECTING:
        break;

      case QSocket.STATE_DISCONNECTED:
        throw new HostError('CL.CheckConnectingState: connection failed');
    }
  }

  connect(host) {
    if (this.cls.demoplayback === true) {
      return;
    }

    this.disconnect();
    this.setConnectingStep(5, 'Connecting to ' + host);

    this.cls.isLocalGame = (host === 'local');
    this.cls.state = Def.clientConnectionState.connecting;
    this.cls.lastcmdsent = Host.realtime;

    eventBus.publish('client.connecting', host);

    const sock = NET.Connect(host);

    if (sock === null) {
      throw new HostError('CL.Connect: connect failed\n');
    }

    this.cls.netcon = sock;
  }

  signonReply() {
    Con.DPrint('CL.SignonReply: ' + this.cls.signon + '\n');

    switch (this.cls.signon) {
      case 1:
        this.setConnectingStep(90, 'Waiting for server data');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('prespawn');
        break;
      case 2:
        eventBus.publish('client.server-info.ready', Object.assign({}, this.cls.serverInfo));
        this.setConnectingStep(95, 'Setting client state');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('name "' + this.identityCvars.name.string + '"\n');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('color ' + (this.identityCvars.color.value >> 4) + ' ' + (this.identityCvars.color.value & 15) + '\n');
        this.cls.message.writeByte(Protocol.clc.stringcmd);
        this.cls.message.writeString('spawn ' + this.cls.spawnparms);
        break;
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
        throw new HostError('Received invalid signon state: ' + this.cls.signon);
    }

    eventBus.publish('client.signon', this.cls.signon);
  }

  readFromServer() {
    while (true) {
      if (this.processingServerDataState === 1) {
        return;
      }

      let ret;
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

  parseServerMessage() {
    parseServerCommandMessage();
  }

  printLastServerMessages() {
    if (this.lastServerMessages.length === 0) {
      return;
    }

    Con.Print('Last server messages:\n');
    for (const cmd of this.lastServerMessages) {
      Con.Print(' ' + cmd + '\n');
    }
  }
}
