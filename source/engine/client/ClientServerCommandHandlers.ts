import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import Cmd from '../common/Cmd.ts';
import { HostError } from '../common/Errors.ts';
import Vector from '../../shared/Vector.ts';
import GameModule from '../common/GameModule.ts';
import { engineApi } from './PageServices.ts';
import { ModelScope, type BrushModel } from '../common/Mod.ts';
import { sharedCollisionModelSource } from '../common/CollisionModelSource.ts';
import { registerClientDeserializer } from '../network/MSG.ts';
import { ServerEdict } from '../server/Edict.ts';
import { eventBus } from '../common/EventBus.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import { ScoreSlot, clientRuntimeState, clientStaticState } from './ClientState.ts';
import type { ClientEdict } from './ClientEntities.ts';
import type { SFX } from './Sound.ts';
import PostProcess from './renderer/postprocess/PostProcess.ts';
import Con from '../common/Console.ts';
import Mod from '../common/Mod.ts';
import clientCvars from './ClientCvars.ts';
import { clientPmove } from './ClientPhysics.ts';
import CL from './CL.ts';
import R from './R.ts';
import Particles from './renderer/effects/Particles.ts';
import Host from '../common/Host.ts';
import ClientHost from './ClientHost.ts';
import S from './Sound.ts';
import SCR from './SCR.ts';
import V from './V.ts';
import { net } from './PageServices.ts';

type ClientSignonState = 0 | 1 | 2 | 3 | 4;

// An edict reference on the wire is the number of the client's own copy of it.
registerClientDeserializer(ServerEdict, (): ClientEdict => clientRuntimeState.clientEntities.getEntity(net.message.readShort()) as ClientEdict);

sharedCollisionModelSource.configureClient({
  getWorldModel: () => CL?.state?.worldmodel ?? null,
  getModels: () => CL?.state?.model_precache ?? null,
});

/** Tracks entity updates during message parsing */
let entitiesReceived = 0;

/**
 * Detects unsupported Protocol 15 / WinQuake serverdata payloads.
 * @returns Whether the unread payload starts with a legacy Protocol 15 serverdata header.
 */
function isUnsupportedLegacyServerData(): boolean {
  const remainingBytes = net.message.cursize - net.message.readcount;

  if (remainingBytes < 4) {
    return false;
  }

  return new DataView(net.message.data, net.message.readcount, remainingBytes).getInt32(0, true) === 15;
}

/**
 * Stores a loaded precache slice while preserving Quake's sparse slot indexing.
 * @param {T[]} target Precache target array.
 * @param {number} startIndex First slot covered by the loaded slice.
 * @param {Array<T | null>} loaded Loaded values, where null leaves the slot empty.
 */
function storeLoadedSlice<T>(target: T[], startIndex: number, loaded: Array<T | null>): void {
  target.length = startIndex + loaded.length;

  for (let offset = 0; offset < loaded.length; offset++) {
    const value = loaded[offset];
    if (value !== null) {
      target[startIndex + offset] = value;
    }
  }
}

/** Marks the screen refdef as dirty for the next frame. */
function markRefdefDirty(): void {
  (SCR as typeof SCR & { recalc_refdef: boolean }).recalc_refdef = true;
}

/**
 * Parses the serverdata payload and prepares the client for the new map.
 */
function parseServerData() {
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = net.message.readByte();

  if (version !== Protocol.version) {
    throw new HostError(`Server returned protocol version ${version}, not ${Protocol.version}\n`);
  }

  Con.DPrint('Server is running a game module with ClientGameAPI provided.\n');

  const activeGameModule = GameModule.active;

  if (activeGameModule === null) {
    throw new HostError('Server is running a game module with client code provided,\nbut no matching client game module is loaded.\nTry clearing your cache and connect again.');
  }

  const name = net.message.readString();
  const author = net.message.readString();
  const serverVersion = [net.message.readByte(), net.message.readByte(), net.message.readByte()];

  const identification = activeGameModule.identification;

  if (identification.name !== name || identification.author !== author) {
    throw new HostError(`Cannot connect, game mismatch.\nThe server is running ${name}\nand you are running ${identification.name}.`);
  }

  if (!activeGameModule.ClientGameAPI.IsServerCompatible(serverVersion)) {
    throw new HostError(`Server (v${serverVersion.join('.')} ) is not compatible. You are running v${identification.version.join('.')}\nTry clearing your cache and connect again.`);
  }

  clientRuntimeState.gameAPI = new activeGameModule.ClientGameAPI(engineApi);

  clientRuntimeState.maxclients = net.message.readByte();
  if ((clientRuntimeState.maxclients <= 0) || (clientRuntimeState.maxclients > 32)) {
    throw new HostError('Bad maxclients (' + clientRuntimeState.maxclients + ') from server!');
  }

  clientRuntimeState.scores.length = 0;

  for (let i = 0; i < clientRuntimeState.maxclients; i++) {
    clientRuntimeState.scores[i] = new ScoreSlot(i);
  }

  clientRuntimeState.levelname = net.message.readString();

  // parsePmovevars(CL);

  Con.Print('\x02' + clientRuntimeState.levelname + '\n\n');

  CL.SetConnectingStep(15, 'Received server info');

  let str: string;
  let nummodels: number;
  const model_precache: string[] = [];
  for (nummodels = 1; ; nummodels++) {
    str = net.message.readString();
    if (str.length === 0) {
      break;
    }
    model_precache[nummodels] = str;
  }
  let numsounds: number;
  const sound_precache: string[] = [];
  for (numsounds = 1; ; numsounds++) {
    str = net.message.readString();
    if (str.length === 0) {
      break;
    }
    sound_precache[numsounds] = str;
  }

  const clientdataFields: string[] = [];

  while (true) {
    const fields = net.message.readString();
    if (fields === '') {
      break;
    }
    clientdataFields.push(fields);
  }

  clientRuntimeState.clientMessages.clientdataFields = clientdataFields;

  while (true) {
    const classname = net.message.readString();

    if (classname === '') {
      break;
    }

    const fields: string[] = [];

    while (true) {
      const field = net.message.readString();

      if (field === '') {
        break;
      }

      fields.push(field);
    }

    let bitsReader: 'readByte' | 'readShort' | 'readLong';

    console.assert(fields.length <= 32, 'entity fields must not have more than 32 fields');

    if (fields.length <= 8) {
      bitsReader = 'readByte';
    } else if (fields.length <= 16) {
      bitsReader = 'readShort';
    } else {
      bitsReader = 'readLong';
    }

    if (fields.length > 0) {
      clientRuntimeState.clientEntityFields[classname] = { fields, bitsReader };
    }
  }

  CL.connection.processingServerDataState = 1;

  void (async () => {
    const models: BaseModel[] = [];
    const sounds: SFX[] = [];
    models.length = 1;
    sounds.length = 1;

    const worldModel = await Mod.ForNameAsync(model_precache[1], false, ModelScope.client);
    if (worldModel === null) {
      throw new HostError(`Failed to load world model ${model_precache[1]}`);
    }
    models[1] = worldModel;
    nummodels--;

    while (nummodels > 0) {
      const chunksize = Math.min(nummodels, 10);
      nummodels -= chunksize;

      CL.SetConnectingStep(25 + (models.length / model_precache.length) * 30, 'Loading models');
      const modelStart = models.length;
      const loadedModels = await Promise.all(model_precache.slice(modelStart, modelStart + chunksize).map((m) => Mod.ForNameAsync(m, false, ModelScope.client)));
      storeLoadedSlice(models, modelStart, loadedModels);

      CL.SendCmd();
    }

    while (numsounds > 0) {
      const chunksize = Math.min(numsounds, 10);
      numsounds -= chunksize;
      CL.SetConnectingStep(55 + (sounds.length / sound_precache.length) * 30, 'Loading sounds');
      const soundStart = sounds.length;
      const loadedSounds = await Promise.all(sound_precache.slice(soundStart, soundStart + chunksize).map((s) => S.PrecacheSoundAsync(s)));
      storeLoadedSlice(sounds, soundStart, loadedSounds);

      CL.SendCmd();
    }

    return { models, sounds };
  })().then(({ models, sounds }) => {
    clientRuntimeState.model_precache.length = 0;
    clientRuntimeState.sound_precache.length = 0;

    clientRuntimeState.model_precache.push(...models);
    clientRuntimeState.sound_precache.push(...sounds);

    CL.connection.processingServerDataState = 2;
    clientRuntimeState.worldmodel = clientRuntimeState.model_precache[1] as BrushModel;
    clientPmove.setWorldmodel(clientRuntimeState.worldmodel);
    const ent = clientRuntimeState.clientEntities.getEntity(0);
    ent.classname = 'worldspawn';
    ent.loadHandler();
    ent.model = clientRuntimeState.worldmodel;
    ent.spawn();
    CL.SetConnectingStep(85, 'Preparing map');
    CL.SendCmd();
    R.NewMap();
    CL.SendCmd();
    Host.noclip_anglehack = false;
    PostProcess.clearStack();
    if (clientRuntimeState.gameAPI) {
      clientRuntimeState.gameAPI.init();
      if (clientRuntimeState.loadClientData && clientRuntimeState.loadClientData[0]) {
        clientRuntimeState.gameAPI.loadGame(clientRuntimeState.loadClientData[0]);
      }
    }
    if (clientRuntimeState.loadClientData && Array.isArray(clientRuntimeState.loadClientData[1])) {
      Particles.DeserializeParticles(clientRuntimeState.loadClientData[1]);
    }
    if (clientRuntimeState.loadClientData && Array.isArray(clientRuntimeState.loadClientData[2])) {
      clientRuntimeState.clientEntities.deserialize(clientRuntimeState.loadClientData[2]);
    }
    clientRuntimeState.loadClientData = null;
  });
}

/**
 * Reads pmove configuration values from the network stream.
 */
function parsePmovevars() {
  const movevars = clientPmove.movevars;
  movevars.gravity = net.message.readFloat();
  movevars.stopspeed = net.message.readFloat();
  movevars.maxspeed = net.message.readFloat();
  movevars.spectatormaxspeed = net.message.readFloat();
  movevars.accelerate = net.message.readFloat();
  movevars.airaccelerate = net.message.readFloat();
  movevars.wateraccelerate = net.message.readFloat();
  movevars.friction = net.message.readFloat();
  movevars.waterfriction = net.message.readFloat();
  movevars.entgravity = net.message.readFloat();

  Con.DPrint('Reconfigured Pmovevars.\n');
}

/**
 * Parses a lightstyle definition.
 */
function parseLightstylePacket() {
  const index = net.message.readByte();
  if (index >= Def.limits.lightstyles) {
    throw new HostError('svc_lightstyle > MAX_LIGHTSTYLES');
  }

  clientRuntimeState.clientEntities.setLightstyle(index, net.message.readString());
}

/**
 * Parses a spatialized sound start request.
 */
function parseStartSoundPacket() {
  const fieldMask = net.message.readByte();
  const volume = ((fieldMask & 1) !== 0) ? net.message.readByte() : 255;
  const attenuation = ((fieldMask & 2) !== 0) ? net.message.readByte() * 0.015625 : 1.0;
  const entchannel = net.message.readShort();
  const soundNum = net.message.readByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = net.message.readCoordVector();

  const sound = clientRuntimeState.sound_precache[soundNum];
  if (sound) {
    S.StartSound(ent, channel, sound, pos, volume / 255.0, attenuation);
  }
}

/**
 * Parses a static entity definition.
 */
function parseStaticEntity() {
  const ent = clientRuntimeState.clientEntities.allocateStaticEntity(net.message.readString());
  const modelindex = net.message.readByte();
  ent.modelindex = modelindex;
  ent.model = clientRuntimeState.model_precache[modelindex] || null;
  ent.frame = net.message.readByte();
  ent.colormap = net.message.readByte();
  ent.skinnum = net.message.readByte();
  ent.effects = net.message.readByte();
  ent.alpha = net.message.readByte() / 255.0;
  ent.solid = net.message.readByte();
  ent.angles.set(net.message.readAngleVector());
  ent.setOrigin(net.message.readCoordVector());
  ent.spawn();
}

/**
 * Parses a static ambient sound definition.
 */
function parseStaticSound() {
  const org = net.message.readCoordVector();
  const soundId = net.message.readByte();
  const vol = net.message.readByte();
  const attn = net.message.readByte();
  const sound = clientRuntimeState.sound_precache[soundId];
  if (sound) {
    S.StaticSound(sound, org, vol / 255.0, attn);
  }
}

/**
 * Applies server cvar updates.
 */
function parseServerCvars() {
  let count = net.message.readByte();

  while (count-- > 0) {
    const name = net.message.readString();
    const value = net.message.readString();

    clientStaticState.serverInfo[name] = value;

    if (clientStaticState.signon === 4) {
      if (clientRuntimeState.maxclients > 1) { // don’t bother printing cvar changes in single player
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
 * @param {BaseModel | null | undefined} model Model to attach to the beam.
 */
function parseBeam(model: BaseModel | null | undefined) {
  const ent = net.message.readShort();
  const start = net.message.readCoordVector();
  const end = net.message.readCoordVector();
  if (!model) {
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = clientRuntimeState.clientEntities.beams[i];
    if (beam.entity !== ent) {
      continue;
    }
    beam.model = model;
    beam.endtime = clientRuntimeState.time + 0.2;
    beam.start = start.copy();
    beam.end = end.copy();
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = clientRuntimeState.clientEntities.beams[i];
    if ((beam.model !== null) && (beam.endtime >= clientRuntimeState.time)) {
      continue;
    }
    beam.entity = ent;
    beam.model = model;
    beam.endtime = clientRuntimeState.time + 0.2;
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
  const type = net.message.readByte() as Protocol.te;
  console.assert(Object.values(Protocol.te).includes(type), `CL.ParseTEnt: invalid temp entity type ${type}`);

  switch (type) {
    case Protocol.te.lightning1:
      parseBeam(clientRuntimeState.clientEntities.tempEntityModels['progs/bolt.mdl']);
      return;
    case Protocol.te.lightning2:
      parseBeam(clientRuntimeState.clientEntities.tempEntityModels['progs/bolt2.mdl']);
      return;
    case Protocol.te.lightning3:
      parseBeam(clientRuntimeState.clientEntities.tempEntityModels['progs/bolt3.mdl']);
      return;
    case Protocol.te.beam: // CR: this model does not exist
      parseBeam(clientRuntimeState.clientEntities.tempEntityModels['progs/beam.mdl']);
      return;
  }

  const pos = net.message.readCoordVector();
  const sounds = clientRuntimeState.clientEntities.tempEntitySounds;

  switch (type) {
    case Protocol.te.wizspike:
      Particles.RunParticleEffect(pos, Vector.origin, 20, 20);
      if (sounds.wizhit !== null && S.IsPositionAudible(pos)) {
        S.StartSound(-1, 0, sounds.wizhit, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.knightspike:
      Particles.RunParticleEffect(pos, Vector.origin, 226, 20);
      if (sounds.knighthit !== null && S.IsPositionAudible(pos)) {
        S.StartSound(-1, 0, sounds.knighthit, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.spike:
      Particles.RunParticleEffect(pos, Vector.origin, 0, 10);
      return;
    case Protocol.te.superspike:
      Particles.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.gunshot:
      Particles.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.explosion: {
      Particles.ParticleExplosion(pos);
      const dl = clientRuntimeState.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = clientRuntimeState.time + 0.5;
      dl.decay = 300.0;
      if (sounds.explosion !== null && S.IsPositionAudible(pos)) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
    }
      return;
    case Protocol.te.tarexplosion:
      Particles.BlobExplosion(pos);
      if (sounds.explosion !== null && S.IsPositionAudible(pos)) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.lavasplash:
      Particles.LavaSplash(pos);
      return;
    case Protocol.te.teleport:
      Particles.TeleportSplash(pos);
      return;
    case Protocol.te.explosion2: {
      const colorStart = net.message.readByte();
      const colorLength = net.message.readByte();
      Particles.ParticleExplosion2(pos, colorStart, colorLength);
      const dl = clientRuntimeState.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = clientRuntimeState.time + 0.5;
      dl.decay = 300.0;
      if (sounds.explosion !== null && S.IsPositionAudible(pos)) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
    }
      return;
    default:
      throw new Error(`CL.ParseTEnt: bad type ${type}`);
  }
}

/**
 * Applies entity deltas for the current frame.
 */
function parsePacketEntities() {
  while (true) {
    const edictNum = net.message.readUint16();

    if (edictNum === 0) {
      break;
    }

    const clent = clientRuntimeState.clientEntities.getEntity(edictNum);

    const bits = net.message.readUint16();

    if (bits & Protocol.u.classname) {
      clent.classname = net.message.readString();
      clent.loadHandler();
      clent.spawn();
    }

    if (bits & Protocol.u.free) {
      clent.free = net.message.readByte() !== 0;
    }

    if (bits & Protocol.u.frame) {
      clent.framePrevious = clent.frame;
      clent.frame = net.message.readByte();
    }

    if (bits & Protocol.u.model) {
      const modelindex = net.message.readByte();
      clent.modelindex = modelindex;
      clent.model = clientRuntimeState.model_precache[modelindex] || null;

      clent.framePrevious = null;
      clent.frameTime = 0.0;

      if (clent.model) {
        clent.syncbase = clent.model.random ? Math.random() : 0.0;
      }
    }

    if (bits & Protocol.u.colormap) {
      clent.colormap = net.message.readByte();
    }

    if (bits & Protocol.u.skin) {
      clent.skinnum = net.message.readByte();
    }

    if (bits & Protocol.u.effects) {
      clent.effects = net.message.readByte();
      clent.alpha = net.message.readByte() / 255.0;
    }

    if (bits & Protocol.u.solid) {
      clent.solid = net.message.readByte();
    }

    const origin = clent.msg_origins[0];
    const angles = clent.msg_angles[0];
    const velocity = clent.msg_velocity[0];

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        origin[i] = net.message.readCoord();
      }

      if (bits & (Protocol.u.angle1 << i)) {
        angles[i] = net.message.readAngle();
        velocity[i] = net.message.readCoord();
      }
    }

    if (bits & Protocol.u.size) {
      clent.maxs.set(net.message.readCoordVector());
      clent.mins.set(net.message.readCoordVector());
    }

    if (bits & Protocol.u.nextthink) {
      clent.lerpEndTime = clientRuntimeState.clientMessages.mtime[0] + net.message.readByte() / 255.0;
    }

    const classname = clent.classname;
    const clientEntityFields = classname !== null ? clientRuntimeState.clientEntityFields[classname] : undefined;
    if (clientEntityFields) {
      // TODO: optimize this
      const fieldbits = clientEntityFields.bitsReader === 'readByte'
        ? net.message.readByte()
        : clientEntityFields.bitsReader === 'readShort'
          ? net.message.readShort()
          : net.message.readLong();

      if (fieldbits > 0) {
        const fields = [];

        for (let i = 0; i < clientEntityFields.fields.length; i++) {
          const field = clientEntityFields.fields[i];
          if ((fieldbits & (1 << i)) !== 0) {
            fields.push(field);
          }
        }

        let counter = 0;

        const values = net.message.readSerializablesOnClient();

        for (const value of values) {
          clent.extended[fields[counter++]] = value;
        }
      }
    }

    const time = clientRuntimeState.clientMessages.mtime[0];

    if (clent.lerpEndTime > time) {
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
  clientRuntimeState.clientMessages.parseTime();
}

/**
 * Handles svc_clientdata and populates the incremental client snapshot.
 */
function handleClientData() {
  clientRuntimeState.clientMessages.parseClient();
}

/**
 * Validates the negotiated protocol version and aborts if mismatched.
 */
function handleVersion() {
  const protocol = net.message.readLong();
  if (protocol !== Protocol.version) {
    throw new HostError(`CL.ParseServerMessage: Server is protocol ${protocol} instead of ${Protocol.version}\n`);
  }
}

/**
 * Processes svc_disconnect by surfacing the server-supplied message.
 */
function handleDisconnect() {
  ClientHost.EndGame(`Server disconnected: ${net.message.readString()}`);
}

/**
 * Routes svc_print text through the console.
 */
function handlePrint() {
  Con.Print(net.message.readString());
}

/**
 * Displays server-sent center print text and mirrors it to the console.
 */
function handleCenterPrint() {
  const string = net.message.readString();
  SCR.CenterPrint(string);
  Con.Print(`\x03${string}\n`); // TODO: have a better system for this
}

/**
 * Handles chat payloads and appends them to the client chat log.
 */
function handleChatMessage() {
  CL.AppendChatMessage(net.message.readString(), net.message.readString(), net.message.readByte() === 1);
}

/**
 * Concatenates svc_stufftext into the pending console buffer.
 */
function handleStuffText() {
  Cmd.text += net.message.readString();
}

/**
 * Delegates svc_damage to the view module so it can spawn impacts.
 */
function handleDamage() {
  const armor = net.message.readByte();
  const blood = net.message.readByte();
  const origin = net.message.readCoordVector();
  V.ApplyDamage(armor, blood, origin);
}

/**
 * Parses svc_serverdata and reinitializes renderer state.
 */
function handleServerData() {
  markRefdefDirty();

  if (isUnsupportedLegacyServerData()) {
    throw new HostError('Protocol 15 / WinQuake serverdata is no longer supported.');
  }

  parseServerData();
}

/**
 * Processes map transitions and resets client signon state.
 */
function handleChangeLevel() {
  const mapname = net.message.readString();
  CL.SetConnectingStep(5, 'Changing level to ' + mapname);
  clientStaticState.signon = 0;
  clientStaticState.changelevel = true;
}

/**
 * Updates the authoritative view angles of the local player.
 */
function handleSetAngle() {
  clientRuntimeState.viewangles.set(net.message.readAngleVector());
}

/**
 * Selects the entity the client should render from.
 */
function handleSetView() {
  clientRuntimeState.viewentity = net.message.readShort();
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
  const value = net.message.readShort();
  S.StopSound(value >> 3, value & 7);
}

/**
 * Updates the server-specified sound precache entry.
 */
function handleLoadSound() {
  const index = net.message.readByte();
  const sound = S.PrecacheSound(net.message.readString());
  if (sound === null) {
    return;
  }
  clientRuntimeState.sound_precache[index] = sound;
  Con.DPrint(`CL.ParseServerMessage: load sound "${clientRuntimeState.sound_precache[index].name}" (${clientRuntimeState.sound_precache[index].state}) on slot ${index}\n`);
}

/**
 * Mirrors scoreboard name updates and broadcasts change events.
 */
function handleUpdateName() {
  const slot = net.message.readByte();
  if (slot >= clientRuntimeState.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatename > MAX_SCOREBOARD');
  }
  const newName = net.message.readString();
  if (clientRuntimeState.scores[slot].name !== '' && newName !== '' && newName !== clientRuntimeState.scores[slot].name) {
    Con.Print(`${clientRuntimeState.scores[slot].name} renamed to ${newName}\n`);
    eventBus.publish('client.players.name-changed', slot, clientRuntimeState.scores[slot].name, newName);
  }
  clientRuntimeState.scores[slot].name = newName;
}

/**
 * Updates frag counts for a player and notifies listeners.
 */
function handleUpdateFrags() {
  const slot = net.message.readByte();
  if (slot >= clientRuntimeState.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD');
  }
  clientRuntimeState.scores[slot].frags = net.message.readShort();
  eventBus.publish('client.players.frags-updated', slot, clientRuntimeState.scores[slot].frags);
}

/**
 * Updates color indices for a player and notifies listeners.
 */
function handleUpdateColors() {
  const slot = net.message.readByte();
  if (slot >= clientRuntimeState.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD');
  }
  clientRuntimeState.scores[slot].colors = net.message.readByte();
  eventBus.publish('client.players.colors-updated', slot, clientRuntimeState.scores[slot].colors);
}

/**
 * Updates ping information for a player.
 */
function handleUpdatePings() {
  const slot = net.message.readByte();
  if (slot >= clientRuntimeState.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatepings > MAX_SCOREBOARD');
  }
  clientRuntimeState.scores[slot].ping = net.message.readShort() / 10;
}

/**
 * Spawns particle effects from svc_particle payloads.
 */
function handleParticle() {
  const org = net.message.readCoordVector();
  const dir = net.message.readCoordVector();
  const msgcount = net.message.readByte();
  const color = net.message.readByte();
  if (msgcount === 255) {
    Particles.ParticleExplosion(org);
  } else {
    Particles.RunParticleEffect(org, dir, color, msgcount);
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
  clientRuntimeState.paused = net.message.readByte() !== 0;
  if (clientRuntimeState.paused) {
    eventBus.publish('client.paused');
  } else {
    eventBus.publish('client.unpaused');
  }
}

/**
 * Tracks the server signon phase and advances the handshake.
 */
function handleSignonNum() {
  const signon = net.message.readByte();
  if (signon <= clientStaticState.signon) {
    throw new HostError('Received signon ' + signon + ' when at ' + clientStaticState.signon);
  }
  console.assert(signon >= 0 && signon <= 4, 'signon must be in range 0-4');
  clientStaticState.signon = signon as ClientSignonState;
  Con.DPrint(`Received signon ${signon}\n`);
  CL.SignonReply();
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
  clientRuntimeState.cdtrack = net.message.readByte();
  net.message.readByte(); // unused (usually always the same as cdtrack)

  if ((clientStaticState.demoplayback || clientStaticState.demorecording) && clientStaticState.forcetrack !== -1) {
    eventBus.publish('client.cdtrack', clientStaticState.forcetrack);
  } else {
    eventBus.publish('client.cdtrack', clientRuntimeState.cdtrack);
  }
}

/**
 * Enters the intermission state.
 */
function handleIntermission() {
  clientRuntimeState.intermission = 1;
  clientRuntimeState.completed_time = clientRuntimeState.time;
  markRefdefDirty();
}

/**
 * Displays the finale text block.
 */
function handleFinale() {
  clientRuntimeState.intermission = 2;
  clientRuntimeState.completed_time = clientRuntimeState.time;
  markRefdefDirty();
  SCR.CenterPrint(net.message.readString());
}

/**
 * Plays a cutscene by showing a center print.
 */
function handleCutscene() {
  clientRuntimeState.intermission = 3;
  clientRuntimeState.completed_time = clientRuntimeState.time;
  markRefdefDirty();
  SCR.CenterPrint(net.message.readString());
}

/**
 * Calls the help command when the server requests the sell screen.
 */
function handleSellScreen() {
  void Cmd.ExecuteString('help');
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
  clientRuntimeState.clientMessages.parsePlayer();
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
  console.assert(clientRuntimeState.gameAPI !== null, 'ClientGameAPI required');
  clientRuntimeState.clientMessages.parseClientEvent();
}

/**
 * Updates portal state.
 */
function handleSetPortalState() {
  const portalNum = net.message.readShort();
  const open = net.message.readByte() !== 0;
  const worldmodel = clientRuntimeState.worldmodel;
  console.assert(worldmodel !== null, 'worldmodel must be available before changing portal state');
  if (worldmodel === null) {
    return;
  }
  worldmodel.areaPortals.setPortalState(portalNum, open);
}

const serverCommandHandlers: Partial<Record<number, () => void>> = {
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
  if (clientCvars.shownet.value === 1) {
    Con.Print('NET: ' + net.message.cursize + ' bytes\n');
  }

  clientRuntimeState.onground = false;

  if (CL.connection.processingServerDataState === 1) {
    return;
  }

  entitiesReceived = 0;

  if (CL.connection.processingServerDataState === 3) {
    CL.connection.processingServerDataState = 0;
  } else {
    CL.connection.lastServerMessages.length = 0;
    net.message.beginReading();
  }

  const messages: string[] = [];

  while (clientStaticState.state > Def.clientConnectionState.disconnected) {
    if (CL.connection.processingServerDataState > 0) {
      break;
    }

    if (net.message.badread) {
      CL.PrintLastServerMessages();
      throw new HostError('CL.ParseServerMessage: Bad server message');
    }

    const cmd = net.message.readByte();

    if (cmd === -1) {
      break;
    }

    const commandEntry = (CL.svc_strings ?? []).find(([, value]) => value === cmd);

    if (!commandEntry) {
      CL.PrintLastServerMessages();
      throw new HostError(`CL.ParseServerMessage: Unknown server message ${cmd}`);
    }

    const command = commandEntry[0];

    if (clientCvars.shownet.value === 2) {
      messages.push(command);
    }

    CL.connection.lastServerMessages.push(command);
    if (CL.connection.lastServerMessages.length > 10) {
      CL.connection.lastServerMessages.shift();
    }

    const handler = serverCommandHandlers[cmd];

    if (handler) {
      handler();
      continue;
    }

    CL.connection.lastServerMessages.pop();
    CL.PrintLastServerMessages();
    throw new HostError('CL.ParseServerMessage: Illegible server message\n');
  }

  if (entitiesReceived > 0) {
    if (clientStaticState.signon === 3) {
      clientStaticState.signon = 4;
      CL.SignonReply();
    }
  }

  // clientRuntimeState.clientEntities.setSolidEntities(clientPmove);

  if (clientCvars.shownet.value === 2) {
    Con.Print(`net: (${net.message.cursize}) ${messages.join(', ')}\n`);
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
