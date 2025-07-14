
import { registry } from './registry.mjs';

import Sys from './common/SysNode.mjs';
import NodeCOM from './common/ComNode.mjs';
import Cmd from './common/Cmd.mjs';
import Con from './common/Console.mjs';
import Host from './common/Host.mjs';
import V from './client/V.mjs';
import NET from './network/Network.mjs';
import SV from './server/Server.mjs';
import PR from './server/Progs.mjs';
import Mod from './common/Mod.mjs';
import * as WebSocket from 'ws';

export default class EngineLauncher {
  static async Launch() {
    console.log('Launching engine as dedicated server...');

    registry.isDedicatedServer = true;

    // inject some external dependencies
    registry.WebSocket = WebSocket;

    // hooking up all required components
    registry.Sys = Sys;
    registry.COM = NodeCOM;
    registry.Cmd = Cmd;
    registry.Con = Con;
    registry.Host = Host;
    registry.V = V;
    registry.NET = NET;
    registry.SV = SV;
    registry.PR = PR;
    registry.Mod = Mod;

    try {
      await Sys.Init();
    } finally {
      // TODO: Host.Shutdown();
    }
  }
};
