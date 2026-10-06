/*
 * ServerHost: the server half of the old Host.
 *
 * Owns the server frame, shutdown and client bookkeeping, and the console commands that act on
 * the running server. It knows nothing about the client runtime (`CL`, `R`, `S`, `M`, ...): a
 * local player reaches it through the `ServerController`, a remote one through its socket.
 */

/* eslint-disable jsdoc/require-returns */

import COM from '../common/Com.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import { eventBus } from '../common/EventBus.ts';
import type Server from './Server.ts';
import type { ServerEdict } from './Edict.ts';
import Vector from '../../shared/Vector.ts';
import Q from '../../shared/Q.ts';
import { ServerClient } from './Client.ts';
import { QSocket } from '../network/NetworkDrivers.ts';
import * as Defs from '../../shared/Defs.ts';
import { content } from '../../shared/Defs.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import PlayerColors from '../common/PlayerColors.ts';
import { HostError } from '../common/Errors.ts';
import type { SessionRequest, ViewthingState } from '../common/ServerController.ts';

type PrintFunction = (text: string) => void;

/** What a `ServerHost` needs from the process it runs in, besides its `Server`. */
export interface ServerHostDependencies {
  /** The server this host drives. */
  readonly sv: Server;
  /** Whether this is a dedicated server, with no local player. */
  readonly dedicated: boolean;
  /** Runs a callback at the start of the next frame, before anything else happens in it. */
  readonly scheduleForNextFrame: (callback: () => void | Promise<void>) => void;
  /** Whether `host_speeds` profiling is switched on. */
  readonly profiling: () => boolean;
  /** Tells whoever shows the local player's view that the player flies through walls (`noclip`). */
  readonly setNoclipAnglehack: (enabled: boolean) => void;
}

/**
 * Server runtime: frame loop, shutdown and the server-side console commands of one server.
 */
export default class ServerHost {
  readonly sv: Server;
  readonly #dedicated: boolean;
  readonly #scheduleForNextFrame: ServerHostDependencies['scheduleForNextFrame'];
  readonly #profiling: ServerHostDependencies['profiling'];
  readonly #setNoclipAnglehack: ServerHostDependencies['setNoclipAnglehack'];

  constructor(dependencies: ServerHostDependencies) {
    this.sv = dependencies.sv;
    this.#dedicated = dependencies.dedicated;
    this.#scheduleForNextFrame = dependencies.scheduleForNextFrame;
    this.#profiling = dependencies.profiling;
    this.#setNoclipAnglehack = dependencies.setNoclipAnglehack;
  }

  /**
   * Whether single-player world simulation may run in a server below multiplayer capacity. The
   * client sets it every frame (it is `false` while a menu has the world paused); a dedicated
   * server never sets it, so it only simulates once a second player could be present.
   */
  simulationAllowed = false;

  /** Provides the name shown for kicks issued from the local console, who is not a connected client. */
  getLocalOperatorName: () => string = () => this.sv.net.hostname.string;

  InitLocal(): void {
    this.FindMaxClients();
  }

  FindMaxClients(): void {
    this.sv.svs.maxclients = 1;
    this.sv.svs.maxclientslimit = Def.limits.clients;
    this.sv.svs.clients.length = 0;

    for (let index = 0; index < this.sv.svs.maxclientslimit; index++) {
      this.sv.svs.clients.push(new ServerClient(index, this.sv));
    }
  }

  /**
   * Whether a cheat command must abort because cheats are disabled; tells the player so.
   * @returns True when the command must abort.
   */
  cheatsDisabled(command: ConsoleCommand): boolean {
    if (this.sv.cheats !== null && this.sv.cheats.value) {
      return false;
    }

    if (command.client !== null) {
      this.sv.clientPrint(command.client, 'Cheats are not enabled on this server.\n');
    }

    return true;
  }

  /**
   * Flushes pending messages to every client, drops them and tears the server down. Local clients
   * listen for `server.shutting-down` to disconnect themselves; `active` is already `false` by then,
   * so they cannot ask for a second shutdown.
   */
  ShutdownServer(isCrashShutdown = false): void {
    if (!this.sv.server.active) {
      return;
    }

    this.sv.server.active = false;
    eventBus.publish('server.shutting-down');

    const start = this.sv.sys.FloatTime();
    let count = 0;

    do {
      count = 0;

      for (let index = 0; index < this.sv.svs.maxclients; index++) {
        const client = this.sv.svs.clients[index];

        if (client.state < ServerClient.STATE.CONNECTED || client.message.cursize === 0) {
          continue;
        }

        if (this.sv.net.CanSendMessage(client.netconnection)) {
          this.sv.net.SendMessage(client.netconnection, client.message);
          client.message.clear();
          continue;
        }

        // Unlike vanilla's UDP driver, none of this engine's transports have a "reliable send
        // window is full, will accept more shortly" state that pumping GetMessage can unblock —
        // CanSendMessage returning false here means the connection already finished closing.
        // Counting it as still-pending would force every shutdown with such a client to burn the
        // full timeout below for a message that can never be delivered.
        if (client.netconnection?.state === QSocket.STATE_DISCONNECTED || client.netconnection?.state === QSocket.STATE_DISCONNECTING) {
          continue;
        }

        this.sv.net.GetMessage(client.netconnection);
        count++;
      }

      if ((this.sv.sys.FloatTime() - start) > 3.0) {
        break;
      }
    } while (count !== 0);

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state >= ServerClient.STATE.CONNECTED) {
        this.sv.dropClient(client, isCrashShutdown, 'Server shutting down');
      }
    }

    this.sv.ShutdownServer(isCrashShutdown);
    eventBus.publish('server.shutdown');
  }

  /**
   * Runs one server frame.
   * @param frametime Seconds this frame advances the world by.
   * @param realtime Wall-clock seconds, only used for bookkeeping that must not depend on the simulation, like ping updates.
   */
  ServerFrame(frametime: number, realtime: number): void {
    const gameAPI = this.sv.server.gameAPI;
    console.assert(gameAPI !== null, 'server gameAPI must exist during ServerFrame');
    if (gameAPI === null) {
      return;
    }

    this.sv.server.frametime = frametime;
    this.sv.svs.realtime = realtime;
    gameAPI.frametime = frametime;
    this.sv.server.datagram.clear();
    this.sv.server.expedited_datagram.clear();
    this.sv.CheckForNewClients();
    this.sv.RunClients();

    if (!this.sv.server.paused && (this.sv.svs.maxclients >= 2 || this.simulationAllowed)) {
      this.sv.physics.physics();
    }

    this.sv.RunScheduledGameCommands();
    this.sv.messages.sendClientMessages();
  }

  /**
   * Runs the server frame of a dedicated server or of a listen server's turn, with `host_speeds` profiling.
   * @param frametime Seconds this frame advances the world by.
   * @param realtime Wall-clock seconds.
   */
  Frame(frametime: number, realtime: number): void {
    if (!this.sv.server.active) {
      return;
    }

    const profiling = this.#profiling();

    if (profiling) {
      console.profile('ServerHost.ServerFrame');
    }

    this.ServerFrame(frametime, realtime);

    if (profiling) {
      console.profileEnd('ServerHost.ServerFrame');
    }
  }

  /**
   * Finds the entity the `view*` development commands act on.
   * @returns The edict of the first `viewthing` on the map, `null` when there is none or no server runs.
   */
  #findViewthing(): ServerEdict | null {
    if (!this.sv.server.active) {
      return null;
    }

    for (let index = 0; index < this.sv.server.num_edicts; index++) {
      const edict = this.sv.server.edicts[index];

      if (!edict.isFree() && edict.entity !== null && edict.entity.classname === 'viewthing') {
        return edict;
      }
    }

    return null;
  }

  /**
   * Reads the model and frame of the entity the `view*` development commands act on.
   * @returns Its state, `null` when the map has none.
   */
  getViewthing(): ViewthingState | null {
    const entity = this.#findViewthing()?.entity ?? null;

    return entity === null ? null : { modelindex: entity.modelindex, frame: entity.frame };
  }

  /**
   * Shows another frame of the entity the `view*` development commands act on.
   * @param frame The frame to show.
   */
  setViewthingFrame(frame: number): void {
    const entity = this.#findViewthing()?.entity ?? null;

    if (entity !== null) {
      entity.frame = frame;
    }
  }

  /**
   * Starts a fresh game on a map, shutting down a running server first.
   * @returns False when the map could not be spawned; the server is shut down again then.
   */
  async StartMap(mapname: string): Promise<boolean> {
    this.ShutdownServer(); // CR: this is the reason why you would need to use changelevel on Counter-Strike 1.6 etc.
    this.sv.svs.serverflags = 0;

    if (!await this.sv.SpawnServer(mapname)) {
      this.sv.ShutdownServer(false);
      return false;
    }

    return true;
  }

  /**
   * Tells every connected client that a level change is coming and holds the server frame until
   * `Changelevel()` ran.
   */
  AnnounceChangelevel(mapname: string): void {
    this.sv.svs.changelevelIssued = true;

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.message.writeByte(Protocol.svc.changelevel);
      client.message.writeString(mapname);
    }
  }

  /**
   * Moves the running game to another map, keeping the players' spawn parameters.
   * @returns False when the map could not be spawned; the server is shut down again then.
   */
  async Changelevel(mapname: string): Promise<boolean> {
    this.sv.SaveSpawnparms();
    this.sv.con.DPrint(`this.Changelevel: changing level to ${mapname}\n`);

    if (!await this.sv.SpawnServer(mapname)) {
      this.sv.ShutdownServer(false);
      return false;
    }

    this.sv.con.DPrint(`this.Changelevel: spawned server for changelevel to ${mapname}\n`);
    return true;
  }

  status(command: ConsoleCommand): void {
    let print: PrintFunction;

    if (command.client === null) {
      if (!this.sv.server.active) {
        if (this.#dedicated) {
          this.sv.con.Print('No active server\n');
          return;
        }

        command.forward();
        return;
      }

      print = (text: string) => {
        this.sv.con.Print(text);
      };
    } else {
      const client = command.client;
      print = (text: string) => {
        this.sv.clientPrint(client, text);
      };
    }

    print(`hostname: ${this.sv.net.hostname.string}\n`);
    print(`address : ${this.sv.net.GetListenAddress()}\n`);
    print(`version : ${this.sv.engineVersion()} (${this.sv.server.gameVersion})\n`);
    print(`map     : ${this.sv.server.mapname}\n`);
    print(`game    : ${this.sv.server.gameName}\n`);
    print(`edicts  : ${this.sv.server.num_edicts} used of ${this.sv.server.edicts.length} allocated\n`);
    print(`players : ${this.sv.net.activeconnections} active (${this.sv.svs.maxclients} max)\n\n`);

    const lines: string[] = [];

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED || client.netconnection === null) {
        continue;
      }

      const parts = [
        client.num.toString().padStart(3),
        client.name.substring(0, 19).padEnd(19),
        client.uniqueId.substring(0, 19).padEnd(19),
        Q.secsToTime(this.sv.net.time - client.netconnection.connecttime).padEnd(9),
        client.ping.toFixed(0).padStart(4),
        (0).toFixed(0).padStart(4), // TODO: add loss
        (ServerClient.STATE[client.state] ?? `unknown (${client.state})`).padEnd(10),
        client.netconnection.address,
      ];

      lines.push(`${parts.join(' | ')}\n`);
    }

    if (lines.length === 0) {
      return;
    }

    print('id  | name                | unique id           | play time | ping | loss | state      | adr\n');
    print('----|---------------------|---------------------|-----------|------|------|------------|-----\n');

    for (const line of lines) {
      print(line);
    }
  }

  god(command: ConsoleCommand): void {
    if (command.forward() || this.cheatsDisabled(command)) {
      return;
    }

    const client = command.client;

    if (client === null) {
      return;
    }

    const entity = client.edict.entity;
    console.assert(entity !== null, 'god command requires a live client entity');

    if (entity === null) {
      return;
    }

    entity.flags ^= Defs.flags.FL_GODMODE;

    if ((entity.flags & Defs.flags.FL_GODMODE) === 0) {
      this.sv.clientPrint(client, 'godmode OFF\n');
      return;
    }

    this.sv.clientPrint(client, 'godmode ON\n');
  }

  notarget(command: ConsoleCommand): void {
    if (command.forward() || this.cheatsDisabled(command)) {
      return;
    }

    const client = command.client;

    if (client === null) {
      return;
    }

    const entity = client.edict.entity;
    console.assert(entity !== null, 'notarget command requires a live client entity');

    if (entity === null) {
      return;
    }

    entity.flags ^= Defs.flags.FL_NOTARGET;

    if ((entity.flags & Defs.flags.FL_NOTARGET) === 0) {
      this.sv.clientPrint(client, 'notarget OFF\n');
      return;
    }

    this.sv.clientPrint(client, 'notarget ON\n');
  }

  noclip(command: ConsoleCommand): void {
    if (command.forward() || this.cheatsDisabled(command)) {
      return;
    }

    const client = command.client;

    if (client === null) {
      return;
    }

    const entity = client.edict.entity;
    console.assert(entity !== null, 'noclip command requires a live client entity');

    if (entity === null) {
      return;
    }

    if (entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP) {
      this.#setNoclipAnglehack(true);
      entity.movetype = Defs.moveType.MOVETYPE_NOCLIP;
      this.sv.clientPrint(client, 'noclip ON\n');
      return;
    }

    this.#setNoclipAnglehack(false);
    entity.movetype = Defs.moveType.MOVETYPE_WALK;
    this.sv.clientPrint(client, 'noclip OFF\n');
  }

  fly(command: ConsoleCommand): void {
    if (command.forward() || this.cheatsDisabled(command)) {
      return;
    }

    const client = command.client;

    if (client === null) {
      return;
    }

    const entity = client.edict.entity;
    console.assert(entity !== null, 'fly command requires a live client entity');

    if (entity === null) {
      return;
    }

    if (entity.movetype !== Defs.moveType.MOVETYPE_FLY) {
      entity.movetype = Defs.moveType.MOVETYPE_FLY;
      this.sv.clientPrint(client, 'flymode ON\n');
      return;
    }

    entity.movetype = Defs.moveType.MOVETYPE_WALK;
    this.sv.clientPrint(client, 'flymode OFF\n');
  }

  ping(command: ConsoleCommand): void {
    if (command.forward()) {
      return;
    }

    const recipientClient = command.client;

    if (recipientClient === null) {
      return;
    }

    this.sv.clientPrint(recipientClient, 'Client ping times:\n');

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      let total = 0;

      for (let pingIndex = 0; pingIndex < client.ping_times.length; pingIndex++) {
        total += client.ping_times[pingIndex];
      }

      this.sv.clientPrint(recipientClient, `${(total * 62.5).toFixed(0).padStart(3)} ${client.name}\n`);
    }
  }

  /**
   * The server half of `name`: a client asked to be renamed. The local console's half lives in
   * `ClientHost.Name_f`.
   */
  name(command: ConsoleCommand, ...names: string[]): void { // signon 2, step 1
    this.sv.con.DPrint(`this.Name_f: ${command.client}\n`);

    if (command.client === null || names.length < 1) {
      return;
    }

    const initialNewName = names.join(' ').trim().substring(0, 15);
    let newName = initialNewName;
    let newNameCounter = 2;

    // Make sure we have a somewhat unique name.
    while (this.sv.FindClientByName(newName)) {
      newName = `${initialNewName}${newNameCounter++}`;
    }

    const previousName = command.client.name;

    if (this.#dedicated && previousName.length !== 0 && previousName !== 'unconnected' && previousName !== newName) {
      this.sv.con.Print(`${previousName} renamed to ${newName}\n`);
    }

    command.client.name = newName;

    const message = this.sv.server.reliable_datagram;
    message.writeByte(Protocol.svc.updatename);
    message.writeByte(command.client.num);
    message.writeString(newName);
  }

  say(command: ConsoleCommand, teamonly: boolean, message?: string): void {
    if (command.forward() || !message || command.client === null) {
      return;
    }

    const sender = command.client;
    const formattedMessage = message.length > 140 ? `${message.substring(0, 140)}...` : message;

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (this.sv.teamplay !== null && this.sv.teamplay.value !== 0 && teamonly && client.entity.team !== sender.entity.team) {
        continue;
      }

      this.sv.sendChatMessageToClient(client, sender.name, formattedMessage, false);
    }

    this.sv.con.Print(`${sender.name}: ${formattedMessage}\n`);
  }

  sayTeam(command: ConsoleCommand, message?: string): void {
    this.say(command, true, message);
  }

  sayAll(command: ConsoleCommand, message?: string): void {
    this.say(command, false, message);
  }

  tell(command: ConsoleCommand, recipient?: string, message?: string): void {
    if (command.forward() || !recipient || !message || command.client === null) {
      if (!recipient || !message) {
        this.sv.con.Print('Usage: tell <recipient> <message>\n');
      }

      return;
    }

    let formattedMessage = message.trim();

    // Remove surrounding double quotes if present.
    if (formattedMessage.startsWith('"')) {
      formattedMessage = formattedMessage.slice(1, -1);
    }

    if (formattedMessage.length > 140) {
      formattedMessage = `${formattedMessage.substring(0, 140)}...`;
    }

    const sender = command.client;

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const client = this.sv.svs.clients[index];

      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      if (client.name.toLowerCase() !== recipient.toLowerCase()) {
        continue;
      }

      this.sv.sendChatMessageToClient(client, sender.name, formattedMessage, true);
      this.sv.sendChatMessageToClient(sender, sender.name, formattedMessage, true);
      break;
    }
  }

  /**
   * The server half of `color`: a client asked to change its shirt and pants colors. The local
   * console's half lives in `ClientHost.Color_f`.
   */
  color(command: ConsoleCommand, ...argv: string[]): void { // signon 2, step 2
    this.sv.con.DPrint(`this.Color_f: ${command.client}\n`);

    if (command.client === null || argv.length === 0) {
      return;
    }

    const { top, bottom } = PlayerColors.parse(argv);
    const playercolor = PlayerColors.pack(top, bottom);

    command.client.colors = playercolor;

    const entity = command.client.edict.entity;
    console.assert(entity !== null, 'color command requires a live client entity');

    if (entity === null) {
      return;
    }

    entity.team = bottom + 1;

    const message = this.sv.server.reliable_datagram;
    message.writeByte(Protocol.svc.updatecolors);
    message.writeByte(command.client.num);
    message.writeByte(playercolor);
  }

  kill(command: ConsoleCommand): void {
    if (command.forward() || command.client === null) {
      return;
    }

    const client = command.client;

    const entity = client.edict.entity;
    console.assert(entity !== null, 'kill command requires a live client entity');

    if (entity === null) {
      return;
    }

    if (entity.health <= 0.0) {
      this.sv.clientPrint(client, 'Can\'t suicide -- already dead!\n');
      return;
    }

    const gameAPI = this.sv.server.gameAPI;
    console.assert(gameAPI !== null, 'kill command requires a live server game API');

    if (gameAPI === null) {
      return;
    }

    gameAPI.time = this.sv.server.time;
    gameAPI.ClientKill(client.edict);
  }

  pause(command: ConsoleCommand): void {
    if (command.forward() || command.client === null) {
      return;
    }

    const client = command.client;

    if (this.sv.pausable === null || this.sv.pausable.value === 0) {
      this.sv.clientPrint(client, 'Pause not allowed.\n');
      return;
    }

    this.sv.server.paused = !this.sv.server.paused;
    this.sv.broadcastPrint(`${client.name}${this.sv.server.paused ? ' paused the game\n' : ' unpaused the game\n'}`);
    this.sv.server.reliable_datagram.writeByte(Protocol.svc.setpause);
    this.sv.server.reliable_datagram.writeByte(this.sv.server.paused ? 1 : 0);
  }

  prespawn(command: ConsoleCommand): void { // signon 1, step 1
    if (command.client === null) {
      this.sv.con.Print('prespawn is not valid from the console\n');
      return;
    }

    this.sv.con.DPrint(`this.PreSpawn_f: ${command.client}\n`);

    const client = command.client;

    if (client.state === ServerClient.STATE.SPAWNED) {
      this.sv.con.Print('prespawn not valid -- already spawned\n');
      return;
    }

    // CR: this.sv.server.signon is a special buffer that is used to send the signon messages.
    client.message.write(new Uint8Array(this.sv.server.signon.data), this.sv.server.signon.cursize);
    client.message.writeByte(Protocol.svc.signonnum);
    client.message.writeByte(2);
  }

  spawn(command: ConsoleCommand): void { // signon 2, step 3
    this.sv.con.DPrint(`this.Spawn_f: ${command.client}\n`);

    if (command.client === null) {
      this.sv.con.Print('spawn is not valid from the console\n');
      return;
    }

    const client = command.client;

    if (client.state === ServerClient.STATE.SPAWNED) {
      this.sv.con.Print('Spawn not valid -- already spawned\n');
      return;
    }

    const message = client.message;
    message.clear();

    message.writeByte(Protocol.svc.time);
    message.writeFloat(this.sv.server.time);

    const entity = client.edict;

    if (this.sv.server.loadgame) {
      this.sv.server.paused = false;
    } else {
      const gameAPI = this.sv.server.gameAPI;
      console.assert(gameAPI !== null, 'spawn requires a live server game API');

      if (gameAPI === null) {
        return;
      }

      gameAPI.prepareEntity(entity, 'player', {
        netname: client.name,
        colormap: entity.num, // the num, not the entity
        team: (client.colors & 15) + 1,
      });

      const playerEntity = entity.entity;
      console.assert(
        playerEntity !== null && typeof playerEntity.restoreSpawnParameters === 'function',
        'spawn requires a prepared player entity with restoreSpawnParameters',
      );

      if (playerEntity === null || typeof playerEntity.restoreSpawnParameters !== 'function') {
        return;
      }

      playerEntity.restoreSpawnParameters(typeof client.spawn_parms === 'string' ? client.spawn_parms : null);

      gameAPI.time = this.sv.server.time;
      gameAPI.ClientConnect(entity);
      gameAPI.time = this.sv.server.time;
      gameAPI.PutClientInServer(entity);
    }

    for (let index = 0; index < this.sv.svs.maxclients; index++) {
      const otherClient = this.sv.svs.clients[index];
      message.writeByte(Protocol.svc.updatename);
      message.writeByte(index);
      message.writeString(otherClient.name);
      message.writeByte(Protocol.svc.updatefrags);
      message.writeByte(index);
      message.writeShort(otherClient.old_frags);
      message.writeByte(Protocol.svc.updatecolors);
      message.writeByte(index);
      message.writeByte(otherClient.colors);
    }

    for (let index = 0; index < Def.limits.lightstyles; index++) {
      message.writeByte(Protocol.svc.lightstyle);
      message.writeByte(index);
      message.writeString(this.sv.server.lightstyles[index]);
    }

    const playerEntity = entity.entity;
    console.assert(playerEntity !== null, 'spawned client must have a player entity');

    if (playerEntity === null) {
      return;
    }

    message.writeByte(Protocol.svc.setangle);
    message.writeAngleVector(playerEntity.angles);
    this.sv.messages.writeClientdataToMessage(client, message);
    message.writeByte(Protocol.svc.signonnum);
    message.writeByte(3);
  }

  begin(command: ConsoleCommand): void { // signon 3, step 1
    this.sv.con.DPrint(`this.Begin_f: ${command.client!}\n`);

    if (command.client === null) {
      this.sv.con.Print('begin is not valid from the console\n');
      return;
    }

    // Send all portal states before the client is officially spawned and gets updates incrementally.
    const worldmodel = this.sv.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required');

    if (worldmodel === null) {
      return;
    }

    const areaPortals = worldmodel.areaPortals;

    for (let portalIndex = 0; portalIndex < areaPortals.numPortals; portalIndex++) {
      command.client.message.writeByte(Protocol.svc.setportalstate);
      command.client.message.writeShort(portalIndex);
      command.client.message.writeByte(areaPortals.isPortalOpen(portalIndex) ? 1 : 0);
    }

    command.client.state = ServerClient.STATE.SPAWNED;

    const gameAPI = this.sv.server.gameAPI;
    console.assert(gameAPI !== null, 'begin requires a live server game API');

    if (gameAPI === null) {
      return;
    }

    if (gameAPI.ClientBegin instanceof Function) {
      gameAPI.time = this.sv.server.time;
      gameAPI.ClientBegin(command.client.edict);
    }
  }

  kick(command: ConsoleCommand): void {
    const argv = command.argv;

    if (command.client === null && !this.sv.server.active) {
      command.forward();
      return;
    }

    if (argv.length < 2) {
      return;
    }

    const selection = argv[1].toLowerCase();
    const invokingClient = command.client;
    let clientIndex = 0;
    let byNumber = false;
    let targetClient: ServerClient | null = null;

    if (argv.length >= 3 && selection === '#') {
      clientIndex = Q.atoi(argv[2]) - 1;

      if (clientIndex < 0 || clientIndex >= this.sv.svs.maxclients) {
        return;
      }

      if (this.sv.svs.clients[clientIndex].state !== ServerClient.STATE.SPAWNED) {
        return;
      }

      targetClient = this.sv.svs.clients[clientIndex];
      byNumber = true;
    } else {
      for (clientIndex = 0; clientIndex < this.sv.svs.maxclients; clientIndex++) {
        const client = this.sv.svs.clients[clientIndex];

        if (client.state < ServerClient.STATE.CONNECTED) {
          continue;
        }

        if (client.name.toLowerCase() === selection) {
          targetClient = client;
          break;
        }
      }
    }

    if (targetClient === null || targetClient === invokingClient) {
      return;
    }

    const who = invokingClient === null ? this.getLocalOperatorName() : invokingClient.name;
    const parsedMessage = argv.length >= 3 && command.args !== null ? COM.Parse(command.args) : null;
    let dropReason = `Kicked by ${who}`;

    if (parsedMessage !== null && parsedMessage.data !== null) {
      let offset = 0;

      if (byNumber) {
        offset++;

        for (; offset < parsedMessage.data.length; offset++) {
          if (parsedMessage.data.charCodeAt(offset) !== 32) {
            break;
          }
        }

        offset += argv[2].length;
      }

      for (; offset < parsedMessage.data.length; offset++) {
        if (parsedMessage.data.charCodeAt(offset) !== 32) {
          break;
        }
      }

      dropReason = `Kicked by ${who}: ${parsedMessage.data.substring(offset)}`;
    }

    this.sv.dropClient(targetClient, false, dropReason);
  }

  give(command: ConsoleCommand, classname?: string): void {
    // CR: unsure if I want a “give item_shells” approach or if I want to push
    // this piece of code into the game module and let the game handle this instead.

    if (command.forward() || this.cheatsDisabled(command)) {
      return;
    }

    const client = command.client;

    if (client === null) {
      return;
    }

    if (!classname) {
      this.sv.clientPrint(client, 'give <classname>\n');
      return;
    }

    const player = client.edict;

    if (!classname.startsWith('item_') && !classname.startsWith('weapon_')) {
      this.sv.clientPrint(client, 'Only entity classes item_* and weapon_* are allowed!\n');
      return;
    }

    // Wait for the next server frame.
    this.sv.ScheduleGameCommand(() => {
      const playerEntity = player.entity;
      console.assert(playerEntity !== null, 'give command requires a live player entity');

      if (playerEntity === null) {
        return;
      }

      const { forward } = playerEntity.v_angle.angleVectors();
      const start = playerEntity.origin;
      const end = forward.copy().multiply(64.0).add(start);
      const mins = new Vector(-16.0, -16.0, -24.0);
      const maxs = new Vector(16.0, 16.0, 32.0);
      const trace = this.sv.engineAPI.Traceline(start, end, false, player, mins, maxs);
      const origin = trace.point.subtract(forward.multiply(16.0)).add(new Vector(0.0, 0.0, 16.0));

      if (![content.CONTENT_EMPTY, content.CONTENT_WATER].includes(this.sv.engineAPI.DetermineStaticWorldContents(origin))) {
        this.sv.clientPrint(client, 'Item would spawn out of world!\n');
        return;
      }

      this.sv.engineAPI.SpawnEntity(classname, {
        origin,
      });
    });
  }

  map(command: ConsoleCommand, mapname?: string): void {
    if (mapname === undefined) {
      this.sv.con.Print('Usage: map <map>\n');
      return;
    }

    if (command.client !== null) {
      return;
    }

    this.ShutdownServer();

    this.#scheduleForNextFrame(async () => {
      if (!await this.StartMap(mapname)) {
        throw new HostError(`Could not spawn server with map ${mapname}`);
      }
    });
  }

  changelevelCommand(mapname?: string): void {
    if (mapname === undefined) {
      this.sv.con.Print('Usage: changelevel <levelname>\n');
      return;
    }

    if (!this.sv.server.active) {
      this.sv.con.Print('Only the server may changelevel\n');
      return;
    }

    this.AnnounceChangelevel(mapname);

    this.#scheduleForNextFrame(async () => {
      if (!await this.Changelevel(mapname)) {
        throw new HostError(`Could not spawn server for changelevel to ${mapname}`);
      }
    });
  }

  restart(): void {
    if (this.sv.server.active) {
      void Cmd.ExecuteString(`map ${this.sv.server.mapname}`);
    }
  }

  disconnect(): void {
    if (!this.sv.server.active) {
      this.sv.con.Print('No active server\n');
      return;
    }

    this.ShutdownServer();
  }

  /**
   * Registers `name` and `color`, which a connecting player sends while signing on. A server that has
   * a realm of its own needs them; where a client shares the command table, `Host` registers a router
   * that picks between the local player's own command and these.
   */
  InitIdentityCommands(): void {
    this.#addCommand('name', (command, ...names) => { this.name(command, ...names); });
    this.#addCommand('color', (command, ...colors) => { this.color(command, ...colors); });
  }

  /**
   * Registers `changelevel` and `restart` for a server whose player lives in another realm. Only that
   * side can reset the client, show the loading plaque and reconnect, so the commands (which is also what
   * the game's `ChangeLevel` and a dead single player end up running) hand the request over instead of
   * acting on the server themselves.
   * @param request Passes the request to the realm of the player.
   */
  InitSessionRequestCommands(request: (request: SessionRequest) => void): void {
    this.#addCommand('changelevel', (command, mapname) => {
      if (command.client !== null) {
        return;
      }

      if (mapname === undefined) {
        this.sv.con.Print('Usage: changelevel <levelname>\n');
        return;
      }

      if (!this.sv.server.active || this.sv.svs.changelevelIssued) {
        return;
      }

      request({ kind: 'changelevel', mapname });
    });

    this.#addCommand('restart', (command) => {
      if (command.client === null && this.sv.server.active) {
        request({ kind: 'restart' });
      }
    });
  }

  /**
   * Registers a console command whose handler gets the running command, and with it who issued it.
   */
  #addCommand(name: string, handler: (command: ConsoleCommand, ...args: string[]) => void | Promise<void>): void {
    Cmd.AddCommand(name, class HostCommand extends ConsoleCommand {
      override run(...args: string[]): void | Promise<void> {
        return handler(this, ...args);
      }
    });
  }

  /**
   * Registers the commands only a dedicated server has: the session commands a client would
   * handle itself, and stand-ins for the client commands a config file may still contain.
   */
  InitDedicatedCommands(): void {
    Cmd.AddCommand('bind', () => {});
    Cmd.AddCommand('unbind', () => {});
    Cmd.AddCommand('unbindall', () => {});
    this.#addCommand('disconnect', () => { this.disconnect(); });
    this.#addCommand('map', (command, mapname) => { this.map(command, mapname); });
    this.#addCommand('restart', () => { this.restart(); });
    this.#addCommand('changelevel', (_command, mapname) => { this.changelevelCommand(mapname); });

    Cmd.AddCommand('connect', () => {
      this.sv.con.Print('cannot connect to another server in dedicated server mode\n');
    });

    Cmd.AddCommand('reconnect', () => {
      this.sv.con.Print('cannot reconnect in dedicated server mode\n');
    });
  }

  /**
   * The `maxplayers` command: how many players the next server takes.
   */
  maxplayers(maxplayers?: string | number): void {
    const { svs, server, con } = this.sv;

    if (maxplayers === undefined) {
      con.Print(`"maxplayers" is "${svs.maxclients}"\n`);
      return;
    }

    if (server.active) {
      con.Print('maxplayers can not be changed while a server is running.\n');
      return;
    }

    let value = Q.atoi(String(maxplayers));

    if (value < 1) {
      value = 1;
    }

    if (value > svs.maxclientslimit) {
      value = svs.maxclientslimit;
      con.Print(`"maxplayers" set to "${value}"\n`);
    }

    svs.maxclients = value;
  }

  /**
   * Registers the console commands that act on the running server, and opens or closes the
   * network to remote players as the server comes and goes: a server for more than one player
   * listens, a single player one does not.
   */
  InitCommands(): void {
    Cmd.AddCommand('maxplayers', (maxplayers?: string | number) => { this.maxplayers(maxplayers); });

    eventBus.subscribe('server.spawned', () => {
      if (this.sv.svs.maxclients === 1 && this.sv.net.listening) {
        void Cmd.ExecuteString('listen 0');
      }

      if (this.sv.svs.maxclients > 1 && !this.sv.net.listening) {
        void Cmd.ExecuteString('listen 1');
      }
    });

    eventBus.subscribe('server.shutdown', () => {
      if (this.sv.net.listening) {
        void Cmd.ExecuteString('listen 0');
      }
    });

    this.#addCommand('status', (command) => { this.status(command); });
    this.#addCommand('god', (command) => { this.god(command); });
    this.#addCommand('notarget', (command) => { this.notarget(command); });
    this.#addCommand('fly', (command) => { this.fly(command); });
    this.#addCommand('noclip', (command) => { this.noclip(command); });
    this.#addCommand('say', (command, message) => { this.sayAll(command, message); });
    this.#addCommand('say_team', (command, message) => { this.sayTeam(command, message); });
    this.#addCommand('tell', (command, recipient, message) => { this.tell(command, recipient, message); });
    this.#addCommand('kill', (command) => { this.kill(command); });
    this.#addCommand('pause', (command) => { this.pause(command); });
    this.#addCommand('spawn', (command) => { this.spawn(command); });
    this.#addCommand('begin', (command) => { this.begin(command); });
    this.#addCommand('prespawn', (command) => { this.prespawn(command); });
    this.#addCommand('kick', (command) => { this.kick(command); });
    this.#addCommand('ping', (command) => { this.ping(command); });
    this.#addCommand('give', (command, classname) => { this.give(command, classname); });
  }
}
