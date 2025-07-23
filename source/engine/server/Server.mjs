import Cvar from '../common/Cvar.mjs';
import { DIST_EPSILON, MoveVars, Pmove, STEPSIZE } from '../common/Pmove.mjs';
import Vector from '../../shared/Vector.mjs';
import MSG, { SzBuffer } from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from './../common/Def.mjs';
import Cmd from '../common/Cmd.mjs';
import Q from '../common/Q.mjs';
import { ED, ServerEdict } from './Edict.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import * as Defs from '../../shared/Defs.mjs';

let { COM, Con, Host, Mod, NET, PR, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  NET = registry.NET;
  PR = registry.PR;
  V = registry.V;
});

/** @typedef {import('./Client.mjs').ServerClient} ServerClient */

const SV = {};

export default SV;

SV.movetype = {
  none: 0,
  anglenoclip: 1,
  angleclip: 2,
  walk: 3,
  step: 4,
  fly: 5,
  toss: 6,
  push: 7,
  noclip: 8,
  flymissile: 9,
  bounce: 10,
};

SV.solid = {
  not: 0,
  trigger: 1,
  bbox: 2,
  slidebox: 3,
  bsp: 4,
};

SV.damage = {
  no: 0,
  yes: 1,
  aim: 2,
};

SV.fl = {
  fly: 1,
  swim: 2,
  conveyor: 4,
  client: 8,
  inwater: 16,
  monster: 32,
  godmode: 64,
  notarget: 128,
  item: 256,
  onground: 512,
  partialground: 1024,
  waterjump: 2048,
  jumpreleased: 4096,
};

// main

SV.server = {
  num_edicts: 0,
  datagram: new SzBuffer(4096, 'SV.server.datagram'),
  reliable_datagram: new SzBuffer(4096, 'SV.server.reliable_datagram'),
  /** sent during client prespawn */
  signon: new SzBuffer(4096, 'SV.server.signon'),
  edicts: [],
  mapname: null,
  worldmodel: null,
};

export class ServerEntityState {
  constructor(num = null) {
    this.num = num;
    this.flags = 0;
    this.origin = new Vector();
    this.angles = new Vector();
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0;
    this.free = false;
    this.classname = null;
    this.mins = new Vector();
    this.maxs = new Vector();
  }

  set(other) {
    this.num = other.num;
    this.flags = other.flags;
    this.origin.set(other.origin);
    this.angles.set(other.angles);
    this.modelindex = other.modelindex;
    this.frame = other.frame;
    this.colormap = other.colormap;
    this.skin = other.skin;
    this.effects = other.effects;
    this.solid = other.solid;
    this.free = other.free;
    this.classname = other.classname;
    this.mins.set(other.mins);
    this.maxs.set(other.maxs);
  }
};

SV.EntityState = ServerEntityState;

SV.svs = {};

/**
 * Simple class hooking up all movevars with corresponding cvars.
 */
class PlayerMoveCvars extends MoveVars {
  // @ts-ignore
  get gravity() { return SV.gravity.value; }
  // @ts-ignore
  get stopspeed() { return SV.stopspeed.value; }
  // @ts-ignore
  get maxspeed() { return SV.maxspeed.value; }
  // @ts-ignore
  get spectatormaxspeed() { return SV.spectatormaxspeed.value; }
  // @ts-ignore
  get accelerate() { return SV.accelerate.value; }
  // @ts-ignore
  get airaccelerate() { return SV.airaccelerate.value; }
  // @ts-ignore
  get wateraccelerate() { return SV.wateraccelerate.value; }
  // @ts-ignore
  get friction() { return SV.friction.value; }
  // @ts-ignore
  get waterfriction() { return SV.waterfriction.value; }

  set gravity(_value) { }
  set stopspeed(_value) { }
  set maxspeed(_value) { }
  set spectatormaxspeed(_value) { }
  set accelerate(_value) { }
  set airaccelerate(_value) { }
  set wateraccelerate(_value) { }
  set friction(_value) { }
  set waterfriction(_value) { }

  /**
   * Writes the movevars to the client.
   * @param {*} message message stream
   */
  sendToClient(message) {
    MSG.WriteFloat(message, this.gravity);
    MSG.WriteFloat(message, this.stopspeed);
    MSG.WriteFloat(message, this.maxspeed);
    MSG.WriteFloat(message, this.spectatormaxspeed);
    MSG.WriteFloat(message, this.accelerate);
    MSG.WriteFloat(message, this.airaccelerate);
    MSG.WriteFloat(message, this.wateraccelerate);
    MSG.WriteFloat(message, this.friction);
    MSG.WriteFloat(message, this.waterfriction);
    MSG.WriteFloat(message, this.entgravity);
  }

  // CR: leaving out entgravity, it’s entity specific
};

/** @type {?Pmove} */
SV.pmove = null;

SV.InitPmove = function() {
  SV.pmove = new Pmove();
  SV.pmove.movevars = new PlayerMoveCvars();
};

SV.Init = function() {
  SV.maxvelocity = new Cvar('sv_maxvelocity', '2000');
  SV.edgefriction = new Cvar('edgefriction', '2');
  SV.stopspeed = new Cvar('sv_stopspeed', '100');
  SV.accelerate = new Cvar('sv_accelerate', '10');
  SV.idealpitchscale = new Cvar('sv_idealpitchscale', '0.8');
  SV.aim = new Cvar('sv_aim', '0.93');
  SV.nostep = new Cvar('sv_nostep', '0');
  SV.cheats = new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
  SV.gravity = new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER);
  SV.friction = new Cvar('sv_friction', '4', Cvar.FLAG.SERVER);
  SV.maxspeed = new Cvar('sv_maxspeed', '320', Cvar.FLAG.SERVER);
  SV.airaccelerate = new Cvar('sv_airaccelerate', '0.7');
  SV.wateraccelerate = new Cvar('sv_wateraccelerate', '10');
  SV.spectatormaxspeed = new Cvar('sv_spectatormaxspeed', '500');
  SV.waterfriction = new Cvar('sv_waterfriction', '4');
  SV.rcon_password = new Cvar('sv_rcon_password', '', Cvar.FLAG.ARCHIVE);

  eventBus.subscribe('cvar.changed', (name) => {
    const cvar = Cvar.FindVar(name);

    if ((cvar.flags & Cvar.FLAG.SERVER) && SV.server.active) {
      SV.CvarChanged(cvar);
    }
  });

  // TODO: we need to observe changes to those pmove vars and resend them to all clients when changed

  SV.InitPmove();

  // SV.nop = new SzBuffer(4);
  // SV.cursize = 1;
  // MSG.WriteByte(SV.nop, Protocol.svc.nop);

  SV.InitBoxHull(); // pmove, remove
};

SV._scheduledGameCommands = [];

SV.RunScheduledGameCommands = function() {
  while (SV._scheduledGameCommands.length > 0) {
    const command = SV._scheduledGameCommands.shift();

    command();
  }
};

/**
 * Schedules a command to be run during the next server frame.
 * @param {Function} command to be executed command
 */
SV.ScheduleGameCommand = function(command) {
  SV._scheduledGameCommands.push(command);
};

SV.StartParticle = function(org, dir, color, count) {
  const datagram = SV.server.datagram;
  if (datagram.cursize >= 1009) {
    return;
  }
  MSG.WriteByte(datagram, Protocol.svc.particle);
  MSG.WriteCoord(datagram, org[0]);
  MSG.WriteCoord(datagram, org[1]);
  MSG.WriteCoord(datagram, org[2]);
  let i; let v;
  for (i = 0; i <= 2; ++i) {
    v = (dir[i] * 16.0) >> 0;
    if (v > 127) {
      v = 127;
    } else if (v < -128) {
      v = -128;
    }
    MSG.WriteChar(datagram, v);
  }
  MSG.WriteByte(datagram, Math.min(count, 255));
  MSG.WriteByte(datagram, color);
};

SV.StartSound = function(edict, channel, sample, volume, attenuation) {
  console.assert(volume >= 0 && volume <= 255, 'volume out of range', volume);
  console.assert(attenuation >= 0.0 && attenuation <= 4.0, 'attenuation out of range', attenuation);
  console.assert(channel >= 0 && channel <= 7, 'channel out of range', channel);

  const datagram = SV.server.datagram;
  if (datagram.cursize >= 1009) {
    return;
  }

  let i;
  for (i = 1; i < SV.server.sound_precache.length; ++i) {
    if (sample === SV.server.sound_precache[i]) {
      break;
    }
  }
  if (i >= SV.server.sound_precache.length) {
    Con.Print('SV.StartSound: ' + sample + ' was not precached\n');
    SV.server.sound_precache.push(sample);
    MSG.WriteByte(datagram, Protocol.svc.loadsound);
    MSG.WriteByte(datagram, i);
    MSG.WriteString(datagram, sample);
  }

  let field_mask = 0;
  if (volume !== 255) {
    field_mask += 1;
  }
  if (attenuation !== 1.0) {
    field_mask += 2;
  }

  MSG.WriteByte(datagram, Protocol.svc.sound);
  MSG.WriteByte(datagram, field_mask);
  if ((field_mask & 1) !== 0) {
    MSG.WriteByte(datagram, volume);
  }
  if ((field_mask & 2) !== 0) {
    MSG.WriteByte(datagram, Math.floor(attenuation * 64.0));
  }
  MSG.WriteShort(datagram, (edict.num << 3) + channel);
  MSG.WriteByte(datagram, i);
  MSG.WriteCoordVector(datagram, edict.entity.origin.copy().add(edict.entity.mins.copy().add(edict.entity.maxs).multiply(0.5)));
};

/**
 * Sends the server info to the client when connecting.
 * @param {ServerClient} client client
 */
SV.SendServerData = function(client) {
  const message = client.message;

  // first message is always a print message, this is safe to do no matter what version is running
  MSG.WriteByte(message, Protocol.svc.print);
  MSG.WriteString(message, `\x02\nVERSION ${Def.version} SERVER (${SV.server.gameVersion})\n`);

  MSG.WriteByte(message, Protocol.svc.serverdata);
  MSG.WriteByte(message, Protocol.version);

  // if QuakeJS is providing a client game API, we need to send the identification
  if (PR.QuakeJS?.ClientGameAPI) {
    const { author, name, version } = PR.QuakeJS.identification;
    MSG.WriteByte(message, 1);
    MSG.WriteString(message, name);
    MSG.WriteString(message, author);
    MSG.WriteByte(message, version[0]);
    MSG.WriteByte(message, version[1]);
    MSG.WriteByte(message, version[2]);
  } else {
    // if we are in legacy mode, we do not need to send much here
    MSG.WriteByte(message, 0);
  }

  MSG.WriteByte(message, SV.svs.maxclients);
  MSG.WriteByte(message, ((Host.coop.value === 0) && (Host.deathmatch.value !== 0)) ? 1 : 0); // gametype (1 deathmatch, 0 coop/singleplayer)
  MSG.WriteString(message, SV.server.edicts[0].entity.message || SV.server.mapname); // levelname
  // @ts-ignore
  SV.pmove.movevars.sendToClient(message);
  for (let i = 1; i < SV.server.model_precache.length; ++i) {
    MSG.WriteString(message, SV.server.model_precache[i]);
  }
  MSG.WriteByte(message, 0);
  for (let i = 1; i < SV.server.sound_precache.length; ++i) {
    MSG.WriteString(message, SV.server.sound_precache[i]);
  }
  MSG.WriteByte(message, 0);

  MSG.WriteByte(message, Protocol.svc.cdtrack);
  MSG.WriteByte(message, SV.server.edicts[0].entity.sounds);
  MSG.WriteByte(message, SV.server.edicts[0].entity.sounds);

  MSG.WriteByte(message, Protocol.svc.setview);
  MSG.WriteShort(message, client.edict.num);

  const serverCvars = Array.from(Cvar.Filter((cvar) => (cvar.flags & Cvar.FLAG.SERVER) !== 0));
  if (serverCvars.length > 0) {
    MSG.WriteByte(client.message, Protocol.svc.cvar);
    MSG.WriteByte(client.message, serverCvars.length);
    for (const serverCvar of serverCvars) {
      SV.WriteCvar(client.message, serverCvar);
    }
  }

  MSG.WriteByte(message, Protocol.svc.signonnum);
  MSG.WriteByte(message, 1);

  client.sendsignon = true;
  client.spawned = false;
};

SV.ConnectClient = function(client, netconnection) {
  Con.DPrint('Client ' + netconnection.address + ' connected\n');

  const spawn_parms = new Array(client.spawn_parms.length);
  if (SV.server.loadgame) {
    for (let i = 0; i < client.spawn_parms.length; i++) {
      spawn_parms[i] = client.spawn_parms[i];
    }
  }

  client.clear();
  client.name = 'unconnected';
  client.netconnection = netconnection;
  client.active = true;

  if (SV.server.loadgame) {
    for (let i = 0; i < client.spawn_parms.length; i++) {
      client.spawn_parms[i] = spawn_parms[i];
    }
  } else {
    SV.server.gameAPI.SetNewParms(client.edict);
    for (let i = 0; i < client.spawn_parms.length; i++) {
      client.spawn_parms[i] = SV.server.gameAPI[`parm${i + 1}`];
    }
  }

  SV.SendServerData(client);
};

SV.fatpvs = [];

SV.CheckForNewClients = function() {
  let ret; let i;
  for (;;) {
    ret = NET.CheckNewConnections();
    if (!ret) {
      return;
    }
    for (i = 0; i < SV.svs.maxclients; ++i) {
      if (!SV.svs.clients[i].active) {
        break;
      }
    }
    if (i === SV.svs.maxclients) {
      Con.Print('SV.CheckForNewClients: Server is full\n');
      const message = new SzBuffer(32);
      MSG.WriteByte(message, Protocol.svc.disconnect);
      MSG.WriteString(message, 'Server is full');
      NET.SendUnreliableMessage(ret, message);
      NET.Close(ret);
      return;
    }
    SV.ConnectClient(SV.svs.clients[i], ret);
    NET.activeconnections++;
  }
};

SV.AddToFatPVS = function(org, node) {
  let pvs; let i; let normal; let d;
  for (;;) {
    if (node.contents < 0) {
      if (node.contents !== Mod.contents.solid) {
        pvs = Mod.LeafPVS(node, SV.server.worldmodel);
        for (i = 0; i < SV.fatbytes; ++i) {
          SV.fatpvs[i] |= pvs[i];
        }
      }
      return;
    }
    normal = node.plane.normal;
    d = org.dot(normal) - node.plane.dist;
    if (d > 8.0) {
      node = node.children[0];
    } else {
      if (d >= -8.0) {
        SV.AddToFatPVS(org, node.children[0]);
      }
      node = node.children[1];
    }
  }
};

SV.FatPVS = function(org) {
  SV.fatbytes = (SV.server.worldmodel.leafs.length + 31) >> 3;
  let i;
  for (i = 0; i < SV.fatbytes; ++i) {
    SV.fatpvs[i] = 0;
  }
  SV.AddToFatPVS(org, SV.server.worldmodel.nodes[0]);
  return SV.fatpvs;
};

/**
 * Traverses all entities in the PVS of the given origin.
 * @param {Uint8Array} pvs PVS to check against
 * @param {number[]} ignoreEdictIds edict ids to ignore
 * @param {number[]} alwaysIncludeEdictIds edict ids to always yield
 * @param {boolean} includeFree whether to include free edicts
 * @yields {ServerEdict} edict
 */
SV.TraversePVS = function*(pvs, ignoreEdictIds = [], alwaysIncludeEdictIds = [], includeFree = false) {
  for (let e = 1; e < SV.server.num_edicts; e++) {
    const ent = SV.server.edicts[e];

    // requested to always include this edict
    if (alwaysIncludeEdictIds.includes(e)) {
      yield ent;
      continue;
    }

    // not active
    if (!includeFree && ent.isFree()) {
      continue;
    }

    // ignore this
    if (ignoreEdictIds.includes(e)) {
      continue;
    }

    // ignore if not touching a PV leaf
    if (!ent.isInPVS(pvs)) {
      continue;
    }

    yield ent;
  }
};

SV.nullcmd = new Protocol.UserCmd();

SV.WritePlayersToClient = function(clent, pvs, msg) {
  let changes = false;

  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const cl = SV.svs.clients[i];
    const playerEntity = cl.edict.entity;

    // ignore unspawned clients
    if (!cl.spawned) {
      continue;
    }

    // only write players that are visible to the client right now
    if (!clent.equals(cl.edict) && !clent.isInPVS(pvs)) {
      continue;
    }

    let pflags = Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND;

    // FIXME: we should have this more flexible?
    if (playerEntity.model !== 'progs/player.mdl') {
      pflags |= Protocol.pf.PF_MODEL;
    }

    if (!playerEntity.velocity.isOrigin()) {
      pflags |= Protocol.pf.PF_VELOCITY;
    }

    if (playerEntity.effects) {
      pflags |= Protocol.pf.PF_EFFECTS;
    }

    if (playerEntity.skin) {
      pflags |= Protocol.pf.PF_SKINNUM;
    }

    if (playerEntity.health <= 0) {
      pflags |= Protocol.pf.PF_DEAD;
    }

    if (clent.equals(cl.edict)) {
      pflags &= ~(Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND);

      if (playerEntity.weaponframe) {
        pflags |= Protocol.pf.PF_WEAPONFRAME;
      }
    }

    MSG.WriteByte(msg, Protocol.svc.playerinfo);
    MSG.WriteByte(msg, i);
    MSG.WriteShort(msg, pflags);

    MSG.WriteCoordVector(msg, playerEntity.origin);
    MSG.WriteByte(msg, playerEntity.frame);

    if (pflags & Protocol.pf.PF_MSEC) {
      const msec = 1000 * (SV.server.time - cl.last_update); // FIXME: right value?
      MSG.WriteByte(msg, Math.max(0, Math.min(msec, 255)));
    }

    if (pflags & Protocol.pf.PF_COMMAND) {
      /** @type {Protocol.UserCmd} */
      const cmd = cl.cmd;

      if (pflags & Protocol.pf.PF_DEAD) {
        cmd.angles.setTo(0, playerEntity.angles[1], 0);
      }

      cmd.buttons = 0; // never send buttons
      cmd.impulse = 0; // never send impulses

      MSG.WriteDeltaUsercmd(msg, SV.nullcmd, cmd);
    }

    if (pflags & Protocol.pf.PF_VELOCITY) {
      MSG.WriteCoordVector(msg, playerEntity.velocity);
    }

    if (pflags & Protocol.pf.PF_MODEL) {
      MSG.WriteByte(msg, playerEntity.modelindex);
    }

    if (pflags & Protocol.pf.PF_EFFECTS) {
      MSG.WriteByte(msg, playerEntity.effects);
    }

    if (pflags & Protocol.pf.PF_SKINNUM) {
      MSG.WriteByte(msg, playerEntity.skin);
    }

    if (pflags & Protocol.pf.PF_WEAPONFRAME) {
      MSG.WriteByte(msg, playerEntity.weaponframe);
    }

    changes = true;
  }

  return changes;
};

/**
 * Writes a delta entity to the message stream.
 * @param {SzBuffer} msg message stream
 * @param {ServerEntityState} from last known state
 * @param {ServerEntityState} to new state
 * @returns {boolean} true, when to differs from from
 */
SV.WriteDeltaEntity = function(msg, from, to) {
  const EPSILON = 0.1;

  let bits = 0;

  // TODO: also ask the entity is it has a corresponding client entity
  if (from.classname !== to.classname) {
    bits |= Protocol.u.classname;
  }

  if (from.free !== to.free) {
    bits |= Protocol.u.free;
  }

  if (from.modelindex !== to.modelindex) {
    bits |= Protocol.u.model;
  }

  if (from.frame !== to.frame) {
    bits |= Protocol.u.frame;
  }

  // not all entities have colormap as a property
  if ((from.colormap || 0) !== (to.colormap || 0)) {
    bits |= Protocol.u.colormap;
  }

  if (from.skin !== to.skin) {
    bits |= Protocol.u.skin;
  }

  if (from.effects !== to.effects) {
    bits |= Protocol.u.effects;
  }

  if (from.solid !== to.solid) {
    bits |= Protocol.u.solid;
  }

  for (let i = 0; i < 3; i++) {
    if (Math.abs(from.origin[i] - to.origin[i]) > EPSILON) {
      bits |= Protocol.u.origin1 << i;
    }

    if (Math.abs(from.angles[i] - to.angles[i]) > 0.0) { // no epsilon check for angles?
      bits |= Protocol.u.angle1 << i;
    }
  }

  if (!from.maxs.equals(to.maxs)) {
    bits |= Protocol.u.size;
  }

  if (!from.mins.equals(to.mins)) {
    bits |= Protocol.u.size;
  }

  console.assert(to.num > 0, 'valid entity num', to.num);

  MSG.WriteShort(msg, to.num);
  MSG.WriteShort(msg, bits);

  if (bits & Protocol.u.classname) {
    MSG.WriteString(msg, to.classname);
  }

  if (bits & Protocol.u.free) {
    MSG.WriteByte(msg, to.free ? 1 : 0);
  }

  if (bits & Protocol.u.model) {
    MSG.WriteByte(msg, to.modelindex);
  }

  if (bits & Protocol.u.frame) {
    MSG.WriteByte(msg, to.frame);
  }

  if (bits & Protocol.u.colormap) {
    MSG.WriteByte(msg, to.colormap);
  }

  if (bits & Protocol.u.skin) {
    MSG.WriteByte(msg, to.skin);
  }

  if (bits & Protocol.u.effects) {
    MSG.WriteByte(msg, to.effects);
  }

  if (bits & Protocol.u.solid) {
    MSG.WriteByte(msg, to.solid);
  }

  for (let i = 0; i < 3; i++) {
    if (bits & (Protocol.u.origin1 << i)) {
      MSG.WriteCoord(msg, to.origin[i]);
    }

    if (bits & (Protocol.u.angle1 << i)) {
      MSG.WriteAngle(msg, to.angles[i]);
    }
  }

  if (bits & Protocol.u.size) {
    MSG.WriteCoordVector(msg, to.maxs);
    MSG.WriteCoordVector(msg, to.mins);
  }

  return true;
};

/**
 * Encodes the current state of the world as
 * a svc_packetentities messages and possibly
 * a svc_nails message and
 * svc_playerinfo messages
 * @param {ServerEdict} clientEdict client edict
 * @param {SzBuffer} msg message stream
 * @returns {boolean} true, when there were changes written to the message
 */
SV.WriteEntitiesToClient = function(clientEdict, msg) {
  const origin = clientEdict.entity.origin.copy().add(clientEdict.entity.view_ofs);
  const pvs = SV.FatPVS(origin);

  let changes = SV.WritePlayersToClient(clientEdict, pvs, msg) ? 1 : 0;

  /** @type {ServerClient} */
  const cl = SV.svs.clients[clientEdict.num - 1];

  MSG.WriteByte(msg, Protocol.svc.deltapacketentities);

  const visedicts = [];

  for (const ent of SV.TraversePVS(pvs, [], [clientEdict.num])) {
    if ((msg.data.byteLength - msg.cursize) < 16) {
      Con.PrintWarning('SV.WriteEntitiesToClient: packet overflow, not writing more entities\n');
      break;
    }

    const toState = new SV.EntityState(ent.num);
    toState.classname = ent.entity.classname;
    toState.modelindex = ent.entity.model ? ent.entity.modelindex : 0;
    toState.frame = ent.entity.frame;
    toState.colormap = ent.entity.colormap;
    toState.skin = ent.entity.skin;
    toState.solid = ent.entity.solid;
    toState.origin.set(ent.entity.origin);
    toState.angles.set(ent.entity.angles);
    toState.effects = ent.entity.effects;
    toState.free = false;
    toState.maxs.set(ent.entity.maxs);
    toState.mins.set(ent.entity.mins);

    /** @type {ServerEntityState} */
    const fromState = cl.getEntityState(ent.num);

    changes |= SV.WriteDeltaEntity(msg, fromState, toState) ? 1 : 0;

    // TODO: wait for a confirmation by the client
    fromState.set(toState);

    visedicts.push(ent.num);
  }

  // pretent all other entities are free
  for (let i = 1; i < SV.server.num_edicts; ++i) {
    const ent = SV.server.edicts[i];

    if (visedicts.includes(ent.num)) {
      // visible and already written
      continue;
    }

    /** @type {ServerEntityState} */
    const fromState = cl.getEntityState(ent.num);
    const toState = new SV.EntityState(ent.num);
    toState.free = true;

    changes |= SV.WriteDeltaEntity(msg, fromState, toState) ? 1 : 0;

    // TODO: wait for a confirmation by the client
    fromState.set(toState);
  }

  MSG.WriteShort(msg, 0); // end of list

  return changes > 0;
};

/**
 * @param {ServerEdict} clientEdict client edict
 * @param {SzBuffer} msg message stream
 * @returns {boolean} true, when there were changes written to the message
 */
SV.WriteClientdataToMessage = function(clientEdict, msg) {
  // FIXME: there is too much hard wired stuff happening here
  // FIXME: interfaces, edict, entity
  if ((clientEdict.entity.dmg_take || clientEdict.entity.dmg_save) && clientEdict.entity.dmg_inflictor) {
    const other = clientEdict.entity.dmg_inflictor.edict ? clientEdict.entity.dmg_inflictor.edict : clientEdict.entity.dmg_inflictor; // FIXME: ServerEdict vs BaseEntity
    const vec = !other.isFree() ? other.entity.origin.copy().add(other.entity.mins.copy().add(other.entity.maxs).multiply(0.5)) : clientEdict.entity.origin;
    MSG.WriteByte(msg, Protocol.svc.damage);
    MSG.WriteByte(msg, Math.min(255, clientEdict.entity.dmg_save));
    MSG.WriteByte(msg, Math.min(255, clientEdict.entity.dmg_take));
    MSG.WriteCoordVector(msg, vec);
    clientEdict.entity.dmg_take = 0.0;
    clientEdict.entity.dmg_save = 0.0;
  }

  // SV.SetIdealPitch(); // CR: remove this? QuakeWorld is not doing it

  if (clientEdict.entity.fixangle) {
    MSG.WriteByte(msg, Protocol.svc.setangle);
    MSG.WriteAngleVector(msg, clientEdict.entity.angles);
    clientEdict.entity.fixangle = false;
  };

  // DELETE ALL FROM UP HERE

  let bits = Protocol.su.items + Protocol.su.weapon;
  if (clientEdict.entity.view_ofs[2] !== Protocol.default_viewheight) {
    bits += Protocol.su.viewheight;
  }
  if (clientEdict.entity.idealpitch !== 0.0) {
    bits += Protocol.su.idealpitch;
  }

  let items;
  if (clientEdict.entity.items2 !== undefined) {
    if (clientEdict.entity.items2 !== 0.0) {
      items = (clientEdict.entity.items >> 0) + ((clientEdict.entity.items2 << 23) >>> 0);
    } else {
      items = (clientEdict.entity.items >> 0) + ((SV.server.gameAPI.serverflags << 28) >>> 0);
    }
  } else {
    items = (clientEdict.entity.items >> 0) + ((SV.server.gameAPI.serverflags << 28) >>> 0);
  }

  if (clientEdict.entity.flags & SV.fl.onground) {
    bits += Protocol.su.onground;
  }
  if (clientEdict.entity.waterlevel >= 2.0) {
    bits += Protocol.su.inwater;
  }

  const velo = clientEdict.entity.velocity, punchangle = clientEdict.entity.punchangle;

  if (punchangle[0] !== 0.0) {
    bits += Protocol.su.punch1;
  }
  if (velo[0] !== 0.0) {
    bits += Protocol.su.velocity1;
  }
  if (punchangle[1] !== 0.0) {
    bits += Protocol.su.punch2;
  }
  if (velo[1] !== 0.0) {
    bits += Protocol.su.velocity2;
  }
  if (punchangle[2] !== 0.0) {
    bits += Protocol.su.punch3;
  }
  if (velo[2] !== 0.0) {
    bits += Protocol.su.velocity3;
  }

  if (clientEdict.entity.weaponframe !== 0.0) {
    bits += Protocol.su.weaponframe;
  }
  if (clientEdict.entity.armorvalue !== 0.0) {
    bits += Protocol.su.armor;
  }

  MSG.WriteByte(msg, Protocol.svc.clientdata);
  MSG.WriteShort(msg, bits);
  if ((bits & Protocol.su.viewheight) !== 0) {
    MSG.WriteChar(msg, clientEdict.entity.view_ofs[2]);
  }
  if ((bits & Protocol.su.idealpitch) !== 0) {
    MSG.WriteChar(msg, clientEdict.entity.idealpitch);
  }

  if ((bits & Protocol.su.punch1) !== 0) {
    MSG.WriteShort(msg, punchangle[0] * 90);
  }
  if ((bits & Protocol.su.velocity1) !== 0) {
    MSG.WriteShort(msg, velo[0] * 0.0625);
  }
  if ((bits & Protocol.su.punch2) !== 0) {
    MSG.WriteShort(msg, punchangle[1] * 90.0);
  }
  if ((bits & Protocol.su.velocity2) !== 0) {
    MSG.WriteShort(msg, velo[1] * 0.0625);
  }
  if ((bits & Protocol.su.punch3) !== 0) {
    MSG.WriteShort(msg, punchangle[2] * 90.0);
  }
  if ((bits & Protocol.su.velocity3) !== 0) {
    MSG.WriteShort(msg, velo[2] * 0.0625);
  }

  MSG.WriteLong(msg, items);
  if ((bits & Protocol.su.weaponframe) !== 0) {
    MSG.WriteByte(msg, clientEdict.entity.weaponframe);
  }
  if ((bits & Protocol.su.armor) !== 0) {
    MSG.WriteByte(msg, clientEdict.entity.armorvalue);
  }
  MSG.WriteByte(msg, SV.ModelIndex(clientEdict.entity.weaponmodel));
  MSG.WriteShort(msg, clientEdict.entity.health);
  MSG.WriteByte(msg, clientEdict.entity.currentammo);
  MSG.WriteByte(msg, clientEdict.entity.ammo_shells);
  MSG.WriteByte(msg, clientEdict.entity.ammo_nails);
  MSG.WriteByte(msg, clientEdict.entity.ammo_rockets);
  MSG.WriteByte(msg, clientEdict.entity.ammo_cells);
  if (COM.standard_quake === true) {
    MSG.WriteByte(msg, clientEdict.entity.weapon & 0xff);
  } else {
    const weapon = clientEdict.entity.weapon;
    for (let i = 0; i <= 31; i++) {
      if ((weapon & (1 << i)) !== 0) {
        MSG.WriteByte(msg, i);
        break;
      }
    }
  }

  return true; // TODO: changes
};

SV.SendClientDatagram = function() { // FIXME: Host.client
  const client = Host.client;
  const msg = new SzBuffer(2048, 'SV.SendClientDatagram');
  MSG.WriteByte(msg, Protocol.svc.time);
  MSG.WriteFloat(msg, SV.server.time);

  let changes = 0;

  // Send ping times to all clients every second
  if (Host.realtime - client.last_ping_update >= 1) {
    for (let i = 0; i < SV.svs.clients.length; i++) {
      const pingClient = SV.svs.clients[i];

      if (!pingClient.active) {
        continue;
      }

      MSG.WriteByte(msg, Protocol.svc.updatepings);
      MSG.WriteByte(msg, i);
      MSG.WriteShort(msg, Math.max(0, Math.min(Math.round(pingClient.ping * 10), 30000)));

      changes |= 1;
    }

    client.last_ping_update = Host.realtime;
  }

  changes |= SV.WriteClientdataToMessage(client.edict, msg) ? 1 : 0;
  changes |= SV.WriteEntitiesToClient(client.edict, msg) ? 1 : 0;

  if (!changes && client.spawned) {
    // nothing to send
    Con.DPrint('SV.SendClientDatagram: no changes\n');
    return true;
  }

  client.last_update = SV.server.time;

  if ((msg.cursize + SV.server.datagram.cursize) < msg.data.byteLength) {
    msg.write(new Uint8Array(SV.server.datagram.data), SV.server.datagram.cursize);
  }
  // Con.DPrint('SV.SendClientDatagram: sending\n' + msg.toHexString() + '\n');
  if (NET.SendUnreliableMessage(client.netconnection, msg) === -1) {
    Host.DropClient(client, true, 'Connectivity issues');
    return false;
  }
  return true;
};

SV.UpdateToReliableMessages = function() {
  for (let i = 0; i < SV.svs.maxclients; i++) {
    Host.client = SV.svs.clients[i];
    const frags = Host.client.edict.entity ? Host.client.edict.entity.frags | 0 : 0; // force int
    if (Host.client.old_frags === frags) {
      continue;
    }
    for (let j = 0; j < SV.svs.maxclients; j++) {
      const client = SV.svs.clients[j];
      if (!client.active) {
        continue;
      }
      MSG.WriteByte(client.message, Protocol.svc.updatefrags);
      MSG.WriteByte(client.message, i);
      MSG.WriteShort(client.message, frags);
    }
    Host.client.old_frags = frags;
  }

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (client.active) {
      client.message.write(new Uint8Array(SV.server.reliable_datagram.data), SV.server.reliable_datagram.cursize);
    }
  }

  SV.server.reliable_datagram.clear();
};

SV.SendClientMessages = function() {
  SV.UpdateToReliableMessages();
  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i]; // FIXME: Host.client
    Host.client = client;
    if (!client.active) {
      continue;
    }
    if (client.spawned) {
      if (!SV.SendClientDatagram()) {
        continue;
      }
    }
    if (!client.sendsignon) {
      if ((Host.realtime - client.last_message) > 30.0) {
        // if (NET.SendUnreliableMessage(client.netconnection, SV.nop) === -1) {
          Host.DropClient(client, true, 'Connectivity issues');
        // }
        client.last_message = Host.realtime;
      }
      //continue;
    }
    if (client.message.overflowed) {
      Host.DropClient(client, true, 'Connectivity issues, too many messages');
      client.message.overflowed = false;
      continue;
    }
    if (client.dropasap) {
      if (NET.CanSendMessage(client.netconnection)) {
        Host.DropClient(client, false, 'Connectivity issues, ASAP drop requested');
      }
    } else if (client.message.cursize !== 0) {
      if (!NET.CanSendMessage(client.netconnection)) {
        continue;
      }
      if (NET.SendMessage(client.netconnection, client.message) === -1) {
        Host.DropClient(client, true, 'Connectivity issues, failed to send message');
      }
      client.message.clear();
      client.last_message = Host.realtime;
      client.sendsignon = false;
    }
  }

  for (let i = 1; i < SV.server.num_edicts; ++i) {
    if (SV.server.edicts[i].isFree()) {
      continue;
    }

    SV.server.edicts[i].entity.effects &= ~Defs.effect.EF_MUZZLEFLASH;
  }
};

/**
 * Returns the model index of the given model name when precached.
 * @param {string} name model name
 * @returns {number} model index
 */
SV.ModelIndex = function(name) {
  if (!name) {
    return 0;
  }
  for (let i = 0; i < SV.server.model_precache.length; ++i) {
    if (SV.server.model_precache[i] === name) {
      return i;
    }
  }
  console.assert(false, 'model must be precached', name);
  return null;
};

SV.CreateBaseline = function() {
  // CR: baseline is stored in SV.server.signon, currently unused
};

SV.SaveSpawnparms = function() {
  SV.svs.serverflags = SV.server.gameAPI.serverflags;
  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];

    if (!client.active) {
      continue;
    }

    client.saveSpawnparms();
  }
};

SV.HasMap = function(mapname) {
  return Mod.ForName('maps/' + mapname + '.bsp') !== null;
};

/**
 * Resets the server and spawns a new map.
 * This will clear all memory, load the map and spawn the player entities.
 * @param {string} mapname map name
 * @returns {boolean} true, when the server was spawned successfully
 */
SV.SpawnServer = function(mapname) {
  let i;

  if (!NET.hostname.string) {
    NET.hostname.set('UNNAMED');
  }

  eventBus.publish('server.spawning', {
    mapname,
  });

  Con.DPrint('SpawnServer: ' + mapname + '\n');
  SV.svs.changelevel_issued = false;

  if (SV.server.active) {
    const reconnect = new SzBuffer(128);
    reconnect.writeByte(Protocol.svc.changelevel);
    reconnect.writeString(mapname);
    NET.SendToAll(reconnect);
  }

  if (Host.coop.value !== 0) {
    Cvar.SetValue('deathmatch', 0);
  }
  Host.current_skill = Math.floor(Host.skill.value + 0.5);
  if (Host.current_skill < 0) {
    Host.current_skill = 0;
  } else if (Host.current_skill > 3) {
    Host.current_skill = 3;
  }
  Cvar.SetValue('skill', Host.current_skill);

  Con.DPrint('Clearing memory\n');
  Mod.ClearAll();

  SV.server.gameAPI = PR.QuakeJS ? new PR.QuakeJS.ServerGameAPI(ServerEngineAPI) : PR.LoadProgs();
  SV.server.gameVersion = `${(PR.QuakeJS ? `${PR.QuakeJS.identification.version.join('.')} QuakeJS` : `${PR.crc} CRC`)}`;

  SV.server.edicts = [];
  // preallocating up to Def.limits.edicts, we can extend that later during runtime
  for (i = 0; i < Def.limits.edicts; ++i) {
    const ent = new ServerEdict(i);

    SV.server.edicts[i] = ent;
  }
  SV.server.datagram.clear();
  SV.server.reliable_datagram.clear();
  SV.server.signon.clear();
  // hooking up the edicts reserved for clients
  SV.server.num_edicts = SV.svs.maxclients + 1;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    const ent = SV.server.edicts[i + 1];

    // we need to spawn the player entity in those client edict slots
    if (!SV.server.gameAPI.prepareEntity(ent, 'player')) {
      Con.PrintWarning('SV.SpawnServer: Cannot start server, because game does not know what a player entity is.\n');
      SV.server.active = false;
      return false;
    }
  }
  SV.server.loading = true;
  SV.server.paused = false;
  SV.server.loadgame = false;
  SV.server.time = 1.0;
  SV.server.lastcheck = 0;
  SV.server.lastchecktime = 0.0;
  SV.server.mapname = mapname;
  SV.server.worldmodel = Mod.ForName('maps/' + mapname + '.bsp');
  if (SV.server.worldmodel === null) {
    Con.PrintWarning('SV.SpawnServer: Cannot start server, unable to load map ' + mapname + '\n');
    SV.server.active = false;
    return false;
  }

  SV.pmove.setWorldmodel(SV.server.worldmodel);

  SV.server.models = [];
  SV.server.models[1] = SV.server.worldmodel;

  SV.areanodes = [];
  SV.CreateAreaNode(0, SV.server.worldmodel.mins, SV.server.worldmodel.maxs);

  SV.server.sound_precache = [''];
  SV.server.model_precache = ['', SV.server.worldmodel.name];
  for (i = 1; i <= SV.server.worldmodel.submodels.length; ++i) {
    // TODO: do we really need this? (yes we do, PF, CL and Host etc. rely on it)
    //       also each submodule is a brush connected to an entity (doors etc.)
    SV.server.model_precache[i + 1] = '*' + i;
    SV.server.models[i + 1] = Mod.ForName('*' + i);
  }

  SV.server.lightstyles = [];
  for (i = 0; i <= 63; ++i) {
    SV.server.lightstyles[i] = '';
  }

  // init the game
  SV.server.gameAPI.init(mapname, SV.svs.serverflags);

  // edict 0 is reserved for worldspawn
  const ent = SV.server.edicts[0];

  if (!SV.server.gameAPI.prepareEntity(ent, 'worldspawn', {
    model: SV.server.worldmodel.name,
    modelindex: 1,
    solid: SV.solid.bsp,
    movetype: SV.movetype.push,
  })) {
    Con.PrintWarning('SV.SpawnServer: Cannot start server, because the game does not know what a worldspawn entity is.\n');
    SV.server.active = false;
    return false;
  }

  // populate all edicts by the entities file
  ED.LoadFromFile(SV.server.worldmodel.entities);
  SV.server.active = true;
  SV.server.loading = false;
  Host.frametime = 0.1;
  SV.Physics();
  SV.Physics();
  SV.CreateBaseline();
  // sending to all clients that we are on a new map
  for (i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = SV.svs.clients[i];
    if (!Host.client.active) {
      continue;
    }
    SV.SendServerData(Host.client);
  }
  eventBus.publish('server.spawned', {
    mapname,
  });
  Con.PrintSuccess('Server spawned.\n');
  Cmd.ExecuteString('status\n');
  return true;
};

SV.ShutdownServer = function (isCrashShutdown) {
  // tell the game we are shutting down the game
  SV.server.gameAPI.shutdown(isCrashShutdown);

  // make sure all references are dropped
  SV.server.active = false;
  SV.server.loading = false;
  SV.server.worldmodel = null;
  SV.server.gameAPI = null;

  // unlink all edicts from client structures, reset data
  for (const client of SV.svs.clients) {
    client.clear();
  }

  // purge out all edicts
  for (const edict of SV.server.edicts) {
    // explicitly tell entities to free memory
    edict.clear();
    edict.freeEdict();
  }

  SV.server.edicts = [];
  SV.server.num_edicts = 0;

  if (isCrashShutdown) {
    Con.Print('Server shut down due to a crash!\n');
    return;
  }

  Con.Print('Server shut down.\n');
};

/**
 * Sends a cvar update to the message stream.
 * It won’t send the cvar value if it is marked as secret.
 * @param {SzBuffer} msg message stream
 * @param {Cvar} cvar cvar to write
 */
SV.WriteCvar = function(msg, cvar) {
  if (cvar.flags & Cvar.FLAG.SECRET) {
    MSG.WriteString(msg, cvar.name);
    MSG.WriteString(msg, cvar.string ? 'REDACTED' : '');
  } else {
    MSG.WriteString(msg, cvar.name);
    MSG.WriteString(msg, cvar.string);
  }
};

/**
 * Sends a cvar change to all clients.
 * This is used to notify clients about cvar changes.
 * It will write the cvar name and value to the message stream.
 * If the cvar is marked as secret, it will write 'REDACTED' instead of the value.
 * @param {Cvar} cvar cvar change to write
 */
SV.CvarChanged = function(cvar) {
  Con.Print(`"${cvar.name}" changed to "${cvar.string}"\n`);

  for (let i = 0; i < SV.svs.maxclients; i++) {
    const client = SV.svs.clients[i];
    if (!client.active || !client.spawned) {
      continue;
    }

    MSG.WriteByte(client.message, Protocol.svc.cvar);
    MSG.WriteByte(client.message, 1);
    SV.WriteCvar(client.message, cvar);
  }
};

// move

SV.CheckBottom = function(ent) {
  const mins = ent.entity.origin.copy().add(ent.entity.mins);
  const maxs = ent.entity.origin.copy().add(ent.entity.maxs);
  for (;;) {
    if (SV.PointContents(new Vector(mins[0], mins[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(mins[0], maxs[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(maxs[0], mins[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(maxs[0], maxs[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    return true;
  }
  const start = new Vector((mins[0] + maxs[0]) * 0.5, (mins[1] + maxs[1]) * 0.5, mins[2]);
  const stop = new Vector(start[0], start[1], start[2] - 2.0 * STEPSIZE);
  let trace = SV.Move(start, Vector.origin, Vector.origin, stop, SV.move.nomonsters, ent);
  if (trace.fraction === 1.0) {
    return false;
  }
  let bottom = trace.endpos[2];
  const mid = bottom;
  for (let x = 0; x <= 1; ++x) {
    for (let y = 0; y <= 1; ++y) {
      start[0] = stop[0] = (x !== 0) ? maxs[0] : mins[0];
      start[1] = stop[1] = (y !== 0) ? maxs[1] : mins[1];
      trace = SV.Move(start, Vector.origin, Vector.origin, stop, SV.move.nomonsters, ent);
      if ((trace.fraction !== 1.0) && (trace.endpos[2] > bottom)) {
        bottom = trace.endpos[2];
      }
      if ((trace.fraction === 1.0) || ((mid - trace.endpos[2]) > STEPSIZE)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Called by monster program code.
 * The move will be adjusted for slopes and stairs, but if the move isn't
 * possible, no move is done, false is returned, and
 * pr_global_struct->trace_normal is set to the normal of the blocking wall
 * @param {ServerEdict} ent edict/entity trying to move
 * @param {Vector} move move direction
 * @param {boolean} relink if true, it will call SV.LinkEdict
 * @returns {boolean} false, if no move is done
 */
SV.movestep = function(ent, move, relink) { // FIXME: return type = boolean
  const oldorg = ent.entity.origin.copy();
  const mins = ent.entity.mins;
  const maxs = ent.entity.maxs;
  // flying monsters don't step up
  if ((ent.entity.flags & (SV.fl.swim | SV.fl.fly)) !== 0) {
    const enemy = ent.entity.enemy;
    const neworg = new Vector();
    // try one move with vertical motion, then one without
    for (let i = 0; i <= 1; ++i) {
      const origin = ent.entity.origin.copy();
      neworg[0] = origin[0] + move[0];
      neworg[1] = origin[1] + move[1];
      neworg[2] = origin[2];
      if (i === 0 && enemy) {
        const dz = ent.entity.origin[2] - enemy.entity.origin[2];
        if (dz > 40.0) {
          neworg[2] -= 8.0;
        } else if (dz < 30.0) {
          neworg[2] += 8.0;
        }
      }
      const trace = SV.Move(ent.entity.origin, mins, maxs, neworg, SV.move.normal, ent);
      if (trace.fraction === 1.0) {
        if (((ent.entity.flags & SV.fl.swim) !== 0) && (SV.PointContents(trace.endpos) === Mod.contents.empty)) {
          return false; // swim monster left water
        }
        ent.entity.origin = trace.endpos.copy();
        if (relink) {
          SV.LinkEdict(ent, true);
        }
        return true;
      }
      if (!enemy) {
        return false;
      }
    }
    return false;
  }
  // push down from a step height above the wished position
  const neworg = ent.entity.origin.copy();
  neworg[0] += move[0];
  neworg[1] += move[1];
  neworg[2] += STEPSIZE;
  const end = neworg.copy();
  end[2] -= STEPSIZE * 2.0;
  const trace = SV.Move(neworg, mins, maxs, end, SV.move.normal, ent);
  if (trace.allsolid === true) {
    return false;
  }
  if (trace.startsolid === true) {
    neworg[2] -= STEPSIZE;
    const trace = SV.Move(neworg, mins, maxs, end, SV.move.normal, ent);
    if ((trace.allsolid === true) || (trace.startsolid === true)) {
      return false;
    }
  }
  // CR: FIXME: there’s a significant difference from WinQuake’s SV_movestep
  if (trace.fraction === 1.0) {
    // if monster had the ground pulled out, go ahead and fall
    if ((ent.entity.flags & SV.fl.partialground) !== 0) {
      const neworg = ent.entity.origin.copy();
      neworg[0] += move[0];
      neworg[1] += move[1];
      ent.entity.origin = neworg;
      if (relink) {
        SV.LinkEdict(ent, true);
      }
      ent.entity.flags &= (~SV.fl.onground);
      return true;
    }

    return false; // walked off an edge
  }
  ent.entity.origin = trace.endpos.copy();
  if (!SV.CheckBottom(ent)) {
    if ((ent.entity.flags & SV.fl.partialground) !== 0) {
      if (relink) {
        SV.LinkEdict(ent, true);
      }
      return true;
    }
    ent.entity.origin = ent.entity.origin.set(oldorg);
    return false;
  }
  ent.entity.flags &= (~SV.fl.partialground >>> 0);
  ent.entity.groundentity = trace.ent.entity;
  if (relink) {
    SV.LinkEdict(ent, true);
  }
  return true;
};

SV.ChangeYaw = function (ent) { // Edict
  const angle1 = ent.entity.angles[1];
  const current = Vector.anglemod(angle1);
  const ideal = ent.entity.ideal_yaw;

  if (current === ideal) {
    return angle1;
  }

  let move = ideal - current;

  if (ideal > current) {
    if (move >= 180.0) {
      move -= 360.0;
    }
  } else if (move <= -180.0) {
    move += 360.0;
  }

  const speed = ent.entity.yaw_speed;

  if (move > 0.0) {
    if (move > speed) {
      move = speed;
    }
  } else if (move < -speed) {
    move = -speed;
  }

  return Vector.anglemod(current + move);
};

SV.StepDirection = function(ent, yaw, dist) {
  ent.entity.ideal_yaw = yaw;
  ent.entity.angles = new Vector(ent.entity.angles[0], SV.ChangeYaw(ent), ent.entity.angles[2]); // CR: I’m not happy about this line
  yaw *= Math.PI / 180.0;
  const oldorigin = ent.entity.origin.copy();
  if (SV.movestep(ent, new Vector(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0.0), false)) {
    const delta = ent.entity.angles[1] - ent.entity.ideal_yaw;
    if ((delta > 45.0) && (delta < 315.0)) {
      ent.entity.origin = ent.entity.origin.set(oldorigin);
    }
    SV.LinkEdict(ent, true);
    return true;
  }
  SV.LinkEdict(ent, true);
  return false;
};

SV.NewChaseDir = function(actor, enemy, dist) {
  const olddir = Vector.anglemod(((actor.entity.ideal_yaw / 45.0) >> 0) * 45.0);
  const turnaround = Vector.anglemod(olddir - 180.0);
  const deltax = enemy.entity.origin[0] - actor.entity.origin[0];
  const deltay = enemy.entity.origin[1] - actor.entity.origin[1];
  let dx; let dy;
  if (deltax > 10.0) {
    dx = 0.0;
  } else if (deltax < -10.0) {
    dx = 180.0;
  } else {
    dx = -1;
  }
  if (deltay < -10.0) {
    dy = 270.0;
  } else if (deltay > 10.0) {
    dy = 90.0;
  } else {
    dy = -1;
  }
  let tdir;
  if ((dx !== -1) && (dy !== -1)) {
    if (dx === 0.0) {
      tdir = (dy === 90.0) ? 45.0 : 315.0;
    } else {
      tdir = (dy === 90.0) ? 135.0 : 215.0;
    }
    if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
      return;
    }
  }
  if ((Math.random() >= 0.25) || (Math.abs(deltay) > Math.abs(deltax))) {
    tdir = dx;
    dx = dy;
    dy = tdir;
  }
  if ((dx !== -1) && (dx !== turnaround) && SV.StepDirection(actor, dx, dist)) {
    return;
  }
  if ((dy !== -1) && (dy !== turnaround) && SV.StepDirection(actor, dy, dist)) {
    return;
  }
  if ((olddir !== -1) && SV.StepDirection(actor, olddir, dist)) {
    return;
  }
  if (Math.random() >= 0.5) {
    for (tdir = 0.0; tdir <= 315.0; tdir += 45.0) {
      if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
        return;
      }
    }
  } else {
    for (tdir = 315.0; tdir >= 0.0; tdir -= 45.0) {
      if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
        return;
      }
    }
  }
  if ((turnaround !== -1) && SV.StepDirection(actor, turnaround, dist)) {
    return;
  }
  actor.entity.ideal_yaw = olddir;
  if (!SV.CheckBottom(actor)) {
    actor.entity.flags |= SV.fl.partialground;
  }
};

SV.CloseEnough = function(ent, goal, dist) { // Edict
  const absmin = ent.entity.absmin, absmax = ent.entity.absmax;
  const absminGoal = goal.entity.absmin, absmaxGoal = goal.entity.absmax;
  for (let i = 0; i <= 2; ++i) {
    if (absminGoal[i] > (absmax[i] + dist)) {
      return false;
    }
    if (absmaxGoal[i] < (absmin[i] - dist)) {
      return false;
    }
  }
  return true;
};

// phys

SV.CheckAllEnts = function() {
  let e; let check;
  for (e = 1; e < SV.server.num_edicts; ++e) {
    check = SV.server.edicts[e];
    if (check.isFree() === true) {
      continue;
    }
    switch (check.entity.movetype) {
      case SV.movetype.push:
      case SV.movetype.none:
      case SV.movetype.noclip:
        continue;
    }
    if (SV.TestEntityPosition(check) === true) {
      Con.Print('entity in invalid position\n');
    }
  }
};

SV.CheckVelocity = function(ent) {
  const velo = ent.entity.velocity, origin = ent.entity.origin;
  for (let i = 0; i <= 2; ++i) {
    let component = velo[i];
    if (Q.isNaN(component)) {
      Con.Print('Got a NaN velocity on ' + ent.entity.classname + '\n');
      component = 0.0;
    }
    if (Q.isNaN(origin[i])) {
      Con.Print('Got a NaN origin on ' + ent.entity.classname + '\n');
      origin[i] = 0.0;
    }
    if (component > SV.maxvelocity.value) {
      component = SV.maxvelocity.value;
    } else if (component < -SV.maxvelocity.value) {
      component = -SV.maxvelocity.value;
    }
    velo[i] = component;
  }
  ent.entity.origin = ent.entity.origin.set(origin);
  ent.entity.velocity = ent.entity.velocity.set(velo);
};

/**
 * Runs thinking code if time.  There is some play in the exact time the think
 * function will be called, because it is called before any movement is done
 * in a frame.  Not used for pushmove objects, because they must be exact.
 * @param {ServerEdict} ent edict
 * @returns {boolean} whether false when an edict got freed
 */
SV.RunThink = function(ent) {
  // CR: turn into an infinite loop to catch up with all thinks (QW)
  while (true) {
    let thinktime = ent.entity.nextthink;

    if (thinktime <= 0.0 || thinktime > (SV.server.time + Host.frametime)) {
      return true;
    }

    if (thinktime < SV.server.time) {
      // don't let things stay in the past.
      // it is possible to start that way
      // by a trigger with a local time.
      thinktime = SV.server.time;
    }

    ent.entity.nextthink = 0.0;
    SV.server.gameAPI.time = thinktime;
    ent.entity.think(null);

    if (ent.isFree()) {
      return false; // think might have deleted the edict
    }
  }
};

SV.Impact = function(e1, e2) {
  SV.server.gameAPI.time = SV.server.time;

  if (e1.entity.touch && (e1.entity.solid !== SV.solid.not)) {
    e1.entity.touch(e2.entity);
  }
  if (e2.entity.touch && (e2.entity.solid !== SV.solid.not)) {
    e2.entity.touch(e1.entity);
  }
};

SV.ClipVelocity = function(vec, normal, out, overbounce) {
  const backoff = vec.dot(normal) * overbounce;

  out[0] = vec[0] - normal[0] * backoff;
  if ((out[0] > -0.1) && (out[0] < 0.1)) {
    out[0] = 0.0;
  }
  out[1] = vec[1] - normal[1] * backoff;
  if ((out[1] > -0.1) && (out[1] < 0.1)) {
    out[1] = 0.0;
  }
  out[2] = vec[2] - normal[2] * backoff;
  if ((out[2] > -0.1) && (out[2] < 0.1)) {
    out[2] = 0.0;
  }
};

SV.FlyMove = function(ent, time) {
  let bumpcount;
  let numplanes = 0;
  let dir;
  const planes = []; let plane;
  const primal_velocity = ent.entity.velocity;
  let original_velocity = ent.entity.velocity;
  const new_velocity = new Vector();
  let i; let j;
  let time_left = time;
  let blocked = 0;
  for (bumpcount = 0; bumpcount <= 3; ++bumpcount) {
    if (ent.entity.velocity.isOrigin()) {
      break;
    }
    const end = ent.entity.origin.copy().add(ent.entity.velocity.copy().multiply(time_left));
    const trace = SV.Move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, 0, ent);
    if (trace.allsolid === true) {
      ent.entity.velocity = new Vector();
      return 3;
    }
    if (trace.fraction > 0.0) {
      ent.entity.origin = ent.entity.origin.set(trace.endpos);
      original_velocity = ent.entity.velocity.copy();
      numplanes = 0;
      if (trace.fraction === 1.0) {
        break;
      }
    }
    console.assert(trace.ent !== null, 'trace.ent must not be null');
    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1;
      if (trace.ent.entity.solid === SV.solid.bsp) {
        ent.entity.flags |= SV.fl.onground;
        ent.entity.groundentity = trace.ent.entity;
      }
    } else if (trace.plane.normal[2] === 0.0) {
      blocked |= 2;
      SV.steptrace = trace;
    }
    SV.Impact(ent, trace.ent);
    if (ent.isFree()) {
      break;
    }
    time_left -= time_left * trace.fraction;
    if (numplanes >= 5) {
      ent.entity.velocity = new Vector();
      return 3;
    }
    planes[numplanes++] = trace.plane.normal.copy();
    for (i = 0; i < numplanes; ++i) {
      SV.ClipVelocity(original_velocity, planes[i], new_velocity, 1.0);
      for (j = 0; j < numplanes; ++j) {
        if (j !== i) {
          plane = planes[j];
          if ((new_velocity[0] * plane[0] + new_velocity[1] * plane[1] + new_velocity[2] * plane[2]) < 0.0) { // plane is not a Vector
            break;
          }
        }
      }
      if (j === numplanes) {
        break;
      }
    }
    if (i !== numplanes) {
      ent.entity.velocity = new_velocity;
    } else {
      if (numplanes !== 2) {
        ent.entity.velocity = new Vector();
        return 7;
      }
      dir = planes[0].cross(planes[1]);
      // scale the velocity by the dot product of velocity and direction
      ent.entity.velocity = dir.multiply(dir.dot(ent.entity.velocity));
    }
    if (ent.entity.velocity.dot(primal_velocity) <= 0.0) {
      ent.entity.velocity = new Vector();
      return blocked;
    }
  }
  return blocked;
};

SV.AddGravity = function(ent) {
  const ent_gravity = ent.entity.gravity || 1.0;

  const velocity = ent.entity.velocity;
  velocity[2] += ent_gravity * SV.gravity.value * Host.frametime * -1.0;
  ent.entity.velocity = velocity;
};

SV.PushEntity = function(ent, pushVector) {
  const end = ent.entity.origin.copy().add(pushVector);
  let nomonsters;
  const solid = ent.entity.solid;
  if (ent.entity.movetype === SV.movetype.flymissile) {
    nomonsters = SV.move.missile;
  } else if ((solid === SV.solid.trigger) || (solid === SV.solid.not)) {
    nomonsters = SV.move.nomonsters;
  } else {
    nomonsters = SV.move.normal;
  }
  const trace = SV.Move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, nomonsters, ent);
  ent.entity.origin = ent.entity.origin.set(trace.endpos);
  SV.LinkEdict(ent, true);
  if (trace.ent) {
    SV.Impact(ent, trace.ent);
  }
  return trace;
};

SV.PushMove = function(pusher, movetime) {
  if (pusher.entity.velocity.isOrigin()) {
    pusher.entity.ltime += movetime;
    return;
  }
  const move = pusher.entity.velocity.copy().multiply(movetime);
  const mins = pusher.entity.absmin.copy().add(move);
  const maxs = pusher.entity.absmax.copy().add(move);
  const pushorig = pusher.entity.origin.copy().add(move);
  pusher.entity.origin = pushorig;
  pusher.entity.ltime += movetime;
  SV.LinkEdict(pusher);
  let check; let movetype;
  const moved = [];
  for (let e = 1; e < SV.server.num_edicts; ++e) {
    check = SV.server.edicts[e];
    if (check.isFree() === true) {
      continue;
    }
    movetype = check.entity.movetype;
    if ((movetype === SV.movetype.push) ||
			(movetype === SV.movetype.none) ||
			(movetype === SV.movetype.noclip)) {
      continue;
    }
    if (((check.entity.flags & SV.fl.onground) === 0) || !check.entity.groundentity || !check.entity.groundentity.equals(pusher)) {
      if (!check.entity.absmin.lt(maxs) || !check.entity.absmax.gt(mins)) {
        continue;
      }

      if (!SV.TestEntityPosition(check)) {
        continue;
      }
    }
    // remove the onground flag for non-players
    if (movetype !== SV.movetype.walk) {
      check.entity.flags &= ~SV.fl.onground;
    }
    const entorig = check.entity.origin.copy();
    moved[moved.length] = [entorig, check];
    pusher.entity.solid = SV.solid.not;
    SV.PushEntity(check, move);
    pusher.entity.solid = SV.solid.bsp;
    if (SV.TestEntityPosition(check) === true) {
      const cmins = check.entity.mins, cmaxs = check.entity.maxs;
      if (cmins[0] === cmaxs[0]) {
        continue;
      }
      if (check.entity.solid === SV.solid.not || check.entity.solid === SV.solid.trigger) {
        cmins[0] = cmaxs[0] = 0.0;
        cmins[1] = cmaxs[1] = 0.0;
        cmaxs[2] = cmins[2];
        check.entity.mins = cmins;
        check.entity.maxs = cmaxs;
        continue;
      }
      check.entity.origin = entorig;
      SV.LinkEdict(check, true);
      check.entity.origin = pushorig;
      SV.LinkEdict(pusher);
      pusher.entity.ltime -= movetime;
      if (pusher.entity.blocked) {
        pusher.entity.blocked(check.entity);
      }
      for (let i = 0; i < moved.length; ++i) {
        const moved_edict = moved[i];
        moved_edict[1].entity.origin = moved_edict[0];
        SV.LinkEdict(moved_edict[1]);
      }
      return;
    }
  }
};

SV.Physics_Pusher = function(ent) {
  const oldltime = ent.entity.ltime;
  const thinktime = ent.entity.nextthink;
  let movetime;
  if (thinktime < (oldltime + Host.frametime)) {
    movetime = thinktime - oldltime;
    if (movetime < 0.0) {
      movetime = 0.0;
    }
  } else {
    movetime = Host.frametime;
  }
  if (movetime !== 0.0) {
    SV.PushMove(ent, movetime);
  }
  if ((thinktime <= oldltime) || (thinktime > ent.entity.ltime)) {
    return;
  }
  ent.entity.nextthink = 0.0;
  SV.server.gameAPI.time = SV.server.time;
  ent.entity.think(null);
};

SV.CheckStuck = function(ent) {
  if (SV.TestEntityPosition(ent) !== true) {
    ent.entity.oldorigin = ent.entity.oldorigin.set(ent.entity.origin);
    return;
  }
  ent.entity.origin = ent.entity.origin.set(ent.entity.oldorigin);
  if (SV.TestEntityPosition(ent) !== true) {
    Con.DPrint('Unstuck.\n');
    SV.LinkEdict(ent, true);
    return;
  }
  const norg = ent.entity.origin.copy();
  for (norg[2] = 0.0; norg[2] <= 17.0; ++norg[2]) {
    for (norg[0] = -1.0; norg[0] <= 1.0; ++norg[0]) {
      for (norg[1] = -1.0; norg[1] <= 1.0; ++norg[1]) {
        ent.entity.origin = ent.entity.origin.set(norg).add(norg);
        if (SV.TestEntityPosition(ent) !== true) {
          Con.DPrint('Unstuck.\n');
          SV.LinkEdict(ent, true);
          return;
        }
      }
    }
  }
  Con.DPrint('player is stuck.\n');
};

SV.CheckWater = function(ent) {
  const point = ent.entity.origin.copy().add(new Vector(0.0, 0.0, ent.entity.mins[2] + 1.0));
  ent.entity.waterlevel = 0.0;
  ent.entity.watertype = Mod.contents.empty;
  let cont = SV.PointContents(point);
  if (cont > Mod.contents.water) {
    return false;
  }
  ent.entity.watertype = cont;
  ent.entity.waterlevel = 1.0;
  const origin = ent.entity.origin;
  point[2] = origin[2] + (ent.entity.mins[2] + ent.entity.maxs[2]) * 0.5;
  cont = SV.PointContents(point);
  if (cont <= Mod.contents.water) {
    ent.entity.waterlevel = 2.0;
    point[2] = origin[2] + ent.entity.view_ofs[2];
    cont = SV.PointContents(point);
    if (cont <= Mod.contents.water) {
      ent.entity.waterlevel = 3.0;
    }
  }
  return ent.entity.waterlevel > 1.0;
};

SV.WallFriction = function(ent, trace) {
  const { forward } = ent.entity.v_angle.angleVectors();
  const normal = trace.plane.normal;
  let d = normal.dot(forward) + 0.5;
  if (d >= 0.0) {
    return;
  }
  d += 1.0;
  const velo = ent.entity.velocity;
  const i = normal.dot(velo);

  // CR: velo[2] was always 0 when I tested this code substitude
  // ent.entity.velocity = ent.entity.velocity.subtract(normal.multiply(i)).multiply(d);

  velo[0] = (velo[0] - normal[0] * i) * d;
  velo[1] = (velo[1] - normal[1] * i) * d;

  ent.entity.velocity = velo;
};

SV.TryUnstick = function(ent, oldvel) {
  const oldorg = ent.entity.origin.copy();
  const dir = new Vector(2.0, 0.0, 0.0);
  let i; let clip;
  for (i = 0; i <= 7; ++i) {
    switch (i) {
      case 1: dir[0] = 0.0; dir[1] = 2.0; break;
      case 2: dir[0] = -2.0; dir[1] = 0.0; break;
      case 3: dir[0] = 0.0; dir[1] = -2.0; break;
      case 4: dir[0] = 2.0; dir[1] = 2.0; break;
      case 5: dir[0] = -2.0; dir[1] = 2.0; break;
      case 6: dir[0] = 2.0; dir[1] = -2.0; break;
      case 7: dir[0] = -2.0; dir[1] = -2.0;
    }
    SV.PushEntity(ent, dir);
    ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
    clip = SV.FlyMove(ent, 0.1);
    const curorg = ent.entity.origin;
    if (Math.abs(oldorg[1] - curorg[1]) > 4.0 || Math.abs(oldorg[0] - curorg[0]) > 4.0) {
      return clip;
    }
    ent.entity.origin = ent.entity.origin.set(oldorg);
  }
  ent.entity.velocity = new Vector();
  return 7;
};

SV.WalkMove = function(ent) {
  const oldonground = ent.entity.flags & SV.fl.onground;
  ent.entity.flags ^= oldonground;
  const oldorg = ent.entity.origin.copy();
  const oldvel = ent.entity.velocity.copy();
  let clip = SV.FlyMove(ent, Host.frametime);
  if ((clip & 2) === 0) {
    return;
  }
  if ((oldonground === 0) && (ent.entity.waterlevel === 0.0)) {
    return;
  }
  if (ent.entity.movetype !== SV.movetype.walk) {
    return;
  }
  if (SV.nostep.value !== 0) {
    return;
  }
  if ((SV.player.entity.flags & SV.fl.waterjump) !== 0) {
    return;
  }
  const nosteporg = ent.entity.origin.copy();
  const nostepvel = ent.entity.velocity.copy();
  ent.entity.origin = ent.entity.origin.set(oldorg);
  SV.PushEntity(ent, new Vector(0.0, 0.0, 18.0));
  ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
  clip = SV.FlyMove(ent, Host.frametime);
  if (clip !== 0) {
    const curorg = ent.entity.origin;
    if (Math.abs(oldorg[1] - curorg[1]) < 0.03125 && Math.abs(oldorg[0] - curorg[0]) < 0.03125) {
      clip = SV.TryUnstick(ent, oldvel);
    }
    if ((clip & 2) !== 0) {
      // FIXME: SV.steptrace can be null!
      if (SV.steptrace) {
        SV.WallFriction(ent, SV.steptrace);
      }
    }
  }
  const downtrace = SV.PushEntity(ent, new Vector(0.0, 0.0, oldvel[2] * Host.frametime - 18.0));
  if (downtrace.plane.normal[2] > 0.7) {
    if (ent.entity.solid === SV.solid.bsp) {
      ent.entity.flags |= SV.fl.onground;
      ent.entity.groundentity = downtrace.ent.entity;
    }
    return;
  }
  ent.entity.origin = ent.entity.origin.set(nosteporg);
  ent.entity.velocity = ent.entity.velocity.set(nostepvel);
};

SV.NoclipMove = function() {
  const ent = SV.player, cmd = Host.client.cmd;

  const { forward, right } = ent.entity.v_angle.angleVectors();

  const wishvel = new Vector(
    forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
    forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
    forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
  );

  ent.entity.velocity = ent.entity.velocity.set(wishvel.multiply(2.0));
};

SV.Physics_Client = function(ent) {
  if (!ent.getClient().active) {
    return;
  }

  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.PlayerPreThink(ent);
  SV.CheckVelocity(ent);
  const movetype = ent.entity.movetype >> 0;
  if ((movetype === SV.movetype.toss) || (movetype === SV.movetype.bounce)) {
    SV.Physics_Toss(ent);
  } else {
    if (!SV.RunThink(ent)) {
      return; // thinking might have freed the edict
    }
    switch (movetype) {
      case SV.movetype.none:
        break;
      case SV.movetype.walk:
        if (!SV.CheckWater(ent) && (ent.entity.flags & SV.fl.waterjump) === 0) {
          SV.AddGravity(ent);
        }
        SV.CheckStuck(ent);
        SV.WalkMove(ent);
        break;
      case SV.movetype.fly:
        SV.FlyMove(ent, Host.frametime);
        break;
      case SV.movetype.noclip:
        ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
        ent.entity.origin = ent.entity.origin.add(ent.entity.velocity.copy().multiply(Host.frametime));
        break;
      default:
        throw new Error('SV.Physics_Client: bad movetype ' + movetype);
    }
  }
  SV.LinkEdict(ent, true);
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.PlayerPostThink(ent);
};

SV.CheckWaterTransition = function(ent) {
  const cont = SV.PointContents(ent.entity.origin);

  if (ent.entity.watertype === 0.0) {
    ent.entity.watertype = cont;
    ent.entity.waterlevel = 1.0;
    return;
  }

  if (cont <= Mod.contents.water) {
    if (ent.entity.watertype === Mod.contents.empty) {
      SV.StartSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0); // TODO: move to game logic
    }
    ent.entity.watertype = cont;
    ent.entity.waterlevel = 1.0;
    return;
  }
  if (ent.entity.watertype !== Mod.contents.empty) {
    SV.StartSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0); // TODO: move to game logic
  }
  ent.entity.watertype = Mod.contents.empty;
  ent.entity.waterlevel = cont;
};

SV.Physics_Toss = function(ent) {
  if (!SV.RunThink(ent)) {
    return; // thinking might have freed the edict
  }
  if ((ent.entity.flags & SV.fl.onground) !== 0) {
    return;
  }

  SV.CheckVelocity(ent);
  const movetype = ent.entity.movetype;
  if ((movetype !== SV.movetype.fly) && (movetype !== SV.movetype.flymissile)) {
    SV.AddGravity(ent);
  }
  ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
  const trace = SV.PushEntity(ent, ent.entity.velocity.copy().multiply(Host.frametime));
  if (trace.fraction === 1.0 || ent.isFree()) {
    return;
  }
  const velocity = new Vector();
  SV.ClipVelocity(ent.entity.velocity, trace.plane.normal, velocity, (movetype === SV.movetype.bounce) ? 1.5 : 1.0);
  ent.entity.velocity = velocity;
  if (trace.plane.normal[2] > 0.7) {
    if (ent.entity.velocity[2] < 60.0 || movetype !== SV.movetype.bounce) {
      ent.entity.flags |= SV.fl.onground;
      ent.entity.groundentity = trace.ent.entity;
      ent.entity.velocity = new Vector();
      ent.entity.avelocity = new Vector();
    }
  }
  SV.CheckWaterTransition(ent);
};

SV.Physics_Step = function(ent) {
  if ((ent.entity.flags & (SV.fl.onground | SV.fl.fly | SV.fl.swim)) === 0) {
    const hitsound = (ent.entity.velocity[2] < (SV.gravity.value * -0.1));
    SV.AddGravity(ent);
    SV.CheckVelocity(ent);
    SV.FlyMove(ent, Host.frametime);
    SV.LinkEdict(ent, true);
    if (((ent.entity.flags & SV.fl.onground) !== 0) && (hitsound === true)) { // TODO: move to game logic
      SV.StartSound(ent, 0, 'demon/dland2.wav', 255, 1.0);
    }
  }
  SV.RunThink(ent);
  SV.CheckWaterTransition(ent);
};

SV._BuildSurfaceDisplayList = function(currentmodel, fa) { // FIXME: move to Mod?
  fa.verts = [];
  if (fa.numedges <= 2) {
    return;
  }
  let i; let index; let vec; let vert; let s; let t;
  const texinfo = currentmodel.texinfo[fa.texinfo];
  const texture = currentmodel.textures[texinfo.texture];
  for (i = 0; i < fa.numedges; ++i) {
    index = currentmodel.surfedges[fa.firstedge + i];
    if (index > 0) {
      vec = currentmodel.vertexes[currentmodel.edges[index][0]];
    } else {
      vec = currentmodel.vertexes[currentmodel.edges[-index][1]];
    }
    vert = new Vector(vec[0], vec[1], vec[2]);
    if (fa.sky !== true) {
      s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
      t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
      vert[3] = s / texture.width;
      vert[4] = t / texture.height;
      if (fa.turbulent !== true) {
        vert[5] = (s - fa.texturemins[0] + (fa.light_s << 4) + 8.0) / 16384.0;
        vert[6] = (t - fa.texturemins[1] + (fa.light_t << 4) + 8.0) / 16384.0;
      }
    }
    if (i >= 3) {
      fa.verts[fa.verts.length] = fa.verts[0];
      fa.verts[fa.verts.length] = fa.verts[fa.verts.length - 2];
    }
    fa.verts[fa.verts.length] = vert;
  }
};

SV.Physics = function() {
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.StartFrame(null);
  for (let i = 0; i < SV.server.num_edicts; i++) {
    const ent = SV.server.edicts[i];
    if (ent.isFree()) {
      continue;
    }
    if (SV.server.gameAPI.force_retouch-- > 0) {
      SV.LinkEdict(ent, true);
    }
    if (ent.isClient()) {
      SV.Physics_Client(ent);
      continue;
    }
    switch (ent.entity.movetype) {
      case SV.movetype.push:
        SV.Physics_Pusher(ent);
        continue;
      case SV.movetype.none:
        SV.RunThink(ent);
        continue;
      case SV.movetype.noclip:
        SV.RunThink(ent);
        continue;
      case SV.movetype.step:
        SV.Physics_Step(ent);
        continue;
      case SV.movetype.toss:
      case SV.movetype.bounce:
      case SV.movetype.fly:
      case SV.movetype.flymissile:
        SV.Physics_Toss(ent);
        continue;
    }
    throw new Error('SV.Physics: bad movetype ' + (ent.entity.movetype >> 0));
  }
  SV.server.time += Host.frametime;
};

// user

SV.SetIdealPitch = function() {
  const ent = SV.player;
  if ((ent.entity.flags & SV.fl.onground) === 0) {
    return;
  }
  const origin = ent.entity.origin;
  const angleval = ent.entity.angles[1] * (Math.PI / 180.0);
  const sinval = Math.sin(angleval);
  const cosval = Math.cos(angleval);
  const top = new Vector(0.0, 0.0, origin[2] + ent.entity.view_ofs[2]);
  const bottom = new Vector(0.0, 0.0, top[2] - 160.0);
  let i; let tr; const z = [];
  for (i = 0; i < 6; ++i) {
    top[0] = bottom[0] = origin[0] + cosval * (i + 3) * 12.0;
    top[1] = bottom[1] = origin[1] + sinval * (i + 3) * 12.0;
    tr = SV.Move(top, Vector.origin, Vector.origin, bottom, 1, ent);
    if (tr.allsolid || tr.fraction === 1.0) {
      return;
    }
    z[i] = top[2] - tr.fraction * 160.0;
  }
  let dir = 0.0; let step; let steps = 0;
  for (i = 1; i < 6; ++i) {
    step = z[i] - z[i - 1];
    if ((step > -0.1) && (step < 0.1)) {
      continue;
    }
    if ((dir !== 0.0) && (((step - dir) > 0.1) || ((step - dir) < -0.1))) {
      return;
    }
    ++steps;
    dir = step;
  }
  if (dir === 0.0) {
    ent.entity.idealpitch = 0.0;
    return;
  }
  if (steps >= 2) {
    ent.entity.idealpitch = -dir * SV.idealpitchscale.value;
  }
};

SV.UserFriction = function() {
  const ent = SV.player;
  const vel = ent.entity.velocity;
  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
  if (speed === 0.0) {
    return;
  }
  const origin = ent.entity.origin;
  const start = new Vector(origin[0] + vel[0] / speed * 16.0, origin[1] + vel[1] / speed * 16.0, origin[2] + ent.entity.mins[2]);
  let friction = SV.friction.value;
  if (SV.Move(start, Vector.origin, Vector.origin, new Vector(start[0], start[1], start[2] - 34.0), 1, ent).fraction === 1.0) {
    friction *= SV.edgefriction.value;
  }
  let newspeed = speed - Host.frametime * (speed < SV.stopspeed.value ? SV.stopspeed.value : speed) * friction;
  if (newspeed < 0.0) {
    newspeed = 0.0;
  }
  newspeed /= speed;
  ent.entity.velocity = ent.entity.velocity.multiply(newspeed);
};

SV.Accelerate = function(wishvel, air) {
  const ent = SV.player;

  const wishdir = wishvel.copy(); // new Vector(wishvel[0], wishvel[1], wishvel[2]);

  let wishspeed = wishdir.normalize();

  if (air && wishspeed > 30.0) {
    wishspeed = 30.0;
  }

  const addspeed = wishspeed - ent.entity.velocity.dot(wishdir);
  if (addspeed <= 0.0) {
    return;
  }
  const accelspeed = Math.min(SV.accelerate.value * Host.frametime * wishspeed, addspeed);
  ent.entity.velocity = ent.entity.velocity.add(wishdir.multiply(accelspeed));
};

SV.WaterMove = function() { // Host.client
  const ent = SV.player; const cmd = Host.client.cmd;
  const { forward, right } = ent.entity.v_angle.angleVectors();
  const wishvel = new Vector(
    forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
    forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
    forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
  );
  if ((cmd.forwardmove === 0.0) && (cmd.sidemove === 0.0) && (cmd.upmove === 0.0)) {
    wishvel[2] -= 60.0;
  } else {
    wishvel[2] += cmd.upmove;
  }
  let wishspeed = wishvel.len();
  let scale;
  if (wishspeed > SV.maxspeed.value) {
    scale = SV.maxspeed.value / wishspeed;
    wishvel.multiply(scale);
    wishspeed = SV.maxspeed.value;
  }
  wishspeed *= 0.7;
  const speed = ent.entity.velocity.len(); let newspeed;
  if (speed !== 0.0) {
    newspeed = speed - Host.frametime * speed * SV.friction.value;
    if (newspeed < 0.0) {
      newspeed = 0.0;
    }
    scale = newspeed / speed;
    ent.entity.velocity = ent.entity.velocity.multiply(scale);
  } else {
    newspeed = 0.0;
  }

  if (wishspeed === 0.0) {
    return;
  }

  const addspeed = wishspeed - newspeed;
  if (addspeed <= 0.0) {
    return;
  }
  const accelspeed = Math.min(SV.accelerate.value * wishspeed * Host.frametime, addspeed);
  ent.entity.velocity = ent.entity.velocity.add(wishvel.multiply(accelspeed / wishspeed));
};

SV.WaterJump = function() { // Host.client
  const ent = SV.player;
  if ((SV.server.time > ent.entity.teleport_time) || (ent.entity.waterlevel === 0.0)) {
    ent.entity.flags &= (~SV.fl.waterjump >>> 0);
    ent.entity.teleport_time = 0.0;
  }

  const nvelo = ent.entity.movedir.copy();
  nvelo[2] = ent.entity.velocity[2];
  ent.entity.velocity = nvelo;
};

SV.AirMove = function() { // Host.client
  const ent = SV.player;
  const cmd = Host.client.cmd;
  const {forward, right} =   ent.entity.angles.angleVectors();
  let fmove = cmd.forwardmove;
  const smove = cmd.sidemove;
  if ((SV.server.time < ent.entity.teleport_time) && (fmove < 0.0)) {
    fmove = 0.0;
  }
  const wishvel = new Vector(
    forward[0] * fmove + right[0] * smove,
    forward[1] * fmove + right[1] * smove,
		((ent.entity.movetype >> 0) !== SV.movetype.walk) ? cmd.upmove : 0.0);
  const wishdir = new Vector(wishvel[0], wishvel[1], wishvel[2]);
  if (wishdir.normalize() > SV.maxspeed.value) {
    wishvel[0] = wishdir[0] * SV.maxspeed.value;
    wishvel[1] = wishdir[1] * SV.maxspeed.value;
    wishvel[2] = wishdir[2] * SV.maxspeed.value;
  }
  if (ent.entity.movetype === SV.movetype.noclip) {
    ent.entity.velocity = wishvel;
  } else if ((ent.entity.flags & SV.fl.onground) !== 0) {
    SV.UserFriction();
    SV.Accelerate(wishvel);
  } else {
    SV.Accelerate(wishvel, true);
  }
};

SV.ClientThink = function() {
  const ent = SV.player;

  if (ent.entity.movetype === SV.movetype.none) {
    return;
  }

  const punchangle = ent.entity.punchangle.copy();
  let len = punchangle.normalize() - 10.0 * Host.frametime;
  if (len < 0.0) {
    len = 0.0;
  }
  ent.entity.punchangle = punchangle.multiply(len);

  if (ent.entity.health <= 0.0) {
    return;
  }

  const angles = ent.entity.angles;
  const v_angle = ent.entity.v_angle.copy().add(punchangle);

  angles[2] = V.CalcRoll(angles, ent.entity.velocity) * 4.0;

  if (!SV.player.entity.fixangle) {
    angles[0] = v_angle[0] / -3.0;
    angles[1] = v_angle[1];
  }

  ent.entity.angles = angles;

  if (ent.entity.flags & SV.fl.waterjump) {
    SV.WaterJump();
  } else if (ent.entity.waterlevel >= 2.0 && ent.entity.movetype !== SV.movetype.noclip) {
    SV.WaterMove();
  } else if (ent.entity.movetype === SV.movetype.noclip) {
    SV.NoclipMove();
  } else {
    SV.AirMove();
  }
};

/**
 * @param {ServerClient} client client
 */
SV.ReadClientMove = function(client) {
  client.cmd.msec = MSG.ReadFloat();
  client.cmd.angles = MSG.ReadAngleVector();
  client.cmd.forwardmove = MSG.ReadShort();
  client.cmd.sidemove = MSG.ReadShort();
  client.cmd.upmove = MSG.ReadShort();
  // CR: we could restructure this a bit and let the ServerGameAPI handle the rest
  client.cmd.buttons = MSG.ReadByte();
  client.edict.entity.button0 = (client.cmd.buttons & Protocol.button.attack) === 1; // QuakeC
  client.edict.entity.button1 = ((client.cmd.buttons & Protocol.button.use) >> 2) === 1; // QuakeC
  client.edict.entity.button2 = ((client.cmd.buttons & Protocol.button.jump) >> 1) === 1; // QuakeC
  client.edict.entity.v_angle = client.cmd.angles;
  client.cmd.impulse = MSG.ReadByte();
  if (client.cmd.impulse !== 0) {
    client.edict.entity.impulse = client.cmd.impulse; // QuakeC
  }

  client.ping_times[client.num_pings++ % client.ping_times.length] = SV.server.time - client.cmd.msec;

  // console.log('client.cmd', client.cmd);
};

// eslint-disable-next-line no-unused-vars
SV.ReadClientMoveQW = function(client) {
  // TODO

  // TODO: 3x MSG_ReadDeltaUsercmd

  // TODO: break if not spawned

  // TODO: SV.PreRunCmd, SV.RunCmd (a few times), SV.PostRunCmd

  // TODO: client.lastcmd = newcmd, client.lastcmd.buttons = 0
};

SV.HandleRconRequest = function(client) {
  const message = client.message;

  const password = MSG.ReadString();
  const cmd = MSG.ReadString();

  const rconPassword = SV.rcon_password.string;

  if (rconPassword === '' || rconPassword !== password) {
    MSG.WriteByte(message, Protocol.svc.print);
    MSG.WriteString(message, 'Wrong rcon password!\n');
    if (rconPassword === '') {
      Con.Print(`SV.HandleRconRequest: rcon attempted by ${client.name} from ${client.netconnection.address}: ${cmd}\n`);
    }
    return;
  }

  Con.Print(`SV.HandleRconRequest: rcon by ${client.name} from ${client.netconnection.address}: ${cmd}\n`);

  Con.StartCapturing();
  Cmd.ExecuteString(cmd);
  const response = Con.StopCapturing();
  MSG.WriteByte(message, Protocol.svc.print);
  MSG.WriteString(message, response);
};

/**
 * Reads client message.
 * @param {ServerClient} client client
 * @returns {boolean} true, if everything was processed successfully
 */
SV.ReadClientMessage = function(client) {
  let qwmove_issued = false;

  /** commands that may be pushed by Cmd.ForwardToServer */
  const commands = [
    'status',
    'god',
    'notarget',
    'fly',
    'name',
    'noclip',
    'say',
    'say_team',
    'tell',
    'color',
    'kill',
    'pause',
    'spawn',
    'begin',
    'prespawn',
    'kick',
    'ping',
    'give',
    'ban',
  ];

  while (true) {
    const ret = NET.GetMessage(client.netconnection);

    if (ret === -1) {
      Con.Print('SV.ReadClientMessage: NET.GetMessage failed\n');
      return false;
    }

    if (ret === 0) {
      return true;
    }

    MSG.BeginReading();

    while (true) {
      if (!client.active) {
        return false;
      }

      if (MSG.badread) {
        Con.Print('SV.ReadClientMessage: badread\n');
        return false;
      }

      client.last_message = Host.realtime;
      client.ping_times[client.num_pings++ % client.ping_times.length] = Host.realtime - client.last_message;

      const cmd = MSG.ReadChar();

      if (cmd === -1) {
        break; // End of message
      }

      switch (cmd) {
        case Protocol.clc.nop:
          // No operation, continue reading
          continue;

        case Protocol.clc.stringcmd: {
          const input = MSG.ReadString();
          const matchedCommand = commands.find((command) =>
            input.toLowerCase().startsWith(command),
          );
          if (matchedCommand) {
            Cmd.ExecuteString(input, client);
          } else {
            Con.Print(`${client.name} tried to ${input}!\n`);
          }
          break;
        }

        case Protocol.clc.rconcmd:
          SV.HandleRconRequest(client);
          break;

        case Protocol.clc.disconnect:
          return false; // Client disconnect

        case Protocol.clc.move:
          SV.ReadClientMove(client);
          break;

        case Protocol.clc.qwmove: // TODO
          if (qwmove_issued) {
            return false;
          }
          qwmove_issued = true;
          SV.ReadClientMoveQW(client);
          break;

        default:
          Con.Print(`SV.ReadClientMessage: unknown command ${cmd}\n`);
          return false;
      }
    }
  }
};

SV.RunClients = function() { // FIXME: Host.client
  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if (!client.active) {
      continue;
    }
    Host.client = client;
    /** @type {ServerEdict} @deprecated */
    SV.player = client.edict; // FIXME: SV.player
    if (!SV.ReadClientMessage(client)) {
      Host.DropClient(client, false, 'Connectivity issues, failed to read message');
      continue;
    }
    if (!client.spawned) {
      client.cmd.reset();
      continue;
    }
    // TODO: drop clients without an update
    SV.ClientThink(); // FIXME: SV.player
  }
};

SV.FindClientByName = function(name) {
  return SV.svs.clients
      .filter((client) => client.active)
      .find((client) => client.name === name);
};

// world

SV.move = Object.freeze({
  normal: 0,
  nomonsters: 1,
  missile: 2,
});

SV.InitBoxHull = function() {
  SV.box_clipnodes = [];
  SV.box_planes = [];
  SV.box_hull = {
    clipnodes: SV.box_clipnodes,
    planes: SV.box_planes,
    firstclipnode: 0,
    lastclipnode: 5,
  };
  for (let i = 0; i <= 5; ++i) {
    const node = {};
    SV.box_clipnodes[i] = node;
    node.planenum = i;
    node.children = [];
    node.children[i & 1] = Mod.contents.empty;
    if (i !== 5) {
      node.children[1 - (i & 1)] = i + 1;
    } else {
      node.children[1 - (i & 1)] = Mod.contents.solid;
    }
    const plane = {};
    SV.box_planes[i] = plane;
    plane.type = i >> 1;
    plane.normal = new Vector();
    plane.normal[i >> 1] = 1.0;
    plane.dist = 0.0;
  }
};

SV.HullForEntity = function(ent, mins, maxs, out_offset) {
  const origin = ent.entity.origin;
  if (ent.entity.solid !== SV.solid.bsp) {
    const emaxs = ent.entity.maxs, emins = ent.entity.mins;
    SV.box_planes[0].dist = emaxs[0] - mins[0];
    SV.box_planes[1].dist = emins[0] - maxs[0];
    SV.box_planes[2].dist = emaxs[1] - mins[1];
    SV.box_planes[3].dist = emins[1] - maxs[1];
    SV.box_planes[4].dist = emaxs[2] - mins[2];
    SV.box_planes[5].dist = emins[2] - maxs[2];
    out_offset.set(origin);
    return SV.box_hull;
  }
  console.assert(ent.entity.movetype !== SV.movetype.none, 'SOLID_BSP with MOVETYPE_NONE');
  const model = SV.server.models[ent.entity.modelindex];
  console.assert(model && model.type === Mod.type.brush, 'model is null or not a brush');
  const size = maxs[0] - mins[0];
  let hull;
  if (size < 3.0) {
    hull = model.hulls[0];
  } else if (size <= 32.0) {
    hull = model.hulls[1];
  } else {
    hull = model.hulls[2];
  }
  out_offset.setTo(
    hull.clip_mins[0] - mins[0] + origin[0],
    hull.clip_mins[1] - mins[1] + origin[1],
    hull.clip_mins[2] - mins[2] + origin[2],
  );
  return hull;
};

SV.CreateAreaNode = function(depth, mins, maxs) {
  const anode = {};
  SV.areanodes[SV.areanodes.length++] = anode;

  anode.trigger_edicts = {};
  anode.trigger_edicts.prev = anode.trigger_edicts.next = anode.trigger_edicts;
  anode.solid_edicts = {};
  anode.solid_edicts.prev = anode.solid_edicts.next = anode.solid_edicts;

  if (depth === 4) {
    anode.axis = -1;
    anode.children = [];
    return anode;
  }

  anode.axis = (maxs[0] - mins[0]) > (maxs[1] - mins[1]) ? 0 : 1;
  anode.dist = 0.5 * (maxs[anode.axis] + mins[anode.axis]);

  const maxs1 = new Vector(maxs[0], maxs[1], maxs[2]);
  const mins2 = new Vector(mins[0], mins[1], mins[2]);
  maxs1[anode.axis] = mins2[anode.axis] = anode.dist;
  anode.children = [SV.CreateAreaNode(depth + 1, mins2, maxs), SV.CreateAreaNode(depth + 1, mins, maxs1)];
  return anode;
};

SV.UnlinkEdict = function(ent) {
  if (ent.area.prev) {
    ent.area.prev.next = ent.area.next;
  }
  if (ent.area.next) {
    ent.area.next.prev = ent.area.prev;
  }
  ent.area.prev = ent.area.next = null;
};

SV.TouchLinks = function(ent, node) {
  const absmin = ent.entity.absmin, absmax = ent.entity.absmax;
  for (let l = node.trigger_edicts.next, next = null; l !== node.trigger_edicts; l = next) {
    next = l.next;
    const touch = l.ent;
    if (touch === ent) {
      continue;
    }
    if (!touch.entity.touch || touch.entity.solid !== SV.solid.trigger) {
      continue;
    }
    if (!absmin.lte(touch.entity.absmax) || !absmax.gte(touch.entity.absmin)) {
      continue;
    }
    SV.server.gameAPI.time = SV.server.time;
    touch.entity.touch(!ent.isFree() ? ent.entity : null);
  }
  if (node.axis === -1) {
    return;
  }
  if (absmax[node.axis] > node.dist) {
    SV.TouchLinks(ent, node.children[0]);
  }
  if (absmax[node.axis] < node.dist) {
    SV.TouchLinks(ent, node.children[1]);
  }
};

SV.FindTouchedLeafs = function(ent, node) {
  if (node.contents === Mod.contents.solid) {
    return;
  }

  if (node.contents < 0) {
    if (ent.leafnums.length === 16) {
      return;
    }
    ent.leafnums[ent.leafnums.length] = node.num - 1;
    return;
  }

  const sides = Vector.boxOnPlaneSide(ent.entity.absmin, ent.entity.absmax, node.plane);

  if ((sides & 1) !== 0) {
    SV.FindTouchedLeafs(ent, node.children[0]);
  }
  if ((sides & 2) !== 0) {
    SV.FindTouchedLeafs(ent, node.children[1]);
  }
};

SV.LinkEdict = function(ent, touch_triggers = false) {
  if (ent.equals(SV.server.edicts[0]) || ent.isFree()) {
    return;
  }

  SV.UnlinkEdict(ent);

  const origin = ent.entity.origin;
  const absmin = origin.copy(), absmax = origin.copy();

  absmin.add(ent.entity.mins).add(new Vector(-1.0, -1.0, -1.0));
  absmax.add(ent.entity.maxs).add(new Vector( 1.0,  1.0,  1.0));

  if ((ent.entity.flags & SV.fl.item) !== 0) {
    // the former else-branch would set Z, but we did it two statements before already,
    // so we need to correct it by subtracting the adjusted Z back.
    absmin.add(new Vector(-14.0, -14.0,  1.0));
    absmax.add(new Vector( 14.0,  14.0, -1.0));
  }

  ent.entity.absmin = ent.entity.absmin.set(absmin);
  ent.entity.absmax = ent.entity.absmax.set(absmax);

  ent.leafnums = [];
  if (ent.entity.modelindex !== 0.0) {
    SV.FindTouchedLeafs(ent, SV.server.worldmodel.nodes[0]);
  }

  if (ent.entity.solid === SV.solid.not) {
    return;
  }

  let node = SV.areanodes[0];
  for (;;) {
    if (node.axis === -1) {
      break;
    }
    if (ent.entity.absmin[node.axis] > node.dist) {
      node = node.children[0];
    } else if (ent.entity.absmax[node.axis] < node.dist) {
      node = node.children[1];
    } else {
      break;
    }
  }

  const before = (ent.entity.solid === SV.solid.trigger) ? node.trigger_edicts : node.solid_edicts;
  ent.area.next = before;
  ent.area.prev = before.prev;
  ent.area.prev.next = ent.area;
  ent.area.next.prev = ent.area;
  ent.area.ent = ent;

  if (touch_triggers) {
    SV.TouchLinks(ent, SV.areanodes[0]);
  }
};

SV.HullPointContents = function(hull, num, p) {
  let d; let node; let plane;
  for (; num >= 0; ) {
    console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);
    node = hull.clipnodes[num];
    plane = hull.planes[node.planenum];
    if (plane.type <= 2) {
      d = p[plane.type] - plane.dist;
    } else {
      d = plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] - plane.dist;
    }
    if (d >= 0.0) {
      num = node.children[0];
    } else {
      num = node.children[1];
    }
  }
  return num;
};

SV.PointContents = function(p) {
  const cont = SV.HullPointContents(SV.server.worldmodel.hulls[0], 0, p);
  if ((cont <= Mod.contents.current_0) && (cont >= Mod.contents.current_down)) {
    return Mod.contents.water;
  }
  return cont;
};

SV.TestEntityPosition = function(ent) {
  const origin = ent.entity.origin.copy();
  return SV.Move(origin, ent.entity.mins, ent.entity.maxs, origin, 0, ent).startsolid;
};

/**
 * Iterative version of SV.RecursiveHullCheck.
 * It simulates the recursive process via an explicit stack.
 * @param {object} hull what hull to check against
 * @param {number} num starting clipnode number (typically hull.firstclipnode)
 * @param {number} p1f fraction at p1 (usually 0.0)
 * @param {number} p2f fraction at p2 (usually 1.0)
 * @param {Vector} p1 start point
 * @param {Vector} p2 end point
 * @param {object} trace object to store trace results
 * @returns {boolean} true means going down, false means going up
 */
SV.RecursiveHullCheck = function(hull, num, p1f, p2f, p1, p2, trace) { // TODO: rewrite to iterative check
  // check for empty
  if (num < 0) {
    if (num !== Mod.contents.solid) {
      trace.allsolid = false;
      if (num === Mod.contents.empty) {
        trace.inopen = true;
      } else {
        trace.inwater = true;
      }
    } else {
      trace.startsolid = true;
    }
    return true; // going down the tree
  }

  console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);

  // find the point distances
  const node = hull.clipnodes[num];
  const plane = hull.planes[node.planenum];
  const t1 = (plane.type < 3 ? p1[plane.type] : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
  const t2 = (plane.type < 3 ? p2[plane.type] : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

  // checking children on side 1
  if (t1 >= 0.0 && t2 >= 0.0) {
    return SV.RecursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
  }

  // checking children on side 2
  if (t1 < 0.0 && t2 < 0.0) {
    return SV.RecursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);
  }

  // put the crosspoint DIST_EPSILON pixels on the near side
  let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2))); // epsilon value of 0.03125 = 1/32
  let midf = p1f + (p2f - p1f) * frac;
  const mid = new Vector(p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2]));
  const side = t1 < 0.0 ? 1 : 0;

  // move up to the node
  if (!SV.RecursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) {
    return false;
  }

  // go past the node
  if (SV.HullPointContents(hull, node.children[1 - side], mid) !== Mod.contents.solid) {
    return SV.RecursiveHullCheck(hull, node.children[1 - side], midf, p2f, mid, p2, trace);
  }

  // never got out of the solid area
  if (trace.allsolid) {
    return false;
  }

  // the other side of the node is solid, this is the impact point
  if (side === 0) {
    trace.plane.normal = plane.normal.copy();
    trace.plane.dist = plane.dist;
  } else {
    trace.plane.normal = plane.normal.copy().multiply(-1);
    trace.plane.dist = -plane.dist;
  }

  while (SV.HullPointContents(hull, hull.firstclipnode, mid) === Mod.contents.solid) {
    // shouldn't really happen, but does occasionally
    frac -= 0.1;
    if (frac < 0.0) {
      trace.fraction = midf;
      trace.endpos = mid.copy();
      Con.DPrint('backup past 0\n');
      return;
    }
    midf = p1f + (p2f - p1f) * frac;
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);
  }

  trace.fraction = midf;
  trace.endpos = mid.copy();

  return false;
};

SV.ClipMoveToEntity = function(ent, start, mins, maxs, end) {
  const trace = {
    fraction: 1.0,
    allsolid: true,
    endpos: end.copy(),
    plane: {normal: new Vector(), dist: 0.0},
    ent: null,
  };
  const offset = new Vector();
  const hull = SV.HullForEntity(ent, mins, maxs, offset);
  SV.RecursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, start.copy().subtract(offset), end.copy().subtract(offset), trace);
  if (trace.fraction !== 1.0) {
    trace.endpos.add(offset);
  }
  if ((trace.fraction < 1.0) || (trace.startsolid === true)) {
    trace.ent = ent;
  }
  return trace;
};

SV.ClipToLinks = function(node, clip) {
  for (let l = node.solid_edicts.next; l !== node.solid_edicts; l = l.next) {
    const touch = l.ent;
    const solid = touch.entity.solid;
    if ((solid === SV.solid.not) || (touch === clip.passedict)) {
      continue;
    }
    console.assert(solid !== SV.solid.trigger, 'trigger not in clipping list');
    if (clip.type === SV.move.nomonsters && solid !== SV.solid.bsp) {
      continue;
    }
    if (!clip.boxmins.lte(touch.entity.absmax) || !clip.boxmaxs.gte(touch.entity.absmin)) {
      continue;
    }
    if (clip.passedict) {
      if (clip.passedict.entity.size !== 0.0 && touch.entity.size === 0.0) {
        continue;
      }
    }
    if (clip.trace.allsolid === true) {
      return;
    }
    if (clip.passedict) {
      if (touch.entity.owner && touch.entity.owner.equals(clip.passedict)) { // TODO: Edict vs Entity
        continue;
      }
      if (clip.passedict.entity.owner && clip.passedict.entity.owner.equals(touch)) { // TODO: Edict vs Entity
        continue;
      }
    }
    let trace;
    if ((touch.entity.flags & SV.fl.monster) !== 0) {
      trace = SV.ClipMoveToEntity(touch, clip.start, clip.mins2, clip.maxs2, clip.end);
    } else {
      trace = SV.ClipMoveToEntity(touch, clip.start, clip.mins, clip.maxs, clip.end);
    }
    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      trace.ent = touch;
      clip.trace = trace;
      if (trace.startsolid) {
        clip.trace.startsolid = true;
      }
    }
  }
  if (node.axis === -1) {
    return;
  }
  if (clip.boxmaxs[node.axis] > node.dist) {
    SV.ClipToLinks(node.children[0], clip);
  }
  if (clip.boxmins[node.axis] < node.dist) {
    SV.ClipToLinks(node.children[1], clip);
  }
};

SV.Move = function(start, mins, maxs, end, type, passedict) {
  const clip = {
    trace: SV.ClipMoveToEntity(SV.server.edicts[0], start, mins, maxs, end),
    start: start,
    end: end,
    mins: mins,
    mins2: type === SV.move.missile ? new Vector(-15.0, -15.0, -15.0) : mins,
    maxs: maxs,
    maxs2: type === SV.move.missile ? new Vector(15.0, 15.0, 15.0) : maxs,
    type: type,
    passedict: passedict,
    boxmins: new Vector(),
    boxmaxs: new Vector(),
  };
  for (let i = 0; i <= 2; i++) {
    if (end[i] > start[i]) {
      clip.boxmins[i] = start[i] + clip.mins2[i] - 1.0;
      clip.boxmaxs[i] = end[i] + clip.maxs2[i] + 1.0;
      continue;
    }
    clip.boxmins[i] = end[i] + clip.mins2[i] - 1.0;
    clip.boxmaxs[i] = start[i] + clip.maxs2[i] + 1.0;
  }
  SV.ClipToLinks(SV.areanodes[0], clip);
  return clip.trace;
};
