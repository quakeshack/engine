/*
 * Host: what every process that runs the engine shares: the clock of the main loop, the work scheduled
 * for later, the cvars that belong to the loop, writing the configuration and the way errors are reported.
 *
 * It knows nothing about a client or a server. How a process starts, runs a frame and stops is the business of
 * `client/ClientHost.ts` and `bootstrap/DedicatedHost.ts`, which also install what happens when the host hits an error.
 */

import type { HostAlertEvent } from '../../shared/GameInterfaces.ts';
import type ServerHost from '../server/ServerHost.ts';

import Cvar from './Cvar.ts';
import * as Def from './Def.ts';
import Cmd, { ConsoleCommand } from './Cmd.ts';
import { eventBus } from './EventBus.ts';
import { HostError } from './Errors.ts';
import Con from './Console.ts';

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

/** Where the host writes the configuration to. */
export interface HostFiles {
  /**
   * Writes a user file.
   * @returns True when it was written.
   */
  WriteTextFile(filename: string, content: string): Promise<boolean>;
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
 * Host singleton: the state of the main loop that the rest of the engine reads (`Host.realtime`, `Host.frametime`),
 * and the scheduler for deferred work. Imported directly, nothing needs to look it up.
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

  /** Where the configuration is written to. Set by the composition root of the process. */
  static files: HostFiles | null = null;

  /** The part of the configuration only a client has, its key bindings. Set by the client. */
  static configExtras: (() => string) | null = null;

  /**
   * What a process does to recover from an error the host reports, e.g. shut the local server down and leave the game.
   * Set by `ClientHost` or `DedicatedHost`.
   */
  static recoverFromError: () => void = () => {};

  /** How a process ends once it cannot go on. Set by `ClientHost` or `DedicatedHost`. */
  static quit: () => void = () => {};

  /** Callbacks that must run before the next frame body starts. */
  static readonly _scheduledForNextFrame: DeferredCallback[] = [];

  /** Named deferred tasks used to coalesce repeated requests. */
  static readonly _scheduleInFuture = new Map<string, ScheduledFutureEntry>();

  static #inHandleCrash = false;

  /**
   * Reports an error the engine recovers from: prints it, lets the process clean up and tells the game.
   * @param error What went wrong.
   */
  static Error(error: string): never | void {
    if (Host.inerror) {
      throw new Error('throw new HostError: recursively entered');
    }

    Host.inerror = true;

    Con.PrintError(`Host Error: ${error}\n`);

    Host.recoverFromError();

    Host.inerror = false;
    eventBus.publish<[HostAlertEvent]>('host.alert', { title: 'Host Error', message: error, severity: 'error' });
  }

  /**
   * Registers the cvars of the loop. The command and cvar tables must exist already.
   * @param commitHash The commit the build was made from, if it knows one.
   * @param dedicated Whether this process runs a dedicated server.
   */
  static InitLocal(commitHash: string | undefined, dedicated: boolean): void {
    const version = commitHash ? `${Def.productVersion}+${commitHash}` : Def.productVersion;

    Host.version = new Cvar('version', version, Cvar.FLAG.READONLY);

    Host.refreshrate = new Cvar('host_refreshrate', '0', Cvar.FLAG.ARCHIVE, 'Affects main loop sleep time, keep it at 0 for vsync-based timing. Vanilla recommendation is 60.');
    Host.framerate = new Cvar('host_framerate', '0');
    Host.speeds = new Cvar('host_speeds', '0');
    Host.ticrate = new Cvar('sys_ticrate', '0.05');
    Host.developer = new Cvar('developer', '0');

    // CR: this is a leftover from QuakeC VM times, so that the game could query whether it is running in dedicated or not
    Host.dedicated = new Cvar('dedicated', dedicated ? '1' : '0', Cvar.FLAG.READONLY, 'Set to 1, if running in dedicated server mode.');

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

      const extras = Host.configExtras?.() ?? '';

      const config = `
  ${extras !== '' ? `${extras}\n\n\n` : ''}

  ${Cvar.WriteVariables()}

  configready
  `;

      await Host.files!.WriteTextFile('config.cfg', config);
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

  /**
   * Starts a frame: advances the clock and runs what was scheduled for it.
   * @param now Wall-clock seconds.
   */
  static async BeginFrame(now: number): Promise<void> {
    Host.realtime = now;
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
    Host.quit();
  }

  /**
   * Whether a crash is being handled, in which case the main loop must not run another frame.
   * @returns True while a crash is being reported.
   */
  static get crashing(): boolean {
    return Host.#inHandleCrash;
  }

  /**
   * Registers the commands every process has.
   */
  static InitCommands(): void {
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
