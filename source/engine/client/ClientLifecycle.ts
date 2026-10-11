import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import * as Def from '../common/Def.ts';
import ClientInput from './ClientInput.ts';
import CL from './CL.ts';
import { clientRuntimeState } from './ClientState.ts';
import GameModule from '../common/GameModule.ts';
import { MoveVars } from '../common/Pmove.ts';
import { engineApi } from './PageServices.ts';
import { eventBus } from '../common/EventBus.ts';
import type { SerializedParticle } from './renderer/effects/Particles.ts';
import type { SerializedClientEntity } from './ClientEntities.ts';
import clientCvars from './ClientCvars.ts';
import { clientPmove } from './ClientPhysics.ts';
import Host from '../common/Host.ts';


/** The client game can tell the menu what to do when a new game is requested. */
export interface StartGameInterface {
  startSingleplayerGame(): void;
  startMultiplayerGame(mapname: string): void;
}

/** Quake 1 default start game entries. */
export class DefaultStartGameFunctions implements StartGameInterface {
  startSingleplayerGame(): void {
    void Cmd.ExecuteString('map start');
  }

  startMultiplayerGame(mapname: string): void {
    void Cmd.ExecuteString(`map ${mapname}`);
  }
}

export default class ClientLifecycle {
  static startGame: StartGameInterface | null = null;

  static async init(): Promise<void> {
    CL.ClearState();
    ClientInput.Init();
    clientPmove.movevars = new MoveVars();
    clientCvars.register();
    this.#registerCommands();
    await clientRuntimeState.clientEntities.initTempEntities();
    CL.ConfigureConnectionIdentity({ name: clientCvars.name, color: clientCvars.color, rcon_password: clientCvars.rcon_password });
    this.initGame();
  }

  static initGame(): void {
    const hostVersion = Host.version;
    const activeGameModule = GameModule.active;

    console.assert(hostVersion !== null, 'Host.version must be registered before initGame');

    if (activeGameModule === null) {
      throw new Error('ClientLifecycle.initGame requires an active game module.');
    }

    document.title = `${activeGameModule.identification.name} (${activeGameModule.identification.version.join('.')}) on ${Def.productName} (${hostVersion?.string ?? ''})`;

    activeGameModule.ClientGameAPI.Init(engineApi);

    this.startGame = activeGameModule.ClientGameAPI.GetStartGameInterface(engineApi);

    if (!this.startGame) {
      this.startGame = new DefaultStartGameFunctions();
    }

    CL.gameCapabilities = [...activeGameModule.identification.capabilities];

    // Published rather than calling into the menu system directly -- `Menu.ts` already imports
    // this module (for `M.StartSingleplayerGame()`'s routing), so importing back would be
    // circular. Only fires once, right after the game module has registered its pages (including
    // the root), which is exactly when it becomes safe to push it.
    eventBus.publish('client.game-initialized');
  }

  static resumeGame(clientdata: string | null, particles: SerializedParticle[] | null, clientEntities: SerializedClientEntity[] | null): void {
    CL.Connect('local');
    clientRuntimeState.loadClientData = [clientdata, particles, clientEntities];
  }

  static #registerCommands(): void {
    Cmd.AddCommand('entities', class EntitiesCommand extends ConsoleCommand {
      override run(): void {
        clientRuntimeState.clientEntities.printEntities();
      }
    });
    Cmd.AddCommand('disconnect', CL.Disconnect);
    Cmd.AddCommand('record', CL.Record_f);
    Cmd.AddCommand('stop', CL.Stop_f);
    Cmd.AddCommand('playdemo', CL.PlayDemo_f);
    Cmd.AddCommand('timedemo', CL.TimeDemo_f);
    Cmd.AddCommand('startdemos', CL.StartDemos_f);
    Cmd.AddCommand('demos', CL.Demos_f);
    Cmd.AddCommand('stopdemo', CL.StopDemo_f);
    Cmd.AddCommand('rcon', CL.Rcon_f);
    Cmd.AddCommand('serverinfo', CL.ServerInfo_f);
    Cmd.AddCommand('movearound', CL.MoveAround_f);
  }
}
