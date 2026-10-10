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
import type { HostAlertEvent } from '../../shared/GameInterfaces.ts';
import Particles, { type SerializedParticle } from './renderer/effects/Particles.ts';
import type { SerializedClientEntity } from './ClientEntities.ts';
import type { AliasModel } from '../common/model/AliasModel.ts';
import type { ServerSaveState, ViewthingState } from '../common/ServerController.ts';
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
import R from './R.ts';
import M from './Menu.ts';
import Host from '../common/Host.ts';
import GameModule from '../common/GameModule.ts';
import WorkerManager from '../common/WorkerManager.ts';
import PlatformWorker from '../common/PlatformWorker.ts';
import { Pmove } from '../common/Pmove.ts';
import { ModelScope, ModelType } from '../common/Mod.ts';
import Mod from '../common/Mod.ts';
import Chase from './Chase.ts';
import VID from './VID.ts';
import ClientLifecycle from './ClientLifecycle.ts';
import ConsoleOverlay from './ConsoleOverlay.ts';
import SaveSlots from './menu/SaveSlots.ts';
import Draw from './Draw.ts';
import IN from './IN.ts';
import Key from './Key.ts';
import S from './Sound.ts';
import SCR from './SCR.ts';
import V from './V.ts';
import { buildConfig, com, net, urls } from './PageServices.ts';
import Sys from './Sys.ts';

/** A savegame file: the server's half and what only the client knows. */
interface SavegameState extends ServerSaveState {
  readonly comment: string | null;
  readonly clientdata: string | null;
  readonly particles: SerializedParticle[];
  readonly clientEntities: SerializedClientEntity[];
}

/**
 * Client runtime facade: frame loop and the player's session commands.
 */
export default class ClientHost {
  /**
   * Hooks the client up to the local server's life cycle. Call once, after the page's services are installed.
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

      if (!net.listening) {
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

      if (!net.listening) {
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
      // A page that is closing has nothing left to leave: the renderer and the sound are gone already.
      if (!Host.isdown && clientStaticState.state === Def.clientConnectionState.connected) {
        CL.Disconnect();
      }
    });
  }

  /**
   * Boots the page: command and variable tables, the file system, the game module, the renderer, sound, input and
   * the menu, then runs the configuration. The server is either in this thread (`SV`) or in a worker.
   */
  static async Boot(): Promise<void> {
    Host.oldrealtime = Sys.FloatTime();

    // What the shared parts of the engine need from this realm.
    Host.files = com;
    Host.configExtras = () => Key.WriteBindings();
    Host.recoverFromError = () => { ClientHost.RecoverFromError(); };
    Host.quit = () => { Sys.Quit(); };
    Cmd.files = com;
    GameModule.com = com;
    WorkerManager.services = { con: Con, com, urls: () => urls ?? undefined };
    PlatformWorker.onCrash = (error) => { Host.HandleCrash(error); };

    Cmd.Init();
    Cvar.Init();

    V.Init(); // required for V.CalcRoll
    Chase.Init();

    await com.Init();
    ClientHost.InitLocal();
    Key.Init();

    Con.Init({ clock: () => Host.realtime, developer: () => Boolean(Host.developer?.value) });
    ConsoleOverlay.Init();

    const { serverHost } = Host;

    if (serverHost !== null) {
      await GameModule.Init(serverHost.sv.engineAPI);
    } else {
      // The server lives in a worker and loads the game there, this thread needs the client side of it.
      await Promise.all([clientStaticState.serverController.init(), GameModule.Init(null)]);
    }

    Mod.Init({
      files: com,
      con: Con,
      loadRenderData: true,
      keptClientModels: () => Object.keys(clientRuntimeState.clientEntities.tempEntityModels),
    });
    net.Init();
    Pmove.Init();
    serverHost?.sv.Init();

    S.Init();
    VID.Init();
    await Draw.Init();
    await R.Init();
    await M.Init();
    await SaveSlots.refresh();
    await CL.Init();
    SCR.Init();
    CDAudio.Init();
    IN.Init();

    // Every cvar of this thread exists now, so the server's can be joined with them before the configuration runs.
    clientStaticState.serverController.attachConsole();

    Cmd.text = `exec better-quake.rc\n${Cmd.text}`;
     
    Host.initialized = true;
    Sys.Print('========Host Initialized=========\n');

    eventBus.publish('host.ready');
  }

  /**
   * Stops the page's engine: writes the configuration and shuts the subsystems down.
   */
  static Shutdown(): void {
    if (Host.isdown) {
      Sys.Print('recursive shutdown\n');
      return;
    }

    eventBus.publish('host.shutting-down');
    Host.isdown = true;
    Host.WriteConfiguration();

    S.Shutdown();
    CDAudio.Shutdown();
    net.Shutdown();
    IN.Shutdown();
    VID.Shutdown();
    Pmove.Shutdown();
    Cmd.Shutdown();
    Cvar.Shutdown();
    eventBus.publish('host.shutdown');
  }

  /**
   * Runs one iteration of the page's main loop, and reports whatever goes wrong in it.
   */
  static async RunFrame(): Promise<void> {
    if (Host.crashing) {
      return;
    }

    try {
      await Host.BeginFrame(Sys.FloatTime());

      if (ClientHost.Frame(Host.frametime, Host.realtime)) {
        Host.framecount++;
      }
    } catch (error) {
      Host.HandleCrash(error as Error);
    }
  }

  /**
   * Registers the variables and commands of the page and hooks the client up to its local server.
   */
  static InitLocal(): void {
    ClientHost.InitCommands();
    Cmd.AddCommand('load', ClientHost.Loadgame_f);
    Cmd.AddCommand('save', ClientHost.Savegame_f);
    Cmd.AddCommand('viewmodel', ClientHost.Viewmodel_f);
    Cmd.AddCommand('viewframe', ClientHost.Viewframe_f);
    Cmd.AddCommand('viewnext', ClientHost.Viewnext_f);
    Cmd.AddCommand('viewprev', ClientHost.Viewprev_f);

    Host.serverHost?.InitCommands();
    Cmd.AddCommand('quit', ClientHost.Quit_f);
    Cmd.AddCommand('name', ClientHost.NameCommand);
    Cmd.AddCommand('color', ClientHost.ColorCommand);
    Host.InitCommands();

    Host.InitLocal(buildConfig?.commitHash ?? undefined, false);
    Host.serverHost?.InitLocal();

    clientStaticState.state = Def.clientConnectionState.disconnected;
    ClientHost.Init();
  }

  /** Shuts the local server down, wherever it runs. */
  static #ShutdownServer(): void {
    if (Host.serverHost !== null) {
      Host.serverHost.ShutdownServer();
      return;
    }

    clientStaticState.serverController.stop();
  }

  /**
   * What the page does after an error: the loading screen goes away, the local server stops and the player leaves the game.
   */
  static RecoverFromError(): void {
    SCR.EndLoadingPlaque();

    ClientHost.#ShutdownServer();

    CL.Disconnect();
    clientStaticState.demonum = -1;
  }

  /**
   * Ends the game the player is in, with a notice, or goes on with the next demo.
   * @param message Why it ended.
   */
  static EndGame(message: string): void {
    Con.PrintSuccess(`Host.EndGame: ${message}\n`);

    if (clientStaticState.demonum !== -1) {
      CL.NextDemo();
      return;
    }

    CL.Disconnect();
    eventBus.publish<[HostAlertEvent]>('host.alert', { title: 'Host.EndGame', message, severity: 'info' });
  }

  /**
   * The `quit` command: asks for confirmation via game code's own quit dialog (see
   * docs/events.md#host), unless typed directly into an already-open console (a deliberate
   * enough action to skip the confirmation). Published as an event rather than calling into
   * the menu system directly, same reasoning as `host.alert` -- the engine has no opinion on
   * what a quit confirmation looks like, or whether one exists at all.
   */
  static Quit_f(): void {
    if (!ConsoleOverlay.isOpen) {
      eventBus.publish('host.quit-requested');
      return;
    }

    ClientHost.ForceQuit();
  }

  /** Quits immediately, no confirmation — used once the player has already confirmed (e.g. the quit dialog's Yes). */
  static ForceQuit(): void {
    ClientHost.#ShutdownServer();

    com.Shutdown();
    Sys.Quit();
  }

  /**
   * `name` and `color` exist on both sides: typed into the local console they set the local
   * player's preference, sent by a client they change that client on the server. As long as both
   * run in one command table, this decides which one is meant.
   */
  static NameCommand(this: ConsoleCommand, ...names: string[]): void {
    if (this.client === null) {
      ClientHost.Name_f.call(this, ...names);
      return;
    }

    Host.serverHost?.name(this, ...names);
  }

  static ColorCommand(this: ConsoleCommand, ...argv: string[]): void {
    if (this.client === null) {
      ClientHost.Color_f.call(this, ...argv);
      return;
    }

    Host.serverHost?.color(this, ...argv);
  }

  static async Savegame_f(this: ConsoleCommand, savename?: string): Promise<void> {
    if (this.client !== null) {
      return;
    }

    if (savename === undefined) {
      Con.Print('Usage: save <savename>\n');
      return;
    }

    const { state } = clientStaticState.serverController;

    if (!state.active) {
      Con.PrintWarning('Not playing a local game.\n');
      return;
    }

    if (clientRuntimeState.intermission !== 0) {
      Con.PrintWarning('Can\'t save in intermission.\n');
      return;
    }

    if (state.maxclients !== 1) {
      Con.PrintWarning('Can\'t save multiplayer games.\n');
      return;
    }

    if (savename.includes('..')) {
      Con.PrintWarning('Relative pathnames are not allowed.\n');
      return;
    }

    // What the client knows is collected right now, the server's half arrives a moment later when it runs in a worker.
    const clientHalf = {
      comment: clientRuntimeState.levelname,
      clientdata: clientRuntimeState.gameAPI ? clientRuntimeState.gameAPI.saveGame() : null,
      particles: Particles.SerializeParticles(),
      clientEntities: clientRuntimeState.clientEntities.serialize(),
    };

    const result = await clientStaticState.serverController.saveState();

    if (!result.ok) {
      Con.PrintWarning(`${result.reason}\n`);
      return;
    }

    const gamestate: SavegameState = { ...result.state, ...clientHalf };
    const filename = com.DefaultExtension(savename, '.json');

    Con.Print(`Saving game to ${filename}...\n`);

    if (await com.WriteTextFile(filename, JSON.stringify(gamestate))) {
      await SaveSlots.refresh();
      Con.PrintSuccess('done.\n');
      return;
    }

    Con.PrintError('ERROR: couldn\'t open.\n');
  }

  static async Loadgame_f(this: ConsoleCommand, savename?: string): Promise<void> {
    if (this.client !== null) {
      return;
    }

    if (savename === undefined) {
      Con.Print('Usage: load <savename>\n');
      return;
    }

    if (savename.includes('..')) {
      Con.PrintWarning('Relative pathnames are not allowed.\n');
      return;
    }

    clientStaticState.demonum = -1;

    const filename = com.DefaultExtension(savename, '.json');

    Con.Print(`Loading game from ${filename}...\n`);

    const data = await com.LoadTextFile(filename);

    if (data === null) {
      Con.PrintError('ERROR: couldn\'t open.\n');
      return;
    }

    let gamestate: SavegameState;

    try {
      gamestate = JSON.parse(data) as SavegameState;
    } catch {
      throw new HostError(`Savegame ${filename} is corrupted or unreadable.`);
    }

    if (gamestate.version !== Def.gamestateVersion) {
      throw new HostError(`Savegame is version ${gamestate.version}, not ${Def.gamestateVersion}\n`);
    }

    CL.Disconnect();
    SCR.BeginLoadingPlaque();

    // The server takes its half, the client resumes with the other once the server is up.
    const { comment: _comment, clientdata, particles, clientEntities, ...serverHalf } = gamestate;

    try {
      await clientStaticState.serverController.restoreState(serverHalf, filename);
    } catch (error) {
      CL.SetConnectingStep(null, null);
      throw error;
    }

    ClientLifecycle.resumeGame(clientdata, particles, clientEntities);
  }

  /**
   * Reads the entity the `view*` commands act on, and says so when the map has none.
   * @returns The state of the entity, `null` when there is none.
   */
  static async #GetViewthing(): Promise<ViewthingState | null> {
    const viewthing = await clientStaticState.serverController.getViewthing();

    if (viewthing === null) {
      Con.Print('No viewthing on map\n');
    }

    return viewthing;
  }

  /**
   * Looks up the model of the viewthing among the models the client has.
   * @returns The alias model, `null` when the viewthing shows something else.
   */
  static #GetViewthingModel(viewthing: ViewthingState): AliasModel | null {
    const model = clientRuntimeState.model_precache[viewthing.modelindex >> 0];

    return model && model.type === ModelType.alias ? model as AliasModel : null;
  }

  static #PrintViewthingFrame(model: AliasModel, frame: number): void {
    const frameData = model.frames[frame];
    let frameName: string;

    if (frameData.group) {
      frameName = frameData.frames[0].name;
    } else {
      frameName = (frameData as Exclude<AliasModel['frames'][number], { group: true }>).name;
    }

    Con.Print(`frame ${frame}: ${frameName}\n`);
  }

  static async Viewmodel_f(model?: string): Promise<void> {
    if (model === undefined) {
      Con.Print('Usage: viewmodel <model>\n');
      return;
    }

    const viewthing = await ClientHost.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const loadedModel = await Mod.ForNameAsync(model, false, ModelScope.client);

    if (!loadedModel) {
      Con.Print(`Can't load ${model}\n`);
      return;
    }

    clientRuntimeState.model_precache[viewthing.modelindex] = loadedModel;
    await clientStaticState.serverController.setViewthingFrame(0);
  }

  static async Viewframe_f(frame?: string): Promise<void> {
    if (frame === undefined) {
      Con.Print('Usage: viewframe <frame>\n');
      return;
    }

    const viewthing = await ClientHost.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = ClientHost.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    await clientStaticState.serverController.setViewthingFrame(Math.min(Q.atoi(frame), model.frames.length - 1));
  }

  static async Viewnext_f(): Promise<void> {
    const viewthing = await ClientHost.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = ClientHost.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    const nextFrame = Math.min((viewthing.frame >> 0) + 1, model.frames.length - 1);

    await clientStaticState.serverController.setViewthingFrame(nextFrame);
    ClientHost.#PrintViewthingFrame(model, nextFrame);
  }

  static async Viewprev_f(): Promise<void> {
    const viewthing = await ClientHost.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = ClientHost.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    const nextFrame = Math.max((viewthing.frame >> 0) - 1, 0);

    await clientStaticState.serverController.setViewthingFrame(nextFrame);
    ClientHost.#PrintViewthingFrame(model, nextFrame);
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
