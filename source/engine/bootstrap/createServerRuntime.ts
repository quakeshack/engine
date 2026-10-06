import type COM from '../common/Com.ts';
import type { GameEdition } from '../common/GameApiSupport.ts';
import type NET from '../network/Network.ts';
import type { SystemServices } from '../common/Services.ts';
import type { ModelCache, PlayerView, ServerDependencies } from '../server/ServerDependencies.ts';

import { sharedCollisionModelSource } from '../common/CollisionModelSource.ts';
import Server from '../server/Server.ts';
import ServerHost from '../server/ServerHost.ts';

/** What a server runtime needs from the host process it lives in. */
export interface ServerRealmHost {
  /** The engine version shown to clients. */
  readonly version: { readonly string: string } | null;
  /** Whether per-frame profiling is switched on. */
  readonly speeds: { readonly value: number } | null;
  /** Runs a callback at the start of the next frame. */
  ScheduleForNextFrame(callback: () => void | Promise<void>): void;
  /** Set by the server's `noclip` command and read by whoever shows the view. */
  noclip_anglehack: boolean;
}

/** The realm services a server runtime is built from. */
export interface ServerRuntimeServices {
  readonly con: ServerDependencies['con'];
  readonly sys: SystemServices;
  readonly net: NET;
  readonly mod: ModelCache;
  readonly com: COM;
  readonly host: ServerRealmHost;
  readonly view: PlayerView;
  /** Which edition of the game data is in use, read when a game asks. */
  readonly gameEdition: () => GameEdition;
}

/** A server and the host that runs it. */
export interface ServerRuntime {
  readonly sv: Server;
  readonly serverHost: ServerHost;
}

/**
 * Builds the server runtime of a process: the `Server` with the parts that simulate and serve it,
 * and the `ServerHost` that drives its frames and answers its console commands.
 *
 * Browser clients and dedicated servers build the same thing, the only difference is `dedicated`.
 * @returns The server and its host.
 */
export function createServerRuntime(services: ServerRuntimeServices, dedicated: boolean): ServerRuntime {
  const { host } = services;

  const sv = new Server({
    con: services.con,
    sys: services.sys,
    net: services.net,
    mod: services.mod,
    view: services.view,
    files: services.com,
    collisionModelSource: sharedCollisionModelSource,
    engineVersion: () => host.version!.string,
    gameEdition: services.gameEdition,
    dedicated,
  });

  const serverHost = new ServerHost({
    sv,
    dedicated,
    scheduleForNextFrame: (callback) => { host.ScheduleForNextFrame(callback); },
    profiling: () => host.speeds !== null && host.speeds.value !== 0,
    setNoclipAnglehack: (enabled) => { host.noclip_anglehack = enabled; },
  });

  return { sv, serverHost };
}
