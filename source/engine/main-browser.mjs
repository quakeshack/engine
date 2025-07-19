import { registry, freeze as registryFreeze } from './registry.mjs';

import Sys from './client/Sys.mjs';
import COM from './common/Com.mjs';
import Cmd from './common/Cmd.mjs';
import Con from './common/Console.mjs';
import Host from './common/Host.mjs';
import V from './client/V.mjs';
import NET from './network/Network.mjs';
import SV from './server/Server.mjs';
import PR from './server/Progs.mjs';
import Mod from './common/Mod.mjs';
import Key from './client/Key.mjs';
import CL from './client/CL.mjs';
import S from './client/Sound.mjs';
import GL from './client/GL.mjs';
import Draw from './client/Draw.mjs';
import R from './client/R.mjs';
import M from './client/Menu.mjs';
import SCR from './client/SCR.mjs';
import CDAudio from './client/CDAudio.mjs';
import Sbar from './client/Sbar.mjs';
import IN from './client/IN.mjs';

export default class EngineLauncher {
  static async Launch() {
    console.log('Launching engine in browser mode...');

    // set some global flags
    registry.isDedicatedServer = false;

    // inject some external dependencies
    registry.WebSocket = window.WebSocket;

    // hooking up all required components
    registry.Sys = Sys;
    registry.COM = COM;
    registry.Con = Con;
    registry.Host = Host;
    registry.V = V;
    registry.NET = NET;
    registry.SV = SV;
    registry.PR = PR;
    registry.Mod = Mod;
    registry.Key = Key;
    registry.CL = CL;
    registry.S = S;
    registry.GL = GL;
    registry.Draw = Draw;
    registry.R = R;
    registry.M = M;
    registry.SCR = SCR;
    registry.CDAudio = CDAudio;
    registry.Sbar = Sbar;
    registry.IN = IN;

    // registry is ready
    registryFreeze();

    await Sys.Init();

    return registry;
  }
};
