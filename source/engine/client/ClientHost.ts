/*
 * ClientHost: the client half of the old Host.
 *
 * Owns the client frame and the console commands that start, change and leave a game from the
 * player's side. It never touches the server directly: the game it hosts locally is driven
 * through `clientStaticState.serverController`.
 */

 

import * as Def from '../common/Def.ts';
import * as Protocol from '../network/Protocol.ts';
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
import Con from '../common/Console.ts';
import { clientRuntimeState, clientStaticState } from './ClientState.ts';
import clientCvars from './ClientCvars.ts';
import CL from './CL.ts';

let { Host, Key, M, NET, R, S, SCR } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host, Key, M, NET, R, S, SCR } = getClientRegistry());
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
      Host.serverHost.getLocalOperatorName = () => clientCvars.name.string;
    }

    NavigationDebug.Init();

    // What the shared console and variables need to know about the server this client is connected to.
    Cmd.forwardToServer = (command) => ClientHost.ForwardToServer(command);
    Cvar.serverState = {
      isServerActive: () => clientStaticState.serverController.state.active,
      reportedCheats: () => clientStaticState.serverInfo?.sv_cheats,
    };

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
      if (clientStaticState.state === Def.clientConnectionState.connected) {
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
    if (clientStaticState.state === Def.clientConnectionState.connecting) {
      CL.CheckConnectingState();
      SCR.UpdateScreen();
      return false;
    }

    Cmd.Execute();

    if (clientStaticState.state === Def.clientConnectionState.connected) {
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
    clientStaticState.serverController.setSimulationAllowed(M.AllowsSimulation() && !ClientHost.isPageHidden());
    clientStaticState.serverController.runLocalFrame(frametime, realtime);

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
    clientRuntimeState.clientEntities.emit();

    SCR.UpdateScreen();

    if (profiling) {
      console.profile('S.Update');
    }

    if (clientStaticState.signon === 4) {
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

  /**
   * Sends a console command to the server this client is connected to, in behalf of the player.
   * @param command The command that asked to be forwarded, `cmd` itself or one that forwards itself.
   * @returns True, the command is taken care of.
   */
  static ForwardToServer(command: ConsoleCommand): boolean {
    console.assert(command.client === null, 'must be executed locally');

    const argv = [...command.argv];
    let name = command.command;

    if (name !== null && name.toLowerCase() === 'cmd') {
      name = argv.shift() ?? null;
    }

    if (name === null) {
      Con.Print('Usage: cmd <command> <args>\n');
      return true;
    }

    if (clientStaticState.state !== Def.clientConnectionState.connected) {
      Con.Print(`Can't "${name}", not connected\n`);
      return true;
    }

    if (clientStaticState.demoplayback) {
      return true;
    }

    // send command to the server in behalf of the client
    clientStaticState.message.writeByte(Protocol.clc.stringcmd);
    clientStaticState.message.writeString(command.args ?? '');

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

    clientStaticState.demonum = -1;
    CL.Disconnect();
    clientStaticState.serverController.stop();

    Key.destination = KeyDestination.game;
    SCR.BeginLoadingPlaque();
    CL.SetConnectingStep(5, 'Spawning server');
    clientStaticState.spawnparms = spawnparms.join(' ');

    Host.ScheduleForNextFrame(async () => {
      if (!await clientStaticState.serverController.start(mapname)) {
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

    if (!clientStaticState.serverController.state.active || clientStaticState.demoplayback) {
      Con.Print('Only the server may changelevel\n');
      return;
    }

    clientStaticState.serverController.announceChangelevel(mapname);

    // This hack allows us to show the loading plaque while resetting the client renderer.
    clientStaticState.changelevel = true;
    clientStaticState.signon = 0;

    Host.ScheduleForNextFrame(async () => {
      if (!await clientStaticState.serverController.changelevel(mapname)) {
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
        if (!clientStaticState.changelevel) {
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
    const { state } = clientStaticState.serverController;

    if (state.active && !clientStaticState.demoplayback && this.client === null) {
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

    clientStaticState.demonum = -1;

    if (clientStaticState.demoplayback) {
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

    clientStaticState.signon = 0;
  }

  /**
   * The local console's half of `name`: remember the name and tell the server it is connected to.
   * The server's half is `ServerHost.Name_f`.
   */
  static Name_f(this: ConsoleCommand, ...names: string[]): void { // signon 2, step 1
    Con.DPrint(`ClientHost.Name_f: ${this.client}\n`);

    if (names.length < 1) {
      Con.Print(`"name" is "${clientCvars.name.string}"\n`);
      return;
    }

    Cvar.Set('_cl_name', names.join(' ').trim().substring(0, 15));

    if (clientStaticState.state === Def.clientConnectionState.connected) {
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
      Con.Print(`"color" is "${clientCvars.color.value >> 4} ${clientCvars.color.value & 15}"\ncolor <0-13> [0-13]\n`);
      return;
    }

    const { top, bottom } = PlayerColors.parse(argv);
    Cvar.Set('_cl_color', PlayerColors.pack(top, bottom));

    if (clientStaticState.state === Def.clientConnectionState.connected) {
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
