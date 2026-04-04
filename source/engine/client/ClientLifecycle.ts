import Cvar from '../common/Cvar.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import * as Def from '../common/Def.ts';
import { gameCapabilities } from '../../shared/Defs.ts';
import ClientInput from './ClientInput.ts';
import CL from './CL.ts';
import { clientRuntimeState } from './ClientState.ts';
import { MoveVars, Pmove } from '../common/Pmove.ts';
import { ClientEngineAPI } from '../common/GameAPIs.ts';
import { eventBus, getClientRegistry } from '../registry.ts';

let { Host, PR, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host, PR, S } = getClientRegistry());
});

/** The client game can tell the menu what to do when a new game is requested. */
export class StartGameInterface {
  startSingleplayerGame(): void {
  }

  startMultiplayerGame(_mapname: string): void {
  }
}

/** Quake 1 default start game entries. */
export class DefaultStartGameFunctions extends StartGameInterface {
  override startSingleplayerGame(): void {
    void Cmd.ExecuteString('map start');
  }

  override startMultiplayerGame(mapname: string): void {
    void Cmd.ExecuteString(`map ${mapname}`);
  }
}

export default class ClientLifecycle {
  static startGame: StartGameInterface | null = null;

  static async init(): Promise<void> {
    CL.ClearState();
    ClientInput.Init();
    CL.pmove = new Pmove();
    CL.pmove.movevars = new MoveVars();
    this.#registerCvars();
    this.#registerCommands();
    await clientRuntimeState.clientEntities.initTempEntities();
    CL.ConfigureConnectionIdentity({ name: CL.name, color: CL.color, rcon_password: CL.rcon_password });
    CL.sfx_talk = S.PrecacheSound('misc/talk.wav');
    this.initGame();
    CL.sbarDisabled = CL.gameCapabilities.includes(gameCapabilities.CAP_HUD_INCLUDES_SBAR);
  }

  static initGame(): void {
    CL.gameCapabilities = [...PR.capabilities];

    if (!PR.QuakeJS?.identification) {
      document.title = `${Def.productName} (${Host.version.string})`;
      return;
    }

    document.title = `${PR.QuakeJS.identification.name} (${PR.QuakeJS.identification.version.join('.')}) on ${Def.productName} (${Host.version.string})`;

    if (PR.QuakeJS.ClientGameAPI) {
      PR.QuakeJS.ClientGameAPI.Init(ClientEngineAPI);

      this.startGame = PR.QuakeJS.ClientGameAPI.GetStartGameInterface(ClientEngineAPI);
    }

    if (!this.startGame) {
      this.startGame = new DefaultStartGameFunctions();
    }

    CL.gameCapabilities = [...PR.QuakeJS.identification.capabilities];
  }

  static resumeGame(clientdata: string | null, particles: string | null): void {
    CL.Connect('local');
    clientRuntimeState.loadClientData = [clientdata, particles];
  }

  static #registerCvars(): void {
    CL.name = new Cvar('_cl_name', 'player', Cvar.FLAG.ARCHIVE);
    CL.color = new Cvar('_cl_color', '0', Cvar.FLAG.ARCHIVE);
    CL.upspeed = new Cvar('cl_upspeed', '200');
    CL.forwardspeed = new Cvar('cl_forwardspeed', '400', Cvar.FLAG.ARCHIVE);
    CL.backspeed = new Cvar('cl_backspeed', '400', Cvar.FLAG.ARCHIVE);
    CL.sidespeed = new Cvar('cl_sidespeed', '350');
    CL.movespeedkey = new Cvar('cl_movespeedkey', '2.0');
    CL.yawspeed = new Cvar('cl_yawspeed', '140');
    CL.pitchspeed = new Cvar('cl_pitchspeed', '150');
    CL.anglespeedkey = new Cvar('cl_anglespeedkey', '1.5');
    CL.shownet = new Cvar('cl_shownet', '0');
    CL.nolerp = new Cvar('cl_nolerp', '0', Cvar.FLAG.ARCHIVE);
    CL.lookspring = new Cvar('lookspring', '0', Cvar.FLAG.ARCHIVE);
    CL.lookstrafe = new Cvar('lookstrafe', '0', Cvar.FLAG.ARCHIVE);
    CL.sensitivity = new Cvar('sensitivity', '3', Cvar.FLAG.ARCHIVE);
    CL.m_pitch = new Cvar('m_pitch', '0.022', Cvar.FLAG.ARCHIVE);
    CL.m_yaw = new Cvar('m_yaw', '0.022', Cvar.FLAG.ARCHIVE);
    CL.m_forward = new Cvar('m_forward', '1', Cvar.FLAG.ARCHIVE);
    CL.m_side = new Cvar('m_side', '0.8', Cvar.FLAG.ARCHIVE);
    CL.rcon_password = new Cvar('rcon_password', '');
    CL.nopred = new Cvar('cl_nopred', '0', Cvar.FLAG.NONE, 'Enables/disables client-side prediction');
    CL.nohud = new Cvar('cl_nohud', '0', Cvar.FLAG.NONE, 'Disables all HUD elements');
    CL.areaportals = new Cvar('cl_areaportals', '0', Cvar.FLAG.ARCHIVE, 'Enables/disables client-side area portal culling');
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
