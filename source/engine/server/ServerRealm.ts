import type { ConsoleOutput, SystemServices } from '../common/Services.ts';
import type { ServerRealmHost } from '../bootstrap/createServerRuntime.ts';

import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import type ServerHost from './ServerHost.ts';

type DeferredCallback = () => void | Promise<void>;

interface ScheduledFutureEntry {
  readonly time: number;
  readonly callback: DeferredCallback;
}

/** What a `ServerRealm` depends on. */
export interface ServerRealmDependencies {
  readonly sys: SystemServices;
  readonly con: ConsoleOutput;
  /** Engine version shown to clients, e.g. `1.2.2+abc123`. */
  readonly engineVersion: string;
  /** Called when something outside the frame loop failed, for example a helper worker. */
  readonly onCrash: (error: unknown) => void;
  /** Called when the server switches the view hack for a player who flies through walls on or off. */
  readonly onNoclipAnglehack?: (enabled: boolean) => void;
}

/**
 * The host of a realm that only runs a server, in a worker for example: frame timing, scheduling and
 * the engine-wide cvars the server code reads. It is what `Host` is for a process that has a client,
 * minus everything that has to do with one.
 */
export default class ServerRealm implements ServerRealmHost {
  /** Largest time step a frame may advance the world by, so a stall does not make the world jump. */
  static readonly MAX_FRAMETIME = 0.1;

  /** Smallest time step a frame advances the world by. */
  static readonly MIN_FRAMETIME = 0.001;

  readonly version: { readonly string: string };
  developer: Cvar | null = null;
  framerate: Cvar | null = null;
  speeds: Cvar | null = null;
  ticrate: Cvar | null = null;
  frametime = 0.0;
  realtime = 0.0;
  framecount = 0;
  serverHost: ServerHost | null = null;

  readonly #sys: SystemServices;
  readonly #onCrash: ServerRealmDependencies['onCrash'];
  readonly #onNoclipAnglehack: ServerRealmDependencies['onNoclipAnglehack'];
  #noclipAnglehack = false;
  readonly #scheduledForNextFrame: DeferredCallback[] = [];
  readonly #scheduledInFuture = new Map<string, ScheduledFutureEntry>();
  #oldrealtime = 0.0;

  constructor(dependencies: ServerRealmDependencies) {
    this.#sys = dependencies.sys;
    this.#onCrash = dependencies.onCrash;
    this.#onNoclipAnglehack = dependencies.onNoclipAnglehack;
    this.version = { string: dependencies.engineVersion };
  }

  /** Whether the local player flies through walls, which changes how their view is handled. */
  get noclip_anglehack(): boolean {
    return this.#noclipAnglehack;
  }

  set noclip_anglehack(enabled: boolean) {
    this.#noclipAnglehack = enabled;
    this.#onNoclipAnglehack?.(enabled);
  }

  /**
   * Registers the cvars of the realm. The command and cvar tables must exist already.
   */
  InitLocal(): void {
    this.framerate = new Cvar('host_framerate', '0');
    this.speeds = new Cvar('host_speeds', '0');
    this.ticrate = new Cvar('sys_ticrate', '0.05');
    this.developer = new Cvar('developer', '0');
    this.#oldrealtime = this.#sys.FloatTime();
  }

  ScheduleForNextFrame(callback: DeferredCallback): void {
    this.#scheduledForNextFrame.push(callback);
  }

  ScheduleInFuture(name: string, callback: DeferredCallback, whenInSeconds: number): void {
    if (this.#scheduledInFuture.has(name)) {
      return;
    }

    // The clock, not the time of the last frame: this may be called before the first frame ran.
    this.#scheduledInFuture.set(name, { time: this.#sys.FloatTime() + whenInSeconds, callback });
  }

  /**
   * Runs one frame: deferred work, console commands, and the server's turn.
   */
  async Frame(): Promise<void> {
    this.realtime = this.#sys.FloatTime();
    this.frametime = this.realtime - this.#oldrealtime;
    this.#oldrealtime = this.realtime;

    if (this.framerate !== null && this.framerate.value > 0) {
      this.frametime = this.framerate.value;
    } else {
      this.frametime = Math.min(ServerRealm.MAX_FRAMETIME, Math.max(ServerRealm.MIN_FRAMETIME, this.frametime));
    }

    while (this.#scheduledForNextFrame.length > 0) {
      const callback = this.#scheduledForNextFrame.shift();

      if (callback === undefined) {
        break;
      }

      await callback();
    }

    for (const [name, { time, callback }] of this.#scheduledInFuture.entries()) {
      if (time > this.realtime) {
        continue;
      }

      await callback();
      this.#scheduledInFuture.delete(name);
    }

    Cmd.Execute();
    this.serverHost?.Frame(this.frametime, this.realtime);
    this.framecount++;
  }

  /**
   * Reports a failure that happened outside of the frame loop, for example in a helper worker.
   * @param error What went wrong.
   */
  HandleCrash(error: unknown): void {
    this.#onCrash(error);
  }
}
