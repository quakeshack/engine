import { SerializableEntity, type EdictData } from '../../shared/GameInterfaces.ts';
import type { WorldspawnEntity as WorldspawnEntityValue } from '../../game/id1/entity/Worldspawn.mjs';
import type { OctreeNode } from '../../shared/Octree.ts';
import type { Visibility } from '../common/model/BSP.ts';
import type { ClientEdict } from '../client/ClientEntities.ts';
import type { ServerClient } from './Client.ts';

import Vector from '../../shared/Vector.ts';
import { SzBuffer, registerSerializableType } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import * as Defs from '../../shared/Defs.ts';
import { eventBus, getClientRegistry, getCommonRegistry } from '../registry.ts';
import Q from '../../shared/Q.ts';
import { ConsoleCommand } from '../common/Cmd.ts';
import { ModelType } from '../common/Mod.ts';

export interface BaseEntity extends SerializableEntity {
  classname: string;
  alpha: number;
  angles: Vector;
  avelocity: Vector;
  absmax: Vector;
  absmin: Vector;
  assignInitialData(initialData: EdictData): void;
  blocked?(blockedByEntity: BaseEntity): void;
  chain?: BaseEntity | ServerEdict | null;
  clear(): void;
  colormap: number;
  deadflag?: number;
  readonly edict?: ServerEdict | null;
  enemy?: BaseEntity | ServerEdict | null;
  equals(otherEntity: BaseEntity | ServerEdict | null): boolean;
  effects: number;
  flags: number;
  frame: number;
  free(): void;
  goalentity?: BaseEntity | ServerEdict | null;
  gravity?: number | null;
  groundentity: BaseEntity | null;
  health: number;
  ideal_yaw?: number;
  idealpitch?: number;
  fixangle?: boolean;
  ltime?: number;
  mins: Vector;
  maxs: Vector;
  model: string | null;
  modelindex: number;
  movetype: Defs.moveType;
  netname?: string | null;
  nextthink?: number;
  oldorigin?: Vector;
  origin: Vector;
  owner?: BaseEntity | ServerEdict | null;
  punchangle: Vector;
  size: Vector;
  skin: number;
  solid: Defs.solid;
  spawn(): void;
  takedamage: Defs.damage;
  team: number;
  teleport_time?: number;
  think?(): void;
  touch?(touchedByEntity: BaseEntity, pushVector: Vector): void;
  velocity: Vector;
  view_ofs: Vector;
  v_angle: Vector;
  waterlevel?: Defs.waterlevel;
  watertype?: Defs.content;
  yaw_speed?: number;
  readonly edictId: number | undefined;
  restoreSpawnParameters?(data: string | null): void;
}

export type WorldspawnEntity = WorldspawnEntityValue;

let { COM, Con, Host, NET, PR, SV } = getCommonRegistry();
let { CL } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL } = getClientRegistry());
  ({ COM, Con, Host, NET, PR, SV } = getCommonRegistry());
});

/**
 * Server-side edict allocation, parsing, and debugging helpers.
 */
export class ED {
  /**
   * Clears an edict for reuse.
   */
  static ClearEdict(ed: ServerEdict): void {
    ed.clear();
    ed.free = false;
  }

  /**
   * Allocates a reusable edict slot.
   * @returns The allocated edict.
   */
  static Alloc(): ServerEdict {
    let i: number;
    let edict: ServerEdict;

    for (i = SV.svs.maxclients + 1; i < SV.server.num_edicts; i++) {
      edict = SV.server.edicts[i] as ServerEdict;

      if (edict.free && (edict.freetime < 2.0 || SV.server.time - edict.freetime > 0.5)) {
        ED.ClearEdict(edict);
        return edict;
      }
    }

    if (i % Def.limits.edicts === 0) {
      SV.server.edicts.length += Def.limits.edicts;

      for (let j = i; j < SV.server.edicts.length; j++) {
        SV.server.edicts[j] = new ServerEdict(j);
      }

      Con.DPrint(`ED.Alloc triggered Def.limits.edicts (${Def.limits.edicts})\n`);
    }

    edict = SV.server.edicts[SV.server.num_edicts++] as ServerEdict;
    ED.ClearEdict(edict);
    return edict;
  }

  /**
   * Marks an edict free so it can be reused later.
   */
  static Free(ed: ServerEdict): void {
    SV.area.unlinkEdict(ed);
    ed.free = true;

    if (ed.entity) {
      ed.entity.clear();
    }

    ed.freetime = SV.server.time;
  }

  /**
   * Prints an edict's fields to the console.
   */
  static Print(ed: ServerEdict): void {
    if (ed.isFree()) {
      return;
    }

    const entity = ed.entity;

    console.assert(entity !== null, 'ED.Print requires a live entity');

    Con.Print(`\nEDICT ${ed.num}:\n`);

    for (let i = 1; i < PR.fielddefs.length; i++) {
      const fieldDef = PR.fielddefs[i];
      const name = PR.GetString(fieldDef.name);

      if (/_[xyz]$/.test(name)) {
        continue;
      }

      const printableValue = (entity as BaseEntity & Record<string, string | number | boolean | Vector | BaseEntity | null | undefined>)[name];
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      Con.Print(`${name.padStart(24, '.')}: ${printableValue}\n`);
    }
  }

  /**
   * Prints all active edicts.
   */
  static PrintEdicts(): void {
    if (!SV.server.active) {
      return;
    }

    Con.Print(`${SV.server.num_edicts} entities\n`);
    SV.server.edicts.forEach((edict: ServerEdict) => {
      ED.Print(edict);
    });
  }

  static PrintEdict_f = class PrintEdictCommand extends ConsoleCommand {
    run(id?: string): void {
      if (!SV.server.active) {
        return;
      }

      if (id === undefined) {
        Con.Print(`Usage: ${this.command} <num>\n`);
        return;
      }

      const index = Q.atoi(id);

      if (index >= 0 && index < SV.server.num_edicts) {
        ED.Print(SV.server.edicts[index] as ServerEdict);
      }
    }
  };

  /**
   * Prints an edict usage summary.
   */
  static Count(): void {
    if (!SV.server.active) {
      return;
    }

    let active = 0;
    let models = 0;
    let solid = 0;
    let step = 0;

    for (let i = 0; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i] as ServerEdict;

      if (ent.isFree()) {
        continue;
      }

      const entity = ent.entity!;

      console.assert(entity !== null, 'ED.Count requires a live entity');

      active++;

      if (entity.solid) {
        solid++;
      }

      if (entity.model) {
        models++;
      }

      if (entity.movetype === Defs.moveType.MOVETYPE_STEP) {
        step++;
      }
    }

    const numEdicts = SV.server.num_edicts;

    Con.Print(`num_edicts:${numEdicts <= 9 ? '  ' : numEdicts <= 99 ? ' ' : ''}${numEdicts}\n`);
    Con.Print(`active    :${active <= 9 ? '  ' : active <= 99 ? ' ' : ''}${active}\n`);
    Con.Print(`view      :${models <= 9 ? '  ' : models <= 99 ? ' ' : ''}${models}\n`);
    Con.Print(`touch     :${solid <= 9 ? '  ' : solid <= 99 ? ' ' : ''}${solid}\n`);
    Con.Print(`step      :${step <= 9 ? '  ' : step <= 99 ? ' ' : ''}${step}\n`);
  }

  /**
   * Parses one edict block from entity text.
   * @returns The remaining entity data after the parsed block.
   */
  static ParseEdict(data: string, ent: ServerEdict, initialData: EdictData = {}): string {
    if (ent.num > 0) {
      ent.clear();
    }

    let keyname = '';
    let anglehack = false;
    let init = false;

    while (true) {
      const parsedKey = COM.Parse(data);

      data = parsedKey.data!;

      if (parsedKey.token.charCodeAt(0) === 125) {
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
          keyname = 'light_lev';
        }
      }

      keyname = keyname.trimEnd();

      const parsedValue = COM.Parse(data);

      data = parsedValue.data!;

      if (data === null) {
        throw new Error('ED.ParseEdict: EOF without closing brace');
      }

      if (parsedValue.token.charCodeAt(0) === 125) {
        throw new Error('ED.ParseEdict: Closing brace without data');
      }

      if (keyname.startsWith('_')) {
        continue;
      }

      const tokenValue = anglehack ? `0 ${parsedValue.token} 0` : parsedValue.token;

      initialData[keyname] = tokenValue.replace(/\\n/g, '\n');
      init = true;
    }

    if (!init) {
      ent.free = true;
    }

    return data;
  }

  /**
   * Loads all entities from the worldspawn entity lump.
   */
  static async LoadFromFile(data: string): Promise<void> {
    let inhibit = 0;
    let ent: ServerEdict | null = null;

    console.assert(SV.server.gameAPI !== null, 'SV.server.gameAPI is required to load entities');

    SV.server.gameAPI!.time = SV.server.time;

    while (true) {
      const parsed = COM.Parse(data);

      if (!parsed.data) {
        break;
      }

      data = parsed.data;

      if (parsed.token !== '{') {
        throw new Error(`ED.LoadFromFile: found ${parsed.token} when expecting {`);
      }

      const initialData: EdictData = {};
      ent = ent ? ED.Alloc() : (SV.server.edicts[0] as ServerEdict);
      data = ED.ParseEdict(data, ent, initialData);

      if (!initialData.classname) {
        Con.Print(`No classname for edict ${ent.num}\n`);
        ED.Free(ent);
        continue;
      }

      const maySpawn = SV.server.gameAPI!.prepareEntity(ent, initialData.classname as string, initialData);

      if (!maySpawn) {
        ED.Free(ent);
        inhibit++;
        continue;
      }

      await SV.WaitForPrecachedResources();

      const spawned = SV.server.gameAPI!.spawnPreparedEntity(ent);

      if (!spawned) {
        Con.Print(`Could not spawn entity for edict ${ent.num}:\n`);
        ED.Print(ent);
        ED.Free(ent);
      }
    }

    Con.DPrint(`${inhibit} entities inhibited\n`);
  }
}

/**
 * Mutable server-side wrapper around a game entity instance.
 */
export class ServerEdict {
  static #lastcheckpvs: Visibility | null = null;

  readonly num: number;
  free: boolean;
  octreeNode: OctreeNode<ServerEdict> | null;
  leafnums: number[];
  freetime: number;
  entity: BaseEntity | null;

  constructor(num: number) {
    this.num = num;
    this.free = false;
    this.octreeNode = null;
    this.leafnums = [];
    this.freetime = 0.0;
    this.entity = null;
  }

  private _requireEntity(): BaseEntity {
    if (this.entity === null) {
      throw new Error(`Edict ${this.num} has no entity`);
    }

    return this.entity;
  }

  /**
   * Clears the currently linked entity instance.
   */
  clear(): void {
    if (this.entity) {
      this.entity.free();
      this.entity = null;
    }
  }

  /**
   * Edict is no longer in use.
   * @returns True when the edict has no live entity.
   */
  isFree(): boolean {
    return this.free || !this.entity;
  }

  /**
   * Returns the current origin for octree bookkeeping.
   * @returns The entity origin, or null if the edict is unused.
   */
  get origin(): Vector | null {
    return this.entity ? this.entity.origin : null;
  }

  /**
   * Returns the current absolute mins for octree bookkeeping.
   * @returns The entity mins, or null if the edict is unused.
   */
  get absmin(): Vector | null {
    return this.entity ? this.entity.absmin : null;
  }

  /**
   * Returns the current absolute maxs for octree bookkeeping.
   * @returns The entity maxs, or null if the edict is unused.
   */
  get absmax(): Vector | null {
    return this.entity ? this.entity.absmax : null;
  }

  toString(): string {
    if (this.isFree()) {
      return `unused (${this.num})`;
    }

    const entity = this._requireEntity();
    return `Edict (${entity.classname}, num: ${this.num}, origin: ${entity.origin})`;
  }

  /**
   * Gives up this edict so it can be reused later.
   */
  freeEdict(): void {
    ED.Free(this);
  }

  /**
   * Compares edicts by slot number.
   * @returns True when both edicts reference the same slot.
   */
  equals(otherEdict: ServerEdict | null): boolean {
    return otherEdict !== null && this.num === otherEdict.num;
  }

  /**
   * Updates mins, maxs, and size for this entity.
   */
  setMinMaxSize(min: Vector, max: Vector): void {
    if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
      throw new Error('Edict.setMinMaxSize: backwards mins/maxs');
    }

    const entity = this._requireEntity();
    entity.mins = min.copy();
    entity.maxs = max.copy();
    entity.size = max.copy().subtract(min);
    this.linkEdict(true);
  }

  /**
   * Moves the entity to a new origin and relinks it.
   */
  setOrigin(vec: Vector): void {
    this._requireEntity().origin = vec.copy();
    this.linkEdict(false);
  }

  /**
   * Relinks the edict in the area tree.
   */
  linkEdict(touchTriggers = false): void {
    SV.area.linkEdict(this, touchTriggers);
  }

  /**
   * Sets the model, also setting mins/maxs when applicable.
   */
  setModel(model: string): void {
    let i: number;

    for (i = 0; i < SV.server.modelPrecache.length; i++) {
      if (SV.server.modelPrecache[i] === model) {
        break;
      }
    }

    if (i === SV.server.modelPrecache.length) {
      throw new Error(`Edict.setModel: ${model} not precached`);
    }

    const entity = this._requireEntity();
    entity.model = model;
    entity.modelindex = i;

    const mod = SV.server.models[i];

    if (mod instanceof Promise) {
      void mod.then((loadedModel) => {
        console.assert(loadedModel !== null, `Edict.setModel: failed to load model ${model}`);
        this.setMinMaxSize(loadedModel!.mins, loadedModel!.maxs);
      });
      return;
    }

    if (mod) {
      this.setMinMaxSize(mod.mins, mod.maxs);
    } else {
      this.setMinMaxSize(Vector.origin, Vector.origin);
    }

    if (entity.solid === Defs.solid.SOLID_BSP) {
      console.assert(mod && mod.type === ModelType.brush, 'Edict.setModel: not a brush model for SOLID_BSP');
    }
  }

  /**
   * Moves self in the given direction.
   * @returns True when walking succeeded.
   */
  walkMove(yaw: number, dist: number): boolean {
    return SV.movement.walkMove(this, yaw, dist);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @returns True when the drop succeeded.
   */
  dropToFloor(z = -2048.0): boolean {
    const entity = this._requireEntity();
    const end = entity.origin.copy().add(new Vector(0.0, 0.0, z));
    const trace = SV.collision.move(entity.origin, entity.mins, entity.maxs, end, 0, this);

    if (trace.fraction === 1.0 || trace.allsolid) {
      return false;
    }

    this.setOrigin(trace.endpos);
    entity.flags |= Defs.flags.FL_ONGROUND;
    entity.groundentity = trace.ent!.entity;
    return true;
  }

  /**
   * Checks if the entity is standing on the ground.
   * @returns True when the edict touches the ground.
   */
  isOnTheFloor(): boolean {
    return SV.movement.checkBottom(this);
  }

  /**
   * Converts this edict into a static entity for client signon.
   */
  makeStatic(): void {
    const entity = this._requireEntity();
    const message = SV.server.signon;
    const modelIndex = SV.ModelIndex(entity.model)!;
    console.assert(modelIndex !== null, `Edict.makeStatic: model ${entity.model} not precached`);
    message.writeByte(Protocol.svc.spawnstatic);
    message.writeString(entity.classname);
    message.writeByte(modelIndex);
    message.writeByte(entity.frame || 0);
    message.writeByte(entity.colormap || 0);
    message.writeByte(entity.skin || 0);
    message.writeByte(entity.effects || 0);
    message.writeByte(Math.floor(entity.alpha * 255.0));
    message.writeByte(entity.solid || 0);
    message.writeAngleVector(entity.angles);
    message.writeCoordVector(entity.origin);
    this.freeEdict();
  }

  /**
   * Returns the next client that is a valid auto-aim/AI target.
   * @returns The selected client edict, or null when none is visible.
   */
  getNextBestClient(): ServerEdict | null {
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

      let ent: ServerEdict;

      for (;; i++) {
        if (i === SV.svs.maxclients + 1) {
          i = 1;
        }

        ent = SV.server.edicts[i] as ServerEdict;

        if (i === check) {
          break;
        }

        if (ent.isFree()) {
          continue;
        }

        const entity = ent._requireEntity();

        if (entity.health <= 0.0 || (entity.flags & Defs.flags.FL_NOTARGET) !== 0) {
          continue;
        }

        break;
      }

      SV.server.lastcheck = i;
      ServerEdict.#lastcheckpvs = SV.server.worldmodel!.getPvsByPoint(ent._requireEntity().origin.copy().add(ent._requireEntity().view_ofs));
      SV.server.lastchecktime = SV.server.time;
    }

    const ent = SV.server.edicts[SV.server.lastcheck] as ServerEdict;
    const entity = ent.entity;

    if (ent.isFree() || entity === null || entity.health <= 0.0) {
      return null;
    }

    const lastcheckpvs = ServerEdict.#lastcheckpvs;

    if (lastcheckpvs === null) {
      return null;
    }

    const leaf = SV.server.worldmodel!.getLeafForPoint(this._requireEntity().origin.copy().add(this._requireEntity().view_ofs)).num;

    if (leaf === 0 || !lastcheckpvs.isRevealed(leaf)) {
      return null;
    }

    return ent;
  }

  /**
   * Checks if this entity is in the given PHS/PVS.
   * @returns True when this entity is in the supplied visibility set.
   */
  isInPXS(pxs: Visibility): boolean {
    return pxs.areRevealed(this.leafnums);
  }

  /**
   * Move this entity toward its goal.
   * @returns True when the move succeeded.
   */
  moveToGoal(dist: number, target: Vector | null = null): boolean {
    return SV.movement.moveToGoal(this, dist, target);
  }

  /**
   * Returns an auto-aim direction for this entity.
   * @returns The resolved aim direction.
   */
  aim(direction: Vector): Vector {
    const entity = this._requireEntity();
    const dir = direction.copy();
    const origin = entity.origin.copy();
    const start = origin.add(new Vector(0.0, 0.0, 20.0));
    const end = new Vector(start[0] + 2048.0 * dir[0], start[1] + 2048.0 * dir[1], start[2] + 2048.0 * dir[2]);
    const trace = SV.collision.move(start, Vector.origin, Vector.origin, end, 0, this);

    if (trace.ent !== null) {
      const hitEntity = trace.ent.entity;

      if (hitEntity !== null && hitEntity.takedamage === Defs.damage.DAMAGE_AIM && (!Host.teamplay!.value || entity.team <= 0 || entity.team !== hitEntity.team)) {
        return dir;
      }
    }

    const bestdir = dir.copy();
    let bestdist = SV.aim!.value;
    let bestent: ServerEdict | null = null;

    for (let i = 1; i < SV.server.num_edicts; i++) {
      const check = SV.server.edicts[i] as ServerEdict;

      if (check.isFree()) {
        continue;
      }

      const checkEntity = check.entity;

      if (checkEntity === null || checkEntity.takedamage !== Defs.damage.DAMAGE_AIM) {
        continue;
      }

      if (check.equals(this)) {
        continue;
      }

      if (Host.teamplay!.value !== 0 && entity.team > 0 && entity.team === checkEntity.team) {
        continue;
      }

      const center = checkEntity.origin.copy().add(checkEntity.mins.copy().add(checkEntity.maxs).multiply(0.5));
      dir.set(center).subtract(start);
      dir.normalize();

      const dist = dir.dot(bestdir);

      if (dist < bestdist) {
        continue;
      }

      const trace = SV.collision.move(start, Vector.origin, Vector.origin, center, 0, this);

      if (trace.ent === check) {
        bestdist = dist;
        bestent = check;
      }
    }

    if (bestent !== null) {
      const bestEntity = bestent._requireEntity();
      dir.set(bestEntity.origin).subtract(entity.origin);
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
   * Returns the next non-free edict in the list.
   * @returns The next active edict, or null if there are no more.
   */
  nextEdict(): ServerEdict | null {
    for (let i = this.num + 1; i < SV.server.num_edicts; i++) {
      const edict = SV.server.edicts[i] as ServerEdict;

      if (!edict.isFree()) {
        return edict;
      }
    }

    return null;
  }

  /**
   * Turns toward ideal_yaw at yaw_speed.
   * @returns The new yaw angle.
   */
  changeYaw(): number {
    const entity = this._requireEntity();
    const angles = entity.angles;
    angles[1] = SV.movement.changeYaw(this);
    entity.angles = angles;
    return angles[1];
  }

  /**
   * Returns the corresponding client object.
   * @returns The mapped client slot, or null when none exists.
   */
  getClient(): ServerClient | null {
    return (SV.svs.clients[this.num - 1] as ServerClient | undefined) ?? null;
  }

  /**
   * Checks whether this edict is a player-client slot.
   * @returns True when the edict is within the active client slot range.
   */
  isClient(): boolean {
    return this.num > 0 && this.num <= SV.svs.maxclients;
  }

  /**
   * Checks whether this edict is worldspawn.
   * @returns True when the edict represents the world.
   */
  isWorld(): boolean {
    return this.num === 0;
  }
}

registerSerializableType(ServerEdict, {
  /**
   * Serializes a server edict reference.
   */
  serialize(sz: SzBuffer, object: ServerEdict): void {
    sz.writeShort(object.num);
  },

  /**
   * Deserializes a server edict reference on the server.
   * @returns The referenced server edict.
   */
  deserializeOnServer(_sz: SzBuffer): ServerEdict {
    const num = NET.message.readShort();
    console.assert(num >= 0 && num < SV.server.num_edicts, `ServerEdict.deserialize: invalid edict number ${num}`);
    return SV.server.edicts[num] as ServerEdict;
  },

  /**
   * Deserializes a server edict reference on the client.
   * @returns The client-side edict proxy.
   */
  deserializeOnClient(_sz: SzBuffer): ClientEdict {
    return CL.state.clientEntities.getEntity(NET.message.readShort()) as ClientEdict;
  },
});
