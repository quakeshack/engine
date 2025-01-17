/* global Game, Host, SV, Con, Protocol, MSG, Cmd, Cvar, Vector, ED, Mod */

// eslint-disable-next-line no-global-assign
Game = {};

Game.EngineInterface = class EngineInterface {
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
    return SV.Move(start, mins ? mins : nullVec, maxs ? maxs : nullVec, end, noMonsters, passEdict);
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
   * Defines a lightstyle (e.g. aazzaa).
   * It will also send an update to all connected clients.
   * @param {Number} styleId
   * @param {String} sequenceString
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
   * @returns list of edicts
   */
  static FindInRadius(origin, radius) {
    const found = [];

    for (let i = 1; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (ent.free || ent.api.solid === SV.solid.not) {
        continue;
      }

      const eorg = origin.copy().subtract(ent.api.origin.copy().add(ent.api.mins.copy().add(ent.api.maxs).multiply(0.5)));

      if (eorg.len() > radius) {
        continue;
      }

      found.push(ent);
    }

    return found;
  }

  static FindByFieldAndValue(field, value, startEdictId = 0) {
    for (let i = startEdictId; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (ent.free) {
        continue;
      }

      if (ent.api[field] === value) {
        return ent;
      }
    }

    return null;
  }

  static PrecacheSound(sfxName) {
    if (SV.server.sound_precache.includes(sfxName)) {
      return;
    }

    SV.server.sound_precache.push(sfxName);
  }

  static PrecacheModel(modelName) {
    if (SV.server.model_precache.includes(modelName)) {
      return;
    }

    SV.server.model_precache.push(modelName);
    SV.server.models.push(Mod.ForName(modelName, true));
  }

  static DebugPrint(str) {
    Con.DPrint(str);
  }

  static AllocEdict() {
    return ED.Alloc();
  }

  // TODO: MSG related methods

  // TODO: RegisterCvar, UnregisterCvar

};

