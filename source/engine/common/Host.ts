/*
 * Host: shared engine lifecycle coordinator for both browser and dedicated
 * runtimes.
 *
 * Owns startup and shutdown sequencing, the main frame loop, server lifecycle
 * transitions, and the classic host and gameplay console commands.
 */

/* eslint-disable jsdoc/require-returns */

import type { HostAlertEvent } from '../../shared/GameInterfaces.ts';
import type { SerializedParticle } from '../client/R.ts';
import type { SerializedClientEntity } from '../client/ClientEntities.ts';
import type { AliasModel } from './model/AliasModel.ts';
import type { ServerSaveState, ViewthingState } from './ServerController.ts';

import Cvar from './Cvar.ts';
import * as Def from './Def.ts';
import Cmd, { ConsoleCommand } from './Cmd.ts';
import { getClientRegistry, getCommonRegistry, registry } from '../registry.ts';
import { eventBus } from './EventBus.ts';
import Q from '../../shared/Q.ts';
import Chase from '../client/Chase.ts';
import VID from '../client/VID.ts';
import { HostError } from './Errors.ts';
import CDAudio from '../client/CDAudio.ts';
import ClientLifecycle from '../client/ClientLifecycle.ts';
import ClientHost from '../client/ClientHost.ts';
import SaveSlots from '../client/menu/SaveSlots.ts';
import type ServerHost from '../server/ServerHost.ts';
import GameModule from './GameModule.ts';
import { Pmove } from './Pmove.ts';
import { ModelScope, ModelType } from './Mod.ts';

let { COM, Con, Mod, NET, SV, Sys, V } = getCommonRegistry();
let { CL, Draw, IN, Key, M, R, S, SCR } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, Mod, NET, SV, Sys, V } = getCommonRegistry());
  ({ CL, Draw, IN, Key, M, R, S, SCR } = getClientRegistry());
});

type DeferredCallback = () => void | Promise<void>;
interface ScheduledFutureEntry {
  readonly time: number;
  readonly callback: DeferredCallback;
}
type CrashLike =
  | Error
  | string
  | null
  | undefined
  | {
      readonly name?: string;
      readonly message?: string;
      readonly constructor?: { readonly name?: string };
    };

/** A savegame file: the server's half and what only the client knows. */
interface SavegameState extends ServerSaveState {
  readonly comment: string | null;
  readonly clientdata: string | null;
  readonly particles: SerializedParticle[];
  readonly clientEntities: SerializedClientEntity[];
}

/** Extracts a display name from a CrashLike value. */
function crashName(error: CrashLike): string {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error === 'string') {
    return 'Error';
  }

  return error?.name ?? error?.constructor?.name ?? 'Error';
}

/** Extracts a human-readable message from a CrashLike value. */
function crashMessage(error: CrashLike): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return error?.message ?? 'Unknown error';
}

/**
 * Host lifecycle singleton.
 *
 * Historically this module was a mutable namespace object. It now uses a real
 * class with static state and methods so the engine can keep the existing
 * `Host.X` call sites while gaining native TypeScript typing.
 */
export default class Host {
  static developer: Cvar | null = null;
  static dedicated: Cvar | null = null;
  static framecount = 0;
  static framerate: Cvar | null = null;
  static frametime = 0.0;
  static initialized = false;

  /** The host of the server that runs in this process, installed by the launcher. `null` while the server runs in a worker. */
  static serverHost: ServerHost | null = null;
  static inerror = false;
  static isdown = false;
  static noclip_anglehack = false;
  static oldrealtime = 0.0;
  static realtime = 0.0;
  static refreshrate: Cvar | null = null;
  static speeds: Cvar | null = null;
  static ticrate: Cvar | null = null;
  static version: Cvar | null = null;

  /** Callbacks that must run before the next frame body starts. */
  static readonly _scheduledForNextFrame: DeferredCallback[] = [];

  /** Named deferred tasks used to coalesce repeated requests. */
  static readonly _scheduleInFuture = new Map<string, ScheduledFutureEntry>();

  static #inHandleCrash = false;

  static EndGame(message: string): void {
    Con.PrintSuccess(`Host.EndGame: ${message}\n`);

    if (CL.cls.demonum !== -1) {
      CL.NextDemo();
      return;
    }

    CL.Disconnect();
    eventBus.publish<[HostAlertEvent]>('host.alert', { title: 'Host.EndGame', message, severity: 'info' });
  }

  /** Shuts the local server down, wherever it runs. */
  static #ShutdownServer(): void {
    if (Host.serverHost !== null) {
      Host.serverHost.ShutdownServer();
      return;
    }

    CL.serverController.stop();
  }

  static Error(error: string): never | void {
    if (Host.inerror) {
      throw new Error('throw new HostError: recursively entered');
    }

    Host.inerror = true;

    if (!registry.isDedicatedServer) {
      SCR.EndLoadingPlaque();
    }

    Con.PrintError(`Host Error: ${error}\n`);

    Host.#ShutdownServer();

    CL.Disconnect();
    CL.cls.demonum = -1;
    Host.inerror = false;
    eventBus.publish<[HostAlertEvent]>('host.alert', { title: 'Host Error', message: error, severity: 'error' });
  }

  static InitLocal(): void {
    const commitHash = registry.buildConfig?.commitHash;
    const version = commitHash ? `${Def.productVersion}+${commitHash}` : Def.productVersion;

    Host.version = new Cvar('version', version, Cvar.FLAG.READONLY);

    Host.InitCommands();
    Host.refreshrate = new Cvar('host_refreshrate', '0', Cvar.FLAG.ARCHIVE, 'Affects main loop sleep time, keep it at 0 for vsync-based timing. Vanilla recommendation is 60.');
    Host.framerate = new Cvar('host_framerate', '0');
    Host.speeds = new Cvar('host_speeds', '0');
    Host.ticrate = new Cvar('sys_ticrate', '0.05');
    Host.developer = new Cvar('developer', '0');

    // CR: this is a leftover from QuakeC VM times, so that the game could query whether it is running in dedicated or not
    Host.dedicated = new Cvar('dedicated', registry.isDedicatedServer ? '1' : '0', Cvar.FLAG.READONLY, 'Set to 1, if running in dedicated server mode.');

    eventBus.subscribe('cvar.changed', (name: string) => {
      const cvar = Cvar.FindVar(name);

      if (cvar === null) {
        return;
      }

      // Automatically save when an archive Cvar changed.
      if ((cvar.flags & Cvar.FLAG.ARCHIVE) && Host.initialized) {
        Host.WriteConfiguration();
      }
    });

    Host.serverHost?.InitLocal();

    if (!registry.isDedicatedServer) {
      CL.cls.state = Def.clientConnectionState.disconnected;
      ClientHost.Init();
    }
  }

  static ConfigReady_f(): void {
    eventBus.publish('host.config.loaded');
    Con.DPrint('Loaded configuration\n');
  }

  static WriteConfiguration(): void {
    Host.ScheduleInFuture('Host.WriteConfiguration', async () => {
      // Never save a config during pending commands.
      if (Cmd.HasPendingCommands()) {
        Con.PrintWarning('Writing configuration dismissed, pending commands outstanding. Try again later.\n');
        return;
      }

      const config = `
  ${!registry.isDedicatedServer ? `${Key.WriteBindings()}\n\n\n` : ''}

  ${Cvar.WriteVariables()}

  configready
  `;

      await COM.WriteTextFile('config.cfg', config);
      Con.DPrint('Wrote configuration\n');
    }, 5.0);
  }

  static WriteConfiguration_f(): void {
    Con.Print('Writing configuration\n');
    Host.WriteConfiguration();
  }

  static ScheduleForNextFrame(callback: DeferredCallback): void {
    Host._scheduledForNextFrame.push(callback);
  }

  static ScheduleInFuture(name: string, callback: DeferredCallback, whenInSeconds: number): void {
    if (Host.isdown) {
      // There’s no future when shutting down.
      void callback();
      return;
    }

    if (Host._scheduleInFuture.has(name)) {
      return;
    }

    Host._scheduleInFuture.set(name, {
      time: Host.realtime + whenInSeconds,
      callback,
    });
  }

  static async _Frame(): Promise<void> {
    Host.realtime = Sys.FloatTime();
    Host.frametime = Host.realtime - Host.oldrealtime;
    Host.oldrealtime = Host.realtime;

    if (Host.framerate !== null && Host.framerate.value > 0) {
      Host.frametime = Host.framerate.value;
    } else if (Host.frametime > 0.1) {
      Host.frametime = 0.1;
    } else if (Host.frametime < 0.001) {
      Host.frametime = 0.001;
    }

    // Check all scheduled things for the next frame.
    while (Host._scheduledForNextFrame.length > 0) {
      const callback = Host._scheduledForNextFrame.shift();

      if (callback === undefined) {
        break;
      }

      await callback();
    }

    // Check what’s scheduled in the future.
    for (const [name, { time, callback }] of Host._scheduleInFuture.entries()) {
      if (time > Host.realtime) {
        continue;
      }

      await callback();
      Host._scheduleInFuture.delete(name);
    }

    if (registry.isDedicatedServer) {
      Cmd.Execute();
      Host.serverHost!.Frame(Host.frametime, Host.realtime);
      Host.framecount++;
      return;
    }

    if (ClientHost.Frame(Host.frametime, Host.realtime)) {
      Host.framecount++;
    }
  }

  // TODO: Sys.Init can handle a crash now since we are main looping without setInterval.
  static HandleCrash(error: CrashLike): void {
    if (error instanceof HostError) {
      Host.Error(error.message);
      return;
    }

    if (Host.#inHandleCrash) {
      console.error(error);
      // eslint-disable-next-line no-debugger
      debugger;
      return;
    }

    Host.#inHandleCrash = true;
    Con.PrintError(`${crashName(error)}: ${crashMessage(error)}\n`);
    eventBus.publish('host.crash', error);
    Sys.Quit();
  }

  static async Frame(): Promise<void> {
    if (Host.#inHandleCrash) {
      return;
    }

    try {
      await Host._Frame();
    } catch (error) {
      Host.HandleCrash(error as CrashLike);
    }
  }

  static async Init(): Promise<void> {
    Host.oldrealtime = Sys.FloatTime();
    Cmd.Init();
    Cvar.Init();

    V.Init(); // required for V.CalcRoll

    if (!registry.isDedicatedServer) {
      Chase.Init();
    }

    await COM.Init();
    Host.InitLocal();

    if (!registry.isDedicatedServer) {
      Key.Init();
    }

    Con.Init();

    if (SV !== undefined) {
      await GameModule.Init(SV.engineAPI);
    } else {
      // The server lives in a worker and loads the game there, this thread needs the client side of it.
      await Promise.all([CL.serverController.init(), GameModule.Init(null)]);
    }

    Mod.Init();
    NET.Init();
    Pmove.Init();
    SV?.Init();

    if (!registry.isDedicatedServer) {
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
    }

    // Every cvar of this thread exists now, so the server's can be joined with them before the configuration runs.
    if (!registry.isDedicatedServer) {
      CL.serverController.attachConsole();
    }

    Cmd.text = `exec better-quake.rc\n${Cmd.text}`;
    // eslint-disable-next-line require-atomic-updates
    Host.initialized = true;
    Sys.Print('========Host Initialized=========\n');

    eventBus.publish('host.ready');
  }

  static Shutdown(): void {
    if (Host.isdown) {
      Sys.Print('recursive shutdown\n');
      return;
    }

    eventBus.publish('host.shutting-down');
    Host.isdown = true;
    Host.WriteConfiguration();

    if (!registry.isDedicatedServer) {
      S.Shutdown();
      CDAudio.Shutdown();
    }

    NET.Shutdown();

    if (!registry.isDedicatedServer) {
      IN.Shutdown();
      VID.Shutdown();
    }

    Pmove.Shutdown();
    Cmd.Shutdown();
    Cvar.Shutdown();
    eventBus.publish('host.shutdown');
  }

  // Commands

  /**
   * The `quit` command: asks for confirmation via game code's own quit dialog (see
   * docs/events.md#host), unless typed directly into an already-open console (a deliberate
   * enough action to skip the confirmation). Published as an event rather than calling into
   * the menu system directly, same reasoning as `host.alert` -- the engine has no opinion on
   * what a quit confirmation looks like, or whether one exists at all.
   */
  static Quit_f(): void {
    if (!registry.isDedicatedServer && !Con.isOpen) {
      eventBus.publish('host.quit-requested');
      return;
    }

    Host.ForceQuit();
  }

  /** Quits immediately, no confirmation — used once the player has already confirmed (e.g. the quit dialog's Yes). */
  static ForceQuit(): void {
    Host.#ShutdownServer();

    COM.Shutdown();
    Sys.Quit();
  }

  static async Savegame_f(this: ConsoleCommand, savename?: string): Promise<void> {
    if (this.client !== null) {
      return;
    }

    if (savename === undefined) {
      Con.Print('Usage: save <savename>\n');
      return;
    }

    const { state } = CL.serverController;

    if (!state.active) {
      Con.PrintWarning('Not playing a local game.\n');
      return;
    }

    if (CL.state.intermission !== 0) {
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
      comment: CL.state.levelname,
      clientdata: CL.state.gameAPI ? CL.state.gameAPI.saveGame() : null,
      particles: R.SerializeParticles(),
      clientEntities: CL.state.clientEntities.serialize(),
    };

    const result = await CL.serverController.saveState();

    if (!result.ok) {
      Con.PrintWarning(`${result.reason}\n`);
      return;
    }

    const gamestate: SavegameState = { ...result.state, ...clientHalf };
    const filename = COM.DefaultExtension(savename, '.json');

    Con.Print(`Saving game to ${filename}...\n`);

    if (await COM.WriteTextFile(filename, JSON.stringify(gamestate))) {
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

    CL.cls.demonum = -1;

    const filename = COM.DefaultExtension(savename, '.json');

    Con.Print(`Loading game from ${filename}...\n`);

    const data = await COM.LoadTextFile(filename);

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
      await CL.serverController.restoreState(serverHalf, filename);
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
    const viewthing = await CL.serverController.getViewthing();

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
    const model = CL.state.model_precache[viewthing.modelindex >> 0];

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

    const viewthing = await Host.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const loadedModel = await Mod.ForNameAsync(model, false, ModelScope.client);

    if (!loadedModel) {
      Con.Print(`Can't load ${model}\n`);
      return;
    }

    CL.state.model_precache[viewthing.modelindex] = loadedModel;
    await CL.serverController.setViewthingFrame(0);
  }

  static async Viewframe_f(frame?: string): Promise<void> {
    if (frame === undefined) {
      Con.Print('Usage: viewframe <frame>\n');
      return;
    }

    const viewthing = await Host.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = Host.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    await CL.serverController.setViewthingFrame(Math.min(Q.atoi(frame), model.frames.length - 1));
  }

  static async Viewnext_f(): Promise<void> {
    const viewthing = await Host.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = Host.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    const nextFrame = Math.min((viewthing.frame >> 0) + 1, model.frames.length - 1);

    await CL.serverController.setViewthingFrame(nextFrame);
    Host.#PrintViewthingFrame(model, nextFrame);
  }

  static async Viewprev_f(): Promise<void> {
    const viewthing = await Host.#GetViewthing();

    if (viewthing === null) {
      return;
    }

    const model = Host.#GetViewthingModel(viewthing);

    if (model === null) {
      return;
    }

    const nextFrame = Math.max((viewthing.frame >> 0) - 1, 0);

    await CL.serverController.setViewthingFrame(nextFrame);
    Host.#PrintViewthingFrame(model, nextFrame);
  }

  /**
   * `name` and `color` exist on both sides: typed into the local console they set the local
   * player's preference, sent by a client they change that client on the server. As long as both
   * run in one command table, this decides which one is meant.
   */
  static Name_f(this: ConsoleCommand, ...names: string[]): void {
    if (this.client === null && !registry.isDedicatedServer) {
      ClientHost.Name_f.call(this, ...names);
      return;
    }

    Host.serverHost?.name(this, ...names);
  }

  static Color_f(this: ConsoleCommand, ...argv: string[]): void {
    if (this.client === null && !registry.isDedicatedServer) {
      ClientHost.Color_f.call(this, ...argv);
      return;
    }

    Host.serverHost?.color(this, ...argv);
  }

  static InitCommands(): void {
    if (registry.isDedicatedServer) {
      Host.serverHost!.InitDedicatedCommands();
    } else {
      ClientHost.InitCommands();
      Cmd.AddCommand('load', Host.Loadgame_f);
      Cmd.AddCommand('save', Host.Savegame_f);
      Cmd.AddCommand('viewmodel', Host.Viewmodel_f);
      Cmd.AddCommand('viewframe', Host.Viewframe_f);
      Cmd.AddCommand('viewnext', Host.Viewnext_f);
      Cmd.AddCommand('viewprev', Host.Viewprev_f);
    }

    Host.serverHost?.InitCommands();
    Cmd.AddCommand('quit', Host.Quit_f);
    Cmd.AddCommand('name', Host.Name_f);
    Cmd.AddCommand('color', Host.Color_f);
    Cmd.AddCommand('writeconfig', Host.WriteConfiguration_f);
    Cmd.AddCommand('configready', Host.ConfigReady_f);

    Cmd.AddCommand('error', class HostErrorCommand extends ConsoleCommand {
      override run(message = ''): void {
        throw new HostError(message);
      }
    });

    Cmd.AddCommand('fatalerror', class HostFatalErrorCommand extends ConsoleCommand {
      override run(message = ''): void {
        throw new Error(message);
      }
    });

    Cmd.AddCommand('eb_topics', class HostEventBusTopicsCommand extends ConsoleCommand {
      override run(): void {
        // TODO: do not allow this command when server is having cheats disabled.
        for (const topic of eventBus.topics.sort()) {
          Con.Print(`${topic}\n`);
        }
      }
    });

    Cmd.AddCommand('eb_publish', class HostEventBusPublishCommand extends ConsoleCommand {
      override run(eventName?: string, ...args: string[]): void {
        // TODO: do not allow this command when server is having cheats disabled.
        if (!eventName) {
          Con.Print(`Usage: ${this.command} <eventName> [args...]\n`);
          return;
        }

        if (!eventBus.topics.includes(eventName)) {
          Con.PrintError(`No such event topic: ${eventName}\n`);
          return;
        }

        eventBus.publish(eventName, ...args);
      }
    });
  }
}
