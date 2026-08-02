import type { EdictData, EdictValueType, SerializableType } from '../../shared/GameInterfaces.ts';
import type { ClientDlight, ClientEdict } from '../client/ClientEntities.ts';
import { BitmapFont, type BitmapFontConfig } from '../client/BitmapFont.ts';
import type { GLTexture } from '../client/GL.ts';
import type { SzBuffer } from '../network/MSG.ts';
import type ParsedQC from './model/parsers/ParsedQC.ts';
import type { BaseModel } from './model/BaseModel.ts';
import type { Visibility } from './model/BSP.ts';
import type { DiscoveredSession, SessionDiscoveryStatus } from '../client/menu/SessionDiscovery.ts';
import type { SaveSlotInfo } from '../client/menu/SaveSlots.ts';

import { PmoveConfiguration } from '../../shared/Pmove.ts';
import Vector from '../../shared/Vector.ts';
import { moveTypes, solid } from '../../shared/Defs.ts';
import { clientConnectionState } from './Def.ts';
import Key, { KeyDestination } from '../client/Key.ts';
import { Action, ColorPicker, Image, KeyBindItem, Label, MenuItem, NumberInput, SaveSlotItem, Slider, Spacer, Textbox, Toggle } from '../client/menu/MenuItem.ts';
import { DialogPage, GridLayout, ImageBasedLayout, ListLayout, ListPage, MenuPage, VerticalLayout } from '../client/menu/MenuPage.ts';
import { MenuViewport } from '../client/menu/MenuViewport.ts';
import type { MenuPic } from '../client/Menu.ts';
import SessionDiscovery from '../client/menu/SessionDiscovery.ts';
import SaveSlotsService from '../client/menu/SaveSlots.ts';
import { SFX as SFXValue } from '../client/Sound.ts';
import VID from '../client/VID.ts';
import * as Protocol from '../network/Protocol.ts';
import { EventBus, eventBus, getClientRegistry, getCommonRegistry } from '../registry.ts';
import { ED, type BaseEntity, ServerEdict as ServerEdictValue } from '../server/Edict.ts';
import Cmd from './Cmd.ts';
import Cvar from './Cvar.ts';
import { HostError } from './Errors.ts';
import Mod, { ModelScope } from './Mod.ts';
import W from './W.ts';
import PostProcess from '../client/renderer/PostProcess.ts';
import type { PostProcessStack } from '../../shared/GameInterfaces.ts';

type ServerEdict = ServerEdictValue;

interface ClientTraceOptions {
  readonly includeEntities?: boolean;
  readonly passEntityId?: number | null;
  readonly filter?: ((entity: ClientEdict) => boolean) | null;
}

interface GameTrace {
  readonly solid: {
    readonly all: boolean;
    readonly start: boolean;
  };
  readonly fraction: number;
  readonly plane: {
    readonly normal: Vector;
    readonly distance: number;
  };
  readonly contents: {
    readonly inOpen: boolean;
    readonly inWater: boolean;
  };
  readonly point: Vector;
  readonly entity: BaseEntity | ClientEdict | null;
}

interface InternalTraceLike {
  readonly allsolid: boolean;
  readonly startsolid: boolean;
  readonly fraction: number;
  readonly plane: {
    readonly normal: Vector;
    readonly dist: number;
  };
  readonly inopen: boolean;
  readonly inwater: boolean;
  readonly endpos: Vector;
  readonly ent: {
    readonly entity: BaseEntity | ClientEdict;
  } | null;
}

interface ClientTraceEntityAdapter {
  readonly entity: ClientEdict;
  readonly num: number;
  equals(other: unknown): boolean;
}

/**
 * Normalize runtime entity references passed through dynamic spawn initial data.
 * @param initialData Initial field values supplied to SpawnEntity.
 * @returns Initial data with ServerEdict wrappers replaced by live entities.
 */
function normalizeEntityInitialData(initialData: Record<string, EdictValueType>): EdictData {
  const normalizedInitialData: EdictData = {};

  for (const [key, value] of Object.entries(initialData)) {
    normalizedInitialData[key] = value instanceof ServerEdictValue ? value.entity : value;
  }

  return normalizedInitialData;
}

type ServerEntityFilter = ((entity: ServerEdict) => boolean) | null;
type ClientEntityFilter = ((entity: ClientEdict) => boolean) | null;
type CommandCallback = (...args: string[]) => void | Promise<void>;

let { COM, Con, Host, SV, V } = getCommonRegistry();
let { CL, Draw, M, R, S, SCR } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, Host, SV, V } = getCommonRegistry());
  ({ CL, Draw, M, R, S, SCR } = getClientRegistry());
});

eventBus.subscribe('com.ready', () => {
  if (!COM.registered) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.shareware);
  }

  if (COM.hipnotic) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.hipnotic);
  }

  if (COM.rogue) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.rogue);
  }

  console.assert(COM.registered !== null, 'COM.registered must exist after com.ready');

  if (COM.registered!.value === 1) {
    ServerEngineAPI.registered = true;
    ClientEngineAPI.registered = true;
  }
});

export enum GameFlavors {
  hipnotic = 'hipnotic',
  rogue = 'rogue',
  shareware = 'shareware',
}

// eslint-disable-next-line jsdoc/require-jsdoc
function internalTraceToGameTrace(trace: InternalTraceLike): GameTrace {
  return {
    solid: {
      all: trace.allsolid,
      start: trace.startsolid,
    },
    fraction: trace.fraction,
    plane: {
      normal: trace.plane.normal,
      distance: trace.plane.dist,
    },
    contents: {
      inOpen: trace.inopen,
      inWater: trace.inwater,
    },
    point: trace.endpos,
    entity: trace.ent ? trace.ent.entity : null,
  };
}

/**
 * Return whether the entity can be traced against.
 * @returns True when the entity can be traced against.
 */
function isTraceableClientSolid(entity: ClientEdict): boolean {
  return entity.solid === solid.SOLID_BBOX
    || entity.solid === solid.SOLID_SLIDEBOX
    || entity.solid === solid.SOLID_BSP
    || entity.solid === solid.SOLID_MESH;
}

/**
 * Return the extents used for tracing the entity.
 * @returns The mins/maxs extents used for tracing.
 */
function getClientTraceExtents(entity: ClientEdict): { mins: Vector; maxs: Vector } {
  if (entity.model !== null && entity.mins.isOrigin() && entity.maxs.isOrigin()) {
    return {
      mins: entity.model.mins,
      maxs: entity.model.maxs,
    };
  }

  return {
    mins: entity.mins,
    maxs: entity.maxs,
  };
}

/**
 * Compute the client's world-space trace bounds.
 */
function computeClientTraceBounds(entity: ClientEdict, absmin: Vector, absmax: Vector): void {
  const { mins, maxs } = getClientTraceExtents(entity);

  if (!entity.angles.isOrigin()) {
    const basis = entity.angles.toRotationMatrix();
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    const centerX = (mins[0] + maxs[0]) * 0.5;
    const centerY = (mins[1] + maxs[1]) * 0.5;
    const centerZ = (mins[2] + maxs[2]) * 0.5;
    const extentsX = (maxs[0] - mins[0]) * 0.5;
    const extentsY = (maxs[1] - mins[1]) * 0.5;
    const extentsZ = (maxs[2] - mins[2]) * 0.5;

    const worldCenter = entity.origin.copy()
      .add(forward.copy().multiply(centerX))
      .add(right.copy().multiply(centerY))
      .add(up.copy().multiply(centerZ));

    const worldExtentX = Math.abs(forward[0]) * extentsX + Math.abs(right[0]) * extentsY + Math.abs(up[0]) * extentsZ;
    const worldExtentY = Math.abs(forward[1]) * extentsX + Math.abs(right[1]) * extentsY + Math.abs(up[1]) * extentsZ;
    const worldExtentZ = Math.abs(forward[2]) * extentsX + Math.abs(right[2]) * extentsY + Math.abs(up[2]) * extentsZ;

    absmin.setTo(
      worldCenter[0] - worldExtentX,
      worldCenter[1] - worldExtentY,
      worldCenter[2] - worldExtentZ,
    );
    absmax.setTo(
      worldCenter[0] + worldExtentX,
      worldCenter[1] + worldExtentY,
      worldCenter[2] + worldExtentZ,
    );
    return;
  }

  absmin.set(entity.origin).add(mins);
  absmax.set(entity.origin).add(maxs);
}

/**
 * Return whether the two AABBs overlap.
 * @returns True when the AABBs overlap.
 */
function traceBoundsOverlap(traceMins: Vector, traceMaxs: Vector, entityMins: Vector, entityMaxs: Vector): boolean {
  return !(
    traceMins[0] > entityMaxs[0]
    || traceMins[1] > entityMaxs[1]
    || traceMins[2] > entityMaxs[2]
    || traceMaxs[0] < entityMins[0]
    || traceMaxs[1] < entityMins[1]
    || traceMaxs[2] < entityMins[2]
  );
}

/**
 * Resolve the best trace including eligible client entities.
 * @returns The best trace including eligible client entities.
 */
function traceClientEntities(
  start: Vector,
  end: Vector,
  worldTrace: InternalTraceLike,
  options: ClientTraceOptions,
): InternalTraceLike {
  const traceMins = new Vector(
    Math.min(start[0], worldTrace.endpos[0]),
    Math.min(start[1], worldTrace.endpos[1]),
    Math.min(start[2], worldTrace.endpos[2]),
  );
  const traceMaxs = new Vector(
    Math.max(start[0], worldTrace.endpos[0]),
    Math.max(start[1], worldTrace.endpos[1]),
    Math.max(start[2], worldTrace.endpos[2]),
  );
  const entityMins = new Vector();
  const entityMaxs = new Vector();

  let bestTrace: InternalTraceLike = worldTrace;

  for (const entity of CL.state.clientEntities.getEntities()) {
    if (entity.num === 0 || entity.free || entity.origin.isInfinite() || entity.model === null) {
      continue;
    }

    if (!isTraceableClientSolid(entity)) {
      continue;
    }

    if (options.passEntityId !== null && options.passEntityId !== undefined && entity.num === options.passEntityId) {
      continue;
    }

    if (options.filter !== null && options.filter !== undefined && !options.filter(entity)) {
      continue;
    }

    computeClientTraceBounds(entity, entityMins, entityMaxs);

    if (!traceBoundsOverlap(traceMins, traceMaxs, entityMins, entityMaxs)) {
      continue;
    }

    const adapter: ClientTraceEntityAdapter = {
      entity,
      num: entity.num,
      equals(other: unknown): boolean {
        return this === other;
      },
    };
    const trace = SV.collision.clipMoveToEntity(
      // @ts-ignore Client tracing reuses shared narrow-phase helpers with a lightweight ClientEdict adapter.
      adapter,
      start,
      Vector.origin,
      Vector.origin,
      bestTrace.endpos,
    ) as InternalTraceLike;

    if (trace.allsolid || trace.startsolid || trace.fraction < bestTrace.fraction) {
      bestTrace = trace;
    }
  }

  return bestTrace;
}

export class CommonEngineAPI {
  static registered = false;
  static gameFlavors: GameFlavors[] = [];

  /**
   * Append text to the command buffer.
   */
  static AppendConsoleText(text: string): void {
    Cmd.text += text;
  }

  /**
   * Return a cvar by name.
   * @returns The variable.
   */
  static GetCvar(name: string): Cvar | null {
    return Cvar.FindVar(name);
  }

  /**
   * Change the value of a cvar.
   * @returns The modified variable.
   */
  static SetCvar(name: string, value: string): Cvar {
    const variable = Cvar.Set(name, value);

    console.assert(variable !== null, 'Cvar.Set requires a registered variable', name);

    return variable!;
  }

  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  static RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME, description);
  }

  static ConsolePrint(msg: string, color = new Vector(1.0, 1.0, 1.0)): void {
    Con.Print(msg, color);
  }

  static ConsoleWarning(msg: string): void {
    Con.PrintWarning(msg);
  }

  static ConsoleError(msg: string): void {
    Con.PrintError(msg);
  }

  static ConsoleDebug(str: string): void {
    Con.DPrint(str);
  }

  /**
   * Parse QuakeC for model animation information.
   * @returns Parsed QC content.
   */
  static ParseQC(qcContent: string): ParsedQC {
    return Mod.ParseQC(qcContent);
  }
}

export class ServerEngineAPI extends CommonEngineAPI {
  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  static override RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.SERVER, description);
  }

  static BroadcastPrint(str: string): void {
    Host.BroadcastPrint(str);
  }

  static StartParticles(origin: Vector, direction: Vector, color: number, count: number): void {
    SV.messages.startParticle(origin, direction, color, count);
  }

  static SpawnAmbientSound(origin: Vector, sfxName: string, volume: number, attenuation: number): boolean {
    let index = 0;

    for (; index < SV.server.soundPrecache.length; index++) {
      if (SV.server.soundPrecache[index] === sfxName) {
        break;
      }
    }

    if (index === SV.server.soundPrecache.length) {
      Con.Print(`no precache: ${sfxName}\n`);
      return false;
    }

    const signon = SV.server.signon;
    signon.writeByte(Protocol.svc.spawnstaticsound);
    signon.writeCoordVector(origin);
    signon.writeByte(index);
    signon.writeByte(volume * 255.0);
    signon.writeByte(attenuation * 64.0);

    return true;
  }

  static StartSound(edict: ServerEdict, channel: number, sfxName: string, volume: number, attenuation: number): boolean {
    SV.messages.startSound(edict, channel, sfxName, volume * 255.0, attenuation);

    return true;
  }

  static Traceline(
    start: Vector,
    end: Vector,
    noMonsters: boolean,
    passEdict: ServerEdict | null,
    mins: Vector | null = null,
    maxs: Vector | null = null,
  ): GameTrace {
    const nullVec = Vector.origin;
    const moveType = noMonsters ? moveTypes.MOVE_NOMONSTERS : moveTypes.MOVE_NORMAL;
    const collision = SV.collision as {
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

  static TracelineLegacy(
    start: Vector,
    end: Vector,
    noMonsters: boolean,
    passEdict: ServerEdict | null,
    mins: Vector | null = null,
    maxs: Vector | null = null,
  ): InternalTraceLike {
    const nullVec = Vector.origin;
    const moveType = noMonsters ? moveTypes.MOVE_NOMONSTERS : moveTypes.MOVE_NORMAL;
    const collision = SV.collision as {
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
  static Lightstyle(styleId: number, sequenceString: string): void {
    const server = SV.server as typeof SV.server & { lightstyles: string[]; loading: boolean };

    server.lightstyles[styleId] = sequenceString;

    if (server.loading) {
      return;
    }

    for (const client of SV.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.lightstyle);
      client.message.writeByte(styleId);
      client.message.writeString(sequenceString);
    }
  }

  /**
   * Find what contents the given point is in, using the active world collision backend.
   * @returns The contents constant.
   */
  static DetermineStaticWorldContents(origin: Vector): number {
    return SV.collision.staticWorldContents(origin);
  }

  /**
   * Compatibility alias for DetermineStaticWorldContents.
   * @returns The contents constant.
   */
  static DetermineWorldContents(origin: Vector): number {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Find what contents the given point is in.
   * @returns The contents constant.
   */
  static DeterminePointContents(origin: Vector): number {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Set an area portal's open or close state.
   */
  static SetAreaPortalState(portalNum: number, open: boolean): void {
    if (SV.server.worldmodel === null) {
      return;
    }

    SV.server.worldmodel.areaPortals.setPortalState(portalNum, open);

    for (const client of SV.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.setportalstate);
      client.message.writeShort(portalNum);
      client.message.writeByte(open ? 1 : 0);
    }
  }

  /**
   * Check whether two areas are connected through open portals.
   * @returns True when the areas are connected.
   */
  static AreasConnected(area0: number, area1: number): boolean {
    if (SV.server.worldmodel === null) {
      return true;
    }

    return SV.server.worldmodel.areaPortals.areasConnected(area0, area1);
  }

  /**
   * Return the auto-assigned portal number for a brush model.
   * @returns The portal number, or `-1` when none exists.
   */
  static GetModelPortal(modelName: string): number {
    if (SV.server.worldmodel === null) {
      return -1;
    }

    return SV.server.worldmodel.modelPortalMap[modelName] ?? -1;
  }

  static ChangeLevel(mapname: string): void {
    if (SV.svs.changelevelIssued) {
      return;
    }

    Cmd.text += `changelevel ${mapname}\n`;
  }

  /**
   * Find all edicts around the origin within the given radius.
   * @returns Matching edicts.
   */
  static FindInRadius(origin: Vector, radius: number, filterFn: ServerEntityFilter = null): ServerEdict[] {
    const vradius = new Vector(radius, radius, radius).multiply(1.5);
    const mins = origin.copy().subtract(vradius);
    const maxs = origin.copy().add(vradius);
    const edicts: ServerEdict[] = [];
    const tree = SV.area.tree!;

    console.assert(tree !== null, 'SV.area.tree must be initialized before radius queries');

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
  static FindByFieldAndValue(field: string, value: EdictValueType, startEdictId = 0): ServerEdict | null {
    for (let index = startEdictId; index < SV.server.num_edicts; index++) {
      const ent = SV.server.edicts[index] as ServerEdict;

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
  static *FindAllByFieldAndValue(field: string, value: EdictValueType, startEdictId = 0): Generator<ServerEdict, void, void> { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let index = startEdictId; index < SV.server.num_edicts; index++) {
      const ent = SV.server.edicts[index] as ServerEdict;

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
  static *FindAllByFilter(filterFn: ServerEntityFilter = null, startEdictId = 0): Generator<ServerEdict, void, void> { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let index = startEdictId; index < SV.server.num_edicts; index++) {
      const ent = SV.server.edicts[index] as ServerEdict;

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
  static *GetClients(): Generator<ServerEdict, void, void> {
    for (const client of SV.svs.spawnedClients()) {
      yield client.edict;
    }
  }

  static GetEdictById(edictId: number): ServerEdict | null {
    if (edictId < 0 || edictId >= SV.server.num_edicts) {
      return null;
    }

    return SV.server.edicts[edictId];
  }

  static PrecacheSound(sfxName: string): void {
    console.assert(typeof sfxName === 'string', 'sfxName must be a string');

    if (SV.server.soundPrecache.includes(sfxName)) {
      return;
    }

    SV.server.soundPrecache.push(sfxName);
  }

  static PrecacheModel(modelName: string): void {
    console.assert(typeof modelName === 'string', 'modelName must be a string');

    if (SV.server.modelPrecache.includes(modelName)) {
      return;
    }

    SV.server.modelPrecache.push(modelName);
    SV.server.models.push(Mod.ForNameAsync(modelName, true, ModelScope.server)); // will cause promises in the array
  }

  /**
   * Spawn an Edict, not an entity.
   * @returns The spawned edict, or `null` on failure.
   */
  static SpawnEntity<T = BaseEntity>(classname: string, initialData: Record<string, EdictValueType> = {}): (Omit<ServerEdict, 'entity'> & { entity: T }) | null {
    const edict = ED.Alloc();
    const normalizedInitialData = normalizeEntityInitialData(initialData);

    try {
      const gameAPI = SV.server.gameAPI;
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

  static IsLoading(): boolean {
    return SV.server.loading;
  }

  /**
   * Dispatch a temporary entity protocol event.
   * @deprecated use client events instead
   */
  static DispatchTempEntityEvent(tempEntityId: number, origin: Vector): void {
    SV.server.datagram.writeByte(Protocol.svc.temp_entity);
    SV.server.datagram.writeByte(tempEntityId);
    SV.server.datagram.writeCoordVector(origin);
  }

  /**
   * Dispatch a beam protocol event.
   * @deprecated use client events instead
   */
  static DispatchBeamEvent(beamId: number, edictId: number, startOrigin: Vector, endOrigin: Vector): void {
    SV.server.datagram.writeByte(Protocol.svc.temp_entity); // FIXME: unhappy about this
    SV.server.datagram.writeByte(beamId);
    SV.server.datagram.writeShort(edictId);
    SV.server.datagram.writeCoordVector(startOrigin);
    SV.server.datagram.writeCoordVector(endOrigin);
  }

  /**
   * Make all clients play the specified audio track.
   */
  static PlayTrack(track: number): void {
    SV.server.datagram.writeByte(Protocol.svc.cdtrack);
    SV.server.datagram.writeByte(track);
    SV.server.datagram.writeByte(0); // unused
  }

  /**
   * Show the shareware sell screen to all clients.
   */
  static ShowSellScreen(): void {
    SV.server.reliable_datagram.writeByte(Protocol.svc.sellscreen);
  }

  /**
   * Dispatch a client event to the specified destination buffer.
   */
  static #DispatchClientEventOnDestination(destination: SzBuffer, eventCode: number, ...args: SerializableType[]): void {
    console.assert(typeof eventCode === 'number', 'eventCode must be a number');

    destination.writeByte(Protocol.svc.clientevent);
    destination.writeByte(eventCode);

    destination.writeSerializables(args);
  }

  /**
   * Dispatch a client event to everyone.
   */
  static BroadcastClientEvent(expedited: boolean, eventCode: number, ...args: SerializableType[]): void {
    this.#DispatchClientEventOnDestination(expedited ? SV.server.datagram : SV.server.expedited_datagram, eventCode, ...args);
  }

  /**
   * Dispatch a client event to the specified receiver.
   */
  static DispatchClientEvent(receiverPlayerEdict: ServerEdict, expedited: boolean, eventCode: number, ...args: SerializableType[]): void {
    console.assert(receiverPlayerEdict instanceof ServerEdictValue && receiverPlayerEdict.isClient(), 'emitterEdict must be a ServerEdict connected to a client');
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
  static Navigate(start: Vector, end: Vector): Vector[] | null {
    return SV.server.navigation?.findPath(start, end) ?? null;
  }

  /**
   * Return a series of waypoints from start to end asynchronously.
   * @returns The waypoints from start to end, or `null` when no path could be found.
   */
  static NavigateAsync(start: Vector, end: Vector): Promise<Vector[] | null> {
    return SV.server.navigation?.findPathAsync(start, end) ?? Promise.resolve(null);
  }

  static GetPHS(origin: Vector): Visibility {
    const worldmodel = SV.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for PHS queries');
    return worldmodel!.getPhsByPoint(origin);
  }

  static GetPVS(origin: Vector): Visibility {
    const worldmodel = SV.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for PVS queries');
    return worldmodel!.getPvsByPoint(origin);
  }

  /**
   * Get the area index for a world position.
   * @returns The area index, where `0` means outside or invalid.
   */
  static GetAreaForPoint(origin: Vector): number {
    const worldmodel = SV.server.worldmodel;
    console.assert(worldmodel !== null, 'server worldmodel required for area queries');
    return worldmodel!.getLeafForPoint(origin).area;
  }

  /**
   * Set the player movement configuration. This is used by the PMove code to determine how the player should move.
   */
  static SetPmoveConfiguration(config: PmoveConfiguration): void {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');
    console.assert(SV.pmove !== null, 'SV.pmove must exist before setting configuration');

    SV.pmove!.configuration = config;
  }

  static get maxplayers(): number {
    return SV.svs.maxclients;
  }

  /**
   * Server game event bus, reset on every map load.
   * @returns The active server event bus.
   */
  static get eventBus(): EventBus {
    return SV.server.eventBus;
  }
}

export class ClientEngineAPI extends CommonEngineAPI {
  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @returns The created variable.
   */
  static override RegisterCvar(name: string, value: string, flags = 0, description: string | null = null): Cvar {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.CLIENT, description);
  }

  static RegisterCommand(name: string, callback: CommandCallback): void {
    Cmd.AddCommand(name, callback);
  }

  static UnregisterCommand(name: string): void {
    Cmd.RemoveCommand(name);
  }

  /**
   * Load a texture from a lump.
   * @returns The loaded texture.
   */
  static LoadPicFromLump(name: string): GLTexture {
    return Draw.LoadPicFromLumpDeferred(name);
  }

  /**
   * Load a texture from a WAD.
   * @returns The loaded texture.
   */
  static LoadPicFromWad(name: string): GLTexture {
    return Draw.LoadPicFromWad(name);
  }

  /**
   * Load a texture from a file.
   * @returns The loaded texture.
   */
  static LoadPicFromFile(filename: string): Promise<GLTexture> {
    return Draw.LoadPicFromFile(filename);
  }

  /**
   * Load a fixed-grid bitmap font atlas from a file (e.g. a stylized header font), described by
   * `config`'s charset and glyph/cell metrics.
   * @returns The loaded font.
   */
  static LoadBitmapFont(filename: string, config: Omit<BitmapFontConfig, 'texture'>): Promise<BitmapFont> {
    return BitmapFont.FromImageFile(filename, config);
  }

  /**
   * Play a sound effect.
   */
  static PlaySound(sfx: SFXValue): void {
    S.LocalSound(sfx);
  }

  /**
   * Load a sound effect. Can be used with PlaySound.
   * @returns The loaded sound effect.
   */
  static LoadSound(sfxName: string): SFXValue {
    const sfx = S.PrecacheSound(sfxName);

    console.assert(sfx !== null, 'sound must be precached before being returned', sfxName);

    return sfx!;
  }

  /**
   * Draw a picture at the specified position.
   */
  static DrawPic(x: number, y: number, pic: GLTexture, scale = 1.0): void {
    Draw.Pic(x, y, pic, scale);
  }

  /**
   * Draw a string on the screen at the specified position.
   */
  static DrawString(x: number, y: number, str: string, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)): void {
    Draw.String(x, y, str, scale, color);
  }

  /**
   * Fill a rectangle with a solid color.
   */
  static DrawRect(x: number, y: number, w: number, h: number, c: Vector, a = 1.0): void {
    Draw.Fill(x, y, w, h, c, a);
  }

  /**
   * Translate a palette index into an RGB color vector.
   * @returns The RGB color vector.
   */
  static IndexToRGB(index: number): [number, number, number] {
    console.assert(typeof index === 'number', 'index must be a number');
    console.assert(index >= 0 && index < 256, 'index must be in range [0, 255]');

    return [
      W.d_8to24table_u8[index * 3] / 256,
      W.d_8to24table_u8[index * 3 + 1] / 256,
      W.d_8to24table_u8[index * 3 + 2] / 256,
    ];
  }

  /**
   * Translate world coordinates to screen coordinates.
   * @returns Screen coordinates, or `null` if the point is behind the camera.
   */
  static WorldToScreen(origin: Vector): Vector | null {
    return R.WorldToScreen(origin);
  }

  /**
   * Get all entities in the game. Both client-only and server entities.
   * @yields Client entities.
   */
  static *GetEntities(filter: ClientEntityFilter = null): Generator<ClientEdict, void, void> {
    for (const entity of CL.state.clientEntities.getEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Get all entities staged for rendering. Both client-only and server entities.
   * @yields Visible client entities.
   */
  static *GetVisibleEntities(filter: ClientEntityFilter = null): Generator<ClientEdict, void, void> {
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Perform a trace line in the client game world.
   * By default this traces static world geometry only.
   * Keep this legacy entry point aligned with the server-side Traceline name so
   * client tracing can grow into entity-aware behavior later without another API
   * rename.
   * @returns The trace result.
   */
  static Traceline(start: Vector, end: Vector, options: ClientTraceOptions | null = null): GameTrace {
    const worldTrace = SV.collision.traceWorldLine(start, end) as InternalTraceLike;

    if (options === null || !options.includeEntities) {
      return internalTraceToGameTrace(worldTrace);
    }

    return internalTraceToGameTrace(traceClientEntities(start, end, worldTrace, options));
  }

  /**
   * Allocate a dynamic light for the given entity Id.
   * @returns The dynamic light instance.
   */
  static AllocDlight(entityId: number): ClientDlight {
    return CL.state.clientEntities.allocateDynamicLight(entityId);
  }

  /**
   * Allocate a new client entity.
   * This is a client-side entity, not a server-side edict.
   * Make sure to invoke spawn() when ready.
   * Make sure to use setOrigin() to set the position of the entity.
   * @returns A new client entity.
   */
  static AllocEntity(): ClientEdict {
    return CL.state.clientEntities.allocateClientEntity();
  }

  /**
   * Spawn a rocket trail effect from start to end.
   */
  static RocketTrail(start: Vector, end: Vector, type: number): void {
    R.RocketTrail(start, end, type);
  }

  /**
   * Place a decal in the world.
   */
  static PlaceDecal(origin: Vector, normal: Vector, texture: GLTexture): void {
    R.PlaceDecal(origin, normal, texture);
  }

  /**
   * Get a model by name. Must be precached first.
   * @returns The model.
   */
  static ModForName(modelName: string): BaseModel {
    console.assert(typeof modelName === 'string', 'modelName must be a string');

    for (let index = 1; index < CL.state.model_precache.length; index++) {
      if (CL.state.model_precache[index].name === modelName) {
        return CL.state.model_precache[index];
      }
    }

    throw new HostError(`ClientEngineAPI.ModForName: ${modelName} not precached`);
  }

  /**
   * Get a model by id.
   * @returns The model.
   */
  static ModById(id: number): BaseModel {
    console.assert(typeof id === 'number' && id > 0, 'id must be a number and greater than 0');

    if (CL.state.model_precache[id]) {
      return CL.state.model_precache[id];
    }

    throw new HostError(`ClientEngineAPI.ModById: ${id} not found`);
  }

  /**
   * Apply a content shift.
   */
  static ContentShift(slot: number, color: Vector, alpha = 0.5): void {
    V.ContentShift(slot + 4, color, alpha);
  }

  /**
   * Set the player movement configuration. This is used by the PMove code to determine how the player will move.
   */
  static SetPmoveConfiguration(config: PmoveConfiguration): void {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');

    CL.pmove.configuration = config;
  }

  static readonly CL = {
    get viewangles(): Vector {
      return CL.state.viewangles.copy();
    },
    get vieworigin(): Vector {
      console.assert(CL.state.viewent !== null, 'client view entity must exist when reading vieworigin');

      return CL.state.viewent!.origin.copy();
    },
    get maxclients(): number {
      return CL.state.maxclients;
    },
    get levelname(): string {
      return CL.state.levelname ?? '';
    },
    get entityNum(): number {
      return CL.state.viewentity;
    },
    /**
     * local time, not game time! If you are looking for SV.server.time, check gametime
     * @returns Local time.
     */
    get time(): number { // FIXME: rename to localtime to make the distinction clearer
      return CL.state.time;
    },
    /**
     * latest SV.server.time, NOT local time!
     * @returns Game time.
     */
    get gametime(): number {
      return CL.state.clientMessages.mtime[0];
    },
    get frametime(): number {
      return Host.frametime;
    },
    get intermission(): boolean {
      return CL.state.intermission > 0;
    },
    /**
     * Current intermission mode: 0 = none, 1 = map exit, 2 = finale, 3 = cutscene.
     * @returns Current intermission mode.
     */
    get intermissionState(): number {
      return CL.state.intermission;
    },
    set intermission(value: boolean) {
      CL.state.intermission = value ? 1 : 0;
    },
    score(num: number) {
      return CL.state.scores[num];
    },
    get serverInfo() {
      return CL.cls.serverInfo;
    },
    /**
     * @returns True while fully connected to a server (local or remote).
     */
    get connected(): boolean {
      return CL.cls.state === clientConnectionState.connected;
    },
  };

  static readonly SV = {
    /**
     * @returns True while this client is also hosting a local (listen) server.
     */
    get active(): boolean {
      return SV.server.active;
    },
  };

  static readonly VID = {
    get width(): number {
      return VID.width;
    },
    get height(): number {
      return VID.height;
    },
    get pixelRatio(): number {
      return VID.pixelRatio;
    },
  };

  static readonly Key = {
    /**
     * Get the string representation of a key binding, e.g. "+attack" -> "mouse1".
     * @returns The bound key string, or `null` when not found.
     */
    getKeyForBinding(binding: string): string | null {
      return Key.BindingToString(binding);
    },
  };

  static readonly SCR = {
    /**
     * @returns The current view size.
     */
    get viewsize(): number {
      return (SCR as typeof SCR & { viewsize: Cvar }).viewsize.value as number;
    },
    /**
     * @returns The current 3D view rectangle in screen coordinates.
     */
    get viewRect(): { x: number; y: number; width: number; height: number } {
      return {
        x: R.refdef.vrect.x,
        y: R.refdef.vrect.y,
        width: R.refdef.vrect.width,
        height: R.refdef.vrect.height,
      };
    },
  };

  static readonly PostProcess = {
    setStack(stack: PostProcessStack): void {
      PostProcess.setStack(stack);
    },

    clearStack(): void {
      PostProcess.clearStack();
    },

    hasStack(): boolean {
      return PostProcess.hasGameplayStack();
    },
  };

  /**
   * Menu registration and navigation, backed by the engine's menu stack (`source/engine/client/menu/`).
   * Widget classes are re-exported here so game code never has to import engine internals directly.
   */
  static readonly Menu = {
    /**
     * Register a page under a name so it can later be opened by `Open`/`Push`/`Replace`.
     */
    RegisterPage(name: string, page: MenuPage): void {
      M.menuStack.register(name, page);
    },

    /**
     * Unregister a previously registered page.
     */
    UnregisterPage(name: string): void {
      M.menuStack.unregister(name);
    },

    /**
     * Declare which registered page is the root -- what `togglemenu`/Escape opens, and what
     * `Clear()`/an involuntary disconnect falls back to. Resolved by name, so re-registering
     * that name to a different page later keeps the root correct without calling this again.
     */
    SetRootPage(name: string): void {
      M.menuStack.setRootPage(name);
    },

    /**
     * Open a registered page as the pause menu, replacing whatever is currently shown.
     */
    Open(name: string): void {
      Key.destination = KeyDestination.menu;
      M.menuStack.push(name);
    },

    /**
     * Push a registered page on top of the current one. Assumes the menu is already open.
     */
    Push(name: string): void {
      M.menuStack.push(name);
    },

    /**
     * Pop the current page, revealing whatever was open before it (closing the menu entirely
     * if nothing is left).
     */
    Pop(): void {
      M.PopMenu();
    },

    /**
     * Pop pages until the stack is at most `depth` deep.
     */
    PopTo(depth: number): void {
      M.menuStack.popTo(depth);
    },

    /**
     * Pop down to a single page, leaving only the bottom of the stack.
     */
    PopToRoot(): void {
      M.menuStack.popToRoot();
    },

    /**
     * Replace the current page with a registered one, without growing the navigation stack.
     */
    Replace(name: string): void {
      M.menuStack.replace(name);
    },

    /**
     * Close the menu entirely, returning to the game (or console).
     */
    Close(): void {
      M.CloseMenu();
    },

    /**
     * Pop every page off the stack without changing `Key.destination` -- unlike `Close()`, this
     * doesn't return to the game/console, it just empties the navigation stack.
     */
    Clear(): void {
      M.menuStack.clear();
    },

    /**
     * Force the menu to close immediately and return control to the game, regardless of
     * connection state -- unlike `Close()`, which stays open while disconnected (nothing to
     * return to). Use this when the action itself is what's about to create a game to return
     * to, e.g. starting a new game from a disconnected menu.
     */
    ForceClose(): void {
      M.menuStack.clear();
      M.ReturnToGame();
    },

    /**
     * Toggle the drop-down console overlay.
     */
    ToggleConsole(): void {
      Con.ToggleConsole_f();
    },

    /**
     * Quit immediately, skipping Host.Quit_f()'s own confirmation gate -- for use after the
     * player already confirmed via a mod's own quit dialog.
     */
    ForceQuit(): void {
      Host.ForceQuit();
    },

    /**
     * Start a new singleplayer game via the active mod's `StartGameInterface`
     * (`ClientGameInterface.GetStartGameInterface`), or the engine's own default (`map start`)
     * if the mod didn't provide one.
     */
    StartSingleplayerGame(): void {
      M.StartSingleplayerGame();
    },

    /**
     * Start (host) a multiplayer game on `mapname` via the active mod's `StartGameInterface`
     * (`ClientGameInterface.GetStartGameInterface`), or the engine's own default
     * (`map <mapname>`) if the mod didn't provide one.
     */
    StartMultiplayerGame(mapname: string): void {
      M.StartMultiplayerGame(mapname);
    },

    /**
     * Load a lump-based pic together with a color-translation texture built from its raw
     * palette indices, for `DrawPicTranslate` (e.g. a player-color preview). The palette/LMP
     * parsing stays engine-side since it's raw asset format handling, not menu content.
     * @returns The pic, with `.translate` populated.
     */
    LoadTranslatablePic(lumpName: string): Promise<MenuPic> {
      return M.LoadTranslatablePic(lumpName);
    },

    /**
     * Check whether the menu is open, optionally a specific registered page.
     * @returns True when the menu (or the named page) is currently shown.
     */
    IsOpen(name?: string): boolean {
      if (name === undefined) {
        return M.menuStack.current() !== null;
      }

      return M.menuStack.isShowing(name);
    },

    /**
     * @returns The current navigation stack depth.
     */
    Depth(): number {
      return M.menuStack.depth();
    },

    /**
     * @returns True when nothing is on the navigation stack.
     */
    IsEmpty(): boolean {
      return M.menuStack.isEmpty();
    },

    /**
     * The page one level below the current one on the stack, if any -- e.g. a dialog's own
     * `getBackdrop` wanting to draw whatever was open before it appeared.
     * @returns The previous page, or null if the current page is at (or below) the root.
     */
    GetPreviousPage(): MenuPage | null {
      return M.menuStack.getPreviousPage();
    },

    /**
     * Insert an item into a registered page, e.g. to extend a built-in screen from game code.
     */
    AddItem(pageName: string, item: MenuItem, index?: number): void {
      const page = M.menuStack.getPage(pageName);

      console.assert(page !== undefined, 'ClientEngineAPI.Menu.AddItem: unknown page', pageName);

      if (!page) {
        return;
      }

      if (index === undefined) {
        page.items.push(item);
      } else {
        page.items.splice(index, 0, item);
      }
    },

    /**
     * Remove a previously added item from a registered page.
     */
    RemoveItem(pageName: string, item: MenuItem): void {
      const page = M.menuStack.getPage(pageName);

      if (!page) {
        return;
      }

      const index = page.items.indexOf(item);

      if (index !== -1) {
        page.items.splice(index, 1);
      }
    },

    /**
     * Current mouse position in the current page's virtual menu-space coordinates (see
     * `MenuViewport`/`MenuPage.viewport`).
     * @returns The horizontal position.
     */
    get mouseX(): number {
      return M.mouseX;
    },

    /**
     * Current mouse position in the current page's virtual menu-space coordinates (see
     * `MenuViewport`/`MenuPage.viewport`).
     * @returns The vertical position.
     */
    get mouseY(): number {
      return M.mouseY;
    },

    /**
     * Convert a virtual-space point (in the current page's viewport) into a real screen pixel
     * position -- for a `customDraw` that needs to place a resolution-aware `DrawPic`/
     * `DrawString` call (see above; a different coordinate system from `Print`/`DrawPic` below)
     * at a virtual-space position.
     * @returns The equivalent real screen position.
     */
    toScreenPosition(x: number, y: number): { x: number; y: number } {
      return M.toScreenPosition(x, y);
    },

    /**
     * The current page's resolved virtual-to-real pixel scale, e.g. to size a resolution-aware
     * `DrawPic` call to match a virtual-space target width.
     * @returns The scale factor.
     */
    get viewportScale(): number {
      return M.viewportScale;
    },

    // Low-level drawing primitives every widget/layout draws with, re-exported so a page's
    // `customDraw`/`customHandleInput` (and a custom MenuItem's `customDraw`) can reproduce the
    // same look without reaching into engine internals. All operate in the current page's own
    // virtual coordinate space (see `MenuViewport`/`MenuPage.viewport`, classic 320x200 by
    // default) -- a different coordinate system from `DrawPic`/`DrawString` above, which are
    // resolution-aware absolute pixel offsets.

    Print(cx: number, cy: number, str: string): void {
      M.Print(cx, cy, str);
    },

    PrintWhite(cx: number, cy: number, str: string): void {
      M.PrintWhite(cx, cy, str);
    },

    DrawCharacter(cx: number, cy: number, num: number): void {
      M.DrawCharacter(cx, cy, num);
    },

    DrawPic(x: number, y: number, pic: MenuPic): void {
      M.DrawPic(x, y, pic);
    },

    DrawPicTranslate(x: number, y: number, pic: MenuPic, top: number, bottom: number): void {
      M.DrawPicTranslate(x, y, pic, top, bottom);
    },

    DrawTextBox(x: number, y: number, width: number, lines: number): void {
      M.DrawTextBox(x, y, width, lines);
    },

    DrawSlider(x: number, y: number, range: number): void {
      M.DrawSlider(x, y, range);
    },

    Action,
    Label,
    Slider,
    Toggle,
    Textbox,
    Spacer,
    Image,
    ColorPicker,
    NumberInput,
    SaveSlotItem,
    KeyBindItem,
    MenuPage,
    DialogPage,
    ListPage,
    VerticalLayout,
    ImageBasedLayout,
    ListLayout,
    GridLayout,
    MenuViewport,
  };

  static readonly Multiplayer = {
    /**
     * Fetch currently joinable sessions for this client's active game (mod) from the master
     * server. Throws if signaling is unavailable -- callers that can't assume it's configured
     * should check first or catch.
     * @returns Sessions matching the active game/mod.
     */
    ListSessions(): Promise<DiscoveredSession[]> {
      return SessionDiscovery.listSessions();
    },

    /**
     * Subscribes to live session updates for this client's active game (mod) over the master
     * server's real-time `/browser` channel. See {@link SessionDiscovery.subscribe}.
     * @returns An unsubscribe function; safe to call more than once.
     */
    SubscribeSessions(
      onSessions: (sessions: DiscoveredSession[]) => void,
      onStatus?: (status: SessionDiscoveryStatus) => void,
    ): () => void {
      return SessionDiscovery.subscribe(onSessions, onStatus);
    },

    /**
     * Requests a fresh session snapshot over an already-open SubscribeSessions channel. See
     * {@link SessionDiscovery.requestRefresh}.
     */
    RequestSessionsRefresh(): void {
      SessionDiscovery.requestRefresh();
    },
  };

  static readonly SaveSlots = {
    /**
     * List save-slot metadata for the currently active game directory.
     * @returns Metadata for save slots `0..maxSlots - 1`.
     */
    List(maxSlots: number): SaveSlotInfo[] {
      return SaveSlotsService.list(maxSlots);
    },

    /**
     * Delete a save slot's data.
     */
    Delete(index: number): void {
      SaveSlotsService.delete(index);
    },
  };

  static get eventBus(): EventBus {
    return CL.state.eventBus;
  }

  /**
   * A second bus alongside `eventBus`, living for the whole game module's lifetime instead of
   * being wiped on every disconnect/reconnect -- see `ClientState.ts`'s `moduleEventBus` for which
   * events reach it (the same set as `eventBus`) and why.
   * @returns The module-lifetime event bus.
   */
  static get moduleEventBus(): EventBus {
    return CL.moduleEventBus;
  }
}
