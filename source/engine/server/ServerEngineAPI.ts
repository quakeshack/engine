import type { EdictData, EdictValueType, SerializableType } from '../../shared/GameInterfaces.ts';
import type { SzBuffer } from '../network/MSG.ts';
import type ParsedQC from '../common/model/parsers/ParsedQC.ts';
import type { Visibility } from '../common/model/BSP.ts';
import type { EventBus } from '../common/EventBus.ts';
import type Server from './Server.ts';

import { PmoveConfiguration } from '../../shared/Pmove.ts';
import Vector from '../../shared/Vector.ts';
import { moveTypes } from '../../shared/Defs.ts';
import * as Protocol from '../network/Protocol.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { type GameEdition, GameFlavors, type GameTrace, type InternalTraceLike, internalTraceToGameTrace } from '../common/GameApiSupport.ts';
import Mod, { ModelScope } from '../common/Mod.ts';
import { type BaseEntity, ServerEdict } from './Edict.ts';

type ServerEntityFilter = ((entity: ServerEdict) => boolean) | null;

/**
 * Normalize runtime entity references passed through dynamic spawn initial data.
 * @param initialData Initial field values supplied to SpawnEntity.
 * @returns Initial data with ServerEdict wrappers replaced by live entities.
 */
function normalizeEntityInitialData(initialData: Record<string, EdictValueType>): EdictData {
  const normalizedInitialData: EdictData = {};

  for (const [key, value] of Object.entries(initialData)) {
    normalizedInitialData[key] = value instanceof ServerEdict ? value.entity : value;
  }

  return normalizedInitialData;
}

/**
 * What a game's server side gets to see of the engine: the members of `ServerGameAPI.Init` and of the
 * constructor of `ServerGameAPI`. One instance belongs to one `Server`.
 */
export class ServerEngineAPI {
  readonly #sv: Server;
  readonly #edition: () => GameEdition;

  constructor(sv: Server, edition: () => GameEdition) {
    this.#sv = sv;
    this.#edition = edition;
  }

  /**
   * Whether the registered (non-shareware) game data is in use.
   * @returns True when the registered game is running.
   */
  get registered(): boolean {
    return this.#edition().registered;
  }

  /**
   * The editions of the game data that are in use.
   * @returns The flavors of the running game data.
   */
  get gameFlavors(): GameFlavors[] {
    const edition = this.#edition();
    const flavors: GameFlavors[] = [];

    if (!edition.registered) {
      flavors.push(GameFlavors.shareware);
    }

    if (edition.hipnotic) {
      flavors.push(GameFlavors.hipnotic);
    }

    if (edition.rogue) {
      flavors.push(GameFlavors.rogue);
    }

    return flavors;
  }

  /**
   * Append text to the command buffer.
   */
  AppendConsoleText(text: string): void {
    Cmd.text += text;
  }

  /**
   * Return a cvar by name.
   * @returns The variable.
   */
  GetCvar(name: string): Cvar | null {
    return Cvar.FindVar(name);
  }

  /**
   * Change the value of a cvar.
   * @returns The modified variable.
   */
  SetCvar(name: string, value: string): Cvar {
    const variable = Cvar.Set(name, value);

    console.assert(variable !== null, 'Cvar.Set requires a registered variable', name);

    return variable!;
  }

  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.SERVER, description);
  }

  ConsolePrint(msg: string, color = new Vector(1.0, 1.0, 1.0)): void {
    this.#sv.con.Print(msg, color);
  }

  ConsoleWarning(msg: string): void {
    this.#sv.con.PrintWarning(msg);
  }

  ConsoleError(msg: string): void {
    this.#sv.con.PrintError(msg);
  }

  ConsoleDebug(str: string): void {
    this.#sv.con.DPrint(str);
  }

  /**
   * Parse QuakeC for model animation information.
   * @returns Parsed QC content.
   */
  ParseQC(qcContent: string): ParsedQC {
    return Mod.ParseQC(qcContent);
  }

  BroadcastPrint(str: string): void {
    this.#sv.broadcastPrint(str);
  }

  StartParticles(origin: Vector, direction: Vector, color: number, count: number): void {
    this.#sv.messages.startParticle(origin, direction, color, count);
  }

  SpawnAmbientSound(origin: Vector, sfxName: string, volume: number, attenuation: number): boolean {
    let index = 0;

    for (; index < this.#sv.server.soundPrecache.length; index++) {
      if (this.#sv.server.soundPrecache[index] === sfxName) {
        break;
      }
    }

    if (index === this.#sv.server.soundPrecache.length) {
      this.#sv.con.Print(`no precache: ${sfxName}\n`);
      return false;
    }

    const signon = this.#sv.server.signon;
    signon.writeByte(Protocol.svc.spawnstaticsound);
    signon.writeCoordVector(origin);
    signon.writeByte(index);
    signon.writeByte(volume * 255.0);
    signon.writeByte(attenuation * 64.0);

    return true;
  }

  StartSound(edict: ServerEdict, channel: number, sfxName: string, volume: number, attenuation: number): boolean {
    this.#sv.messages.startSound(edict, channel, sfxName, volume * 255.0, attenuation);

    return true;
  }

  Traceline(
    start: Vector,
    end: Vector,
    noMonsters: boolean,
    passEdict: ServerEdict | null,
    mins: Vector | null = null,
    maxs: Vector | null = null,
  ): GameTrace {
    const nullVec = Vector.origin;
    const moveType = noMonsters ? moveTypes.MOVE_NOMONSTERS : moveTypes.MOVE_NORMAL;
    const collision = this.#sv.collision as {
      move(
        start: Vector,
        mins: Vector,
        maxs: Vector,
        end: Vector,
        type: moveTypes,
        passedict: ServerEdict | null,
      ): InternalTraceLike;
    };
    const trace = collision.move(
      start,
      mins ? mins : nullVec,
      maxs ? maxs : nullVec,
      end,
      moveType,
      passEdict,
    );
    return internalTraceToGameTrace(trace);
  }

  TracelineLegacy(
    start: Vector,
    end: Vector,
    noMonsters: boolean,
    passEdict: ServerEdict | null,
    mins: Vector | null = null,
    maxs: Vector | null = null,
  ): InternalTraceLike {
    const nullVec = Vector.origin;
    const moveType = noMonsters ? moveTypes.MOVE_NOMONSTERS : moveTypes.MOVE_NORMAL;
    const collision = this.#sv.collision as {
      move(
        start: Vector,
        mins: Vector,
        maxs: Vector,
        end: Vector,
        type: moveTypes,
        passedict: ServerEdict | null,
      ): InternalTraceLike;
    };
    return collision.move(
      start,
      mins ? mins : nullVec,
      maxs ? maxs : nullVec,
      end,
      moveType,
      passEdict,
    );
  }

  /**
   * Define a lightstyle (e.g. aazzaa).
   * It will also send an update to all connected clients.
   */
  Lightstyle(styleId: number, sequenceString: string): void {
    const { server } = this.#sv;

    server.lightstyles[styleId] = sequenceString;

    if (server.loading) {
      return;
    }

    for (const client of this.#sv.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.lightstyle);
      client.message.writeByte(styleId);
      client.message.writeString(sequenceString);
    }
  }

  /**
   * Find what contents the given point is in, using the active world collision backend.
   * @returns The contents constant.
   */
  DetermineStaticWorldContents(origin: Vector): number {
    return this.#sv.collision.staticWorldContents(origin);
  }

  /**
   * Compatibility alias for DetermineStaticWorldContents.
   * @returns The contents constant.
   */
  DetermineWorldContents(origin: Vector): number {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Find what contents the given point is in.
   * @returns The contents constant.
   */
  DeterminePointContents(origin: Vector): number {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Set an area portal's open or close state.
   */
  SetAreaPortalState(portalNum: number, open: boolean): void {
    if (this.#sv.server.worldmodel === null) {
      return;
    }

    this.#sv.server.worldmodel.areaPortals.setPortalState(portalNum, open);

    for (const client of this.#sv.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.setportalstate);
      client.message.writeShort(portalNum);
      client.message.writeByte(open ? 1 : 0);
    }
  }

  /**
   * Check whether two areas are connected through open portals.
   * @returns True when the areas are connected.
   */
  AreasConnected(area0: number, area1: number): boolean {
    if (this.#sv.server.worldmodel === null) {
      return true;
    }

    return this.#sv.server.worldmodel.areaPortals.areasConnected(area0, area1);
  }

  /**
   * Return the auto-assigned portal number for a brush model.
   * @returns The portal number, or `-1` when none exists.
   */
  GetModelPortal(modelName: string): number {
    if (this.#sv.server.worldmodel === null) {
      return -1;
    }

    return this.#sv.server.worldmodel.modelPortalMap[modelName] ?? -1;
  }

  ChangeLevel(mapname: string): void {
    if (this.#sv.svs.changelevelIssued) {
      return;
    }

    Cmd.text += `changelevel ${mapname}\n`;
  }

  /**
   * Find all edicts around the origin within the given radius.
   * @returns Matching edicts.
   */
  FindInRadius(origin: Vector, radius: number, filterFn: ServerEntityFilter = null): ServerEdict[] {
    const vradius = new Vector(radius, radius, radius).multiply(1.5);
    const mins = origin.copy().subtract(vradius);
    const maxs = origin.copy().add(vradius);
    const edicts: ServerEdict[] = [];
    const tree = this.#sv.area.tree!;

    console.assert(tree !== null, 'this.#sv.area.tree must be initialized before radius queries');

    for (const ent of tree.queryAABB(mins, maxs)) {
      if (ent.num === 0 || ent.isFree()) {
        continue;
      }

      const entity = ent.entity!;
      const eorg = origin.copy().subtract(entity.origin.copy().add(entity.mins.copy().add(entity.maxs).multiply(0.5)));

      if (eorg.len() > radius) {
        continue;
      }

      if (!filterFn || filterFn(ent)) {
        edicts.push(ent);
      }
    }

    return edicts; // used to be a generator, but we need to return an array due to changing linked lists in between
  }

  /**
   * Find the first edict that matches the field value.
   * @deprecated use FindAllByFieldAndValue instead
   * @returns The first matching edict, if any.
   */
  FindByFieldAndValue(field: string, value: EdictValueType, startEdictId = 0): ServerEdict | null {
    for (let index = startEdictId; index < this.#sv.server.num_edicts; index++) {
      const ent = this.#sv.server.edicts[index] as ServerEdict;

      if (ent.isFree()) {
        continue;
      }

      const entity = ent.entity!;
      const entityFields = entity as BaseEntity & Record<string, EdictValueType | undefined>;

      if (entityFields[field] === value) {
        return ent; // FIXME: turn it into yield
      }
    }

    return null;
  }

  // TODO: optimize lookups by using maps for fields such as classname, target, targetname
  /**
   * Yield all edicts whose field matches the supplied value.
   * Complexity: O(n) where n is the number of edicts in the server.
   * @yields Matching edicts.
   */
  *FindAllByFieldAndValue(field: string, value: EdictValueType, startEdictId = 0): Generator<ServerEdict, void, void> { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let index = startEdictId; index < this.#sv.server.num_edicts; index++) {
      const ent = this.#sv.server.edicts[index] as ServerEdict;

      if (ent.isFree()) {
        continue;
      }

      const entity = ent.entity!;
      const entityFields = entity as BaseEntity & Record<string, EdictValueType | undefined>;

      if (entityFields[field] === value) {
        yield ent;
      }
    }
  }

  /**
   * Yield all edicts that match the filter.
   * Complexity: O(n) where n is the number of edicts in the server.
   * @yields Matching edicts.
   */
  *FindAllByFilter(filterFn: ServerEntityFilter = null, startEdictId = 0): Generator<ServerEdict, void, void> { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let index = startEdictId; index < this.#sv.server.num_edicts; index++) {
      const ent = this.#sv.server.edicts[index] as ServerEdict;

      if (ent.isFree()) {
        continue;
      }

      if (!filterFn || filterFn(ent)) {
        yield ent;
      }
    }
  }

  /**
   * Yield all connected client edicts.
   * @yields Connected client edicts.
   */
  *GetClients(): Generator<ServerEdict, void, void> {
    for (const client of this.#sv.svs.spawnedClients()) {
      yield client.edict;
    }
  }

  GetEdictById(edictId: number): ServerEdict | null {
    if (edictId < 0 || edictId >= this.#sv.server.num_edicts) {
      return null;
    }

    return this.#sv.server.edicts[edictId];
  }

  PrecacheSound(sfxName: string): void {
    console.assert(typeof sfxName === 'string', 'sfxName must be a string');

    if (this.#sv.server.soundPrecache.includes(sfxName)) {
      return;
    }

    this.#sv.server.soundPrecache.push(sfxName);
  }

  PrecacheModel(modelName: string): void {
    console.assert(typeof modelName === 'string', 'modelName must be a string');

    if (this.#sv.server.modelPrecache.includes(modelName)) {
      return;
    }

    this.#sv.server.modelPrecache.push(modelName);
    this.#sv.server.models.push(this.#sv.mod.ForNameAsync(modelName, true, ModelScope.server)); // will cause promises in the array
  }

  /**
   * Spawn an Edict, not an entity.
   * @returns The spawned edict, or `null` on failure.
   */
  SpawnEntity<T = BaseEntity>(classname: string, initialData: Record<string, EdictValueType> = {}): (Omit<ServerEdict, 'entity'> & { entity: T }) | null {
    const edict = this.#sv.ed.Alloc();
    const normalizedInitialData = normalizeEntityInitialData(initialData);

    try {
      const gameAPI = this.#sv.server.gameAPI;
      console.assert(gameAPI !== null, 'server gameAPI must exist before spawning entities');

      if (gameAPI === null || !gameAPI.prepareEntity(edict, classname, normalizedInitialData)) {
        edict.freeEdict();
        return null;
      }

      if (!gameAPI.spawnPreparedEntity(edict)) {
        edict.freeEdict();
        return null;
      }
    } catch (e) {
      edict.freeEdict();
      throw e;
    }

    return edict as unknown as Omit<ServerEdict, 'entity'> & { entity: T };
  }

  IsLoading(): boolean {
    return this.#sv.server.loading;
  }

  /**
   * Dispatch a temporary entity protocol event.
   * @deprecated use client events instead
   */
  DispatchTempEntityEvent(tempEntityId: number, origin: Vector): void {
    this.#sv.server.datagram.writeByte(Protocol.svc.temp_entity);
    this.#sv.server.datagram.writeByte(tempEntityId);
    this.#sv.server.datagram.writeCoordVector(origin);
  }

  /**
   * Dispatch a beam protocol event.
   * @deprecated use client events instead
   */
  DispatchBeamEvent(beamId: number, edictId: number, startOrigin: Vector, endOrigin: Vector): void {
    this.#sv.server.datagram.writeByte(Protocol.svc.temp_entity); // FIXME: unhappy about this
    this.#sv.server.datagram.writeByte(beamId);
    this.#sv.server.datagram.writeShort(edictId);
    this.#sv.server.datagram.writeCoordVector(startOrigin);
    this.#sv.server.datagram.writeCoordVector(endOrigin);
  }

  /**
   * Make all clients play the specified audio track.
   */
  PlayTrack(track: number): void {
    this.#sv.server.datagram.writeByte(Protocol.svc.cdtrack);
    this.#sv.server.datagram.writeByte(track);
    this.#sv.server.datagram.writeByte(0); // unused
  }

  /**
   * Show the shareware sell screen to all clients.
   */
  ShowSellScreen(): void {
    this.#sv.server.reliable_datagram.writeByte(Protocol.svc.sellscreen);
  }

  /**
   * Dispatch a client event to the specified destination buffer.
   */
  #DispatchClientEventOnDestination(destination: SzBuffer, eventCode: number, ...args: SerializableType[]): void {
    console.assert(typeof eventCode === 'number', 'eventCode must be a number');

    destination.writeByte(Protocol.svc.clientevent);
    destination.writeByte(eventCode);

    destination.writeSerializables(args);
  }

  /**
   * Dispatch a client event to everyone.
   */
  BroadcastClientEvent(expedited: boolean, eventCode: number, ...args: SerializableType[]): void {
    this.#DispatchClientEventOnDestination(expedited ? this.#sv.server.datagram : this.#sv.server.expedited_datagram, eventCode, ...args);
  }

  /**
   * Dispatch a client event to the specified receiver.
   */
  DispatchClientEvent(receiverPlayerEdict: ServerEdict, expedited: boolean, eventCode: number, ...args: SerializableType[]): void {
    console.assert(receiverPlayerEdict instanceof ServerEdict && receiverPlayerEdict.isClient(), 'emitterEdict must be a ServerEdict connected to a client');
    console.assert(receiverPlayerEdict.getClient() !== null, 'receiverPlayerEdict must have a client');

    const receiverClient = receiverPlayerEdict.getClient()!;
    const destination = expedited ? receiverClient.expedited_message : receiverClient.message;

    this.#DispatchClientEventOnDestination(destination, eventCode, ...args);
  }

  /**
   * Return a series of waypoints from start to end.
   * @deprecated use NavigateAsync instead
   * @returns The waypoints from start to end, or `null` when no path could be found.
   */
  Navigate(start: Vector, end: Vector): Vector[] | null {
    return this.#sv.server.navigation?.findPath(start, end) ?? null;
  }

  /**
   * Return a series of waypoints from start to end asynchronously.
   * @returns The waypoints from start to end, or `null` when no path could be found.
   */
  NavigateAsync(start: Vector, end: Vector): Promise<Vector[] | null> {
    return this.#sv.server.navigation?.findPathAsync(start, end) ?? Promise.resolve(null);
  }

  GetPHS(origin: Vector): Visibility {
    const worldmodel = this.#sv.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for PHS queries');
    return worldmodel!.getPhsByPoint(origin);
  }

  GetPVS(origin: Vector): Visibility {
    const worldmodel = this.#sv.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for PVS queries');
    return worldmodel!.getPvsByPoint(origin);
  }

  /**
   * Get the area index for a world position.
   * @returns The area index, where `0` means outside or invalid.
   */
  GetAreaForPoint(origin: Vector): number {
    const worldmodel = this.#sv.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for area queries');
    return worldmodel!.getLeafForPoint(origin).area;
  }

  /**
   * Set the player movement configuration. This is used by the PMove code to determine how the player should move.
   */
  SetPmoveConfiguration(config: PmoveConfiguration): void {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');
    console.assert(this.#sv.pmove !== null, 'this.#sv.pmove must exist before setting configuration');

    this.#sv.pmove!.configuration = config;
  }

  get maxplayers(): number {
    return this.#sv.svs.maxclients;
  }

  /**
   * Server game event bus, reset on every map load.
   * @returns The active server event bus.
   */
  get eventBus(): EventBus {
    return this.#sv.server.eventBus;
  }
}
