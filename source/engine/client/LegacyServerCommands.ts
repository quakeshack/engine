import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import { HostError } from '../common/Errors.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { ModelScope, type BrushModel } from '../common/Mod.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import { ScoreSlot } from './ClientState.ts';
import Vector from '../../shared/Vector.ts';
import type { SFX } from './Sound.ts';
import {
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
} from './ClientServerCommandHandlers.ts';

let { CL, Con, NET, Mod, S, R, V, Host } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, NET, Mod, S, R, V, Host } = getClientRegistry());
});

// TRIGGER WARNING: this content has been completely produced by Claude Opus 4.6
//                  it’s only here, because I want the original demos working again --CR

// ── WinQuake SU_ Client Data Update Bits ────────────────────────────────────
// Note: bit 8 is unused in WinQuake, so ITEMS starts at bit 9.
const enum SU {
  VIEWHEIGHT = 1 << 0,
  IDEALPITCH = 1 << 1,
  PUNCH1 = 1 << 2,
  PUNCH2 = 1 << 3,
  PUNCH3 = 1 << 4,
  VELOCITY1 = 1 << 5,
  VELOCITY2 = 1 << 6,
  VELOCITY3 = 1 << 7,
  // bit 8 unused
  ITEMS = 1 << 9,
  ONGROUND = 1 << 10,
  INWATER = 1 << 11,
  WEAPONFRAME = 1 << 12,
  ARMOR = 1 << 13,
  WEAPON = 1 << 14,
}

// ── WinQuake U_ Entity Update Bits ──────────────────────────────────────────
const enum U {
  MOREBITS = 1 << 0,
  ORIGIN1 = 1 << 1,
  ORIGIN2 = 1 << 2,
  ORIGIN3 = 1 << 3,
  ANGLE2 = 1 << 4,
  NOLERP = 1 << 5,
  FRAME = 1 << 6,
  SIGNAL = 1 << 7,
  ANGLE1 = 1 << 8,
  ANGLE3 = 1 << 9,
  MODEL = 1 << 10,
  COLORMAP = 1 << 11,
  SKIN = 1 << 12,
  EFFECTS = 1 << 13,
  LONGENTITY = 1 << 14,
}

// ── WinQuake SND_ Sound Flags ───────────────────────────────────────────────
const enum SND {
  VOLUME = 1 << 0,
  ATTENUATION = 1 << 1,
}

// ── Legacy Coordinate / Angle Helpers ───────────────────────────────────────
// WinQuake coords: 16-bit short × (1/8)    = 2 bytes
// WinQuake angles: 8-bit byte × (360/256)  = 1 byte

/**
 * Reads a WinQuake coordinate (short / 8).
 * @returns {number} the decoded coordinate
 */
function readLegacyCoord(): number {
  return NET.message.readShort() * (1.0 / 8.0);
}

/**
 * Reads a WinQuake angle (byte × 360/256).
 * @returns {number} the decoded angle in degrees
 */
function readLegacyAngle(): number {
  return NET.message.readByte() * (360.0 / 256.0);
}

/**
 * Reads 3 WinQuake coordinates as a Vector.
 * @returns {Vector} xyz coordinate vector
 */
function readLegacyCoordVector(): Vector {
  return new Vector(readLegacyCoord(), readLegacyCoord(), readLegacyCoord());
}

/**
 * Reads 3 WinQuake angles as a Vector.
 * @returns {Vector} pitch/yaw/roll angle vector
 */
function readLegacyAngleVector(): Vector {
  return new Vector(readLegacyAngle(), readLegacyAngle(), readLegacyAngle());
}

// ── Entity Baselines ────────────────────────────────────────────────────────

interface LegacyBaseline {
  modelindex: number;
  frame: number;
  colormap: number;
  skin: number;
  effects: number;
  origin: Float32Array;
  angles: Float32Array;
}

const legacyBaselines: LegacyBaseline[] = [];

/**
 * Returns the stored baseline for the given entity number, creating a blank one if needed.
 * @param {number} num entity number
 * @returns {LegacyBaseline} the baseline record
 */
function getBaseline(num: number): LegacyBaseline {
  if (!legacyBaselines[num]) {
    legacyBaselines[num] = {
      modelindex: 0,
      frame: 0,
      colormap: 0,
      skin: 0,
      effects: 0,
      origin: new Float32Array(3),
      angles: new Float32Array(3),
    };
  }
  return legacyBaselines[num];
}

/**
 * Returns the random-sync seed for models that support randomized animation starts.
 * @param {BaseModel} model Model assigned to the entity.
 * @returns {number} Sync seed to store on the client entity.
 */
function getModelSyncbase(model: BaseModel): number {
  return model.random ? Math.random() : 0.0;
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

// ── svc_serverdata (11) ─────────────────────────────────────────────────────
// WinQuake wire format:
//   long    protocol version (must be 15)
//   byte    maxclients
//   byte    gametype (0=coop, 1=dm)
//   string  level name
//   strings model precache list (empty string terminates)
//   strings sound precache list (empty string terminates)

/**
 * Parses WinQuake svc_serverdata and reinitializes client state for legacy demo playback.
 */
function handleLegacyServerData() {
  Con.DPrint('Legacy Serverdata packet received.\n');
  CL.ClearState();
  CL.cls.legacy_demo = true;
  legacyBaselines.length = 0;

  const protocol = NET.message.readLong();
  if (protocol !== 15) {
    throw new HostError(`Legacy server returned protocol ${protocol}, not 15`);
  }

  const maxclients = NET.message.readByte();
  CL.state.maxclients = maxclients;

  CL.state.scores.length = 0;
  for (let i = 0; i < CL.state.maxclients; i++) {
    CL.state.scores[i] = new ScoreSlot(i);
  }

  NET.message.readByte(); // skip gametype, not used by the client

  CL.state.levelname = NET.message.readString();

  Con.Print('\x02' + CL.state.levelname + '\n\n');

  CL.SetConnectingStep(15, 'Received server info');

  // Read model precache list (strings terminated by empty string)
  const model_precache: string[] = [];
  for (let nummodels = 1; ; nummodels++) {
    const str = NET.message.readString();
    if (str.length === 0) {
      break;
    }
    model_precache[nummodels] = str;
  }

  // Read sound precache list (strings terminated by empty string)
  const sound_precache: string[] = [];
  for (let numsounds = 1; ; numsounds++) {
    const str = NET.message.readString();
    if (str.length === 0) {
      break;
    }
    sound_precache[numsounds] = str;
  }

  // Async asset loading
  CL.connection.processingServerDataState = 1;

  void (async () => {
    const models: BaseModel[] = [];
    const sounds: SFX[] = [];
    models.length = 1;
    sounds.length = 1;

    // Load world model first
    const worldModel = await Mod.ForNameAsync(model_precache[1], false, ModelScope.client);
    if (worldModel === null) {
      throw new HostError(`Failed to load world model ${model_precache[1]}`);
    }
    models[1] = worldModel;

    // Load remaining models in chunks
    while (models.length < model_precache.length) {
      const remaining = model_precache.slice(models.length);
      const chunksize = Math.min(remaining.length, 10);
      if (chunksize === 0) {
        break;
      }
      CL.SetConnectingStep(25 + (models.length / model_precache.length) * 30, 'Loading models');
      const modelStart = models.length;
      const loaded = await Promise.all(remaining.slice(0, chunksize).map((m) => Mod.ForNameAsync(m, false, ModelScope.client)));
      storeLoadedSlice(models, modelStart, loaded);
      CL.SendCmd();
    }

    // Load sounds in chunks
    while (sounds.length < sound_precache.length) {
      const remaining = sound_precache.slice(sounds.length);
      const chunksize = Math.min(remaining.length, 10);
      if (chunksize === 0) {
        break;
      }
      CL.SetConnectingStep(55 + (sounds.length / sound_precache.length) * 30, 'Loading sounds');
      const soundStart = sounds.length;
      const loaded = await Promise.all(remaining.slice(0, chunksize).map((s) => S.PrecacheSoundAsync(s)));
      storeLoadedSlice(sounds, soundStart, loaded);
      CL.SendCmd();
    }

    return { models, sounds };
  })().then(({ models, sounds }) => {
    CL.state.model_precache.length = 0;
    CL.state.sound_precache.length = 0;

    CL.state.model_precache.push(...models);
    CL.state.sound_precache.push(...sounds);

    CL.connection.processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1] as BrushModel;
    CL.pmove.setWorldmodel(CL.state.worldmodel);

    const ent = CL.state.clientEntities.getEntity(0);
    ent.classname = 'worldspawn';
    ent.loadHandler();
    ent.model = CL.state.model_precache[1] || null;
    ent.spawn();

    R.NewMap();
  }).catch((e) => {
    Con.Print(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw new HostError('Legacy ServerData loading failed');
  });
}

// ── svc_spawnbaseline (22) ──────────────────────────────────────────────────
// WinQuake wire format:
//   short   entity number
//   byte    modelindex
//   byte    frame
//   byte    colormap
//   byte    skin
//   3× (coord, angle)  origin[i], angles[i]   – interleaved

/**
 * Parses a WinQuake svc_spawnbaseline and stores the entity baseline.
 */
function handleLegacySpawnBaseline() {
  const entnum = NET.message.readShort();
  const baseline = getBaseline(entnum);

  baseline.modelindex = NET.message.readByte();
  baseline.frame = NET.message.readByte();
  baseline.colormap = NET.message.readByte();
  baseline.skin = NET.message.readByte();

  for (let i = 0; i < 3; i++) {
    baseline.origin[i] = readLegacyCoord();
    baseline.angles[i] = readLegacyAngle();
  }
}

// ── svc_spawnstatic (20) ────────────────────────────────────────────────────
// Same baseline wire format as spawnbaseline (without the entity number).
// WinQuake copies baseline → entity after parsing.

/**
 * Parses a WinQuake svc_spawnstatic and creates a static client entity.
 */
function handleLegacySpawnStatic() {
  const modelindex = NET.message.readByte();
  const frame = NET.message.readByte();
  const colormap = NET.message.readByte();
  const skin = NET.message.readByte();

  const org = new Vector();
  const ang = new Vector();

  for (let i = 0; i < 3; i++) {
    org[i] = readLegacyCoord();
    ang[i] = readLegacyAngle();
  }

  const ent = CL.state.clientEntities.allocateClientEntity('static_entity');
  ent.modelindex = modelindex;
  ent.model = CL.state.model_precache[modelindex] || null;
  ent.frame = frame;
  ent.colormap = colormap;
  ent.skinnum = skin;
  ent.setOrigin(org);
  ent.angles.set(ang);
  ent.spawn();
}

// ── svc_clientdata (15) ─────────────────────────────────────────────────────
// WinQuake wire format:
//   short   bitmask
//   per-axis (i=0..2): punchangle[i] if SU_PUNCHn (char), velocity[i] if SU_VELOCITYn (char×16)
//   long    items (ALWAYS sent)
//   if SU_WEAPONFRAME: byte
//   if SU_ARMOR: byte
//   if SU_WEAPON: byte
//   short   health (ALWAYS)
//   byte    ammo (ALWAYS)
//   4× byte shells/nails/rockets/cells (ALWAYS)
//   byte    activeweapon (ALWAYS)
// Note: SU_ONGROUND and SU_INWATER are pure bit flags – no data follows.

/**
 * Parses WinQuake svc_clientdata with correct bit layout and read order.
 */
function handleLegacyClientData() {
  const bits = NET.message.readShort();

  CL.state.viewheight = (bits & SU.VIEWHEIGHT) ? NET.message.readChar() : 22;
  CL.state.idealpitch = (bits & SU.IDEALPITCH) ? NET.message.readChar() : 0;

  // WinQuake interleaves punchangle[i] and velocity[i] per axis
  for (let i = 0; i < 3; i++) {
    CL.state.punchangle[i] = (bits & (SU.PUNCH1 << i)) ? NET.message.readChar() : 0;
    // Read velocity from the wire to keep the buffer in sync (not used for prediction)
    if (bits & (SU.VELOCITY1 << i)) {
      NET.message.readChar();
    }
  }

  // Items are ALWAYS sent (unconditional long)
  CL.state.items = NET.message.readLong();

  // Onground / inwater are pure bit flags – no data bytes follow
  CL.state.onground = (bits & SU.ONGROUND) !== 0;
  CL.state.inwater = (bits & SU.INWATER) !== 0;

  // Conditional stats
  CL.state.stats[Def.stat.weaponframe] = (bits & SU.WEAPONFRAME) ? NET.message.readByte() : 0;
  CL.state.stats[Def.stat.armor] = (bits & SU.ARMOR) ? NET.message.readByte() : 0;
  CL.state.stats[Def.stat.weapon] = (bits & SU.WEAPON) ? NET.message.readByte() : 0;

  // Always-sent stats
  CL.state.stats[Def.stat.health] = NET.message.readShort();
  CL.state.stats[Def.stat.ammo] = NET.message.readByte();
  CL.state.stats[Def.stat.shells] = NET.message.readByte();
  CL.state.stats[Def.stat.nails] = NET.message.readByte();
  CL.state.stats[Def.stat.rockets] = NET.message.readByte();
  CL.state.stats[Def.stat.cells] = NET.message.readByte();

  // Active weapon (always sent)
  CL.state.stats[Def.stat.activeweapon] = NET.message.readByte();
}

// ── Entity Update (fast update, cmd & 0x80) ────────────────────────────────
// When the high bit of the command byte is set, the low 7 bits are the
// initial update flags.  This is the WinQuake CL_ParseUpdate equivalent.

/**
 * Parses a WinQuake entity update.  Called when the high bit of the command
 * byte is set.
 * @param {number} bits initial update bits (low 7 bits of command byte)
 */
export function handleLegacyEntityUpdate(bits: number): void {
  // Advance signon on first entity update  (SIGNONS - 1 → SIGNONS)
  if (CL.cls.signon === 3) {
    CL.cls.signon = 4;
    CL.SignonReply();
  }

  // Extended bits
  if (bits & U.MOREBITS) {
    bits |= NET.message.readByte() << 8;
  }

  // Entity number
  const num = (bits & U.LONGENTITY) ? NET.message.readShort() : NET.message.readByte();

  const clent = CL.state.clientEntities.getEntity(num);
  const baseline = getBaseline(num);

  // Detect whether the entity was present in the previous server frame.
  // If not, we cannot interpolate from a previous position.
  const forcelink = (clent.msgtime !== CL.state.clientMessages.mtime[1]);
  clent.msgtime = CL.state.clientMessages.mtime[0];

  // Model
  const modelindex = (bits & U.MODEL) ? NET.message.readByte() : baseline.modelindex;
  clent.modelindex = modelindex;
  const model = CL.state.model_precache[modelindex] || null;
  if (model !== clent.model) {
    clent.model = model;
    if (model) {
      clent.syncbase = getModelSyncbase(model);
    } else {
      clent.forcelink = true;
    }
  }

  // Frame, colormap, skin, effects
  clent.frame = (bits & U.FRAME) ? NET.message.readByte() : baseline.frame;
  clent.colormap = (bits & U.COLORMAP) ? NET.message.readByte() : baseline.colormap;
  clent.skinnum = (bits & U.SKIN) ? NET.message.readByte() : baseline.skin;
  clent.effects = (bits & U.EFFECTS) ? NET.message.readByte() : baseline.effects;

  // Shift interpolation history
  clent.msg_origins[1].set(clent.msg_origins[0]);
  clent.msg_angles[1].set(clent.msg_angles[0]);

  // Origin / angle – interleaved per axis (WinQuake order)
  clent.msg_origins[0][0] = (bits & U.ORIGIN1) ? readLegacyCoord() : baseline.origin[0];
  clent.msg_angles[0][0] = (bits & U.ANGLE1) ? readLegacyAngle() : baseline.angles[0];

  clent.msg_origins[0][1] = (bits & U.ORIGIN2) ? readLegacyCoord() : baseline.origin[1];
  clent.msg_angles[0][1] = (bits & U.ANGLE2) ? readLegacyAngle() : baseline.angles[1];

  clent.msg_origins[0][2] = (bits & U.ORIGIN3) ? readLegacyCoord() : baseline.origin[2];
  clent.msg_angles[0][2] = (bits & U.ANGLE3) ? readLegacyAngle() : baseline.angles[2];

  // U_NOLERP: server explicitly says don’t interpolate (e.g. teleport)
  if (bits & U.NOLERP) {
    clent.forcelink = true;
  }

  // Set up lerp: assume next server frame in +0.1s
  const shouldSnap = forcelink || clent.forcelink;
  const mtime0 = CL.state.clientMessages.mtime[0];

  if (shouldSnap) {
    // Entity just appeared or teleported – snap to current position
    clent.msg_origins[1].set(clent.msg_origins[0]);
    clent.msg_angles[1].set(clent.msg_angles[0]);
    clent.origin.set(clent.msg_origins[0]);
    clent.originPrevious.setTo(Infinity, Infinity, Infinity);
    clent.angles.set(clent.msg_angles[0]);
    clent.anglesPrevious.setTo(Infinity, Infinity, Infinity);
  } else {
    // Smooth transition from current to new target
    clent.originPrevious.set(clent.origin);
    clent.originTime = mtime0;
    clent.origin.set(clent.msg_origins[0]);
    clent.anglesPrevious.set(clent.angles);
    clent.anglesTime = mtime0;
    clent.angles.set(clent.msg_angles[0]);
  }

  clent.nextthink = mtime0 + 0.1; // 100ms is the default QuakeC state machine logic frame interval
  clent.forcelink = false;
  clent.updatecount++;
}

// ── svc_disconnect (2) ──────────────────────────────────────────────────────
// WinQuake sends no additional data with disconnect.

/**
 * Handles WinQuake svc_disconnect (no additional data on the wire).
 */
function handleLegacyDisconnect() {
  Host.EndGame('Server disconnected\n');
}

// ── svc_version (4) ─────────────────────────────────────────────────────────

/**
 * Validates the WinQuake protocol version (must be 15).
 */
function handleLegacyVersion() {
  const protocol = NET.message.readLong();
  if (protocol !== 15) {
    throw new HostError(`CL.ParseServerMessage: Server is protocol ${protocol} instead of 15\n`);
  }
}

// ── svc_setangle (10) ───────────────────────────────────────────────────────
// WinQuake angles are 1 byte each (byte × 360/256).

/**
 * Updates the authoritative view angles using WinQuake 1-byte angle precision.
 */
function handleLegacySetAngle() {
  CL.state.viewangles.set(readLegacyAngleVector());
}

// ── svc_sound (6) ───────────────────────────────────────────────────────────
// WinQuake wire format:
//   byte    field_mask (SND_ flags)
//   if SND_VOLUME: byte
//   if SND_ATTENUATION: byte (÷64)
//   short   entity<<3 | channel
//   byte    sound_num
//   3× coord  position

/**
 * Parses a WinQuake svc_sound with legacy coordinate precision.
 */
function handleLegacySound() {
  const fieldMask = NET.message.readByte();
  const volume = (fieldMask & SND.VOLUME) ? NET.message.readByte() : 255;
  const attenuation = (fieldMask & SND.ATTENUATION) ? NET.message.readByte() / 64.0 : 1.0;

  const entchannel = NET.message.readShort();
  const soundNum = NET.message.readByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = readLegacyCoordVector();

  const sound = CL.state.sound_precache[soundNum];
  if (sound) {
    S.StartSound(ent, channel, sound, pos, volume / 255.0, attenuation);
  }
}

// ── svc_damage (19) ─────────────────────────────────────────────────────────

/**
 * Delegates WinQuake svc_damage with legacy coordinate precision.
 */
function handleLegacyDamage() {
  const armor = NET.message.readByte();
  const blood = NET.message.readByte();
  const origin = readLegacyCoordVector();
  V.ApplyDamage(armor, blood, origin);
}

// ── svc_particle (18) ───────────────────────────────────────────────────────
// WinQuake: origin is 3× ReadCoord, direction is 3× ReadChar × (1/16).

/**
 * Parses WinQuake svc_particle with legacy coords and signed-char direction.
 */
function handleLegacyParticle() {
  const org = readLegacyCoordVector();
  // WinQuake direction: 3× signed char × (1/16)
  const dir = new Vector(
    NET.message.readChar() * 0.0625,
    NET.message.readChar() * 0.0625,
    NET.message.readChar() * 0.0625,
  );
  const msgcount = NET.message.readByte();
  const color = NET.message.readByte();

  if (msgcount === 255) {
    R.ParticleExplosion(org);
  } else {
    R.RunParticleEffect(org, dir, color, msgcount);
  }
}

// ── svc_temp_entity (23) ────────────────────────────────────────────────────

/**
 * Parses a beam entity from the message buffer.
 * @param {BaseModel | null | undefined} model beam model to use
 */
function parseLegacyBeam(model: BaseModel | null | undefined): void {
  const ent = NET.message.readShort();
  const start = readLegacyCoordVector();
  const end = readLegacyCoordVector();

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

  Con.Print('beam list overflow!\n');
}

/**
 * Parses a WinQuake svc_temp_entity with legacy coordinate precision.
 */
function handleLegacyTempEntity() {
  const type = NET.message.readByte() as Protocol.te;
  console.assert(Object.values(Protocol.te).includes(type), `invalid temp entity type ${type}`);

  switch (type) {
    case Protocol.te.lightning1:
      parseLegacyBeam(CL.state.clientEntities.tempEntityModels['progs/bolt.mdl']);
      return;
    case Protocol.te.lightning2:
      parseLegacyBeam(CL.state.clientEntities.tempEntityModels['progs/bolt2.mdl']);
      return;
    case Protocol.te.lightning3:
      parseLegacyBeam(CL.state.clientEntities.tempEntityModels['progs/bolt3.mdl']);
      return;
    case Protocol.te.beam:
      parseLegacyBeam(CL.state.clientEntities.tempEntityModels['progs/beam.mdl']);
      return;
  }

  const pos = readLegacyCoordVector();
  const sounds = CL.state.clientEntities.tempEntitySounds;

  switch (type) {
    case Protocol.te.wizspike:
      R.RunParticleEffect(pos, Vector.origin, 20, 20);
      if (sounds.wizhit !== null) {
        S.StartSound(-1, 0, sounds.wizhit, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.knightspike:
      R.RunParticleEffect(pos, Vector.origin, 226, 20);
      if (sounds.knighthit !== null) {
        S.StartSound(-1, 0, sounds.knighthit, pos, 1.0, 1.0);
      }
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
      if (sounds.explosion !== null) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
    }
      return;
    case Protocol.te.tarexplosion:
      R.BlobExplosion(pos);
      if (sounds.explosion !== null) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
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
      if (sounds.explosion !== null) {
        S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
      return;
    }
    default:
      throw new Error(`CL.ParseTEnt: bad type ${type}`);
  }

}

// ── svc_spawnstaticsound (29) ───────────────────────────────────────────────

/**
 * Parses WinQuake svc_spawnstaticsound with legacy coordinate precision.
 */
function handleLegacySpawnStaticSound() {
  const org = readLegacyCoordVector();
  const soundId = NET.message.readByte();
  const vol = NET.message.readByte();
  const attn = NET.message.readByte();
  const sound = CL.state.sound_precache[soundId];
  if (sound) {
    S.StaticSound(sound, org, vol / 255.0, attn);
  }
}

// ── svc_killedmonster / svc_foundsecret / svc_updatestat ────────────────────
// Legacy versions without gameCapabilities assertions (not available during
// demo playback).

/**
 * Increments the monster kill statistic (no gameCapabilities check for legacy demos).
 */
function handleLegacyKilledMonster() {
  CL.state.stats[Def.stat.monsters]++;
}

/**
 * Increments the secret discovery statistic (no gameCapabilities check for legacy demos).
 */
function handleLegacyFoundSecret() {
  CL.state.stats[Def.stat.secrets]++;
}

/**
 * Updates an individual HUD statistic entry (no gameCapabilities check for legacy demos).
 */
function handleLegacyUpdateStat() {
  const index = NET.message.readByte();
  CL.state.stats[index] = NET.message.readLong();
}

// ── Handler Table ───────────────────────────────────────────────────────────
// Only WinQuake svc commands (0–34).  QuakeShack-only opcodes (≥101) are
// omitted because a WinQuake demo will never emit them.

export const legacyServerCommandHandlers: Partial<Record<number, () => void>> = {
  [Protocol.svc.nop]: handleNop,
  [Protocol.svc.time]: handleTime,
  [Protocol.svc.clientdata]: handleLegacyClientData,
  [Protocol.svc.version]: handleLegacyVersion,
  [Protocol.svc.disconnect]: handleLegacyDisconnect,
  [Protocol.svc.print]: handlePrint,
  [Protocol.svc.centerprint]: handleCenterPrint,
  [Protocol.svc.stufftext]: handleStuffText,
  [Protocol.svc.damage]: handleLegacyDamage,
  [Protocol.svc.serverdata]: handleLegacyServerData,
  [Protocol.svc.setangle]: handleLegacySetAngle,
  [Protocol.svc.setview]: handleSetView,
  [Protocol.svc.lightstyle]: handleLightStyle,
  [Protocol.svc.sound]: handleLegacySound,
  [Protocol.svc.stopsound]: handleStopSound,
  [Protocol.svc.updatename]: handleUpdateName,
  [Protocol.svc.updatefrags]: handleUpdateFrags,
  [Protocol.svc.updatecolors]: handleUpdateColors,
  [Protocol.svc.particle]: handleLegacyParticle,
  [Protocol.svc.spawnbaseline]: handleLegacySpawnBaseline,
  [Protocol.svc.spawnstatic]: handleLegacySpawnStatic,
  [Protocol.svc.temp_entity]: handleLegacyTempEntity,
  [Protocol.svc.setpause]: handleSetPause,
  [Protocol.svc.signonnum]: handleSignonNum,
  [Protocol.svc.killedmonster]: handleLegacyKilledMonster,
  [Protocol.svc.foundsecret]: handleLegacyFoundSecret,
  [Protocol.svc.updatestat]: handleLegacyUpdateStat,
  [Protocol.svc.spawnstaticsound]: handleLegacySpawnStaticSound,
  [Protocol.svc.cdtrack]: handleCdTrack,
  [Protocol.svc.intermission]: handleIntermission,
  [Protocol.svc.finale]: handleFinale,
  [Protocol.svc.cutscene]: handleCutscene,
  [Protocol.svc.sellscreen]: handleSellScreen,
};
