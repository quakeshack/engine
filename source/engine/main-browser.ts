import type { BuildConfig, URLs } from './build-config';

import CL from './client/CL.ts';
import Draw from './client/Draw.ts';
import IN from './client/IN.ts';
import Key from './client/Key.ts';
import M from './client/Menu.ts';
import R from './client/R.ts';
import S from './client/Sound.ts';
import Sys from './client/Sys.ts';
import V from './client/V.ts';
import Sbar from './client/Sbar.ts';
import SCR from './client/SCR.ts';
import COM from './common/Com.ts';
import Con from './common/Console.ts';
import Host from './common/Host.ts';
import Mod from './common/Mod.ts';
import NET from './network/Network.ts';
import { freeze as registryFreeze, registry } from './registry.mjs';
import PR from './server/Progs.ts';
import SV from './server/Server.ts';

export default class EngineLauncher {
  static async Launch(urls: URLs, buildConfig: BuildConfig): Promise<typeof registry> {
    console.info('Launching engine in browser mode...');

    registry.urls = urls;
    registry.buildConfig = buildConfig;

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
    registry.Draw = Draw;
    registry.R = R;
    registry.M = M;
    registry.SCR = SCR;
    registry.Sbar = Sbar;
    registry.IN = IN;

    // registry is ready
    registryFreeze();

    await Sys.Init();

    return registry;
  }
}
