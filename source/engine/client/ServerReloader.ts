import type { ConsoleOutput } from '../common/Services.ts';
import type { SavegameState } from './ClientHost.ts';
import type { ServerWorkerHandle, WorkerServerControllerDependencies } from './WorkerServerController.ts';

import { ConsoleCommand } from '../common/Cmd.ts';

/** What `ServerReloader` is built from; the composition root of the page knows all of it. */
export interface ServerReloaderDependencies {
  /** The part of the controller that is replaced. */
  readonly controller: {
    readonly state: { readonly active: boolean; readonly mapname: string | null };
    replaceWorker(next: Pick<WorkerServerControllerDependencies, 'worker' | 'channel'>): Promise<void>;
  };
  /** Starts a new server worker from the bundle the build wrote last, with a channel of its own. */
  readonly spawn: () => { readonly worker: ServerWorkerHandle; readonly channel: WorkerServerControllerDependencies['channel'] };
  /** Points the network layer at the new channel; the old sockets are gone with the old server. */
  readonly attachChannel: (port: MessagePort) => void;
  /** Lets go of the remote players that were relayed to the old server. */
  readonly closePeers: () => void;
  /** Collects a savegame of the game that is running. */
  readonly capture: () => Promise<{ readonly ok: true; readonly state: SavegameState } | { readonly ok: false; readonly reason: string }>;
  /** Starts a game from a savegame state, on the server that is up. */
  readonly restore: (state: SavegameState, source: string) => Promise<void>;
  /** Makes the client let go of the server it is connected to. */
  readonly disconnect: () => void;
  /** Starts a map from scratch, as the `map` command does. */
  readonly startMap: (mapname: string) => void;
  readonly con: ConsoleOutput;
}

/**
 * Replaces the server worker of the page with a new one, so that a change of the game's server code takes effect
 * without reloading the page: the renderer, the textures and the menu stay, only the server and the level begin again.
 * Development builds only, see `server_reload`.
 *
 * The server's state is gone with the worker. By default it is put back through the savegame machinery (a capture on
 * the old server, a restore on the new one, so entities come back by classname with the new code); where that is
 * refused or fails the level starts from scratch.
 */
export default class ServerReloader {
  readonly #deps: ServerReloaderDependencies;
  #reloading = false;

  constructor(dependencies: ServerReloaderDependencies) {
    this.#deps = dependencies;
  }

  /**
   * Builds the console command for it.
   * @returns The `server_reload [restart]` command class to register.
   */
  createCommand(): new () => ConsoleCommand {
    const reload = (keepState: boolean): Promise<void> => this.reload(keepState);

    return class ServerReloadConsoleCommand extends ConsoleCommand {
      override async run(mode?: string): Promise<void> {
        if (this.client !== null) {
          return;
        }

        await reload(mode !== 'restart');
      }
    };
  }

  /**
   * Replaces the server worker and starts the level again.
   * @param keepState Put the entities and the game's state back, instead of starting the level from scratch.
   */
  async reload(keepState: boolean): Promise<void> {
    const { con, controller } = this.#deps;

    if (this.#reloading) {
      con.PrintWarning('The server is already being reloaded.\n');
      return;
    }

    this.#reloading = true;

    try {
      const { mapname } = controller.state;
      let saved: SavegameState | null = null;

      if (keepState && controller.state.active) {
        const captured = await this.#deps.capture();

        if (captured.ok) {
          saved = captured.state;
        } else {
          con.PrintWarning(`${captured.reason} The level starts from scratch.\n`);
        }
      }

      this.#deps.disconnect();
      this.#deps.closePeers();

      const next = this.#deps.spawn();

      this.#deps.attachChannel(next.channel.port1);
      await controller.replaceWorker(next);
      con.PrintSuccess('Server worker replaced.\n');

      await this.#resume(saved, mapname);
    } finally {
      this.#reloading = false;
    }
  }

  async #resume(saved: SavegameState | null, mapname: string | null): Promise<void> {
    const { con } = this.#deps;

    if (saved !== null) {
      try {
        await this.#deps.restore(saved, 'server_reload');
        return;
      } catch (error) {
        con.PrintWarning(`${error instanceof Error ? error.message.trim() : String(error)}\nThe level starts from scratch.\n`);
      }
    }

    if (mapname !== null) {
      this.#deps.startMap(mapname);
    }
  }
}
