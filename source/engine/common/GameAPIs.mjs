import { PmoveConfiguration } from '../../shared/Pmove.ts';
import Vector from '../../shared/Vector.ts';
import { solid } from '../../shared/Defs.ts';
import Key from '../client/Key.mjs';
import { SFX } from '../client/Sound.mjs';
import VID from '../client/VID.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { EventBus, eventBus, registry } from '../registry.mjs';
import { ED, ServerEdict } from '../server/Edict.mjs';
import Cmd from './Cmd.mjs';
import Cvar from './Cvar.mjs';
import { HostError } from './Errors.mjs';
import Mod from './Mod.mjs';
import W from './W.mjs';

/** @typedef {import('../client/ClientEntities.mjs').ClientEdict} ClientEdict */
/** @typedef {import('../client/ClientEntities.mjs').ClientDlight} ClientDlight */
/** @typedef {import('../client/GL.mjs').GLTexture} GLTexture */
/** @typedef {import('../network/MSG.mjs').SzBuffer} SzBuffer */
/** @typedef {import('../server/Navigation.mjs').Navigation} Navigation */
/** @typedef {import('./model/parsers/ParsedQC.mjs').default} ParsedQC */
/** @typedef {import('./model/BaseModel.mjs').BaseModel} BaseModel */
/** @typedef {import('../server/physics/ServerCollisionSupport.mjs').CollisionTrace} CollisionTrace */
/**
 * @typedef ClientTraceOptions
 * @property {boolean} [includeEntities] include current client entities in addition to static world geometry
 * @property {?number} [passEntityId] client entity number to skip during entity tracing
 * @property {?((entity: ClientEdict) => boolean)} [filter] optional candidate filter for entity tracing
 */
/**
 * @typedef GameTrace
 * @property {{ all: boolean, start: boolean }} solid solid hit flags
 * @property {number} fraction completed trace fraction
 * @property {{ normal: Vector, distance: number }} plane impact plane
 * @property {{ inOpen: boolean, inWater: boolean }} contents terminal contents flags
 * @property {Vector} point final trace point
 * @property {import('../../game/id1/entity/BaseEntity.mjs').default|ClientEdict|null} entity hit entity, if any
 */

let { CL, Con, Draw, Host, R, S, SCR, SV, V} = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
  R = registry.R;
  S = registry.S;
  SCR = registry.SCR;
  SV = registry.SV;
  V = registry.V;
});

eventBus.subscribe('com.ready', () => {
  const COM = registry.COM;

  if (!COM.registered) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.shareware);
  }

  if (COM.hipnotic) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.hipnotic);
  }

  if (COM.rogue) {
    CommonEngineAPI.gameFlavors.push(GameFlavors.rogue);
  }

  if (COM.registered.value === 1) {
    ServerEngineAPI.registered = true;
    ClientEngineAPI.registered = true;
  }
});

/** @enum {string} */
export const GameFlavors = Object.freeze({
  hipnotic: 'hipnotic',
  rogue: 'rogue',
  shareware: 'shareware',
});

// eslint-disable-next-line jsdoc/require-jsdoc
function internalTraceToGameTrace(trace) {
  return {
    solid: {
      /** @type {boolean} */
      all: trace.allsolid,
      /** @type {boolean} */
      start: trace.startsolid,
    },
    /** @type {number} */
    fraction: trace.fraction,
    plane: {
      /** @type {Vector} */
      normal: trace.plane.normal,
      /** @type {number} */
      distance: trace.plane.dist,
    },
    contents: {
      /** @type {boolean} */
      inOpen: !!trace.inopen,
      /** @type {boolean} */
      inWater: !!trace.inwater,
    },
    /** @type {Vector} final position of the line */
    point: trace.endpos,
    /** @type {?import('../../game/id1/entity/BaseEntity.mjs').default} entity */
    entity: trace.ent ? trace.ent.entity : null,
  };
}

/**
 * @param {ClientEdict} entity client entity candidate
 * @returns {boolean} true when the entity can be traced against
 */
function isTraceableClientSolid(entity) {
  return entity.solid === solid.SOLID_BBOX
    || entity.solid === solid.SOLID_SLIDEBOX
    || entity.solid === solid.SOLID_BSP
    || entity.solid === solid.SOLID_MESH;
}

/**
 * @param {ClientEdict} entity client entity candidate
 * @returns {{ mins: Vector, maxs: Vector }} extents used for tracing this entity
 */
function getClientTraceExtents(entity) {
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
 * @param {ClientEdict} entity client entity candidate
 * @param {Vector} absmin output minimum bounds
 * @param {Vector} absmax output maximum bounds
 */
function computeClientTraceBounds(entity, absmin, absmax) {
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
 * @param {Vector} traceMins trace minimum bounds
 * @param {Vector} traceMaxs trace maximum bounds
 * @param {Vector} entityMins entity minimum bounds
 * @param {Vector} entityMaxs entity maximum bounds
 * @returns {boolean} true when the AABBs overlap
 */
function traceBoundsOverlap(traceMins, traceMaxs, entityMins, entityMaxs) {
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
 * @param {Vector} start trace start
 * @param {Vector} end trace end
 * @param {CollisionTrace} worldTrace current static-world trace result
 * @param {ClientTraceOptions} options client trace options
 * @returns {CollisionTrace} best trace including eligible client entities
 */
function traceClientEntities(start, end, worldTrace, options) {
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

  /** @type {CollisionTrace} */
  let bestTrace = worldTrace;

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

    const trace = SV.collision.clipMoveToEntity({
      // @ts-ignore Client tracing reuses shared narrow-phase helpers with a lightweight ClientEdict adapter.
      entity,
      num: entity.num,
      equals(other) {
        return this === other;
      },
    }, start, Vector.origin, Vector.origin, bestTrace.endpos);

    if (trace.allsolid || trace.startsolid || trace.fraction < bestTrace.fraction) {
      bestTrace = trace;
    }
  }

  return bestTrace;
}

export class CommonEngineAPI {
  /**
   * Indicates whether the game is registered (not shareware).
   * @type {boolean} true if the game is registered, false if it is shareware
   */
  static registered = false;

  /** @type {GameFlavors[]} */
  static gameFlavors = [];

  /**
   * Appends text to the command buffer.
   * @param {string} text command strings to be added to the Cmd.text buffer
   */
  static AppendConsoleText(text) {
    Cmd.text += text;
  }

  /**
   * Gets a cvar by name.
   * @param {string} name name of the variable
   * @returns {Cvar} the variable
   */
  static GetCvar(name) {
    return Cvar.FindVar(name);
  }

  /**
   * Changes the value of a cvar.
   * @param {string} name name of the variable
   * @param {string} value value
   * @returns {Cvar} the modified variable
   */
  static SetCvar(name, value) {
    return Cvar.Set(name, value);
  }

  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @param {string} name name of the variable
   * @param {string} value value
   * @param {number} flags optional flags
   * @param {?string} description optional description
   * @returns {Cvar} the created variable
   */
  static RegisterCvar(name, value, flags = 0, description = null) {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME, description);
  }

  static ConsolePrint(msg, color = new Vector(1.0, 1.0, 1.0)) {
    Con.Print(msg, color);
  }

  static ConsoleWarning(msg) {
    Con.PrintWarning(msg);
  }

  static ConsoleError(msg) {
    Con.PrintError(msg);
  }

  static ConsoleDebug(str) {
    Con.DPrint(str);
  }

  /**
   * Parses QuakeC for model animation information.
   * @param {string} qcContent qc content
   * @returns {ParsedQC} parsed QC content
   */
  static ParseQC(qcContent) {
    return Mod.ParseQC(qcContent);
  }
};

export class ServerEngineAPI extends CommonEngineAPI {
  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @param {string} name name of the variable
   * @param {string} value value
   * @param {number} flags optional flags
   * @param {?string} description optional description
   * @returns {Cvar} the created variable
   */
  static RegisterCvar(name, value, flags = 0, description = null) {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.SERVER, description);
  }

  static BroadcastPrint(str) {
    Host.BroadcastPrint(str);
  }

  static StartParticles(origin, direction, color, count) {
    SV.messages.startParticle(origin, direction, color, count);
  }

  static SpawnAmbientSound(origin, sfxName, volume, attenuation) {
    let i = 0;

    for (; i < SV.server.soundPrecache.length; i++) {
      if (SV.server.soundPrecache[i] === sfxName) {
        break;
      }
    }

    if (i === SV.server.soundPrecache.length) {
      Con.Print('no precache: ' + sfxName + '\n');
      return false;
    }

    const signon = SV.server.signon;
    signon.writeByte(Protocol.svc.spawnstaticsound);
    signon.writeCoordVector(origin);
    signon.writeByte(i);
    signon.writeByte(volume * 255.0);
    signon.writeByte(attenuation * 64.0);

    return true;
  }

  static StartSound(edict, channel, sfxName, volume, attenuation) {
    SV.messages.startSound(edict, channel, sfxName, volume * 255.0, attenuation);

    return true;
  }

  static Traceline(start, end, noMonsters, passEdict, mins = null, maxs = null) {
    const nullVec = Vector.origin;
    const trace = SV.collision.move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);
    return internalTraceToGameTrace(trace);
  }

  static TracelineLegacy(start, end, noMonsters, passEdict, mins = null, maxs = null) {
    const nullVec = Vector.origin;
    return SV.collision.move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);
  }

  /**
   * Defines a lightstyle (e.g. aazzaa).
   * It will also send an update to all connected clients.
   * @param {number} styleId
   * @param {string} sequenceString
   */
  static Lightstyle(styleId, sequenceString) {
    SV.server.lightstyles[styleId] = sequenceString;

    if (SV.server.loading) {
      return;
    }

    for (const client of SV.svs.spawnedClients()) {
      client.message.writeByte(Protocol.svc.lightstyle);
      client.message.writeByte(styleId);
      client.message.writeString(sequenceString);
    }
  }

  /**
   * Finds out what contents the given point is in, using the active world
   * collision backend.
   * @param {Vector} origin point in space
   * @returns {number} contents
   */
  static DetermineStaticWorldContents(origin) {
    return SV.collision.staticWorldContents(origin);
  }

  /**
   * Compatibility alias for DetermineStaticWorldContents.
   * @param {Vector} origin point in space
   * @returns {number} contents
   */
  static DetermineWorldContents(origin) {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Finds out what contents the given point is in.
   * @param {Vector} origin point in space
   * @returns {number} contents
   */
  static DeterminePointContents(origin) {
    return this.DetermineStaticWorldContents(origin);
  }

  /**
   * Set an area portal's open/close state.
   * Call this when a door or platform opens/closes to control sound propagation
   * and area connectivity. Uses reference counting: multiple entities can hold
   * the same portal open.
   * @param {number} portalNum portal index (from the BSP area portals lump)
   * @param {boolean} open true to open (increment ref count), false to close (decrement)
   */
  static SetAreaPortalState(portalNum, open) {
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
   * Check if two areas are connected through open portals.
   * @param {number} area0 first area index
   * @param {number} area1 second area index
   * @returns {boolean} true if the areas are connected
   */
  static AreasConnected(area0, area1) {
    if (SV.server.worldmodel === null) {
      return true;
    }

    return SV.server.worldmodel.areaPortals.areasConnected(area0, area1);
  }

  /**
   * Get the auto-assigned portal number for a brush model.
   * Returns -1 if the model has no associated portal.
   * @param {string} modelName brush model name (e.g. "*1")
   * @returns {number} portal number, or -1 if none
   */
  static GetModelPortal(modelName) {
    if (SV.server.worldmodel === null) {
      return -1;
    }

    return SV.server.worldmodel.modelPortalMap[modelName] ?? -1;
  }

  static ChangeLevel(mapname) {
    if (SV.svs.changelevelIssued) {
      return;
    }

    Cmd.text += `changelevel ${mapname}\n`;
  }

  /**
   * Finds all edicts around origin in given radius.
   * @param {Vector} origin point in space
   * @param {number} radius not really a radius, it’s used for creating an axis-aligned bounding box
   * @param {(ent: ServerEdict) => boolean} filterFn optional filter function, if provided, will be used to filter entities
   * @returns {ServerEdict[]} matching edict
   */
  static FindInRadius(origin, radius, filterFn = null) {
    const vradius = new Vector(radius, radius, radius);
    const mins = origin.copy().subtract(vradius);
    const maxs = origin.copy().add(vradius);

    /** @type {ServerEdict[]} */
    const edicts = [];

    for (const ent of SV.area.tree.queryAABB(mins, maxs)) {
      if (ent.num === 0 || ent.isFree()) {
        continue;
      }

      const eorg = origin.copy().subtract(ent.entity.origin.copy().add(ent.entity.mins.copy().add(ent.entity.maxs).multiply(0.5)));

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
   * @param {string} field field name to inspect on each entity
   * @param {import('../../shared/GameInterfaces').EdictValueType} value target field value
   * @param {number} startEdictId entity number to start searching from
   * @deprecated use FindAllByFieldAndValue instead
   * @returns {ServerEdict|null} first matching edict, if any
   */
  static FindByFieldAndValue(field, value, startEdictId = 0) { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let i = startEdictId; i < SV.server.num_edicts; i++) {
      /** @type {ServerEdict} */
      const ent = SV.server.edicts[i];

      if (ent.isFree()) {
        continue;
      }

      if (ent.entity[field] === value) {
        return ent; // FIXME: turn it into yield
      }
    }

    return null;
  }

  // TODO: optimize lookups by using maps for fields such as targetname, etc.
  static *FindAllByFieldAndValue(field, value, startEdictId = 0) { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let i = startEdictId; i < SV.server.num_edicts; i++) {
      /** @type {ServerEdict} */
      const ent = SV.server.edicts[i];

      if (ent.isFree()) {
        continue;
      }

      if (ent.entity[field] === value) {
        yield ent;
      }
    }
  }

  /**
   * @param {function(ServerEdict): boolean} filterFn
   * @param {number} startEdictId
   * @yields {ServerEdict}
   */
  static *FindAllByFilter(filterFn = null, startEdictId = 0) { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let i = startEdictId; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (ent.isFree()) {
        continue;
      }

      if (!filterFn || filterFn(ent)) {
        yield ent;
      }
    }
  }

  static *GetClients() {
    for (const client of SV.svs.spawnedClients()) {
      yield client.edict;
    }
  }

  static GetEdictById(edictId) {
    if (edictId < 0 || edictId >= SV.server.num_edicts) {
      return null;
    }

    return SV.server.edicts[edictId];
  }

  static PrecacheSound(sfxName) {
    console.assert(typeof(sfxName) === 'string', 'sfxName must be a string');

    if (SV.server.soundPrecache.includes(sfxName)) {
      return;
    }

    SV.server.soundPrecache.push(sfxName);
  }

  static PrecacheModel(modelName) {
    console.assert(typeof(modelName) === 'string', 'modelName must be a string');

    if (SV.server.modelPrecache.includes(modelName)) {
      return;
    }

    SV.server.modelPrecache.push(modelName);
    SV.server.models.push(Mod.ForNameAsync(modelName, true, Mod.scope.server)); // will cause promises in the array
  }

  /**
   * Spawns an Edict, not an entity.
   * @param {string} classname classname of the entity to spawn, needs to be registered
   * @param {Record<string, any>} initialData key-value pairs to initialize the entity with, will be handled by the game code
   * @returns {ServerEdict|null} the spawned edict (NOT ENTITY), or null on failure
   */
  static SpawnEntity(classname, initialData = {}) {
    const edict = ED.Alloc();

    try {
      if (!SV.server.gameAPI.prepareEntity(edict, classname, initialData)) {
        edict.freeEdict();
        return null;
      }

      if (!SV.server.gameAPI.spawnPreparedEntity(edict)) {
        edict.freeEdict();
        return null;
      }
    } catch (e) {
      edict.freeEdict();
      throw e;
    }

    return edict;
  }

  static IsLoading() {
    return SV.server.loading;
  }

  /**
   * @param {number} tempEntityId temporary entity protocol id
   * @param {Vector} origin event origin
   * @deprecated use client events instead
   */
  static DispatchTempEntityEvent(tempEntityId, origin) {
    SV.server.datagram.writeByte(Protocol.svc.temp_entity);
    SV.server.datagram.writeByte(tempEntityId);
    SV.server.datagram.writeCoordVector(origin);
  }

  /**
   * @param {number} beamId beam protocol id
   * @param {number} edictId source entity id
   * @param {Vector} startOrigin beam start position
   * @param {Vector} endOrigin beam end position
   * @deprecated use client events instead
   */
  static DispatchBeamEvent(beamId, edictId, startOrigin, endOrigin) {
    SV.server.datagram.writeByte(Protocol.svc.temp_entity); // FIXME: unhappy about this
    SV.server.datagram.writeByte(beamId);
    SV.server.datagram.writeShort(edictId);
    SV.server.datagram.writeCoordVector(startOrigin);
    SV.server.datagram.writeCoordVector(endOrigin);
  }

  /**
   * Makes all clients play the specified audio track.
   * @param {number} track audio track number
   */
  static PlayTrack(track) {
    SV.server.datagram.writeByte(Protocol.svc.cdtrack);
    SV.server.datagram.writeByte(track);
    SV.server.datagram.writeByte(0); // unused
  }

  /**
   * Shows the shareware sell screen to all clients.
   * Used when completing shareware episode 1.
   */
  static ShowSellScreen() {
    SV.server.reliable_datagram.writeByte(Protocol.svc.sellscreen);
  }

  /**
   * Dispatches a client event to the specified receiver.
   * NOTE: Events are written to the datagram AFTER an entity update, so referring to an entity that will be removed in the same frame will not work!
   * @param {SzBuffer} destination destination to write the event to, can be SV.server.datagram or a client message buffer
   * @param {number} eventCode event code, must be understood by the client
   * @param  {...import('../../shared/GameInterfaces').SerializableType} args any arguments to pass to the client event, will be serialized
   */
  static #DispatchClientEventOnDestination(destination, eventCode, ...args) {
    console.assert(typeof eventCode === 'number', 'eventCode must be a number');

    destination.writeByte(Protocol.svc.clientevent);
    destination.writeByte(eventCode);

    destination.writeSerializables(args);
  }

  /**
   * Dispatches a client event to everyone
   * @param {boolean} expedited if true, the event will be sent before the next entity update, otherwise it will be sent after the next entity update
   * @param {number} eventCode event code, must be understood by the client
   * @param  {...import('../../shared/GameInterfaces').SerializableType} args any arguments to pass to the client event, will be serialized
   */
  static BroadcastClientEvent(expedited, eventCode, ...args) {
    this.#DispatchClientEventOnDestination(expedited ? SV.server.datagram : SV.server.expedited_datagram, eventCode, ...args);
  }

  /**
   * Dispatches a client event to the specified receiver.
   * @param {ServerEdict} receiverPlayerEdict the edict of the player to send the event to
   * @param {boolean} expedited if true, the event will be sent before the next entity update, otherwise it will be sent after the next entity update
   * @param {number} eventCode event code, must be understood by the client
   * @param  {...import('../../shared/GameInterfaces').SerializableType} args any arguments to pass to the client event, will be serialized
   */
  static DispatchClientEvent(receiverPlayerEdict, expedited, eventCode, ...args) {
    console.assert(receiverPlayerEdict instanceof ServerEdict && receiverPlayerEdict.isClient(), 'emitterEdict must be a ServerEdict connected to a client');

    const destination = expedited ? receiverPlayerEdict.getClient().expedited_message : receiverPlayerEdict.getClient().message;

    this.#DispatchClientEventOnDestination(destination, eventCode, ...args);
  }

  /**
   * Will return a series of waypoints from start to end.
   * @param {Vector} start start point
   * @param {Vector} end end point
   * @returns {Vector[]} array of waypoints from start to end, including start and end
   */
  static Navigate(start, end) {
    return SV.server.navigation.findPath(start, end);
  }

  /**
   * Will return a series of waypoints from start to end.
   * @param {Vector} start start point
   * @param {Vector} end end point
   * @returns {Promise<Vector[]>} array of waypoints from start to end, including start and end
   */
  static async NavigateAsync(start, end) {
    return SV.server.navigation.findPathAsync(start, end);
  }

  static GetPHS(origin) {
    return SV.server.worldmodel.getPhsByPoint(origin);
  }

  static GetPVS(origin) {
    return SV.server.worldmodel.getPvsByPoint(origin);
  }

  /**
   * Get the area index for a world position.
   * @param {Vector} origin world position
   * @returns {number} area index (0 = outside/invalid)
   */
  static GetAreaForPoint(origin) {
    return SV.server.worldmodel.getLeafForPoint(origin).area;
  }

  /**
   * Sets the player movement configuration. This is used by the PMove code to determine how the player should move.
   * @param {PmoveConfiguration} config pmove profile
   */
  static SetPmoveConfiguration(config) {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');

    SV.pmove.configuration = config;
  }

  static get maxplayers() {
    return SV.svs.maxclients;
  }

  /**
   * Server game event bus, will be reset on every map load.
   * @returns {EventBus} event bus
   */
  static get eventBus() {
    return SV.server.eventBus;
  }
};

export class ClientEngineAPI extends CommonEngineAPI {
  /**
   * Make sure to free the variable in shutdown().
   * @see {@link Cvar}
   * @param {string} name name of the variable
   * @param {string} value value
   * @param {number} flags optional flags
   * @param {?string} description optional description
   * @returns {Cvar} the created variable
   */
  static RegisterCvar(name, value, flags = 0, description = null) {
    return new Cvar(name, value, flags | Cvar.FLAG.GAME | Cvar.FLAG.CLIENT, description);
  }

  /**
   * @param {string} name command name
   * @param {Function} callback callback function
   */
  static RegisterCommand(name, callback) {
    Cmd.AddCommand(name, callback);
  }

  // eslint-disable-next-line no-unused-vars
  static UnregisterCommand(name) {
    // TODO: implement
    console.assert(false, 'UnregisterCommand is not implemented yet');
  }

  /**
   * Loads texture from lump.
   * @param {string} name lump name
   * @returns {GLTexture} texture
   */
  static LoadPicFromLump(name) {
    return Draw.LoadPicFromLumpDeferred(name);
  }

  /**
   * Loads texture from WAD.
   * @param {string} name lump name
   * @returns {GLTexture} texture
   */
  static LoadPicFromWad(name) {
    return Draw.LoadPicFromWad(name);
  }

  /**
   * Loads texture from file.
   * @param {string} filename texture filename
   * @returns {Promise<GLTexture>} texture
   */
  static async LoadPicFromFile(filename) {
    return await Draw.LoadPicFromFile(filename);
  }

  /**
   * Plays a sound effect.
   * @param {SFX} sfx sound effect
   */
  static PlaySound(sfx) {
    S.LocalSound(sfx);
  }

  /**
   * Loads a sound effect. Can be used with PlaySound.
   * @param {string} sfxName sound effect name, e.g. "misc/talk.wav"
   * @returns {SFX} sound effect
   */
  static LoadSound(sfxName) {
    return S.PrecacheSound(sfxName);
  }

  /**
   * Draws a picture at the specified position.
   * @param {number} x x position
   * @param {number} y y position
   * @param {GLTexture} pic pic texture to draw
   * @param {number} scale optional scale (default: 1.0)
   */
  static DrawPic(x, y, pic, scale = 1.0) {
    Draw.Pic(x, y, pic, scale);
  }

  /**
   * Draws a string on the screen at the specified position.
   * @param {number} x x position
   * @param {number} y y position
   * @param {string} str string
   * @param {number} scale optional scale (default: 1.0)
   * @param {Vector} color optional color in RGB format (default: white)
   */
  static DrawString(x, y, str, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)) {
    Draw.String(x, y, str, scale, color);
  }

  /**
   * Fills a rectangle with a solid color.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} w The width of the rectangle.
   * @param {number} h The height of the rectangle.
   * @param {Vector} c The color index.
   * @param {number} a Optional alpha value (default is 1.0).
   */
  static DrawRect(x, y, w, h, c, a = 1.0) {
    Draw.Fill(x, y, w, h, c, a);
  }

  /**
   * @param {number} index index on the palette, must be in range [0, 255]
   * @returns {Vector} RGB color vector
   */
  static IndexToRGB(index) {
    console.assert(typeof index === 'number', 'index must be a number');
    console.assert(index >= 0 && index < 256, 'index must be in range [0, 255]');

    return new Vector(
      W.d_8to24table_u8[index * 3] / 256,
      W.d_8to24table_u8[index * 3 + 1] / 256,
      W.d_8to24table_u8[index * 3 + 2] / 256,
    );
  }

  /**
   * Translates world coordinates to screen coordinates.
   * @param {Vector} origin position in world coordinates
   * @returns {Vector|null} position in screen coordinates, or null if the point is behind the camera
   */
  static WorldToScreen(origin) {
    return R.WorldToScreen(origin);
  }

  /**
   * Gets all entities in the game. Both client-only and server entities.
   * @param {(ent: ClientEdict) => boolean} filter filter function, if provided, will be used to filter entities
   * @yields {ClientEdict} entity
   */
  static *GetEntities(filter = null) {
    for (const entity of CL.state.clientEntities.getEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Gets all entities staged for rendering. Both client-only and server entities.
   * @param {(ent: ClientEdict) => boolean} filter filter function, if provided, will be used to filter entities
   * @yields {ClientEdict} entity
   */
  static *GetVisibleEntities(filter = null) {
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (filter && !filter(entity)) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Performs a trace line in the client game world.
   * By default this traces static world geometry only.
   * Keep this legacy entry point aligned with the server-side Traceline name so
   * client tracing can grow into entity-aware behavior later without another API
   * rename.
   * @param {Vector} start start position
   * @param {Vector} end end position
   * @param {ClientTraceOptions} [options] optional entity-tracing options
   * @returns {GameTrace} trace result
   */
  static Traceline(start, end, options = null) {
    const worldTrace = SV.collision.traceWorldLine(start, end);

    if (options === null || options.includeEntities !== true) {
      return internalTraceToGameTrace(worldTrace);
    }

    return internalTraceToGameTrace(traceClientEntities(start, end, worldTrace, options));
  }

  /**
   * Allocates a dynamic light for the given entity Id.
   * @param {number} entityId entity Id, can be 0
   * @returns {ClientDlight} dynamic light instance
   */
  static AllocDlight(entityId) {
    return CL.state.clientEntities.allocateDynamicLight(entityId);
  }

  /**
   * Allocates a new client entity.
   * This is a client-side entity, not a server-side edict.
   * Make sure to invoke spawn() when ready.
   * Make sure to use setOrigin() to set the position of the entity.
   * @returns {ClientEdict} a new client entity
   */
  static AllocEntity() {
    return CL.state.clientEntities.allocateClientEntity();
  }

  /**
   * Spawns a rocket trail effect from start to end
   * @param {Vector} start e.g. previous origin
   * @param {Vector} end e.g. current origin
   * @param {number} type type of the trail
   */
  static RocketTrail(start, end, type) {
    R.RocketTrail(start, end, type);
  }

  /**
   * Places a decal in the world.
   * @param {Vector} origin position to place decal at
   * @param {Vector} normal normal/orientation
   * @param {GLTexture} texture texture to place
   */
  static PlaceDecal(origin, normal, texture) {
    R.PlaceDecal(origin, normal, texture);
  }

  /**
   * Gets model by name. Must be precached first.
   * @param {string} modelName model name
   * @returns {BaseModel} model index
   */
  static ModForName(modelName) {
    console.assert(typeof modelName === 'string', 'modelName must be a string');

    for (let i = 1; i < CL.state.model_precache.length; i++) {
      if (CL.state.model_precache[i].name === modelName) {
        return CL.state.model_precache[i];
      }
    }

    throw new HostError(`ClientEngineAPI.ModForName: ${modelName} not precached`);
  }

  static ModById(id) {
    console.assert(typeof id === 'number' && id > 0, 'id must be a number and greater than 0');

    if (CL.state.model_precache[id]) {
      return CL.state.model_precache[id];
    }

    throw new HostError(`ClientEngineAPI.ModById: ${id} not found`);
  }

  /**
   * @param {number} slot see Def.contentShift
   * @param {Vector} color RGB color vector
   * @param {number} alpha alpha value, default is 0.5
   */
  static ContentShift(slot, color, alpha = 0.5) {
    V.ContentShift(slot + 4, color, alpha);
  }

  /**
   * Sets the player movement configuration. This is used by the PMove code to determine how the player will move.
   * @param {PmoveConfiguration} config pmove profile
   */
  static SetPmoveConfiguration(config) {
    console.assert(config instanceof PmoveConfiguration, 'config must be an instance of PmoveConfiguration');

    CL.pmove.configuration = config;
  }

  static M = null;

  static CL = {
    get viewangles() {
      return CL.state.viewangles.copy();
    },
    get vieworigin() {
      return CL.state.viewent.origin.copy();
    },
    get maxclients() {
      return CL.state.maxclients;
    },
    get levelname() {
      return CL.state.levelname;
    },
    get entityNum() {
      return CL.state.viewentity;
    },
    /**
     * local time, not game time! If you are looking for SV.server.time, check gametime
     * @returns {number} local time
     */
    get time() { // FIXME: rename to localtime to make the distinction clearer
      return CL.state.time;
    },
    /**
     * latest SV.server.time, NOT local time!
     * @returns {number} game time
     */
    get gametime() {
      return CL.state.clientMessages.mtime[0];
    },
    get frametime() {
      return Host.frametime;
    },
    get intermission() {
      return CL.state.intermission > 0;
    },
    set intermission(value) {
      CL.state.intermission = value ? 1 : 0;
    },
    score(/** @type {number} */ num) {
      return CL.state.scores[num];
    },
    get serverInfo() {
      return CL.cls.serverInfo;
    },
  };

  static VID = {
    get width() { return VID.width; },
    get height() { return VID.height; },
    get pixelRatio() { return VID.pixelRatio; },
  };

  static Key = {
    /**
     * Gets the string representation of a key binding, e.g. "+attack" -> "mouse1"
     * @param {string} binding key binding string
     * @returns {string|null} string representation of the key binding, or null if not found
     */
    getKeyForBinding(binding) {
      return Key.BindingToString(binding);
    },
  };

  static SCR = {
    /**
     * @returns {number} the current view size (important ones for the status bar are 100, 110, 120)
     */
    get viewsize() { return /** @type {number} */ (SCR.viewsize.value); },
  };

  static get eventBus() {
    return CL.state.eventBus;
  };
};
