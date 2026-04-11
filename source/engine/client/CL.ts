import Q from '../../shared/Q.ts';
import * as Def from '../common/Def.ts';
import * as Protocol from '../network/Protocol.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { Pmove, PmovePlayer } from '../common/Pmove.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { gameCapabilities, solid } from '../../shared/Defs.ts';
import ClientDemos from './ClientDemos.ts';
import { ClientPlayerState } from './ClientMessages.ts';
import VID from './VID.ts';
import { clientRuntimeState, clientStaticState } from './ClientState.ts';
import ClientConnection from './ClientConnection.ts';
import ClientLifecycle from './ClientLifecycle.ts';
import { BrushModel } from '../common/Mod.ts';
// import { materialFlags, PBRMaterial, QuakeMaterial } from './renderer/Materials.mjs';

let { Con, Draw, Host } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Draw, Host } = getClientRegistry());
});

export default class CL {
  /** @deprecated – use Def.contentShift */
  static cshift = Def.contentShift;

  /** @deprecated – use Def.clientConnectionState */
  static active = Def.clientConnectionState;

  static pmove = new Pmove();

  static #clientDemos = new ClientDemos();
  static #connection: ClientConnection;

  static gameCapabilities: gameCapabilities[] = [];
  static cls = clientStaticState;
  static state = clientRuntimeState;
  static svc_strings: Array<[string, number]> = [];

  static {
    this.#connection = new ClientConnection({ clientDemos: this.#clientDemos });
    this.cls.bindClientDemos(this.#clientDemos);
    this.svc_strings = Object.entries(Protocol.svc);
  }

  static nolerp: Cvar = null!;
  static rcon_password: Cvar = null!;
  static shownet: Cvar = null!;
  static name: Cvar = null!;
  static color: Cvar = null!;
  static upspeed: Cvar = null!;
  static forwardspeed: Cvar = null!;
  static backspeed: Cvar = null!;
  static sidespeed: Cvar = null!;
  static movespeedkey: Cvar = null!;
  static yawspeed: Cvar = null!;
  static pitchspeed: Cvar = null!;
  static anglespeedkey: Cvar = null!;
  static lookspring: Cvar = null!;
  static lookstrafe: Cvar = null!;
  static sensitivity: Cvar = null!;
  static m_pitch: Cvar = null!;
  static m_yaw: Cvar = null!;
  static m_forward: Cvar = null!;
  static m_side: Cvar = null!;
  static nopred: Cvar = null!;
  static nohud: Cvar = null!;
  static areaportals: Cvar = null!;
  static nullcmd = new Protocol.UserCmd();

  static StartDemos(demos: string[]): void {
    this.#clientDemos.startDemos(demos);
  }

  static async StartPlayback(demoname: string, timedemo = false): Promise<void> {
    await this.#clientDemos.startPlayback(demoname, timedemo);
  }

  static StopPlayback(): void { // public, by Host.js
    this.#clientDemos.stopPlayback();
  }

  static StartRecording(demoname: string, forcetrack = -1): void {
    this.#clientDemos.startRecording(demoname, forcetrack);
  }

  static async StopRecording(): Promise<void> {
    await this.#clientDemos.stopRecording();
  }

  static NextDemo(): void { // public, by Host.js, M.js
    this.#clientDemos.playNext();
  }

  static async Init(): Promise<void> {
    eventBus.subscribe('server.spawning', () => {
      CL.SetConnectingStep(1, 'Spawning server');
    });

    eventBus.subscribe('server.spawned', () => {
      CL.SetConnectingStep(3, 'Spawning server');
    });

    return ClientLifecycle.init();
  }

  static InitGame(): void {
    ClientLifecycle.initGame();
  }

  static SetConnectingStep(percentage: number | null, message: string | null): void {
    CL.#connection.setConnectingStep(percentage, message);
  }

  static GetMessage(): number {
    return CL.#connection.getMessage();
  }

  static SendCmd(): void {
    CL.#connection.sendCmd();
  }

  static ResetCheatCvars(): void {
    CL.#connection.resetCheatCvars();
  }

  static ClearState(): void {
    CL.#connection.clearState();
  }

  static ConfigureConnectionIdentity(cvars: { name: Cvar | null; color: Cvar | null; rcon_password: Cvar | null }): void {
    CL.#connection.configureIdentityCvars(cvars);
  }

  static get connection(): ClientConnection {
    return CL.#connection;
  }

  static ReadFromServer(): void {
    CL.connection.readFromServer();
  }

  static ParseServerMessage(): void {
    CL.connection.parseServerMessage();
  }

  static PrintLastServerMessages(): void {
    CL.connection.printLastServerMessages();
  }

  static Disconnect(): void {
    CL.#connection.disconnect();
  }

  static CheckConnectingState(): void {
    CL.#connection.checkConnectingState();
  }

  static Connect(host: string): void {
    CL.#connection.connect(host);
  }

  static SignonReply(): void {
    CL.#connection.signonReply();
  }

  static Stop_f = class StopRecordingCommand extends ConsoleCommand {
    async run(): Promise<void> {
      if (this.client) {
        return;
      }

      await CL.StopRecording();
    }
  };

  static Record_f = class StartRecordingCommand extends ConsoleCommand {
    run(demoname?: string, map?: string, track?: string): void {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: record <demoname> [<map> [cd track]]\n');
        return;
      }

      if (demoname.indexOf('..') !== -1) {
        Con.PrintWarning('Relative pathnames are not allowed.\n');
        return;
      }

      if (map === undefined && CL.cls.state === Def.clientConnectionState.connected) {
        Con.PrintWarning('Can not record - already connected to server\nClient demo recording must be started before connecting\n');
        return;
      }

      void Cmd.ExecuteString('map ' + map);

      CL.StartRecording(demoname, Q.atoi(track || '0'));
    }
  };

  static StartDemos_f = class StartDemosCommand extends ConsoleCommand {
    run(...demos: string[]): void {
      if (this.client) {
        return;
      }

      if (demos.length === 0) {
        Con.Print('Usage: startdemos <demoname1> [<demoname2> ...]\n');
        return;
      }

      Con.Print(demos.length + ' demo(s) in loop\n');

      Host.ScheduleForNextFrame(() => {
        CL.StartDemos(demos);
      });
    }
  };

  static Demos_f = class NextDemoCommand extends ConsoleCommand {
    run(): void {
      if (CL.#clientDemos.demonum === -1) {
        CL.#clientDemos.demonum = 1;
      }

      CL.Disconnect();
      CL.#clientDemos.playNext();
    }
  };

  static StopDemo_f = class StopPlaybackCommand extends ConsoleCommand {
    run(): void {
      if (this.client) {
        return;
      }

      if (!CL.#clientDemos.demoplayback) {
        return;
      }

      CL.StopPlayback();
    }
  };

  static PlayDemo_f = class StartPlaybackCommand extends ConsoleCommand {
    async run(demoname?: string): Promise<void> {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: playdemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      await CL.StartPlayback(demoname);
    }
  };

  static TimeDemo_f = class TimeDemoCommand extends ConsoleCommand { // private
    async run(demoname?: string): Promise<void> {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: timedemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      await CL.StartPlayback(demoname, true);
    }
  };

  static Rcon_f = class extends ConsoleCommand {
    run(...args: string[]): void { // private
      if (args.length === 0) {
        Con.Print('Usage: rcon <command>\n');
        return;
      }

      const password = CL.rcon_password.string;

      if (!password) {
        Con.Print('You must set \'rcon_password\' before issuing an rcon command.\n');
        return;
      }

      CL.cls.message.writeByte(Protocol.clc.rconcmd);
      CL.cls.message.writeString(password);
      CL.cls.message.writeString(this.args!.substring(5));
    }
  };

  static Draw(): void { // public, called by SCR.js // FIXME: maybe put that into M?, called by SCR
    if (this.cls.changelevel || this.cls.connecting) {
      Draw.BlackScreen();

      if (this.state.gameAPI) {
        this.state.gameAPI.drawLoading();
      }
    }

    if (this.cls.changelevel) {
      Draw.String(VID.width / 2 - 96, VID.height / 2 - 32, 'Loading', 3.0); // TODO: use the loading graphic
    }

    if (this.cls.connecting) {
      const x0 = VID.width / 2 - 36 * 8;
      const y0 = VID.height - 96;
      // Draw.String(x0, y0, 'Connecting', 2.0);
      Draw.StringWhite(x0, y0 + 48, this.cls.connecting.message);

      const len = 30;
      const p = this.cls.connecting.percentage;
      Draw.String(x0, y0 + 24, `[${'#'.repeat(p / 100 * len).padEnd(len, '_')}] ${p.toFixed(0).padStart(0, ' ')}%`, 2.0);
    }
  }

  static DrawHUD(): void {
    if (this.nohud.value !== 0) {
      return;
    }

    if (this.state.gameAPI) {
      this.state.gameAPI.draw();
    }
  }

  static ClientFrame(): void {
    if (this.cls.signon !== 4) {
      return; // not ready yet
    }

    if (this.state.gameAPI) {
      this.state.gameAPI.startFrame();
    }

    this.state.clientEntities.think();

    // CR: playing around with rendering into textures
    // const comptex = CL.state.worldmodel.textures.find((t) => t.name === 'BIGDOOR4');
    // if (comptex && comptex instanceof QuakeMaterial) {
    //   const dateTime = (new Date().toISOString()).split('T');
    //   Draw.BeginTexture(comptex.texture);
    //   Draw.String(8, 8, 'Hello world!', 1.0);
    //   Draw.String(8, 24, dateTime[0], 1.0);
    //   Draw.String(8, 32, dateTime[1], 1.0);
    //   // comptex.flags |= materialFlags.MF_SKIP;
    //   // R.RenderWorld();
    //   // comptex.flags &= ~materialFlags.MF_SKIP;
    //   Draw.EndTexture();
    // }
  }

  static ServerInfo_f(): void { // private
    if (CL.cls.state !== Def.clientConnectionState.connected) {
      Con.Print('Can\'t "serverinfo", not connected\n');
      return;
    }

    for (const [key, value] of Object.entries(CL.cls.serverInfo)) {
      Con.Print(`${key}: ${value}\n`);
    }
  }

  static MoveAround_f(): void { // private
    if (CL.cls.state !== Def.clientConnectionState.connected) {
      Con.Print('Can\'t "movearound", not connected\n');
      return;
    }

    if (CL.cls.signon !== 4) {
      Con.Print('You must wait for the server to send you the map before moving around.\n');
      return;
    }

    if (CL.cls.movearound !== null) {
      clearInterval(CL.cls.movearound);
      CL.cls.movearound = null;
      Con.Print('Stopped moving around.\n');
      return;
    }

    CL.cls.movearound = setInterval(() => {
      if (CL.cls.state !== Def.clientConnectionState.connected) {
        Con.Print('No longer connected, stopped moving around.\n');
        clearInterval(CL.cls.movearound!);
        CL.cls.movearound = null;
        return;
      }

      if (Math.random() < 0.1) {
        if (Math.random() < 0.5) {
          Cmd.text += '+back; wait; -back;\n';
        } else {
          Cmd.text += '+forward; wait; -forward;\n';
        }
      }

      if (Math.random() < 0.5) {
        Cmd.text += '+jump; wait; -jump;\n';
      }

      if (Math.random() < 0.2) {
        Cmd.text += '+attack; wait; -attack;\n';
      }
    }, 1000);

    Con.Print('Started moving around.\n');
  }

  static AppendChatMessage(name: string, message: string, direct: boolean): void { // private // TODO: Client
    eventBus.publish('client.chat.message', name, message, direct);
  }

  static PredictMove(): void { // public, by Host.js
    this.state.time = Host.realtime - this.state.latency;
    this.state.predicted = false;

    if (this.nopred.value !== 0) {
      return;
    }

    if (this.cls.demoplayback) {
      return;
    }

    const playerEntity = this.state.playerentity;
    if (!playerEntity) {
      return;
    }

    // ensure the pmove has the current worldmodel
    if (!this.pmove.physents.length && this.state.worldmodel) {
      this.pmove.setWorldmodel(this.state.worldmodel);
    }

    if (!this.pmove.physents.length) {
      return;
    }

    // figure out how many unacknowledged commands we need to replay
    const current = this.state.moveSequence;
    const ack = this.state.acknowledgedMoveSequence;
    const pending = (current - ack) & 0xFF;

    if (pending === 0 || pending > Protocol.CMD_BUFFER_SIZE) {
      // no pending commands or too many (something went wrong) — skip prediction
      return;
    }

    // populate collision entities for prediction
    CL.#setupPredictionPhysents();

    // get a player move instance
    const pmove = this.pmove.newPlayerMove();

    // build the initial “from” state from the last server-confirmed position
    const from = new ClientPlayerState(pmove);
    from.origin.set(playerEntity.msg_origins[0]);
    from.velocity.set(playerEntity.msg_velocity[0]);
    from.onground = this.state.onground ? 0 : null;
    // use server-acknowledged PM state for prediction base — these arrive
    // alongside the move ack in clientdata and are more reliable than the
    // playerstate array (which may not be populated for the local player)
    from.pmFlags = this.state.ackedPmFlags;
    from.pmTime = this.state.ackedPmTime;
    from.oldbuttons = this.state.ackedPmOldButtons;
    from.waterjumptime = this.state.playerstate?.waterjumptime ?? 0;

    const to = new ClientPlayerState(pmove);

    // replay each unacknowledged command
    for (let i = 1; i <= pending; i++) {
      const seq = (ack + i) & 0xFF;
      const slot = this.state.cmdBuffer[seq & Protocol.CMD_BUFFER_MASK];
      const cmd = slot.cmd;

      CL.PredictUsercmd(pmove, from, to, cmd);

      // swap from ← to for the next iteration
      from.origin.set(to.origin);
      from.velocity.set(to.velocity);
      from.angles.set(to.angles);
      from.onground = to.onground;
      from.pmFlags = to.pmFlags;
      from.pmTime = to.pmTime;
      from.oldbuttons = to.oldbuttons;
      from.waterjumptime = to.waterjumptime;
    }

    // apply predicted position to the player entity for rendering
    playerEntity.origin.set(to.origin);
    playerEntity.velocity.set(to.velocity);
    this.state.predicted = true;
  }

  /**
   * Populates CL.pmove with solid entities from the client entity list
   * for collision detection during prediction.
   */
  static #setupPredictionPhysents(): void {
    const pm = this.pmove;
    pm.clearEntities();

    const entities = this.state.clientEntities.entities;
    const playerEntNum = this.state.viewentity;

    for (let i = 1; i < entities.length; i++) {
      const ent = entities[i];
      if (!ent || ent.free || ent.num === playerEntNum) {
        continue;
      }

      // nothing to predict here, skip (otherwise Pmove will hail with NaNs and Infinities)
      if (ent.origin.isInfinite() || ent.angles.isInfinite()) {
        continue;
      }

      const s = ent.solid;
      if (s !== solid.SOLID_BSP && s !== solid.SOLID_BBOX && s !== solid.SOLID_SLIDEBOX) {
        continue;
      }

      const model = (s === solid.SOLID_BSP && ent.model instanceof BrushModel)
        ? ent.model : null;

      pm.addEntity(ent, model);
    }
  }

  /**
   * @param {PmovePlayer} pmove pmove for player
   * @param {ClientPlayerState} from previous state
   * @param {ClientPlayerState} to current state
   * @param {Protocol.UserCmd} u player commands
   */
  static PredictUsercmd(pmove: PmovePlayer, from: ClientPlayerState, to: ClientPlayerState, u: Protocol.UserCmd): void { // private
    // split long commands
    if (u.msec > 50) {
      const mid = new ClientPlayerState(pmove);
      const split = u.copy();
      split.msec /= 2;
      this.PredictUsercmd(pmove, from, mid, split);
      this.PredictUsercmd(pmove, mid, to, split);
      return;
    }

    pmove.origin.set(from.origin);
    pmove.angles.set(u.angles);
    pmove.velocity.set(from.velocity);

    pmove.oldbuttons = from.oldbuttons;
    pmove.waterjumptime = from.waterjumptime;
    pmove.pmFlags = from.pmFlags;
    pmove.pmTime = from.pmTime;
    pmove.dead = CL.state.stats[Def.stat.health] <= 0; // TODO: use a proper player state field for this
    pmove.spectator = false;

    pmove.cmd.set(u);

    pmove.move();

    to.waterjumptime = pmove.waterjumptime;
    to.oldbuttons = pmove.cmd.buttons;
    to.pmFlags = pmove.pmFlags;
    to.pmTime = pmove.pmTime;
    to.origin.set(pmove.origin);
    to.velocity.set(pmove.velocity);
    to.angles.set(pmove.angles);
    to.onground = pmove.onground;
    to.weaponframe = from.weaponframe;
  }

  /**
   * Calculate the new position of players, without other player clipping.
   * We do this to set up real player prediction.
   * Players are predicted twice, first without clipping other players,
   * then with clipping against them.
   * This sets up the first phase.
   */
  static SetUpPlayerPrediction(): void { // public, by Host.js
    // TODO: implement prediction setup once client prediction is refactored.
  }
}
