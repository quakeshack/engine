import type { Visibility } from '../common/model/BSP.ts';
import type { SerializableType } from '../../shared/GameInterfaces.ts';
import type Vector from '../../shared/Vector.ts';
import type { BaseEntity, ServerEdict } from './Edict.ts';

import { SzBuffer } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Defs from '../../shared/Defs.ts';
import Cvar from '../common/Cvar.ts';
import { requireActiveGameModule } from '../common/GameModule.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';
import { ServerClient } from './Client.ts';
import { ServerEntityState } from './ServerEntityState.ts';

type BitsWriter = 'writeByte' | 'writeShort' | 'writeLong';
type DynamicEntityFieldValue = SerializableType | undefined;

interface DamageInflictorEntityLike {
  edict?: ServerEdict;
  isFree(): boolean;
  entity: ServerMessageEntity;
}

interface WorldspawnMessageEntity {
  message?: string | null;
  sounds?: number;
}

interface ServerMessageEntity extends BaseEntity {
  alpha: number;
  ammo_cells: number;
  ammo_nails: number;
  ammo_rockets: number;
  ammo_shells: number;
  armorvalue: number;
  classname: string;
  colormap: number;
  currentammo: number;
  dmg_inflictor: DamageInflictorEntityLike | ServerEdict | null;
  dmg_save: number;
  dmg_take: number;
  effects: number;
  fixangle: boolean;
  flags: number;
  frame: number;
  frags: number;
  health: number;
  idealpitch: number;
  items: number;
  items2?: number;
  message?: string | null;
  mins: Vector;
  maxs: Vector;
  model: string | null;
  modelindex: number;
  nextthink?: number;
  origin: Vector;
  punchangle: Vector;
  skin: number;
  solid: number;
  sounds?: number;
  velocity: Vector;
  view_ofs: Vector;
  waterlevel: Defs.waterlevel;
  weapon: number;
  weaponframe: number;
  weaponmodel: string | null;
}

let { Con, Host, NET, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Host, NET, SV } = getCommonRegistry());
});

/**
 * Returns a live entity view for an edict.
 * @returns The typed entity bound to the edict.
 */
function requireEntity(edict: ServerEdict): ServerMessageEntity {
  const entity = edict.entity;

  console.assert(entity !== null, 'ServerMessages requires a live edict entity');

  return entity as ServerMessageEntity;
}

/**
 * Returns the initialized worldspawn entity.
 * @returns The current worldspawn entity.
 */
function requireWorldspawnEntity(): WorldspawnMessageEntity {
  const entity = SV.server.edicts[0]?.entity;

  console.assert(entity !== null, 'ServerMessages requires a worldspawn entity');

  return entity as WorldspawnMessageEntity;
}

/**
 * Handles all server to client message assembly and related helpers.
 */
export class ServerMessages {
  readonly nullcmd: Protocol.UserCmd;

  constructor() {
    this.nullcmd = new Protocol.UserCmd();
  }

  startParticle(org: Vector, dir: Vector, color: number, count: number): void {
    const datagram = SV.server.datagram;
    if (datagram.cursize >= 1009) {
      return;
    }
    datagram.writeByte(Protocol.svc.particle);
    datagram.writeCoordVector(org);
    datagram.writeCoordVector(dir);
    datagram.writeByte(Math.min(count, 255));
    datagram.writeByte(color);
  }

  startSound(edict: ServerEdict, channel: number, sample: string, volume: number, attenuation: number): void {
    console.assert(volume >= 0 && volume <= 255, 'volume out of range', volume);
    console.assert(attenuation >= 0.0 && attenuation <= 4.0, 'attenuation out of range', attenuation);
    console.assert(channel >= 0 && channel <= 7, 'channel out of range', channel);

    const datagram = SV.server.datagram;
    if (datagram.cursize >= 1009) {
      return;
    }

    let i;
    for (i = 1; i < SV.server.soundPrecache.length; i++) {
      if (sample === SV.server.soundPrecache[i]) {
        break;
      }
    }
    if (i >= SV.server.soundPrecache.length) {
      Con.Print('SV.StartSound: ' + sample + ' was not precached\n');
      SV.server.soundPrecache.push(sample);
      datagram.writeByte(Protocol.svc.loadsound);
      datagram.writeByte(i);
      datagram.writeString(sample);
    }

    let fieldMask = 0;

    if (volume !== 255) {
      fieldMask |= 1;
    }
    if (attenuation !== 1.0) {
      fieldMask |= 2;
    }

    datagram.writeByte(Protocol.svc.sound);
    datagram.writeByte(fieldMask);
    if ((fieldMask & 1) !== 0) {
      datagram.writeByte(volume);
    }
    if ((fieldMask & 2) !== 0) {
      datagram.writeByte(Math.floor(attenuation * 64.0));
    }
    const entity = requireEntity(edict);

    datagram.writeShort((edict.num << 3) + channel);
    datagram.writeByte(i);
    datagram.writeCoordVector(entity.origin.copy().add(entity.mins.copy().add(entity.maxs).multiply(0.5)));
  }

  /**
   * Sends the serverdata message to a specific client.
   * Needs to be done in order to complete the signon process step 1.
   */
  sendServerData(client: ServerClient): void {
    const message = client.message;
    const worldspawnEntity = requireWorldspawnEntity();
    const activeGameModule = requireActiveGameModule();
    const { author, name, version } = activeGameModule.identification;

    message.writeByte(Protocol.svc.print);
    message.writeString(`\x02\nVERSION ${Host.version!.string} SERVER (${SV.server.gameVersion})\n`);

    message.writeByte(Protocol.svc.serverdata);
    message.writeByte(Protocol.version);
    message.writeString(name);
    message.writeString(author);
    message.writeByte(version[0]);
    message.writeByte(version[1]);
    message.writeByte(version[2]);

    message.writeByte(SV.svs.maxclients);
    message.writeString(worldspawnEntity.message || SV.server.mapname!);
    // SV.pmove.movevars.sendToClient(message);
    for (let i = 1; i < SV.server.modelPrecache.length; i++) {
      message.writeString(SV.server.modelPrecache[i]);
    }
    message.writeByte(0);
    for (let i = 1; i < SV.server.soundPrecache.length; i++) {
      message.writeString(SV.server.soundPrecache[i]);
    }
    message.writeByte(0);

    for (const field of SV.server.clientdataFields) {
      message.writeString(field);
    }
    message.writeByte(0);

    for (const [classname, { fields }] of Object.entries(SV.server.clientEntityFields)) {
      message.writeString(classname);
      for (const field of fields) {
        message.writeString(field);
      }
      message.writeByte(0);
    }
    message.writeByte(0);

    // sounds on worldspawn defines the cd track
    const cdtrack = worldspawnEntity.sounds;

    // only play cd track automatically if set in worldspawn
    if (typeof cdtrack === 'number') {
      message.writeByte(Protocol.svc.cdtrack);
      message.writeByte(cdtrack);
      message.writeByte(0); // unused
    }

    message.writeByte(Protocol.svc.setview);
    message.writeShort(client.edict.num);

    const serverCvars = Array.from(Cvar.Filter((cvar: Cvar) => (cvar.flags & Cvar.FLAG.SERVER) !== 0));
    if (serverCvars.length > 0) {
      client.message.writeByte(Protocol.svc.cvar);
      client.message.writeByte(serverCvars.length);
      for (const serverCvar of serverCvars) {
        this.writeCvar(client.message, serverCvar);
      }
    }

    // make sure the client knows about the paused state
    if (SV.server.paused) {
      client.message.writeByte(Protocol.svc.setpause);
      client.message.writeByte(1);
    }

    message.writeByte(Protocol.svc.signonnum);
    message.writeByte(1);

    client.state = ServerClient.STATE.CONNECTED;
  }

  writeCvar(msg: SzBuffer, cvar: Cvar): void {
    if (cvar.flags & Cvar.FLAG.SECRET) {
      msg.writeString(cvar.name);
      msg.writeString(cvar.string ? 'REDACTED' : '');
    } else {
      msg.writeString(cvar.name);
      msg.writeString(cvar.string);
    }
  }

  cvarChanged(cvar: Cvar): void {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }

      client.message.writeByte(Protocol.svc.cvar);
      client.message.writeByte(1);
      this.writeCvar(client.message, cvar);
    }
  }

  *traversePVS(pvs: Visibility, ignoreEdictIds: number[] = [], alwaysIncludeEdictIds: number[] = [], includeFree = false): Generator<ServerEdict, void, void> {
    for (let e = 1; e < SV.server.num_edicts; e++) {
      const ent = SV.server.edicts[e];

      if (alwaysIncludeEdictIds.includes(e)) {
        yield ent;
        continue;
      }

      if (!includeFree && ent.isFree()) {
        continue;
      }

      if (ignoreEdictIds.includes(e)) {
        continue;
      }

      if (!ent.isInPXS(pvs)) {
        continue;
      }

      yield ent;
    }
  }

  writePlayersToClient(clientEdict: ServerEdict, pvs: Visibility, msg: SzBuffer): boolean {
    let changes = false;

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const cl = SV.svs.clients[i];
      const playerEntity = requireEntity(cl.edict);

      if (cl.state !== ServerClient.STATE.SPAWNED) {
        continue;
      }

      if (!clientEdict.equals(cl.edict) && !clientEdict.isInPXS(pvs)) {
        continue;
      }

      let pflags = Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND;

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

      if (clientEdict.equals(cl.edict)) {
        pflags &= ~(Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND);

        if (playerEntity.weaponframe) {
          pflags |= Protocol.pf.PF_WEAPONFRAME;
        }
      }

      msg.writeByte(Protocol.svc.playerinfo);
      msg.writeByte(i);
      msg.writeShort(pflags);

      msg.writeCoordVector(playerEntity.origin);
      msg.writeByte(playerEntity.frame);

      if (pflags & Protocol.pf.PF_MSEC) {
        const msec = 1000 * (SV.server.time - cl.local_time);
        msg.writeByte(Math.max(0, Math.min(msec, 255)));
      }

      if (pflags & Protocol.pf.PF_COMMAND) {
        const cmd = cl.cmd;

        if (pflags & Protocol.pf.PF_DEAD) {
          cmd.angles.setTo(0, playerEntity.angles[1], 0);
        }

        cmd.buttons = 0;
        cmd.impulse = 0;

        msg.writeDeltaUsercmd(this.nullcmd, cmd);
      }

      if (pflags & Protocol.pf.PF_VELOCITY) {
        msg.writeCoordVector(playerEntity.velocity);
      }

      if (pflags & Protocol.pf.PF_MODEL) {
        msg.writeByte(playerEntity.modelindex);
      }

      if (pflags & Protocol.pf.PF_EFFECTS) {
        msg.writeByte(playerEntity.effects);
      }

      if (pflags & Protocol.pf.PF_SKINNUM) {
        msg.writeByte(playerEntity.skin);
      }

      if (pflags & Protocol.pf.PF_WEAPONFRAME) {
        msg.writeByte(playerEntity.weaponframe);
      }

      changes = true;
    }

    return changes;
  }

  /**
   * Writes delta between two entity states to the message.
   * @returns True when any entity state data was written.
   */
  writeDeltaEntity(msg: SzBuffer, from: ServerEntityState, to: ServerEntityState): boolean {
    const EPSILON = 0.01;

    let bits = 0;

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

    if ((from.colormap || 0) !== (to.colormap || 0)) {
      bits |= Protocol.u.colormap;
    }

    if (from.skin !== to.skin) {
      bits |= Protocol.u.skin;
    }

    if (from.alpha !== to.alpha || from.effects !== to.effects) {
      bits |= Protocol.u.effects;
    }

    if (from.solid !== to.solid) {
      bits |= Protocol.u.solid;
    }

    if (to.nextthink >= SV.server.time && (to.nextthink - from.nextthink) > 0.001) {
      bits |= Protocol.u.nextthink;
    }

    for (let i = 0; i < 3; i++) {
      if (isFinite(to.origin[i]) && Math.abs(from.origin[i] - to.origin[i]) > EPSILON) {
        bits |= Protocol.u.origin1 << i;
      }

      if (isFinite(to.angles[i]) && Math.abs(from.angles[i] - to.angles[i]) > EPSILON) {
        bits |= Protocol.u.angle1 << i;
      }

      if (isFinite(to.velocity[i]) && Math.abs(from.velocity[i] - to.velocity[i]) > EPSILON) {
        bits |= Protocol.u.angle1 << i;
      }
    }

    if (!from.maxs.equals(to.maxs)) {
      bits |= Protocol.u.size;
    }

    if (!from.mins.equals(to.mins)) {
      bits |= Protocol.u.size;
    }

    if (bits === 0) {
      return false;
    }

    console.assert(to.num !== null && to.num > 0, 'valid entity num', to.num);

    msg.writeUint16(to.num!);
    msg.writeUint16(bits);

    if (bits & Protocol.u.classname) {
      msg.writeString(to.classname!);
    }

    if (bits & Protocol.u.free) {
      msg.writeByte(to.free ? 1 : 0);
    }

    if (bits & Protocol.u.frame) {
      msg.writeByte(to.frame);
    }

    if (bits & Protocol.u.model) {
      msg.writeByte(to.modelindex);
    }

    if (bits & Protocol.u.colormap) {
      msg.writeByte(to.colormap);
    }

    if (bits & Protocol.u.skin) {
      msg.writeByte(to.skin);
    }

    if (bits & Protocol.u.effects) {
      msg.writeByte(to.effects);
      msg.writeByte(Math.floor((to.alpha || 1) * 255.0)); // CR: QuakeC may not have alpha
    }

    if (bits & Protocol.u.solid) {
      msg.writeByte(to.solid);
    }

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        msg.writeCoord(to.origin[i]);
      }

      if (bits & (Protocol.u.angle1 << i)) {
        msg.writeAngle(isFinite(to.angles[i]) ? to.angles[i] : 0);
        msg.writeCoord(to.velocity[i]);
      }
    }

    if (bits & Protocol.u.size) {
      msg.writeCoordVector(to.maxs);
      msg.writeCoordVector(to.mins);
    }

    if (bits & Protocol.u.nextthink) {
      if (from.nextthink <= 0) {
        from.nextthink = SV.server.time;
      }
      msg.writeByte(to.nextthink - from.nextthink < 0.250 ? Math.min(255, (to.nextthink - from.nextthink) * 255.0) : 0);
    }

    if (SV.server.clientEntityFields[to.classname!]) {
      const entityFields = SV.server.clientEntityFields[to.classname!];
      const fields = entityFields.fields;
      const bitsWriter = entityFields.bitsWriter as BitsWriter | null;

      let fieldbits = 0;
      const values = [];

      for (const field of fields) {
        if (from.extended[field] !== to.extended[field]) {
          fieldbits |= 1 << fields.indexOf(field);
          values.push(to.extended[field]);
        }
      }

      if (bitsWriter) {
        msg[bitsWriter](fieldbits);
      }

      if (bitsWriter && fieldbits > 0) {
        msg.writeSerializables(values);
      }
    }

    return true;
  }

  writeEntitiesToClient(clientEdict: ServerEdict, msg: SzBuffer): boolean {
    const clientEntity = requireEntity(clientEdict);
    const origin = clientEntity.origin.copy().add(clientEntity.view_ofs);
    const pvs = SV.server.worldmodel!.getFatPvsByPoint(origin);

    let changes = this.writePlayersToClient(clientEdict, pvs, msg) ? 1 : 0;

    const cl = SV.svs.clients[clientEdict.num - 1];

    msg.writeByte(Protocol.svc.deltapacketentities);

    const visedicts = [];

    for (const ent of this.traversePVS(pvs, [], [clientEdict.num])) {
      if ((msg.data.byteLength - msg.cursize) < 16) {
        Con.PrintWarning('SV.WriteEntitiesToClient: packet overflow, not writing more entities\n');
        break;
      }

      const entity = requireEntity(ent);
      const toState = new ServerEntityState(ent.num);
      toState.classname = entity.classname;
      toState.modelindex = entity.model ? entity.modelindex : 0;
      toState.frame = entity.frame;
      toState.colormap = entity.colormap || 0;
      toState.skin = entity.skin;
      toState.solid = entity.solid;
      toState.origin.set(entity.origin);
      toState.angles.set(entity.angles);
      toState.velocity.set(entity.velocity);
      toState.effects = entity.effects;
      toState.alpha = entity.alpha;
      toState.free = false;
      toState.maxs.set(entity.maxs);
      toState.mins.set(entity.mins);
      toState.nextthink = entity.nextthink || 0;

      if (SV.server.clientEntityFields[entity.classname]) {
        const entityFields = SV.server.clientEntityFields[entity.classname];
        const fields = entityFields.fields;
        const serializableEntity = entity as ServerMessageEntity & Record<string, DynamicEntityFieldValue>;

        for (const field of fields) {
          const value = serializableEntity[field];

          if (value !== undefined) {
            toState.extended[field] = value;
          }
        }
      }

      const fromState = cl.getEntityState(ent.num);

      changes |= this.writeDeltaEntity(msg, fromState, toState) ? 1 : 0;

      fromState.set(toState);

      visedicts.push(ent.num);
    }

    for (let i = 1; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (visedicts.includes(ent.num)) {
        continue;
      }

      const fromState = cl.getEntityState(ent.num);
      const toState = new ServerEntityState(ent.num);
      toState.freeEdict();

      changes |= this.writeDeltaEntity(msg, fromState, toState) ? 1 : 0;
      fromState.set(toState);
    }

    msg.writeShort(0);

    return changes > 0;
  }

  writeClientdataToMessage(client: ServerClient, msg: SzBuffer): boolean {
    const clientEdict = client.edict;
    const clientEntity = requireEntity(clientEdict);

    if ((clientEntity.dmg_take || clientEntity.dmg_save) && clientEntity.dmg_inflictor) {
      const inflictor = clientEntity.dmg_inflictor;
      const other = 'edict' in inflictor && inflictor.edict ? inflictor.edict : inflictor;
      const otherEntity = requireEntity(other as ServerEdict);
      const vec = !other.isFree() ? otherEntity.origin.copy().add(otherEntity.mins.copy().add(otherEntity.maxs).multiply(0.5)) : clientEntity.origin;
      msg.writeByte(Protocol.svc.damage);
      msg.writeByte(Math.min(255, clientEntity.dmg_save));
      msg.writeByte(Math.min(255, clientEntity.dmg_take));
      msg.writeCoordVector(vec);
      clientEntity.dmg_take = 0.0;
      clientEntity.dmg_save = 0.0;
    }

    if (clientEntity.fixangle) {
      msg.writeByte(Protocol.svc.setangle);
      msg.writeAngleVector(clientEntity.angles);
      clientEntity.fixangle = false;
    }

    let bits = Protocol.su.moveack;
    if (clientEntity.view_ofs[2] !== Protocol.default_viewheight) {
      bits |= Protocol.su.viewheight;
    }
    if (clientEntity.idealpitch !== 0.0) {
      bits |= Protocol.su.idealpitch;
    }

    if (clientEntity.flags & Defs.flags.FL_ONGROUND) {
      bits |= Protocol.su.onground;
    }
    if (clientEntity.waterlevel >= Defs.waterlevel.WATERLEVEL_WAIST) {
      bits |= Protocol.su.inwater;
    }

    const punchangle = clientEntity.punchangle;

    if (punchangle[0] !== 0.0) {
      bits |= Protocol.su.punch1;
    }
    if (punchangle[1] !== 0.0) {
      bits |= Protocol.su.punch2;
    }
    if (punchangle[2] !== 0.0) {
      bits |= Protocol.su.punch3;
    }

    msg.writeByte(Protocol.svc.clientdata);
    msg.writeShort(bits);
    if ((bits & Protocol.su.viewheight) !== 0) {
      msg.writeChar(clientEntity.view_ofs[2]);
    }
    if ((bits & Protocol.su.idealpitch) !== 0) {
      msg.writeChar(clientEntity.idealpitch);
    }

    if ((bits & Protocol.su.punch1) !== 0) {
      msg.writeShort(punchangle[0] * 90);
    }
    if ((bits & Protocol.su.punch2) !== 0) {
      msg.writeShort(punchangle[1] * 90.0);
    }
    if ((bits & Protocol.su.punch3) !== 0) {
      msg.writeShort(punchangle[2] * 90.0);
    }

    if ((bits & Protocol.su.moveack) !== 0) {
      msg.writeByte(client.lastMoveSequence);
      // send authoritative PM state alongside the move ack so the client
      // can start prediction replay from the correct pmFlags / pmTime
      msg.writeByte(client.pmFlags);
      msg.writeByte(client.pmTime);
      msg.writeByte(client.pmOldButtons);
    }

    const clientdataFields = SV.server.clientdataFields;
    const destination = msg;

    let fieldbits = 0;
    const values = [];
    const serializableEntity = clientEntity as ServerMessageEntity & Record<string, DynamicEntityFieldValue>;

    for (let i = 0; i < clientdataFields.length; i++) {
      const field = clientdataFields[i];
      const value = serializableEntity[field];

      if (!value) {
        continue;
      }

      fieldbits |= (1 << i);
      values.push(value);
    }

    const bitsWriter = SV.server.clientdataFieldsBitsWriter as BitsWriter | null;
    console.assert(bitsWriter !== null, 'clientdataFieldsBitsWriter must be configured for GameModule clientdata');
    if (bitsWriter !== null) {
      destination[bitsWriter](fieldbits);
      destination.writeSerializables(values);
    }

    return true;
  }

  /**
   * Sends a datagram to a specific client.
   * @returns True when the datagram contained any replicated changes.
   */
  sendClientDatagram(client: ServerClient): boolean {
    const msg = new SzBuffer(16000, 'SV.SendClientDatagram');
    msg.writeByte(Protocol.svc.time);
    msg.writeFloat(SV.server.time);

    let changes = 0;

    if (Host.realtime - client.last_ping_update >= 1) {
      for (let i = 0; i < SV.svs.clients.length; i++) {
        const pingClient = SV.svs.clients[i];

        if (pingClient.state < ServerClient.STATE.CONNECTED) {
          continue;
        }

        msg.writeByte(Protocol.svc.updatepings);
        msg.writeByte(i);
        msg.writeShort(Math.max(0, Math.min(Math.round(pingClient.ping * 10), 30000)));

        changes |= 1;
      }

      client.last_ping_update = Host.realtime;
    }

    if (client.expedited_message.cursize > 0 && (msg.cursize + client.expedited_message.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(client.expedited_message.data), client.expedited_message.cursize);
      client.expedited_message.clear();
      changes |= 1;
    }

    if ((msg.cursize + SV.server.expedited_datagram.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(SV.server.expedited_datagram.data), SV.server.expedited_datagram.cursize);
      changes |= 1;
    }

    changes |= this.writeClientdataToMessage(client, msg) ? 1 : 0;
    changes |= this.writeEntitiesToClient(client.edict, msg) ? 1 : 0;

    if (client.state !== ServerClient.STATE.SPAWNED) {
      Con.DPrint('SV.SendClientDatagram: not spawned\n');
      return true;
    }

    if (!changes) {
      Con.DPrint('SV.SendClientDatagram: no changes for client ' + client.num + '\n');
    }

    client.last_update = SV.server.time;

    if ((msg.cursize + SV.server.datagram.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(SV.server.datagram.data), SV.server.datagram.cursize);
    }

    if (NET.SendUnreliableMessage(client.netconnection, msg) === -1) {
      Host.DropClient(client, true, 'Connectivity issues');
      return false;
    }
    return true;
  }

  updateToReliableMessages(): void {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const currentClient = SV.svs.clients[i];
      const frags = currentClient.edict.entity ? requireEntity(currentClient.edict).frags | 0 : 0;
      if (currentClient.old_frags === frags) {
        continue;
      }
      for (let j = 0; j < SV.svs.maxclients; j++) {
        const client = SV.svs.clients[j];
        if (client.state < ServerClient.STATE.CONNECTED) {
          continue;
        }
        client.message.writeByte(Protocol.svc.updatefrags);
        client.message.writeByte(i);
        client.message.writeShort(frags);
      }
      currentClient.old_frags = frags;
    }

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (client.state >= ServerClient.STATE.CONNECTED) {
        client.message.write(new Uint8Array(SV.server.reliable_datagram.data), SV.server.reliable_datagram.cursize);
      }
    }

    SV.server.reliable_datagram.clear();
  }

  sendClientMessages(): void {
    this.updateToReliableMessages();

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (client.state < ServerClient.STATE.CONNECTED) {
        continue;
      }
      if (client.state === ServerClient.STATE.SPAWNED) {
        if (!this.sendClientDatagram(client)) {
          continue;
        }
      }
      if (client.message.overflowed) {
        Host.DropClient(client, true, 'Connectivity issues, too many messages');
        client.message.overflowed = false;
        continue;
      }
      if (client.state === ServerClient.STATE.DROPASAP) {
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
      }
    }

    for (let i = 1; i < SV.server.num_edicts; i++) {
      if (SV.server.edicts[i].isFree()) {
        continue;
      }

      requireEntity(SV.server.edicts[i] as ServerEdict).effects &= ~Defs.effect.EF_MUZZLEFLASH;
    }
  }
}
