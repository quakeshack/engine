import Vector from '../../shared/Vector.mjs';
import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { registry } from '../registry.mjs';
import { ED, ServerEdict } from '../server/Edict.mjs';
import Cmd from './Cmd.mjs';
import Cvar from './Cvar.mjs';

export class ServerEngineAPI {
  static BroadcastPrint(str) {
    registry.Host.BroadcastPrint(str);
  }

  static StartParticles(origin, direction, color, count) {
    registry.SV.StartParticle(origin, direction, color, count);
  }

  static SpawnAmbientSound(origin, sfxName, volume, attenuation) {
    const { SV, Con } = registry;

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
    registry.SV.StartSound(edict, channel, sfxName, volume * 255.0, attenuation);

    return true;
  }

  static Traceline(start, end, noMonsters, passEdict, mins = null, maxs = null) {
    const nullVec = Vector.origin;
    const trace = registry.SV.Move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);

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
    return registry.SV.Move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);
  }

  static AppendConsoleText(text) {
    Cmd.text += text;
  }

  static GetCvar(name) {
    return Cvar.FindVar(name);
  }

  static SetCvar(name, value) {
    Cvar.Set(name, value);
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

  /**
   * Defines a lightstyle (e.g. aazzaa).
   * It will also send an update to all connected clients.
   * @param {number} styleId
   * @param {string} sequenceString
   */
  static Lightstyle(styleId, sequenceString) {
    const { SV } = registry;

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
    return registry.SV.PointContents(origin);
  }

  static ChangeLevel(mapname) {
    const { SV } = registry;

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
    const { SV } = registry;

    for (let i = 1; i < SV.server.num_edicts; i++) {
      /** @type {ServerEdict} */
      const ent = SV.server.edicts[i];

      if (ent.isFree() || ent.entity.solid === SV.solid.not) {
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
    const { SV } = registry;

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
    const { SV } = registry;

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
    const { SV } = registry;

    if (edictId < 0 || edictId >= SV.server.num_edicts) {
      return null;
    }

    return SV.server.edicts[edictId];
  }

  static PrecacheSound(sfxName) {
    const { SV } = registry;

    console.assert(typeof(sfxName) === 'string', 'sfxName must be a string');

    if (SV.server.sound_precache.includes(sfxName)) {
      return;
    }

    SV.server.sound_precache.push(sfxName);
  }

  static PrecacheModel(modelName) {
    const { SV, Mod } = registry;

    console.assert(typeof(modelName) === 'string', 'modelName must be a string');

    if (SV.server.model_precache.includes(modelName)) {
      return;
    }

    SV.server.model_precache.push(modelName);
    SV.server.models.push(Mod.ForName(modelName, true));
  }

  static ConsolePrint(msg) {
    registry.Con.Print(msg);
  }

  static ConsoleWarning(msg) {
    registry.Con.PrintWarning(msg);
  }

  static ConsoleError(msg) {
    registry.Con.PrintError(msg);
  }

  static ConsoleDebug(str) {
    registry.Con.DPrint(str);
  }

  /**
   * Spawns a new Entity, not an Edict
   * @param {string} classname
   * @param {{[key: string]: any}} initialData
   * @returns
   */
  static SpawnEntity(classname, initialData = {}) {
    const { SV } = registry;

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
    return registry.SV.server.loading;
  }

  static ParseQC(qcContent) {
    return registry.Mod.ParseQC(qcContent);
  }

  static DispatchTempEntityEvent(tempEntityId, origin) {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.temp_entity);
    MSG.WriteByte(SV.server.datagram, tempEntityId);
    MSG.WriteCoordVector(SV.server.datagram, origin);
  }

  static DispatchBeamEvent(beamId, edictId, startOrigin, endOrigin) {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.temp_entity); // FIXME: unhappy about this
    MSG.WriteByte(SV.server.datagram, beamId);
    MSG.WriteShort(SV.server.datagram, edictId);
    MSG.WriteCoordVector(SV.server.datagram, startOrigin);
    MSG.WriteCoordVector(SV.server.datagram, endOrigin);
  }

  static BroadcastMonsterKill() {
    const { SV } = registry;

    MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.killedmonster);
  }

  static BroadcastSecretFound() {
    const { SV } = registry;

    MSG.WriteByte(SV.server.reliable_datagram, Protocol.svc.foundsecret);
  }

  static BroadcastObituary(killerEdictId, victimEdictId, killerWeapon, killerItems) {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.obituary);
    MSG.WriteShort(SV.server.datagram, killerEdictId);
    MSG.WriteShort(SV.server.datagram, victimEdictId);
    MSG.WriteLong(SV.server.datagram, killerWeapon);
    MSG.WriteLong(SV.server.datagram, killerItems);
  }

  static EnterIntermission() {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.intermission);
  }

  static EnterFinale() {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.finale);
  }

  static PlayTrack(id1, id2) {
    const { SV } = registry;

    MSG.WriteByte(SV.server.datagram, Protocol.svc.cdtrack);
    MSG.WriteByte(SV.server.datagram, id1);
    MSG.WriteByte(SV.server.datagram, id2);
  }

  // TODO: MSG related methods
};

export class ClientEngineAPI {

};
