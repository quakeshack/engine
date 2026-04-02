import { registry, freeze as registryFreeze } from './registry.mjs';

import Sys from './client/Sys.mjs';
import COM from './common/Com.ts';
import Con from './common/Console.ts';
import Host from './common/Host.ts';
import V from './client/V.mjs';
import NET from './network/Network.ts';
import SV from './server/Server.mjs';
import PR from './server/Progs.mjs';
import Mod from './common/Mod.ts';
import Key from './client/Key.mjs';
import CL from './client/CL.mjs';
import S from './client/Sound.mjs';
import Draw from './client/Draw.mjs';
import R from './client/R.mjs';
import M from './client/Menu.mjs';
import SCR from './client/SCR.mjs';
import Sbar from './client/Sbar.mjs';
import IN from './client/IN.mjs';

export default class EngineLauncher {
  /**
   * @param {typeof registry.urls} urls URL builder functions
   * @param {typeof registry.buildConfig} buildConfig build information from Vite
   * @returns {Promise<import("./registry.mjs").registry>} engine registry
   */
  static async Launch(urls, buildConfig) {
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
};
