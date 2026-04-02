import Vector from '../../shared/Vector.ts';
import { SzBuffer, registerSerializableType } from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import * as Defs from '../../shared/Defs.ts';
import { eventBus, registry } from '../registry.mjs';
import Q from '../../shared/Q.ts';
import { ConsoleCommand } from '../common/Cmd.mjs';
import { ClientEdict } from '../client/ClientEntities.mjs';
import { OctreeNode } from '../../shared/Octree.ts';
import { Visibility } from '../common/model/BSP.mjs';

/** @typedef {import('../../game/id1/entity/BaseEntity.mjs').default} BaseEntity */
/** @typedef {import('../../game/id1/entity/Worldspawn.mjs').WorldspawnEntity} WorldspawnEntity */

let { CL, COM, Con, Host, NET, PR, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Host, NET, PR, SV } = registry);
});

/** @typedef {import('./Client.mjs').ServerClient} ServerClient */

export class ED {
  /** @param {ServerEdict} ed edict */
  static ClearEdict(ed) { // TODO: move to SV.Edict
    if (ed.entity) {
      ed.entity.free();
      ed.entity = null;
    }
    ed.clear();
    ed.free = false;
  }

  static Alloc() { // TODO: move to SV?
    let i;
    /** @type {ServerEdict} */
    let e;
    for (i = SV.svs.maxclients + 1; i < SV.server.num_edicts; i++) {
      e = SV.server.edicts[i];
      if ((e.free === true) && ((e.freetime < 2.0) || ((SV.server.time - e.freetime) > 0.5))) {
        ED.ClearEdict(e);
        return e;
      }
    }
    if ((i % Def.limits.edicts) === 0) {
      // allocate another block
      SV.server.edicts.length += Def.limits.edicts;
      for (let j = i; j < SV.server.edicts.length; j++) {
        SV.server.edicts[j] = new ServerEdict(j);
      }
      Con.DPrint(`ED.Alloc triggered Def.limits.edicts (${Def.limits.edicts})\n`);
    }
    e = SV.server.edicts[SV.server.num_edicts++];
    ED.ClearEdict(e);
    return e;
  }

  /** @param {ServerEdict} ed edict */
  static Free(ed) { // TODO: move to SV.Edict
    SV.area.unlinkEdict(ed);
    // mark as free, it will be cleared later
    ed.free = true;
    if (ed.entity) {
      // only reset the data, not free the entire entity yet
      // freeing the entity is done in ED.ClearEdict
      ed.entity.clear();
    }
    ed.freetime = SV.server.time;
  }

  /** @param {ServerEdict} ed edict */
  static Print(ed) {
    if (ed.isFree()) {
      return;
    }
    Con.Print('\nEDICT ' + ed.num + ':\n');

    for (let i = 1; i < PR.fielddefs.length; i++) {
      const d = PR.fielddefs[i];
      const name = PR.GetString(d.name);

      if (/_[xyz]$/.test(name)) {
        continue;
      }

      Con.Print(`${name.padStart(24, '.')}: ${ed.entity[name]}\n`);
    }
  }

  static PrintEdicts() {
    if (!SV.server.active) {
      return;
    }

    Con.Print(`${SV.server.num_edicts} entities\n`);
    SV.server.edicts.forEach(ED.Print);
  }

  static PrintEdict_f = class extends ConsoleCommand {
    run(id) {
      if (SV.server.active !== true) {
        return;
      }
      if (id === undefined) {
        Con.Print(`Usage: ${this.command} <num>\n`);
        return;
      }
      const i = Q.atoi(id);
      if ((i >= 0) && (i < SV.server.num_edicts)) {
        ED.Print(SV.server.edicts[i]);
      }
    }
  };

  static Count() {
    if (SV.server.active !== true) {
      return;
    }
    let active = 0, models = 0, solid = 0, step = 0;
    for (let i = 0; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];
      if (ent.isFree() === true) {
        continue;
      }
      active++;
      if (ent.entity.solid) {
        solid++;
      }
      if (ent.entity.model) {
        models++;
      }
      if (ent.entity.movetype === Defs.moveType.MOVETYPE_STEP) {
        step++;
      }
    }
    const num_edicts = SV.server.num_edicts;
    Con.Print('num_edicts:' + (num_edicts <= 9 ? '  ' : (num_edicts <= 99 ? ' ' : '')) + num_edicts + '\n');
    Con.Print('active    :' + (active <= 9 ? '  ' : (active <= 99 ? ' ' : '')) + active + '\n');
    Con.Print('view      :' + (models <= 9 ? '  ' : (models <= 99 ? ' ' : '')) + models + '\n');
    Con.Print('touch     :' + (solid <= 9 ? '  ' : (solid <= 99 ? ' ' : '')) + solid + '\n');
    Con.Print('step      :' + (step <= 9 ? '  ' : (step <= 99 ? ' ' : '')) + step + '\n');
  }

  static ParseEdict(data, ent, initialData = {}) {
    // If not the world entity, clear the entity data
    // CR: this is required, otherwise we would overwrite data SV.SpawnServer had set prior
    if (ent.num > 0) {
      ent.clear();
    }

    let keyname;
    let anglehack;
    let init = false;

    // Parse until closing brace
    while (true) {
      const parsedKey = COM.Parse(data);

      data = parsedKey.data;

      if (parsedKey.token.charCodeAt(0) === 125) {
        // Closing brace found
        break;
      }

      if (data === null) {
        throw new Error('ED.ParseEdict: EOF without closing brace');
      }

      if (parsedKey.token === 'angle') {
        keyname = 'angles';
        anglehack = true;
      } else {
        keyname = parsedKey.token;
        anglehack = false;

        if (keyname === 'light') {
          keyname = 'light_lev'; // Quake 1 convention
        }
      }

      // Remove trailing spaces in keyname
      keyname = keyname.trimEnd();

      // Parse the value
      const parsedValue = COM.Parse(data);

      data = parsedValue.data;

      if (data === null) {
        throw new Error('ED.ParseEdict: EOF without closing brace');
      }

      if (parsedValue.token.charCodeAt(0) === 125) {
        throw new Error('ED.ParseEdict: Closing brace without data');
      }

      if (keyname.startsWith('_')) {
        // Ignore keys starting with "_"
        continue;
      }

      if (anglehack) {
        parsedValue.token = `0 ${parsedValue.token} 0`;
      }

      initialData[keyname] = parsedValue.token.replace(/\\n/g, '\n');

      init = true;
    }

    // Mark the entity as free if no valid initialization occurred
    if (!init) {
      ent.free = true;
    }

    return data;
  }

  /**
   * Loads entities from a file.
   * @param {string} data - The data to load.
   */
  static async LoadFromFile(data) {
    let inhibit = 0;
    let ent = null;
    SV.server.gameAPI.time = SV.server.time;

    while (true) {
      const parsed = COM.Parse(data);

      if (!parsed.data) {
        break;
      }

      data = parsed.data;

      if (parsed.token !== '{') {
        throw new Error(`ED.LoadFromFile: found ${parsed.token} when expecting {`);
      }

      /** @type {import('source/shared/GameInterfaces').EdictData} */
      const initialData = {};
      ent = ent ? ED.Alloc() : SV.server.edicts[0];
      data = ED.ParseEdict(data, ent, initialData);

      if (!initialData.classname) {
        Con.Print(`No classname for edict ${ent.num}\n`);
        ED.Free(ent);
        continue;
      }

      // console.assert(ent.num === 0 && initialData.classname === 'worldspawn', 'Edict 0 must be worldspawn');

      const maySpawn = SV.server.gameAPI.prepareEntity(ent, /** @type {string} */(initialData.classname), initialData);

      if (!maySpawn) {
        ED.Free(ent);
        inhibit++;
        continue;
      }

      await SV.WaitForPrecachedResources();

      const spawned = SV.server.gameAPI.spawnPreparedEntity(ent);

      if (!spawned) {
        Con.Print(`Could not spawn entity for edict ${ent.num}:\n`);
        ED.Print(ent);
        ED.Free(ent);
        continue;
      }
    }

    Con.DPrint(`${inhibit} entities inhibited\n`);
  }
}

export class ServerEdict {
  static #lastcheckpvs = /** @type {Visibility|null} */ (null);

  /**
   * @param {number} num edict number
   */
  constructor(num) {
    this.num = num;
    this.free = false;
    /** @type {OctreeNode|null} used for fast lookup */
    this.octreeNode = null;
    /** @type {number[]} used for PXS lookup */
    this.leafnums = [];
    this.freetime = 0.0;
    /** @type {BaseEntity|null} entity managed by the game code */
    this.entity = null;
  }

  clear() {
    if (this.entity) {
      this.entity.free();
      this.entity = null;
    }
  }

  /**
   * Edict is no longer in use
   * @returns {boolean} true when freed/unused
   */
  isFree() {
    return this.free || !this.entity;
  }

  get origin() { // for Octree use
    return this.entity ? this.entity.origin : null;
  }

  get absmin() { // for Octree use
    return this.entity ? this.entity.absmin : null;
  }

  get absmax() { // for Octree use
    return this.entity ? this.entity.absmax : null;
  }

  toString() {
    if (this.isFree()) {
      return `unused (${this.num})`;
    }

    return `Edict (${this.entity.classname}, num: ${this.num}, origin: ${this.entity.origin})`;
  }

  /**
   * Gives up this edict and can be reused differently later.
   */
  freeEdict() {
    ED.Free(this);
  }

  /**
   *
   * @param {ServerEdict} otherEdict other edict
   * @returns {boolean} whether it’s equal
   */
  equals(otherEdict) {
    return otherEdict && this.num === otherEdict.num;
  }

  /**
   * @param {Vector} min min
   * @param {Vector} max max
   */
  setMinMaxSize(min, max) {
    // FIXME: console.assert this check
    if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
      throw new Error('Edict.setMinMaxSize: backwards mins/maxs');
    }

    this.entity.mins = min.copy();
    this.entity.maxs = max.copy();
    this.entity.size = max.copy().subtract(min);
    this.linkEdict(true);
  }

  /**
   * @param {Vector} vec origin
   */
  setOrigin(vec) {
    this.entity.origin = vec.copy();
    this.linkEdict(false);
  }

  linkEdict(touchTriggers = false) {
    SV.area.linkEdict(this, touchTriggers);
  }

  /**
   * Sets the model, also sets mins/maxs when applicable.
   * Model has to be precached, otherwise an Error is thrown.
   * @throws {Error} Model not precached.
   * @param {string} model path to the model, e.g. progs/player.mdl
   */
  setModel(model) {
    let i;

    for (i = 0; i < SV.server.modelPrecache.length; i++) {
      if (SV.server.modelPrecache[i] === model) {
        break;
      }
    }

    if (i === SV.server.modelPrecache.length) {
      throw new Error('Edict.setModel: ' + model + ' not precached');
    }

    this.entity.model = model;
    this.entity.modelindex = i;

    const mod = SV.server.models[i];

    if (mod instanceof Promise) {
      // model is not yet loaded, this happens when spawning an entity and it’s calling precache AND setmodel right after (QuakeC jank)
      void mod.then((loadedModel) => {
        this.setMinMaxSize(loadedModel.mins, loadedModel.maxs);
      });
      return;
    }

    if (mod) {
      this.setMinMaxSize(mod.mins, mod.maxs);
    } else {
      this.setMinMaxSize(Vector.origin, Vector.origin);
    }

    // CR: dear future me, investigate the fun issues with entities with SOLID_BSP and non-brush models, right now it breaks Pmove and a few other things.
    if (this.entity.solid === Defs.solid.SOLID_BSP) {
      console.assert(mod && mod.type === 0, 'Edict.setModel: not a brush model for SOLID_BSP');
    }
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw yaw in degrees
   * @param {number} dist distance to move
   * @returns {boolean} true, when walking was successful
   */
  walkMove(yaw, dist) {
    return SV.movement.walkMove(this, yaw, dist);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} z maximum distance to look down to check
   * @returns {boolean} true, when the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    const end = this.entity.origin.copy().add(new Vector(0.0, 0.0, z));
    const trace = SV.collision.move(this.entity.origin, this.entity.mins, this.entity.maxs, end, 0, this);

    if (trace.fraction === 1.0 || trace.allsolid) {
      return false;
    }

    this.setOrigin(trace.endpos);
    this.entity.flags |= Defs.flags.FL_ONGROUND;
    this.entity.groundentity = trace.ent.entity;

    return true;
  }

  /**
   * Checks if the entity is standing on the ground.
   * @returns {boolean} true, when edict touches the ground
   */
  isOnTheFloor() {
    return SV.movement.checkBottom(this);
  }

  /**
   * It will send a svc_spawnstatic upon signon to make clients register a static entity.
   * Also this will free and release this Edict.
   */
  makeStatic() {
    const message = SV.server.signon;
    message.writeByte(Protocol.svc.spawnstatic);
    message.writeString(this.entity.classname); // FIXME: compress this, it’s ballooning the signon buffer.
    message.writeByte(SV.ModelIndex(this.entity.model));
    message.writeByte(this.entity.frame || 0);
    message.writeByte(this.entity.colormap || 0);
    message.writeByte(this.entity.skin || 0);
    message.writeByte(this.entity.effects || 0);
    message.writeByte(Math.floor(this.entity.alpha * 255.0));
    message.writeByte(this.entity.solid || 0);
    message.writeAngleVector(this.entity.angles);
    message.writeCoordVector(this.entity.origin);
    this.freeEdict();
  }

  /**
   * Returns client (or object that has a client enemy) that would be a valid target. If there are more than one
   * valid options, they are cycled each frame. If (self.origin + self.viewofs) is not in the PVS of the target, null is returned.
   * @returns {ServerEdict} Edict when client found, null otherwise
   */
  getNextBestClient() { // TODO: move to GameAPI, this is not interesting for edicts
    // refresh check cache
    if (SV.server.time - SV.server.lastchecktime >= 0.1) {
      let check = SV.server.lastcheck;
      if (check <= 0) {
        check = 1;
      } else if (check > SV.svs.maxclients) {
        check = SV.svs.maxclients;
      }
      let i = 1;
      if (check !== SV.svs.maxclients) {
        i += check;
      }
      let ent;
      for (; ; i++) {
        if (i === SV.svs.maxclients + 1) {
          i = 1;
        }
        ent = SV.server.edicts[i];
        if (i === check) {
          break;
        }
        if (ent.isFree()) {
          continue;
        }
        if (ent.entity.health <= 0.0 || (ent.entity.flags & Defs.flags.FL_NOTARGET) !== 0) {
          continue;
        }
        break;
      }
      SV.server.lastcheck = i;
      ServerEdict.#lastcheckpvs = SV.server.worldmodel.getPvsByPoint(ent.entity.origin.copy().add(ent.entity.view_ofs));
      SV.server.lastchecktime = SV.server.time;
    }

    const ent = SV.server.edicts[SV.server.lastcheck];

    if (ent.isFree() || ent.entity.health <= 0.0) { // TODO: better interface, not health
      // not interesting anymore
      return null;
    }

    const l = SV.server.worldmodel.getLeafForPoint(this.entity.origin.copy().add(this.entity.view_ofs)).num;

    if (l === 0 || !ServerEdict.#lastcheckpvs.isRevealed(l)) {
      // outside leaf (sentinel) or leaf is not visible according to PVS
      return null;
    }

    return ent;
  }

  /**
   * Checks if this entity is in the given PHS/PVS.
   * @param {Visibility} pxs PHS/PVS to check against
   * @returns {boolean} true, when this entity is in the PVS
   */
  isInPXS(pxs) {
    return pxs.areRevealed(this.leafnums);
  }

  /**
   * Move this entity toward its goal. Used for monsters.
   * @param {number} dist distance to move
   * @param {Vector | null} target optional target position, otherwise .goalentity is used
   * @returns {boolean} true, when successful
   */
  moveToGoal(dist, target = null) {
    return SV.movement.moveToGoal(this, dist, target);
  }

  /**
   * Returns a vector along which this entity can shoot.
   * Usually, this entity is a player, and the vector returned is calculated by auto aiming to the closest enemy entity.
   * NOTE: The original code and unofficial QuakeC reference docs say there’s an argument (speed/misslespeed), but it’s unused.
   * @param {Vector} direction e.g. forward
   * @returns {Vector} aim direction
   */
  aim(direction) {
    const dir = direction.copy();
    const origin = this.entity.origin.copy();
    const start = origin.add(new Vector(0.0, 0.0, 20.0));

    const end = new Vector(start[0] + 2048.0 * dir[0], start[1] + 2048.0 * dir[1], start[2] + 2048.0 * dir[2]);
    const tr = SV.collision.move(start, Vector.origin, Vector.origin, end, 0, this);
    if (tr.ent !== null) {
      if ((tr.ent.entity.takedamage === Defs.damage.DAMAGE_AIM) && (!Host.teamplay.value || this.entity.team <= 0 || this.entity.team !== tr.ent.entity.team)) { // Legacy cvars
        return dir;
      }
    }
    const bestdir = dir.copy();
    let bestdist = SV.aim.value;
    let bestent = null;
    for (let i = 1; i < SV.server.num_edicts; i++) {
      const check = SV.server.edicts[i];
      if (check.isFree()) {
        continue;
      }
      if (check.entity.takedamage !== Defs.damage.DAMAGE_AIM) {
        continue;
      }
      if (check.equals(this)) {
        continue;
      }
      if ((Host.teamplay.value !== 0) && (this.entity.team > 0) && (this.entity.team === check.entity.team)) { // Legacy cvars
        continue;
      }
      const corigin = check.entity.origin, cmins = check.entity.mins, cmaxs = check.entity.maxs;
      end.set(corigin).add(cmins.copy().add(cmaxs).multiply(0.5));
      dir.set(end).subtract(start);
      dir.normalize();
      let dist = dir.dot(bestdir);
      if (dist < bestdist) {
        continue;
      }
      const tr = SV.collision.move(start, Vector.origin, Vector.origin, end, 0, this);
      if (tr.ent === check) {
        bestdist = dist;
        bestent = check;
      }
    }
    if (bestent !== null) {
      dir.set(bestent.entity.origin).subtract(this.entity.origin);
      const dist = dir.dot(bestdir);
      end[0] = bestdir[0] * dist;
      end[1] = bestdir[1] * dist;
      end[2] = dir[2];
      end.normalize();
      return end;
    }
    return bestdir;
  }

  /**
   * Returns entity that is just after this in the entity list.
   * Useful to browse the list of entities, because it skips the undefined ones.
   * @returns {ServerEdict | null} next edict, or null if there are no more entities
   */
  nextEdict() {
    for (let i = this.num + 1; i < SV.server.num_edicts; i++) {
      if (!SV.server.edicts[i].isFree()) {
        return SV.server.edicts[i];
      }
    }

    return null;
  }

  /**
   * Change the horizontal orientation of this entity. Turns towards .ideal_yaw at .yaw_speed. Called every 0.1 sec by monsters.
   * @returns {number} new yaw angle
   */
  changeYaw() {
    const angles = this.entity.angles;
    angles[1] = SV.movement.changeYaw(this);
    this.entity.angles = angles;

    return angles[1];
  }

  /**
   * returns the corresponding client object
   * @returns {ServerClient | null} client object, if edict is actually a client edict
   */
  getClient() {
    return SV.svs.clients[this.num - 1] || null;
  }

  /**
   * check if edict is a client edict
   * @returns {boolean} true, when edict is a client edict
   */
  isClient() {
    return (this.num > 0) && (this.num <= SV.svs.maxclients);
  }

  /**
   * checks if this entity is worldspawn
   * @returns {boolean} true, when edict represents world
   */
  isWorld() {
    return this.num === 0;
  }
};

registerSerializableType(ServerEdict, {
  /**
   * @param {SzBuffer} sz serialization buffer
   * @param {ServerEdict} object edict to serialize
   */
  serialize(sz, object) {
    sz.writeShort(object.num);
  },

  /**
   * @param {SzBuffer} sz serialization buffer
   * @returns {ServerEdict} deserialized edict
   */
  // eslint-disable-next-line no-unused-vars
  deserializeOnServer(sz) {
    const num = NET.message.readShort();
    console.assert(num >= 0 && num < SV.server.num_edicts, `ServerEdict.deserialize: invalid edict number ${num}`);
    return SV.server.edicts[num];
  },

  /**
   * @param {SzBuffer} sz serialization buffer
   * @returns {ClientEdict} deserialized edict
   */
  // eslint-disable-next-line no-unused-vars
  deserializeOnClient(sz) {
    return CL.state.clientEntities.getEntity(NET.message.readShort());
  },
});
