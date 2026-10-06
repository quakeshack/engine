import type { SerializedData } from '../../shared/GameInterfaces.ts';
import type { ServerClientSpawnParameters } from '../server/Client.ts';

/** The server's half of a savegame. The page adds its own half and writes the file. */
export interface ServerSaveState {
  readonly version: number;
  readonly gameversion: string;
  readonly spawn_parms: ServerClientSpawnParameters;
  readonly mapname: string;
  readonly time: number;
  readonly lightstyles: string[];
  readonly globals: SerializedData;
  readonly cvars: Array<[name: string, value: string]>;
  readonly edicts: Array<[classname: string, data: SerializedData] | null>;
  readonly num_edicts: number;
}

/** Why a game cannot be saved right now, or what to save. */
export type ServerSaveResult =
  | { readonly ok: true; readonly state: ServerSaveState }
  | { readonly ok: false; readonly reason: string };

/** The entity the development commands `viewmodel`, `viewframe`, `viewnext` and `viewprev` act on. */
export interface ViewthingState {
  readonly modelindex: number;
  readonly frame: number;
}

/**
 * Something the game on the server wants the session to do, which only the client side can carry out:
 * the level change or restart has to reset the client, show the loading plaque and reconnect. The
 * server in the page's thread runs these as console commands of the shared table, a server in a
 * worker sends them as events (see `ServerWorkerProtocol`).
 */
export type SessionRequest =
  | { readonly kind: 'changelevel'; readonly mapname: string }
  | { readonly kind: 'restart' };

/**
 * Read-only facts about the local server that the client side is allowed to know.
 *
 * Today these are read straight from the in-thread server. Once the server runs in its own worker
 * they are a mirror kept up to date over the control channel, so nothing on the client side may
 * rely on anything beyond this shape.
 */
export interface ServerStateMirror {
  /** Whether a server is up and simulating. */
  readonly active: boolean;
  /** Player slots of the running server, `1` for single player. */
  readonly maxclients: number;
  /** Map the server is running, `null` when there is none. */
  readonly mapname: string | null;
  /** Whether a player paused the game. */
  readonly paused: boolean;
}

/**
 * The control plane between the client runtime and the local server it hosts (single player or a
 * listen server). Everything the client does to or asks of the server goes through here instead of
 * reaching into `SV`, so the implementation can move to another thread without the callers noticing.
 *
 * The data plane, the game protocol itself, does not pass through here: the client talks to the
 * server over its own socket like any remote player.
 */
export interface ServerController {
  /** The server facts the client side may read. */
  readonly state: ServerStateMirror;

  /**
   * Brings the server up for use: a server in a worker boots it and loads the game there, so cvars
   * a game registers exist before the first console command. Settles when it can take requests.
   */
  init(): Promise<void>;

  /**
   * Tells the server whether it may run the world at all while it is below multiplayer capacity,
   * e.g. `false` while a menu has the game paused.
   */
  setSimulationAllowed(allowed: boolean): void;

  /**
   * Gives the local server its turn for this client frame. The in-thread implementation runs a
   * server frame right here; a worker implementation steps on command arrival instead and does
   * nothing.
   * @param frametime Seconds the frame advances the world by.
   * @param realtime Wall-clock seconds.
   */
  runLocalFrame(frametime: number, realtime: number): void;

  /**
   * Starts a fresh game on a map, shutting down a running server first.
   * @returns False when the map could not be spawned; the server is shut down again then.
   */
  start(mapname: string): Promise<boolean>;

  /**
   * Tells every client that a level change is coming, and holds the server frame until it
   * happened. Follow up with `changelevel()` on the next frame.
   */
  announceChangelevel(mapname: string): void;

  /**
   * Moves the running game to another map, keeping the players' spawn parameters.
   * @returns False when the map could not be spawned; the server is shut down again then.
   */
  changelevel(mapname: string): Promise<boolean>;

  /** Shuts the server down. Does nothing when none is running. */
  stop(isCrashShutdown?: boolean): void;

  /**
   * Makes the server's cvars and commands usable from the console of this thread: its cvars exist here
   * and follow it, and the commands only it has are forwarded to it. Call once, after every cvar of this
   * thread was registered, because the ones both sides register keep this thread's value.
   */
  attachConsole(): void;

  /**
   * Collects the server's half of a savegame.
   * @returns The state, or why the game cannot be saved now.
   */
  saveState(): Promise<ServerSaveResult>;

  /**
   * Starts the map of a savegame and puts the server's half of it back.
   * @param state The server's half of the savegame.
   * @param source Where the savegame came from, named in errors.
   * @throws HostError when the map cannot be spawned or the savegame does not match the game.
   */
  restoreState(state: ServerSaveState, source: string): Promise<void>;

  /**
   * Reads the entity the `view*` commands act on.
   * @returns Its model and frame, `null` when the map has none.
   */
  getViewthing(): Promise<ViewthingState | null>;

  /** Shows another frame of the entity the `view*` commands act on. */
  setViewthingFrame(frame: number): Promise<void>;
}
