import type { ServerController, ServerSaveResult, ServerSaveState, ServerStateMirror, ViewthingState } from '../common/ServerController.ts';
import type Server from './Server.ts';
import type ServerHost from './ServerHost.ts';
import ServerSavegame from './ServerSavegame.ts';

/**
 * Controls a server that runs on the same thread as its client. It is a thin layer over
 * `ServerHost`; its worth is that clients only ever see the `ServerController` interface.
 */
export default class InThreadServerController implements ServerController {
  readonly state: ServerStateMirror;
  readonly #sv: Server;
  readonly #host: ServerHost;

  constructor(sv: Server, host: ServerHost) {
    this.#sv = sv;
    this.#host = host;
    this.state = {
      get active(): boolean {
        return sv.server.active;
      },
      get maxclients(): number {
        return sv.svs.maxclients;
      },
      get mapname(): string | null {
        return sv.server.mapname;
      },
      get paused(): boolean {
        return sv.server.paused;
      },
    };
  }

  // The server of this thread was built together with its client, there is nothing to boot.
  init(): Promise<void> {
    return Promise.resolve();
  }

  setSimulationAllowed(allowed: boolean): void {
    this.#host.simulationAllowed = allowed;
  }

  runLocalFrame(frametime: number, realtime: number): void {
    if (!this.#sv.server.active || this.#sv.svs.changelevelIssued) {
      return;
    }

    this.#host.Frame(frametime, realtime);
  }

  async start(mapname: string): Promise<boolean> {
    return await this.#host.StartMap(mapname);
  }

  announceChangelevel(mapname: string): void {
    this.#host.AnnounceChangelevel(mapname);
  }

  async changelevel(mapname: string): Promise<boolean> {
    return await this.#host.Changelevel(mapname);
  }

  stop(isCrashShutdown = false): void {
    this.#host.ShutdownServer(isCrashShutdown);
  }

  // The server shares the console of its client, its cvars and commands are the same ones.
  attachConsole(): void {
  }

  saveState(): Promise<ServerSaveResult> {
    return Promise.resolve(ServerSavegame.capture(this.#sv));
  }

  async restoreState(state: ServerSaveState, source: string): Promise<void> {
    await ServerSavegame.restore(this.#sv, state, source);
  }

  getViewthing(): Promise<ViewthingState | null> {
    return Promise.resolve(this.#host.getViewthing());
  }

  setViewthingFrame(frame: number): Promise<void> {
    this.#host.setViewthingFrame(frame);
    return Promise.resolve();
  }
}
