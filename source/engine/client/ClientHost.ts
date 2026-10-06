/*
 * ClientHost: the client half of the old Host.
 *
 * Owns the client frame and the console commands that start, change and leave a game from the
 * player's side. It never touches the server directly: the game it hosts locally is driven
 * through `CL.serverController`.
 */

 

import * as Def from '../common/Def.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { HostError } from '../common/Errors.ts';
import PlayerColors from '../common/PlayerColors.ts';
import type { SessionRequest } from '../common/ServerController.ts';
import { getClientRegistry } from '../registry.ts';
import { eventBus } from '../common/EventBus.ts';
import Vector from '../../shared/Vector.ts';
import { content } from '../../shared/Defs.ts';
import CDAudio from './CDAudio.ts';
import InviteCommand from './InviteCommand.ts';
import NavigationDebug from './NavigationDebug.ts';
import Q from '../../shared/Q.ts';
import { KeyDestination } from './Key.ts';

let { CL, Con, Host, Key, M, NET, R, S, SCR } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Host, Key, M, NET, R, S, SCR } = getClientRegistry());
});

/**
 * Client runtime facade: frame loop and the player's session commands.
 */
export default class ClientHost {
  /**
   * Hooks the client up to the local server's life cycle. Call once, after the registry is frozen.
   */
  static Init(): void {
    // Kicks issued from the local console are issued by the local player.
    if (Host.serverHost !== null) {
      Host.serverHost.getLocalOperatorName = () => CL.name.string;
    }

    NavigationDebug.Init();

    Cmd.AddCommand('invite', InviteCommand);

    // Hints for the host of an online game, once the server is up and the player is in.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    eventBus.subscribe('server.spawned', async () => {
      await Q.sleep(5000);

      if (!NET.listening) {
        return;
      }

      Con.PrintSuccess('Online multiplayer game has been created!\n');
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
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

    // A local client leaves together with its server.
    eventBus.subscribe('server.shutting-down', () => {
      if (CL.cls.state === Def.clientConnectionState.connected) {
        CL.Disconnect();
      }
    });
  }

  /**
   * Whether the page is in a background tab, where the browser throttles its timers.
   * @returns True when the player cannot see the page.
   */
  static isPageHidden(): boolean {
    return (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
  }

  /**
   * Runs one client frame: network in, input, the local server's turn, prediction, drawing, sound.
   * @param frametime Seconds since the last frame.
   * @param realtime Wall-clock seconds.
   * @returns False while the client is still connecting and no full frame ran.
   */
  static Frame(frametime: number, realtime: number): boolean {
    if (CL.cls.state === Def.clientConnectionState.connecting) {
      CL.CheckConnectingState();
      SCR.UpdateScreen();
      return false;
    }

    Cmd.Execute();

    if (CL.cls.state === Def.clientConnectionState.connected) {
      CL.ReadFromServer();
    }

    const profiling = Host.speeds !== null && Host.speeds.value !== 0;

    if (profiling) {
      console.profile('CL.ClientFrame');
    }

    CL.ClientFrame();

    if (profiling) {
      console.profileEnd('CL.ClientFrame');
    }

    CL.SendCmd();

    // The server takes its turn right after the client sent its command, like a remote one would.
    // A hidden page only gets throttled timers, a single player world would crawl, so it waits for the player to come back.
    CL.serverController.setSimulationAllowed(M.AllowsSimulation() && !ClientHost.isPageHidden());
    CL.serverController.runLocalFrame(frametime, realtime);

    // Set up prediction for other players.
    CL.SetUpPlayerPrediction();

    if (profiling) {
      console.profile('CL.PredictMove');
    }

    // Do client-side motion prediction.
    CL.PredictMove();

    if (profiling) {
      console.profileEnd('CL.PredictMove');
    }

    // Set up prediction for other players.
    CL.SetUpPlayerPrediction();

    // Build a refresh entity list.
    CL.state.clientEntities.emit();

    SCR.UpdateScreen();

    if (profiling) {
      console.profile('S.Update');
    }

    if (CL.cls.signon === 4) {
      S.Update(R.refdef.vieworg, R.vpn, R.vright, R.vup, R.viewleaf ? R.viewleaf.contents <= content.CONTENT_WATER : false);
    } else {
      S.Update(Vector.origin, Vector.origin, Vector.origin, Vector.origin, false);
    }

    CDAudio.Update();

    if (profiling) {
      console.profileEnd('S.Update');
    }

    return true;
  }

  static Map_f(this: ConsoleCommand, mapname?: string, ...spawnparms: string[]): void {
    if (mapname === undefined) {
      Con.Print('Usage: map <map>\n');
      return;
    }

    if (this.client !== null) {
      return;
    }

    CL.cls.demonum = -1;
    CL.Disconnect();
    CL.serverController.stop();

    Key.destination = KeyDestination.game;
    SCR.BeginLoadingPlaque();
    CL.SetConnectingStep(5, 'Spawning server');
    CL.cls.spawnparms = spawnparms.join(' ');

    Host.ScheduleForNextFrame(async () => {
      if (!await CL.serverController.start(mapname)) {
        throw new HostError(`Could not spawn server with map ${mapname}`);
      }

      CL.SetConnectingStep(null, null);
      CL.Connect('local');
    });
  }

  static Changelevel_f(mapname?: string): void {
    if (mapname === undefined) {
      Con.Print('Usage: changelevel <levelname>\n');
      return;
    }

    if (!CL.serverController.state.active || CL.cls.demoplayback) {
      Con.Print('Only the server may changelevel\n');
      return;
    }

    CL.serverController.announceChangelevel(mapname);

    // This hack allows us to show the loading plaque while resetting the client renderer.
    CL.cls.changelevel = true;
    CL.cls.signon = 0;

    Host.ScheduleForNextFrame(async () => {
      if (!await CL.serverController.changelevel(mapname)) {
        throw new HostError(`Could not spawn server for changelevel to ${mapname}`);
      }

      CL.SetConnectingStep(null, null);
    });
  }

  /**
   * Carries out what the game on a server in another realm asked for: that server cannot reset this
   * client, so a level change or restart arrives here and runs as the matching console command.
   * @param request What the server asked for.
   */
  static HandleSessionRequest(request: SessionRequest): void {
    switch (request.kind) {
      case 'changelevel':
        // Asked twice before the first one ran (e.g. two triggers in one frame), the level changes once.
        if (!CL.cls.changelevel) {
          ClientHost.Changelevel_f(request.mapname);
        }
        break;

      case 'restart':
        void Cmd.ExecuteString('restart');
        break;

      default:
        break;
    }
  }

  static Restart_f(this: ConsoleCommand): void {
    const { state } = CL.serverController;

    if (state.active && !CL.cls.demoplayback && this.client === null) {
      void Cmd.ExecuteString(`map ${state.mapname}`);
    }
  }

  static Reconnect_f(): void {
    Con.PrintWarning('NOT IMPLEMENTED: reconnect\n'); // TODO: reimplement reconnect here
  }

  static Connect_f(address?: string): void {
    if (address === undefined) {
      Con.Print('Usage: connect <address>\n');
      Con.Print(' - <address> can be "self", connecting to the current domain name\n');
      return;
    }

    CL.cls.demonum = -1;

    if (CL.cls.demoplayback) {
      CL.StopPlayback();
      CL.Disconnect();
    }

    if (address === 'self') {
      const url = new URL(location.href);
      const path = !url.pathname.endsWith('/') ? `${url.pathname}/` : url.pathname;
      CL.Connect(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${path}api/`);
    } else {
      CL.Connect(address);
    }

    CL.cls.signon = 0;
  }

  /**
   * The local console's half of `name`: remember the name and tell the server it is connected to.
   * The server's half is `ServerHost.Name_f`.
   */
  static Name_f(this: ConsoleCommand, ...names: string[]): void { // signon 2, step 1
    Con.DPrint(`ClientHost.Name_f: ${this.client}\n`);

    if (names.length < 1) {
      Con.Print(`"name" is "${CL.name.string}"\n`);
      return;
    }

    Cvar.Set('_cl_name', names.join(' ').trim().substring(0, 15));

    if (CL.cls.state === Def.clientConnectionState.connected) {
      this.forward();
    }
  }

  /**
   * The local console's half of `color`: remember the colors and tell the server it is connected
   * to. The server's half is `ServerHost.Color_f`.
   */
  static Color_f(this: ConsoleCommand, ...argv: string[]): void { // signon 2, step 2
    Con.DPrint(`ClientHost.Color_f: ${this.client}\n`);

    if (argv.length === 0) {
      Con.Print(`"color" is "${CL.color.value >> 4} ${CL.color.value & 15}"\ncolor <0-13> [0-13]\n`);
      return;
    }

    const { top, bottom } = PlayerColors.parse(argv);
    Cvar.Set('_cl_color', PlayerColors.pack(top, bottom));

    if (CL.cls.state === Def.clientConnectionState.connected) {
      this.forward();
    }
  }

  static InitCommands(): void {
    Cmd.AddCommand('map', ClientHost.Map_f);
    Cmd.AddCommand('restart', ClientHost.Restart_f);
    Cmd.AddCommand('changelevel', ClientHost.Changelevel_f);
    Cmd.AddCommand('connect', ClientHost.Connect_f);
    Cmd.AddCommand('reconnect', ClientHost.Reconnect_f);
  }
}
