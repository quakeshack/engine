import { solid } from '../../shared/Defs.mjs';
import Vector from '../../shared/Vector.mjs';
import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ED, ServerEdict } from '../server/Edict.mjs';
import Cmd from './Cmd.mjs';
import Cvar from './Cvar.mjs';
import Mod, { ParsedQC } from './Mod.mjs';

let { Con, Host, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Host = registry.Host;
  SV = registry.SV;
});

eventBus.subscribe('com.ready', () => {
  const COM = registry.COM;

  if (COM.hipnotic) {
    EngineAPI.gameFlavors.push(GameFlavors.hipnotic);
  }

  if (COM.rogue) {
    EngineAPI.gameFlavors.push(GameFlavors.rogue);
  }
});

/** @enum {string} */
export const GameFlavors = Object.freeze({
  hipnotic: 'hipnotic',
  rogue: 'rogue',
});

export class EngineAPI {
  /** Engine’s main event bus. */
  static eventBus = eventBus;

  /** @type {GameFlavors[]} */
  static gameFlavors = [];

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

  static ConsolePrint(msg) {
    Con.Print(msg);
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

export class ServerEngineAPI extends EngineAPI {
  static BroadcastPrint(str) {
    Host.BroadcastPrint(str);
  }

  static StartParticles(origin, direction, color, count) {
    SV.StartParticle(origin, direction, color, count);
  }

  static SpawnAmbientSound(origin, sfxName, volume, attenuation) {
    let i = 0;

    for (; i < SV.server.sound_precache.length; ++i) {
      if (SV.server.sound_precache[i] === sfxName) {
        break;
      }
    }

    if (i === SV.server.sound_precache.length) {
      Con.Print('no precache: ' + sfxName + '\n');
      return false;
    }

    const signon = SV.server.signon;
    MSG.WriteByte(signon, Protocol.svc.spawnstaticsound);
    MSG.WriteCoordVector(signon, origin);
    MSG.WriteByte(signon, i);
    MSG.WriteByte(signon, volume * 255.0);
    MSG.WriteByte(signon, attenuation * 64.0);

    return true;
  }

  static StartSound(edict, channel, sfxName, volume, attenuation) {
    SV.StartSound(edict, channel, sfxName, volume * 255.0, attenuation);

    return true;
  }

  static Traceline(start, end, noMonsters, passEdict, mins = null, maxs = null) {
    const nullVec = Vector.origin;
    const trace = SV.Move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);

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

  static TracelineLegacy(start, end, noMonsters, passEdict, mins = null, maxs = null) {
    const nullVec = Vector.origin;
    return SV.Move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);
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

    for (let i = 0; i < SV.svs.maxclients; ++i) {
      const client = SV.svs.clients[i];

      if (!client.active && !client.spawned) {
        continue;
      }

      MSG.WriteByte(client.message, Protocol.svc.lightstyle);
      MSG.WriteByte(client.message, styleId);
      MSG.WriteString(client.message, sequenceString);
    }
  }

  /**
   * Finds out what contents the given point is in.
   * @param {Vector} origin
   * @returns contents
   */
  static DeterminePointContents(origin) {
    return SV.PointContents(origin);
  }

  static ChangeLevel(mapname) {
    if (SV.svs.changelevel_issued) {
      return;
    }

    SV.svs.changelevel_issued = true;

    Cmd.text += `changelevel ${mapname}\n`;
  }

  /**
   * Finds all edicts around origin in given radius.
   * @param {Vector} origin
   * @param {number} radius
   * @yields {SV.Edict} matching edict
   */
  static *FindInRadius(origin, radius) {
    for (let i = 1; i < SV.server.num_edicts; i++) {
      /** @type {ServerEdict} */
      const ent = SV.server.edicts[i];

      if (ent.isFree() || ent.entity.solid === solid.SOLID_NOT) {
        continue;
      }

      const eorg = origin.copy().subtract(ent.entity.origin.copy().add(ent.entity.mins.copy().add(ent.entity.maxs).multiply(0.5)));

      if (eorg.len() > radius) {
        continue;
      }

      yield ent;
    }
  }

  static FindByFieldAndValue(field, value, startEdictId = 0) { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let i = (startEdictId % SV.server.num_edicts); i < SV.server.num_edicts; i++) {
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

  static *FindAllByFieldAndValue(field, value, startEdictId = 0) { // FIXME: startEdictId should be edict? not 100% happy about this
    for (let i = (startEdictId % SV.server.num_edicts); i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (ent.isFree()) {
        continue;
      }

      if (ent.entity[field] === value) {
        yield ent;
      }
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

    if (SV.server.sound_precache.includes(sfxName)) {
      return;
    }

    SV.server.sound_precache.push(sfxName);
  }

  static PrecacheModel(modelName) {
    console.assert(typeof(modelName) === 'string', 'modelName must be a string');

    if (SV.server.model_precache.includes(modelName)) {
      return;
    }

    SV.server.model_precache.push(modelName);
    SV.server.models.push(Mod.ForName(modelName, true));
  }

  /**
   * Spawns a new Entity, not an Edict
   * @param {string} classname
   * @param {{[key: string]: any}} initialData
   * @returns
   */
  static SpawnEntity(classname, initialData = {}) {
    const edict = ED.Alloc();

    if (!SV.server.gameAPI.prepareEntity(edict, classname, initialData)) {
      edict.freeEdict();
      return null;
    }

    if (!SV.server.gameAPI.spawnPreparedEntity(edict)) {
      edict.freeEdict();
      return null;
    }

    return edict.entity;
  }

  static IsLoading() {
    return SV.server.loading;
  }

  static DispatchTempEntityEvent(tempEntityId, origin) {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.temp_entity);
    MSG.WriteByte(SV.server.datagram, tempEntityId);
    MSG.WriteCoordVector(SV.server.datagram, origin);
  }

  static DispatchBeamEvent(beamId, edictId, startOrigin, endOrigin) {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.temp_entity); // FIXME: unhappy about this
    MSG.WriteByte(SV.server.datagram, beamId);
    MSG.WriteShort(SV.server.datagram, edictId);
    MSG.WriteCoordVector(SV.server.datagram, startOrigin);
    MSG.WriteCoordVector(SV.server.datagram, endOrigin);
  }

  static BroadcastMonsterKill() {
    MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.killedmonster);
  }

  static BroadcastSecretFound() {
    MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.foundsecret);
  }

  static BroadcastObituary(killerEdictId, victimEdictId, killerWeapon, killerItems) {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.obituary);
    MSG.WriteShort(SV.server.datagram, killerEdictId);
    MSG.WriteShort(SV.server.datagram, victimEdictId);
    MSG.WriteLong(SV.server.datagram, killerWeapon);
    MSG.WriteLong(SV.server.datagram, killerItems);
  }

  static EnterIntermission() {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.intermission);
  }

  static EnterFinale() {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.finale);
  }

  static PlayTrack(id1, id2) {
    MSG.WriteByte(SV.server.datagram, Protocol.svc.cdtrack);
    MSG.WriteByte(SV.server.datagram, id1);
    MSG.WriteByte(SV.server.datagram, id2);
  }

  // TODO: MSG related methods
};

export class ClientEngineAPI extends EngineAPI {


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
  }

};
