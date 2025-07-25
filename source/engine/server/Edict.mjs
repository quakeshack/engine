import Vector from '../../shared/Vector.mjs';
import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import { eventBus, registry } from '../registry.mjs';
import Q from '../common/Q.mjs';
import { ConsoleCommand } from '../common/Cmd.mjs';

let { COM, Con, Host, Mod, PR, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  PR = registry.PR;
  SV = registry.SV;
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
    if (i === Def.limits.edicts) {
      // TODO: soft limit, hard limit, also allocate directly 200 more in one go
      Con.PrintWarning(`ED.Alloc triggered Def.limits.edicts (${Def.limits.edicts})\n`);
    }
    e = SV.server.edicts[SV.server.num_edicts++];
    if (!e) {
      e = new SV.Edict(i);
      SV.server.edicts.push(e);
    }
    ED.ClearEdict(e);
    return e;
  }

  /** @param {ServerEdict} ed edict */
  static Free(ed) { // TODO: move to SV.Edict
    SV.UnlinkEdict(ed);
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
    let i; let ent; let active = 0; let models = 0; let solid = 0; let step = 0;
    for (i = 0; i < SV.server.num_edicts; i++) {
      ent = SV.server.edicts[i];
      if (ent.isFree() === true) {
        continue;
      }
      ++active;
      if (ent.entity.solid) {
        ++solid;
      }
      if (ent.entity.model) {
        ++models;
      }
      if (ent.entity.movetype === SV.movetype.step) {
        ++step;
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
  static LoadFromFile(data) {
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

      const initialData = {};
      ent = ent ? ED.Alloc() : SV.server.edicts[0];
      data = ED.ParseEdict(data, ent, initialData);

      if (!initialData.classname) {
        Con.Print(`No classname for edict ${ent.num}\n`);
        ED.Free(ent);
        continue;
      }

      const maySpawn = SV.server.gameAPI.prepareEntity(ent, initialData.classname, initialData);

      if (!maySpawn) {
        ED.Free(ent);
        inhibit++;
        continue;
      }

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
  /**
   * @param {number} num edict number
   */
  constructor(num) {
    this.num = num;
    this.free = false;
    this.area = {
      ent: this,
    };
    this.leafnums = [];
    this.freetime = 0.0;
    /** @type {import('../../game/id1/entity/BaseEntity.mjs').default} */
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
    SV.LinkEdict(this, touchTriggers);
  }

  /**
   * Sets the model, also sets mins/maxs when applicable.
   * Model has to be precached, otherwise an Error is thrown.
   * @throws {Error} Model not precached.
   * @param {string} model path to the model, e.g. progs/player.mdl
   */
  setModel(model) {
    let i;

    for (i = 0; i < SV.server.model_precache.length; i++) {
      if (SV.server.model_precache[i] === model) {
        break;
      }
    }

    if (i === SV.server.model_precache.length) {
      throw new Error('Edict.setModel: ' + model + ' not precached');
    }

    this.entity.model = model;
    this.entity.modelindex = i;

    const mod = SV.server.models[i];

    if (mod) {
      this.setMinMaxSize(mod.mins, mod.maxs);
    } else {
      this.setMinMaxSize(Vector.origin, Vector.origin);
    }
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw yaw in degrees
   * @param {number} dist distance to move
   * @returns {boolean} true, when walking was successful
   */
  walkMove(yaw, dist) {
    if ((this.entity.flags & (SV.fl.onground + SV.fl.fly + SV.fl.swim)) === 0) {
      return false;
    }

    yaw *= (Math.PI / 180.0);

    return SV.movestep(this, new Vector(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0.0), true);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} z maximum distance to look down to check
   * @returns {boolean} true, when the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    const end = this.entity.origin.copy().add(new Vector(0.0, 0.0, z));
    const trace = SV.Move(this.entity.origin, this.entity.mins, this.entity.maxs, end, 0, this);

    if (trace.fraction === 1.0 || trace.allsolid) {
      return false;
    }

    this.setOrigin(trace.endpos);
    this.entity.flags |= SV.fl.onground;
    this.entity.groundentity = trace.ent.entity;

    return true;
  }

  /**
   * Checks if the entity is standing on the ground.
   * @returns {boolean} true, when edict touches the ground
   */
  isOnTheFloor() {
    return SV.CheckBottom(this);
  }

  /**
   * It will send a svc_spawnstatic upon signon to make clients register a static entity.
   * Also this will free and release this Edict.
   */
  makeStatic() {
    const message = SV.server.signon;
    MSG.WriteByte(message, Protocol.svc.spawnstatic);
    MSG.WriteString(message, this.entity.classname); // FIXME: compress this, it’s ballooning the signon buffer.
    MSG.WriteByte(message, SV.ModelIndex(this.entity.model));
    MSG.WriteByte(message, this.entity.frame || 0);
    MSG.WriteByte(message, this.entity.colormap || 0);
    MSG.WriteByte(message, this.entity.skin || 0);
    MSG.WriteByte(message, this.entity.effects || 0);
    MSG.WriteByte(message, this.entity.solid || 0);
    MSG.WriteAngleVector(message, this.entity.angles);
    MSG.WriteCoordVector(message, this.entity.origin);
    this.freeEdict();
  }

  /**
   * Returns client (or object that has a client enemy) that would be * a valid target. If there are more than one
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
        if (ent.entity.health <= 0.0 || (ent.entity.flags & SV.fl.notarget) !== 0) {
          continue;
        }
        break;
      }
      SV.server.lastcheck = i;
      SV.lastcheckpvs = Mod.LeafPVS(Mod.PointInLeaf(ent.entity.origin.copy().add(ent.entity.view_ofs), SV.server.worldmodel), SV.server.worldmodel); // FIXME: use ….worldmodel.getPointInLeaf() etc.
      SV.server.lastchecktime = SV.server.time;
    }

    const ent = SV.server.edicts[SV.server.lastcheck];

    if (ent.isFree() || ent.entity.health <= 0.0) { // TODO: better interface, not health
      // not interesting anymore
      return null;
    }

    const l = Mod.PointInLeaf(this.entity.origin.copy().add(this.entity.view_ofs), SV.server.worldmodel).num - 1;

    if (l < 0 || (SV.lastcheckpvs[l >> 3] & (1 << (l & 7))) === 0) {
      // back side leaf or leaf is not visible according to PVS
      return null;
    }

    return ent;
  }

  /**
   * Checks if this entity is in the given PVS.
   * @param {number[]} pvs PVS to check against
   * @returns {boolean} true, when this entity is in the PVS
   */
  isInPVS(pvs) {
    for (let i = 0; i < this.leafnums.length; i++) {
      if ((pvs[this.leafnums[i] >> 3] & (1 << (this.leafnums[i] & 7))) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Move this entity toward its goal. Used for monsters.
   * @param {number} dist distance to move
   * @returns {boolean} true, when successful
   */
  moveToGoal(dist) {
    if ((this.entity.flags & (SV.fl.onground + SV.fl.fly + SV.fl.swim)) === 0) {
      return false;
    }

    // FIXME: interfaces, edict, entity
    const goal = this.entity.goalentity?.edict ? this.entity.goalentity.edict : this.entity.goalentity;
    const enemy = this.entity.enemy?.edict ? this.entity.enemy.edict : this.entity.enemy;

    console.assert(goal !== null, 'must have goal for moveToGoal');

    if (enemy !== null && !enemy.isWorld() && SV.CloseEnough(this, goal, dist)) {
      return false;
    }

    if (Math.random() >= 0.75 || !SV.StepDirection(this, this.entity.ideal_yaw, dist)) {
      SV.NewChaseDir(this, goal, dist);

      return true;
    }

    return false;
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
    const tr = SV.Move(start, Vector.origin, Vector.origin, end, 0, this);
    if (tr.ent !== null) {
      if ((tr.ent.entity.takedamage === SV.damage.aim) && (!Host.teamplay.value || this.entity.team <= 0 || this.entity.team !== tr.ent.entity.team)) {
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
      if (check.entity.takedamage !== SV.damage.aim) {
        continue;
      }
      if (check.equals(this)) {
        continue;
      }
      if ((Host.teamplay.value !== 0) && (this.entity.team > 0) && (this.entity.team === check.entity.team)) {
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
      const tr = SV.Move(start, Vector.origin, Vector.origin, end, 0, this);
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
    angles[1] = SV.ChangeYaw(this);
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
