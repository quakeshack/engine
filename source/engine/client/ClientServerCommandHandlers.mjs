import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import Cmd from '../common/Cmd.mjs';
import { HostError } from '../common/Errors.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';
import Vector from '../../shared/Vector.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';
import { sharedCollisionModelSource } from '../common/CollisionModelSource.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ScoreSlot } from './ClientState.mjs';

import { legacyServerCommandHandlers, handleLegacyEntityUpdate } from './LegacyServerCommands.mjs';

/** @typedef {typeof import('./CL.mjs').default} ClientLayer */
/** @typedef {import('./ClientMessages.mjs').ClientMessages} ClientMessages */

let { CL, Con, SCR, S, R, V, Host, SV, NET, Mod, PR, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, SCR, S, R, V, Host, SV, NET, Mod, PR, COM } = registry);
});

sharedCollisionModelSource.configureClient({
  getWorldModel: () => CL?.state?.worldmodel ?? null,
  getModels: () => CL?.state?.model_precache ?? null,
});

/** Tracks entity updates during message parsing */
let entitiesReceived = 0;

/**
 * Parses the serverdata payload and prepares the client for the new map.
 */
function parseServerData() {
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = NET.message.readByte();

  if (version !== Protocol.version) {
    throw new HostError('Server returned protocol version ' + version + ', not ' + Protocol.version + '\n');
  }

  const isHavingClientQuakeJS = NET.message.readByte() === 1;

  if (isHavingClientQuakeJS) {
    Con.DPrint('Server is running QuakeJS with ClientGameAPI provided.\n');

    if (!PR.QuakeJS?.ClientGameAPI) {
      throw new HostError('Server is running QuakeJS with client code provided,\nbut client code is not imported.\nTry clearing your cache and connect again.');
    }

    const name = NET.message.readString();
    const author = NET.message.readString();
    const serverVersion = [NET.message.readByte(), NET.message.readByte(), NET.message.readByte()];

    const identification = PR.QuakeJS.identification;

    if (identification.name !== name || identification.author !== author) {
      throw new HostError(`Cannot connect, game mismatch.\nThe server is running ${name}\nand you are running ${identification.name}.`);
    }

    if (!PR.QuakeJS.ClientGameAPI.IsServerCompatible(serverVersion)) {
      throw new HostError(`Server (v${serverVersion.join('.')} ) is not compatible. You are running v${identification.version.join('.')}\nTry clearing your cache and connect again.`);
    }

    CL.state.gameAPI = new PR.QuakeJS.ClientGameAPI(ClientEngineAPI);
  } else {
    const game = NET.message.readString();

    if (game !== COM.game) {
      throw new HostError('Server is running game ' + game + ', not ' + COM.game + '\n');
    }

    document.title = `${game} on ${Def.productName} (${Host.version.string})`;
  }

  CL.state.maxclients = NET.message.readByte();
  if ((CL.state.maxclients <= 0) || (CL.state.maxclients > 32)) {
    throw new HostError('Bad maxclients (' + CL.state.maxclients + ') from server!');
  }

  CL.state.scores.length = 0;

  for (let i = 0; i < CL.state.maxclients; i++) {
    CL.state.scores[i] = new ScoreSlot(i);
  }

  CL.state.levelname = NET.message.readString();

  // parsePmovevars(CL);

  Con.Print('\x02' + CL.state.levelname + '\n\n');

  CL.SetConnectingStep(15, 'Received server info');

  let str;
  let nummodels; const model_precache = [];
  for (nummodels = 1; ; nummodels++) {
    str = NET.message.readString();
    if (str.length === 0) {
      break;
    }
    model_precache[nummodels] = str;
  }
  let numsounds; const sound_precache = [];
  for (numsounds = 1; ; numsounds++) {
    str = NET.message.readString();
    if (str.length === 0) {
      break;
    }
    sound_precache[numsounds] = str;
  }

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_DYNAMIC)) {
    const clientdataFields = [];

    while (true) {
      const fields = NET.message.readString();
      if (fields === '') {
        break;
      }
      clientdataFields.push(fields);
    }

    CL.state.clientMessages.clientdataFields = clientdataFields;
  }

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_ENTITY_EXTENDED)) {
    while (true) {
      const classname = NET.message.readString();

      if (classname === '') {
        break;
      }

      const fields = [];

      while (true) {
        const field = NET.message.readString();

        if (field === '') {
          break;
        }

        fields.push(field);
      }

      /** @type {'readByte' | 'readShort' | 'readLong' | null} */
      let bitsReader = null;

      console.assert(fields.length <= 32, 'entity fields must not have more than 32 fields');

      if (fields.length <= 8) {
        bitsReader = 'readByte';
      } else if (fields.length <= 16) {
        bitsReader = 'readShort';
      } else {
        bitsReader = 'readLong';
      }

      if (fields.length > 0) {
        CL.state.clientEntityFields[classname] = { fields, bitsReader };
      }
    }
  }

  CL.connection.processingServerDataState = 1;

  void (async () => {
    const models = [null];
    const sounds = [null];

    models[1] = await Mod.ForNameAsync(model_precache[1], false, Mod.scope.client);
    nummodels--;

    while (nummodels > 0) {
      const chunksize = Math.min(nummodels, 10);
      nummodels -= chunksize;

      CL.SetConnectingStep(25 + (models.length / model_precache.length) * 30, 'Loading models');
      models.push(...await Promise.all(model_precache.slice(models.length, models.length + chunksize).map((m) => Mod.ForNameAsync(m, false, Mod.scope.client))));

      CL.SendCmd();
    }

    while (numsounds > 0) {
      const chunksize = Math.min(numsounds, 10);
      numsounds -= chunksize;
      CL.SetConnectingStep(55 + (sounds.length / sound_precache.length) * 30, 'Loading sounds');
      sounds.push(...await Promise.all(sound_precache.slice(sounds.length, sounds.length + chunksize).map((s) => S.PrecacheSoundAsync(s))));

      CL.SendCmd();
    }

    return { models, sounds };
  })().then(({ models, sounds }) => {
    CL.state.model_precache.length = 0;
    CL.state.sound_precache.length = 0;

    CL.state.model_precache.push(...models);
    CL.state.sound_precache.push(...sounds);

    CL.connection.processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1];
    CL.pmove.setWorldmodel(CL.state.worldmodel);
    const ent = CL.state.clientEntities.getEntity(0);
    ent.classname = 'worldspawn';
    ent.loadHandler();
    ent.model = CL.state.worldmodel;
    ent.spawn();
    CL.SetConnectingStep(85, 'Preparing map');
    CL.SendCmd();
    R.NewMap();
    CL.SendCmd();
    Host.noclip_anglehack = false;
    if (CL.state.gameAPI) {
      CL.state.gameAPI.init();
      if (CL.state.loadClientData && CL.state.loadClientData[0]) {
        CL.state.gameAPI.loadGame(CL.state.loadClientData[0]);
      }
    }
    if (CL.state.loadClientData && CL.state.loadClientData[1]) {
      R.DeserializeParticles(CL.state.loadClientData[1]);
    }
    CL.state.loadClientData = null;
  });
}

/**
 * Reads pmove configuration values from the network stream.
 */
function parsePmovevars() {
  const movevars = CL.pmove.movevars;
  movevars.gravity = NET.message.readFloat();
  movevars.stopspeed = NET.message.readFloat();
  movevars.maxspeed = NET.message.readFloat();
  movevars.spectatormaxspeed = NET.message.readFloat();
  movevars.accelerate = NET.message.readFloat();
  movevars.airaccelerate = NET.message.readFloat();
  movevars.wateraccelerate = NET.message.readFloat();
  movevars.friction = NET.message.readFloat();
  movevars.waterfriction = NET.message.readFloat();
  movevars.entgravity = NET.message.readFloat();

  Con.DPrint('Reconfigured Pmovevars.\n');
}

/**
 * Parses a lightstyle definition.
 */
function parseLightstylePacket() {
  const index = NET.message.readByte();
  if (index >= Def.limits.lightstyles) {
    throw new HostError('svc_lightstyle > MAX_LIGHTSTYLES');
  }

  CL.state.clientEntities.setLightstyle(index, NET.message.readString());
}

/**
 * Parses a spatialized sound start request.
 */
function parseStartSoundPacket() {
  const fieldMask = NET.message.readByte();
  const volume = ((fieldMask & 1) !== 0) ? NET.message.readByte() : 255;
  const attenuation = ((fieldMask & 2) !== 0) ? NET.message.readByte() * 0.015625 : 1.0;
  const entchannel = NET.message.readShort();
  const soundNum = NET.message.readByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = NET.message.readCoordVector();

  S.StartSound(ent, channel, CL.state.sound_precache[soundNum], pos, volume / 255.0, attenuation);
}

/**
 * Parses a static entity definition.
 */
function parseStaticEntity() {
  const ent = CL.state.clientEntities.allocateClientEntity(NET.message.readString());
  ent.model = CL.state.model_precache[NET.message.readByte()];
  ent.frame = NET.message.readByte();
  ent.colormap = NET.message.readByte();
  ent.skinnum = NET.message.readByte();
  ent.effects = NET.message.readByte();
  ent.alpha = NET.message.readByte() / 255.0;
  ent.solid = NET.message.readByte();
  ent.angles.set(NET.message.readAngleVector());
  ent.setOrigin(NET.message.readCoordVector());
  ent.spawn();
}

/**
 * Parses a static ambient sound definition.
 */
function parseStaticSound() {
  const org = NET.message.readCoordVector();
  const soundId = NET.message.readByte();
  const vol = NET.message.readByte();
  const attn = NET.message.readByte();
  S.StaticSound(CL.state.sound_precache[soundId], org, vol / 255.0, attn);
}

/**
 * Applies server cvar updates.
 */
function parseServerCvars() {
  let count = NET.message.readByte();

  while (count-- > 0) {
    const name = NET.message.readString();
    const value = NET.message.readString();

    CL.cls.serverInfo[name] = value;

    if (CL.cls.signon === 4) {
      if (CL.state.maxclients > 1) { // don’t bother printing cvar changes in single player
        Con.Print(`"${name}" changed to "${value}"\n`);
      }
      eventBus.publish('client.server-info.updated', name, value);
    }

    // reset cheat cvars when sv_cheats is turned off
    if (name === 'sv_cheats' && value === '0') {
      CL.ResetCheatCvars();
    }
  }
}

/**
 * Parses beam-style temporary entities.
 * @param {import('../common/model/BaseModel.mjs').BaseModel} model Model to attach to the beam.
 */
function parseBeam(model) {
  const ent = NET.message.readShort();
  const start = NET.message.readCoordVector();
  const end = NET.message.readCoordVector();
  if (!model) {
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = CL.state.clientEntities.beams[i];
    if (beam.entity !== ent) {
      continue;
    }
    beam.model = model;
    beam.endtime = CL.state.time + 0.2;
    beam.start = start.copy();
    beam.end = end.copy();
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = CL.state.clientEntities.beams[i];
    if ((beam.model !== null) && (beam.endtime >= CL.state.time)) {
      continue;
    }
    beam.entity = ent;
    beam.model = model;
    beam.endtime = CL.state.time + 0.2;
    beam.start = start.copy();
    beam.end = end.copy();
    return;
  }
  Con.PrintWarning('beam list overflow!\n');
}

/**
 * Decodes temporary entities (explosions, splashes, etc.).
 */
function parseTemporaryEntity() {
  const type = NET.message.readByte();

  switch (type) {
    case Protocol.te.lightning1:
      parseBeam(CL.state.clientEntities.tempEntityModels['progs/bolt.mdl']);
      return;
    case Protocol.te.lightning2:
      parseBeam(CL.state.clientEntities.tempEntityModels['progs/bolt2.mdl']);
      return;
    case Protocol.te.lightning3:
      parseBeam(CL.state.clientEntities.tempEntityModels['progs/bolt3.mdl']);
      return;
    case Protocol.te.beam: // CR: this model does not exist
      parseBeam(CL.state.clientEntities.tempEntityModels['progs/beam.mdl']);
      return;
  }

  const pos = NET.message.readCoordVector();
  const sounds = CL.state.clientEntities.tempEntitySounds;

  switch (type) {
    case Protocol.te.wizspike:
      R.RunParticleEffect(pos, Vector.origin, 20, 20);
      S.StartSound(-1, 0, sounds.wizhit, pos, 1.0, 1.0);
      return;
    case Protocol.te.knightspike:
      R.RunParticleEffect(pos, Vector.origin, 226, 20);
      S.StartSound(-1, 0, sounds.knighthit, pos, 1.0, 1.0);
      return;
    case Protocol.te.spike:
      R.RunParticleEffect(pos, Vector.origin, 0, 10);
      return;
    case Protocol.te.superspike:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.gunshot:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.explosion: {
      R.ParticleExplosion(pos);
      const dl = CL.state.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = CL.state.time + 0.5;
      dl.decay = 300.0;
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
    }
      return;
    case Protocol.te.tarexplosion:
      R.BlobExplosion(pos);
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      return;
    case Protocol.te.lavasplash:
      R.LavaSplash(pos);
      return;
    case Protocol.te.teleport:
      R.TeleportSplash(pos);
      return;
    case Protocol.te.explosion2: {
      const colorStart = NET.message.readByte();
      const colorLength = NET.message.readByte();
      R.ParticleExplosion2(pos, colorStart, colorLength);
      const dl = CL.state.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = CL.state.time + 0.5;
      dl.decay = 300.0;
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
    }
      return;
  }

  throw new Error(`CL.ParseTEnt: bad type ${type}`);
}

/**
 * Applies entity deltas for the current frame.
 */
function parsePacketEntities() {
  while (true) {
    const edictNum = NET.message.readUint16();

    if (edictNum === 0) {
      break;
    }

    const clent = CL.state.clientEntities.getEntity(edictNum);

    const bits = NET.message.readUint16();

    if (bits & Protocol.u.classname) {
      clent.classname = NET.message.readString();
      clent.loadHandler();
      clent.spawn();
    }

    if (bits & Protocol.u.free) {
      clent.free = NET.message.readByte() !== 0;
    }

    if (bits & Protocol.u.frame) {
      clent.framePrevious = clent.frame;
      clent.frame = NET.message.readByte();
    }

    if (bits & Protocol.u.model) {
      const modelindex = NET.message.readByte();
      clent.model = CL.state.model_precache[modelindex] || null;

      clent.framePrevious = null;
      clent.frameTime = 0.0;

      if (clent.model) {
        clent.syncbase = clent.model.random ? Math.random() : 0.0;
      }
    }

    if (bits & Protocol.u.colormap) {
      clent.colormap = NET.message.readByte();
    }

    if (bits & Protocol.u.skin) {
      clent.skinnum = NET.message.readByte();
    }

    if (bits & Protocol.u.effects) {
      clent.effects = NET.message.readByte();
      clent.alpha = NET.message.readByte() / 255.0;
    }

    if (bits & Protocol.u.solid) {
      clent.solid = NET.message.readByte();
    }

    const origin = clent.msg_origins[0];
    const angles = clent.msg_angles[0];
    const velocity = clent.msg_velocity[0];

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        origin[i] = NET.message.readCoord();
      }

      if (bits & (Protocol.u.angle1 << i)) {
        angles[i] = NET.message.readAngle();
        velocity[i] = NET.message.readCoord();
      }
    }

    if (bits & Protocol.u.size) {
      clent.maxs.set(NET.message.readCoordVector());
      clent.mins.set(NET.message.readCoordVector());
    }

    if (bits & Protocol.u.nextthink) {
      clent.nextthink = CL.state.clientMessages.mtime[0] + NET.message.readByte() / 255.0;
    }

    if (CL.gameCapabilities.includes(gameCapabilities.CAP_ENTITY_EXTENDED)) {
      const clientEntityFields = CL.state.clientEntityFields[clent.classname];
      if (clientEntityFields) {
        const fieldbits = NET.message[clientEntityFields.bitsReader]();

        if (fieldbits > 0) {
          const fields = [];

          for (let i = 0; i < clientEntityFields.fields.length; i++) {
            const field = clientEntityFields.fields[i];
            if ((fieldbits & (1 << i)) !== 0) {
              fields.push(field);
            }
          }

          let counter = 0;

          const values = NET.message.readSerializablesOnClient();

          for (const value of values) {
            clent.extended[fields[counter++]] = value;
          }
        }
      }
    }

    const time = CL.state.clientMessages.mtime[0];

    if (clent.nextthink > time) {
      if (!clent.msg_origins[0].equals(clent.origin)) {
        clent.originTime = time;
        clent.originPrevious.set(clent.origin);
      }

      if (!clent.msg_angles[0].equals(clent.angles)) {
        clent.anglesTime = time;
        clent.anglesPrevious.set(clent.angles);
      }

      if (!clent.msg_velocity[0].equals(clent.velocity)) {
        clent.velocityTime = time;
        clent.velocityPrevious.set(clent.velocity);
      }

      if (bits & Protocol.u.frame) {
        clent.frameTime = time;
      }
    }

    clent.updatecount++;

    clent.msg_origins[1].set(clent.msg_origins[0]);
    clent.msg_angles[1].set(clent.msg_angles[0]);
    clent.msg_velocity[1].set(clent.msg_velocity[0]);

    if (clent.free) {
      clent.freeEdict();
    }
  }
}

/**
 * Handles svc_nop – intentionally does nothing.
 */
function handleNop() { }

/**
 * Handles svc_time by forwarding to the high-level parser.
 */
function handleTime() {
  CL.state.clientMessages.parseTime();
}

/**
 * Handles svc_clientdata and populates the incremental client snapshot.
 */
function handleClientData() {
  CL.state.clientMessages.parseClient();
}

/**
 * Validates the negotiated protocol version and aborts if mismatched.
 */
function handleVersion() {
  const protocol = NET.message.readLong();
  if (protocol !== Protocol.version) {
    throw new HostError('CL.ParseServerMessage: Server is protocol ' + protocol + ' instead of ' + Protocol.version + '\n');
  }
}

/**
 * Processes svc_disconnect by surfacing the server-supplied message.
 */
function handleDisconnect() {
  Host.EndGame(`Server disconnected: ${NET.message.readString()}`);
}

/**
 * Routes svc_print text through the console.
 */
function handlePrint() {
  Con.Print(NET.message.readString());
}

/**
 * Displays server-sent center print text and mirrors it to the console.
 */
function handleCenterPrint() {
  const string = NET.message.readString();
  SCR.CenterPrint(string);
  Con.Print('\x03' + string + '\n'); // TODO: have a better system for this
}

/**
 * Handles chat payloads and appends them to the client chat log.
 */
function handleChatMessage() {
  CL.AppendChatMessage(NET.message.readString(), NET.message.readString(), NET.message.readByte() === 1);
}

/**
 * Concatenates svc_stufftext into the pending console buffer.
 */
function handleStuffText() {
  Cmd.text += NET.message.readString();
}

/**
 * Delegates svc_damage to the view module so it can spawn impacts.
 */
function handleDamage() {
  const armor = NET.message.readByte();
  const blood = NET.message.readByte();
  const origin = NET.message.readCoordVector();
  V.ApplyDamage(armor, blood, origin);
}

/**
 * Parses svc_serverdata and reinitializes renderer state.
 */
function handleServerData() {
  SCR.recalc_refdef = true;

  // peak into the serverdata message to detect legacy demos and route to the old handlers if needed
  if (new DataView(NET.message.data).getUint32(1, true) === 15) {
    legacyServerCommandHandlers[Protocol.svc.serverdata]();
    return;
  }

  parseServerData();
}

/**
 * Processes map transitions and resets client signon state.
 */
function handleChangeLevel() {
  const mapname = NET.message.readString();
  CL.SetConnectingStep(5, 'Changing level to ' + mapname);
  CL.cls.signon = 0;
  CL.cls.changelevel = true;
}

/**
 * Updates the authoritative view angles of the local player.
 */
function handleSetAngle() {
  CL.state.viewangles.set(NET.message.readAngleVector());
}

/**
 * Selects the entity the client should render from.
 */
function handleSetView() {
  CL.state.viewentity = NET.message.readShort();
}

/**
 * Updates lightstyle definitions used for dynamic lighting.
 */
function handleLightStyle() {
  parseLightstylePacket();
}

/**
 * Triggers spatialized sounds for the given entity/channel tuple.
 */
function handleSound() {
  parseStartSoundPacket();
}

/**
 * Stops a currently playing sound for an entity/channel pair.
 */
function handleStopSound() {
  const value = NET.message.readShort();
  S.StopSound(value >> 3, value & 7);
}

/**
 * Updates the server-specified sound precache entry.
 */
function handleLoadSound() {
  const index = NET.message.readByte();
  CL.state.sound_precache[index] = S.PrecacheSound(NET.message.readString());
  Con.DPrint(`CL.ParseServerMessage: load sound "${CL.state.sound_precache[index].name}" (${CL.state.sound_precache[index].state}) on slot ${index}\n`);
}

/**
 * Mirrors scoreboard name updates and broadcasts change events.
 */
function handleUpdateName() {
  const slot = NET.message.readByte();
  if (slot >= CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatename > MAX_SCOREBOARD');
  }
  const newName = NET.message.readString();
  if (CL.state.scores[slot].name !== '' && newName !== '' && newName !== CL.state.scores[slot].name) {
    Con.Print(`${CL.state.scores[slot].name} renamed to ${newName}\n`);
    eventBus.publish('client.players.name-changed', slot, CL.state.scores[slot].name, newName);
  }
  CL.state.scores[slot].name = newName;
}

/**
 * Updates frag counts for a player and notifies listeners.
 */
function handleUpdateFrags() {
  const slot = NET.message.readByte();
  if (slot >= CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD');
  }
  CL.state.scores[slot].frags = NET.message.readShort();
  eventBus.publish('client.players.frags-updated', slot, CL.state.scores[slot].frags);
}

/**
 * Updates color indices for a player and notifies listeners.
 */
function handleUpdateColors() {
  const slot = NET.message.readByte();
  if (slot >= CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD');
  }
  CL.state.scores[slot].colors = NET.message.readByte();
  eventBus.publish('client.players.colors-updated', slot, CL.state.scores[slot].colors);
}

/**
 * Updates ping information for a player.
 */
function handleUpdatePings() {
  const slot = NET.message.readByte();
  if (slot >= CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatepings > MAX_SCOREBOARD');
  }
  CL.state.scores[slot].ping = NET.message.readShort() / 10;
}

/**
 * Spawns particle effects from svc_particle payloads.
 */
function handleParticle() {
  const org = NET.message.readCoordVector();
  const dir = NET.message.readCoordVector();
  const msgcount = NET.message.readByte();
  const color = NET.message.readByte();
  if (msgcount === 255) {
    R.ParticleExplosion(org);
  } else {
    R.RunParticleEffect(org, dir, color, msgcount);
  }
}

/**
 * Placeholder for svc_spawnbaseline which is not implemented yet.
 */
function handleSpawnBaseline() {
  console.assert(false, 'spawnbaseline is not implemented');
}

/**
 * Adds a static entity to the scene.
 */
function handleSpawnStatic() {
  parseStaticEntity();
}

/**
 * Parses temporary entities such as explosions and beam effects.
 */
function handleTempEntity() {
  parseTemporaryEntity();
}

/**
 * Toggles the paused state and publishes pause events.
 */
function handleSetPause() {
  CL.state.paused = NET.message.readByte() !== 0;
  if (CL.state.paused) {
    eventBus.publish('client.paused');
  } else {
    eventBus.publish('client.unpaused');
  }
}

/**
 * Tracks the server signon phase and advances the handshake.
 */
function handleSignonNum() {
  const signon = NET.message.readByte();
  if (signon <= CL.cls.signon) {
    throw new HostError('Received signon ' + signon + ' when at ' + CL.cls.signon);
  }
  console.assert(signon >= 0 && signon <= 4, 'signon must be in range 0-4');
  CL.cls.signon = /** @type {0|1|2|3|4} */ (signon);
  Con.DPrint(`Received signon ${signon}\n`);
  CL.SignonReply();
}

/**
 * Increments the monster kill statistic.
 */
function handleKilledMonster() {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'killedmonster requires CAP_LEGACY_UPDATESTAT');
  CL.state.stats[Def.stat.monsters]++;
}

/**
 * Increments the secret discovery statistic.
 */
function handleFoundSecret() {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'foundsecret requires CAP_LEGACY_UPDATESTAT');
  CL.state.stats[Def.stat.secrets]++;
}

/**
 * Updates an individual HUD/statistic entry.
 */
function handleUpdateStat() {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'updatestat requires CAP_LEGACY_UPDATESTAT');
  const index = NET.message.readByte();
  console.assert(index >= 0 && index < CL.state.stats.length, 'updatestat must be in range');
  CL.state.stats[index] = NET.message.readLong();
}

/**
 * Queues a static ambient sound.
 */
function handleSpawnStaticSound() {
  parseStaticSound();
}

/**
 * Starts or overrides the current CD track.
 */
function handleCdTrack() {
  CL.state.cdtrack = NET.message.readByte();
  NET.message.readByte(); // unused (usually always the same as cdtrack)

  if (((CL.cls.demoplayback === true) || (CL.cls.demorecording === true)) && (CL.cls.forcetrack !== -1)) {
    eventBus.publish('client.cdtrack', CL.cls.forcetrack);
  } else {
    eventBus.publish('client.cdtrack', CL.state.cdtrack);
  }
}

/**
 * Enters the intermission state.
 */
function handleIntermission() {
  CL.state.intermission = 1;
  CL.state.completed_time = CL.state.time;
  SCR.recalc_refdef = true;
}

/**
 * Displays the finale text block.
 */
function handleFinale() {
  CL.state.intermission = 2;
  CL.state.completed_time = CL.state.time;
  SCR.recalc_refdef = true;
  SCR.CenterPrint(NET.message.readString());
}

/**
 * Plays a cutscene by showing a center print.
 */
function handleCutscene() {
  CL.state.intermission = 3;
  CL.state.completed_time = CL.state.time;
  SCR.recalc_refdef = true;
  SCR.CenterPrint(NET.message.readString());
}

/**
 * Calls the help command when the server requests the sell screen.
 */
function handleSellScreen() {
  Cmd.ExecuteString('help');
}

/**
 * Updates client-only movement variables such as gravity.
 */
function handlePmoveVars() {
  parsePmovevars();
}

/**
 * Updates player-specific interpolation data.
 */
function handlePlayerInfo() {
  CL.state.clientMessages.parsePlayer();
}

/**
 * Applies delta compressed packet entities.
 */
function handleDeltaPacketEntities() {
  entitiesReceived++;
  parsePacketEntities();
}

/**
 * Applies server-sent configuration variables.
 */
function handleCvar() {
  parseServerCvars();
}

/**
 * Passes custom client events to the game API.
 */
function handleClientEvent() {
  console.assert(CL.state.gameAPI !== null, 'ClientGameAPI required');
  CL.state.clientMessages.parseClientEvent();
}

/**
 * Updates portal state.
 */
function handleSetPortalState() {
  const portalNum = NET.message.readShort();
  const open = NET.message.readByte() !== 0;
  CL.state.worldmodel.areaPortals.setPortalState(portalNum, open);
}

/** @type {Record<number, Function>} */
const serverCommandHandlers = {
  [Protocol.svc.nop]: handleNop,
  [Protocol.svc.time]: handleTime,
  [Protocol.svc.clientdata]: handleClientData,
  [Protocol.svc.version]: handleVersion,
  [Protocol.svc.disconnect]: handleDisconnect,
  [Protocol.svc.print]: handlePrint,
  [Protocol.svc.centerprint]: handleCenterPrint,
  [Protocol.svc.chatmsg]: handleChatMessage,
  [Protocol.svc.stufftext]: handleStuffText,
  [Protocol.svc.damage]: handleDamage,
  [Protocol.svc.serverdata]: handleServerData,
  [Protocol.svc.changelevel]: handleChangeLevel,
  [Protocol.svc.setangle]: handleSetAngle,
  [Protocol.svc.setview]: handleSetView,
  [Protocol.svc.lightstyle]: handleLightStyle,
  [Protocol.svc.sound]: handleSound,
  [Protocol.svc.stopsound]: handleStopSound,
  [Protocol.svc.loadsound]: handleLoadSound,
  [Protocol.svc.updatename]: handleUpdateName,
  [Protocol.svc.updatefrags]: handleUpdateFrags,
  [Protocol.svc.updatecolors]: handleUpdateColors,
  [Protocol.svc.updatepings]: handleUpdatePings,
  [Protocol.svc.particle]: handleParticle,
  [Protocol.svc.spawnbaseline]: handleSpawnBaseline,
  [Protocol.svc.spawnstatic]: handleSpawnStatic,
  [Protocol.svc.temp_entity]: handleTempEntity,
  [Protocol.svc.setpause]: handleSetPause,
  [Protocol.svc.signonnum]: handleSignonNum,
  [Protocol.svc.killedmonster]: handleKilledMonster,
  [Protocol.svc.foundsecret]: handleFoundSecret,
  [Protocol.svc.updatestat]: handleUpdateStat,
  [Protocol.svc.spawnstaticsound]: handleSpawnStaticSound,
  [Protocol.svc.cdtrack]: handleCdTrack,
  [Protocol.svc.intermission]: handleIntermission,
  [Protocol.svc.finale]: handleFinale,
  [Protocol.svc.cutscene]: handleCutscene,
  [Protocol.svc.sellscreen]: handleSellScreen,
  [Protocol.svc.pmovevars]: handlePmoveVars,
  [Protocol.svc.playerinfo]: handlePlayerInfo,
  [Protocol.svc.deltapacketentities]: handleDeltaPacketEntities,
  [Protocol.svc.cvar]: handleCvar,
  [Protocol.svc.clientevent]: handleClientEvent,
  [Protocol.svc.setportalstate]: handleSetPortalState,
};

/**
 * Dispatches one in-flight server message through dedicated opcode handlers.
 */
export function parseServerMessage() {
  if (CL.shownet.value === 1) {
    Con.Print('NET: ' + NET.message.cursize + ' bytes\n');
  }

  CL.state.onground = false;

  if (CL.connection.processingServerDataState === 1) {
    return;
  }

  entitiesReceived = 0;

  if (CL.connection.processingServerDataState === 3) {
    CL.connection.processingServerDataState = 0;
  } else {
    CL.connection.lastServerMessages.length = 0;
    NET.message.beginReading();
  }

  const messages = /** @type {string[]} */ ([]);

  while (CL.cls.state > Def.clientConnectionState.disconnected) {
    if (CL.connection.processingServerDataState > 0) {
      break;
    }

    if (NET.message.badread === true) {
      CL.PrintLastServerMessages();
      throw new HostError('CL.ParseServerMessage: Bad server message');
    }

    const cmd = NET.message.readByte();

    if (cmd === -1) {
      break;
    }

    // legacy demo playback: high bit of command byte indicates an entity delta
    if (CL.cls.legacy_demo && (cmd & 0x80)) {
      handleLegacyEntityUpdate(cmd & 0x7F);
      continue;
    }

    const command = CL.svc_strings.find(([, value]) => value === cmd)[0];

    if (CL.shownet.value === 2) {
      messages.push(command);
    }

    CL.connection.lastServerMessages.push(command);
    if (CL.connection.lastServerMessages.length > 10) {
      CL.connection.lastServerMessages.shift();
    }

    const handler = (CL.cls.legacy_demo && legacyServerCommandHandlers[cmd]) ? legacyServerCommandHandlers[cmd] : serverCommandHandlers[cmd];

    if (handler) {
      handler();
      continue;
    }

    CL.connection.lastServerMessages.pop();
    CL.PrintLastServerMessages();
    throw new HostError('CL.ParseServerMessage: Illegible server message\n');
  }

  if (entitiesReceived > 0) {
    if (CL.cls.signon === 3) {
      CL.cls.signon = 4;
      CL.SignonReply();
    }
  }

  // CL.state.clientEntities.setSolidEntities(CL.pmove);

  if (CL.shownet.value === 2) {
    Con.Print('NET: (' + NET.message.cursize + ') ' + messages.join(', ') + '\n');
  }
}

export {
  handleNop,
  handleTime,
  handlePrint,
  handleCenterPrint,
  handleStuffText,
  handleSetView,
  handleLightStyle,
  handleStopSound,
  handleUpdateName,
  handleUpdateFrags,
  handleUpdateColors,
  handleSetPause,
  handleSignonNum,
  handleCdTrack,
  handleIntermission,
  handleFinale,
  handleCutscene,
  handleSellScreen,
};
