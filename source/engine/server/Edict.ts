import { SerializableEntity, type EdictData } from '../../shared/GameInterfaces.ts';
import type { WorldspawnEntity as WorldspawnEntityValue } from '../../game/id1/entity/Worldspawn.ts';
import type { OctreeNode } from '../../shared/Octree.ts';
import type { Visibility } from '../common/model/BSP.ts';
import type { ServerClient } from './Client.ts';

import Vector from '../../shared/Vector.ts';
import { SzBuffer, registerSerializableType } from '../network/MSG.ts';
import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import * as Defs from '../../shared/Defs.ts';
import { eventBus } from '../common/EventBus.ts';
import Q from '../../shared/Q.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import { ModelType } from '../common/Mod.ts';
import { CorruptedResourceError, HostError } from '../common/Errors.ts';
import type Server from './Server.ts';
import COM from '../common/Com.ts';
import { MAX_ATTACHMENT_DEPTH } from '../common/AttachmentTransform.ts';
import { ServerAttachments } from './ServerAttachments.ts';

// FIXME: we should improve this interface and make the actual BaseEntity implement it
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
  /**
   * The sequence a sequenced model plays (image sprites, skeletal models), -1 for none, which is also what an entity
   * that does not declare it has: the model then follows `frame`. See `docs/skeletal-models.md`.
   */
  sequence?: number;
  /**
   * Server time at which the sequence started. Setting it to `now` restarts it, to `now - elapsed` resumes it.
   * `null` or `undefined`, the default, says the game sets none: the client then stamps its own when the model or the
   * sequence changes. A game that declares it with a number sends that number, 0 included.
   */
  animtime?: number | null;
  /** Playback speed multiplier of the sequence, 1 when not declared. */
  framerate?: number;
  free(): void;
  goalentity?: BaseEntity | ServerEdict | null;
  gravity?: number | null;
  groundentity: BaseEntity | null;
  health: number;
  ideal_yaw?: number;
  idealpitch?: number;
  fixangle?: boolean;
  interact?(interactingEntity: BaseEntity): void;
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
  use?(usedByEntity: BaseEntity): void;
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

/** fields to hide from console output */
const NON_PRINTABLE_ENTITY_FIELDS = new Set(['edict', 'engine', 'game']);

/**
 * Collects the field names worth printing for a live entity.
 * @returns Sorted entity field names suitable for debug output.
 */
function getPrintableEntityFieldNames(entity: BaseEntity): string[] {
  const fieldNames = new Set<string>();

  for (const fieldName of Object.keys(entity)) {
    if (NON_PRINTABLE_ENTITY_FIELDS.has(fieldName) || fieldName.startsWith('_')) {
      continue;
    }

    fieldNames.add(fieldName);
  }

  return [...fieldNames].sort();
}

/**
 * Formats a single entity field value for console output.
 * @returns Readable string representation for console debugging.
 */
function formatPrintableEntityValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return value.toString();
  }

  if (value instanceof Vector) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatPrintableEntityValue(entry)).join(', ')}]`;
  }

  if (typeof value === 'object') {
    const candidate = value as {
      readonly classname?: unknown;
      readonly edictId?: unknown;
      readonly num?: unknown;
      readonly constructor?: { readonly name?: unknown };
    };

    if (typeof candidate.classname === 'string') {
      const entityId = typeof candidate.edictId === 'number' ? `#${candidate.edictId}` : '';
      return `${candidate.classname}${entityId}`;
    }

    if (typeof candidate.num === 'number') {
      return `edict #${candidate.num}`;
    }

    const constructorName = candidate.constructor?.name;
    if (typeof constructorName === 'string' && constructorName !== 'Object') {
      return `[${constructorName}]`;
    }

    return `[object ${(constructorName instanceof String) ? constructorName : 'Object'}]`;
  }

  return '[value]';
}

const SERVER: unique symbol = Symbol('ServerEdict.server');
const ATTACHMENT: unique symbol = Symbol('ServerEdict.attachment');

/** What an edict knows about attachments: whom it follows and who follows it. */
interface AttachmentState {
  /** The edict this one is attached to, `null` when it is free-standing. */
  parent: ServerEdict | null;
  /** The tag of the parent's model it follows, `null` for the parent's origin. */
  tagName: string | null;
  /** Whether the missing tag has been reported for this attachment, so a model without it logs once. */
  tagReported: boolean;
  /** The edicts attached to this one. */
  readonly children: Set<ServerEdict>;
}

/**
 * Server-side edict allocation, parsing, and debugging helpers.
 */
export class ED {
  readonly #sv: Server;

  constructor(sv: Server) {
    this.#sv = sv;
  }

  /**
   * Clears an edict for reuse.
   */
  ClearEdict(ed: ServerEdict): void {
    ed.clear();
    ed.free = false;
  }

  /**
   * Allocates a reusable edict slot.
   * @returns The allocated edict.
   */
  Alloc(): ServerEdict {
    let i: number;
    let edict: ServerEdict;

    for (i = this.#sv.svs.maxclients + 1; i < this.#sv.server.num_edicts; i++) {
      edict = this.#sv.server.edicts[i] as ServerEdict;

      if (edict.free && (edict.freetime < 2.0 || this.#sv.server.time - edict.freetime > 0.5)) {
        this.ClearEdict(edict);
        eventBus.publish('server.edict.assigned', edict.num);
        return edict;
      }
    }

    if (i % Def.limits.edicts === 0) {
      this.#sv.server.edicts.length += Def.limits.edicts;

      for (let j = i; j < this.#sv.server.edicts.length; j++) {
        this.#sv.server.edicts[j] = new ServerEdict(j, this.#sv);
      }

      this.#sv.con.DPrint(`this.Alloc triggered Def.limits.edicts (${Def.limits.edicts})\n`);
    }

    edict = this.#sv.server.edicts[this.#sv.server.num_edicts++] as ServerEdict;
    this.ClearEdict(edict);
    eventBus.publish('server.edict.assigned', edict.num);
    return edict;
  }

  /**
   * Marks an edict free so it can be reused later.
   */
  Free(ed: ServerEdict): void {
    if (ed.attachedChildren.size > 0) {
      ServerAttachments.releaseChildren(this.#sv, ed, ed.attachedChildren);
    }

    ed.clearAttachment();
    this.#sv.area.unlinkEdict(ed);
    ed.free = true;

    if (ed.entity) {
      ed.entity.clear();
    }

    ed.freetime = this.#sv.server.time;
    eventBus.publish('server.edict.freed', ed.num);
  }

  /**
   * Prints an edict's fields to the console.
   */
  Print(ed: ServerEdict): void {
    if (ed.isFree()) {
      return;
    }

    const entity = ed.entity;

    console.assert(entity !== null, 'this.Print requires a live entity');

    this.#sv.con.Print(`\nEDICT ${ed.num}:\n`);

    if (entity === null) {
      this.#sv.con.Print('\nNULL ENTITY!\n');
      return;
    }


    for (const name of getPrintableEntityFieldNames(entity)) {
      const printableValue = (entity as unknown as Record<string, unknown>)[name];

      if (printableValue === undefined || typeof printableValue === 'function') {
        continue;
      }

      this.#sv.con.Print(`${name.padStart(24, '.')}: ${formatPrintableEntityValue(printableValue)}\n`);
    }
  }

  /**
   * Prints all active edicts.
   */
  PrintEdicts(): void {
    if (!this.#sv.server.active) {
      return;
    }

    this.#sv.con.Print(`${this.#sv.server.num_edicts} entities\n`);
    this.#sv.server.edicts.forEach((edict: ServerEdict) => {
      this.Print(edict);
    });
  }

  /**
   * Prints an edict summary.
   */
  printEdictCommand(command: ConsoleCommand, id?: string): void {
    if (!this.#sv.server.active) {
      return;
    }

    if (id === undefined) {
      this.#sv.con.Print(`Usage: ${command.command} <num>\n`);
      return;
    }

    const index = Q.atoi(id);

    if (index >= 0 && index < this.#sv.server.num_edicts) {
      this.Print(this.#sv.server.edicts[index] as ServerEdict);
    }
  }

  /**
   * Prints all active edicts.
   */
  printEdictsCommand(): void {
    if (!this.#sv.server.active) {
      return;
    }

    this.PrintEdicts();
  }

  /**
   * Prints an edict usage summary.
   */
  printEdictcountCommand(): void {
    if (!this.#sv.server.active) {
      return;
    }

    let active = 0;
    let models = 0;
    let solid = 0;
    let step = 0;

    for (let i = 0; i < this.#sv.server.num_edicts; i++) {
      const ent = this.#sv.server.edicts[i] as ServerEdict;

      if (ent.isFree()) {
        continue;
      }

      const entity = ent.entity!;

      console.assert(entity !== null, 'this.Count requires a live entity');

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

    const numEdicts = this.#sv.server.num_edicts;
    const padWidth = Math.ceil(Math.log10(numEdicts + 1)) + 1;

    this.#sv.con.Print(`num_edicts :${numEdicts.toString().padStart(padWidth, ' ')}\n`);
    this.#sv.con.Print(`active     :${active.toString().padStart(padWidth, ' ')}\n`);
    this.#sv.con.Print(`view       :${models.toString().padStart(padWidth, ' ')}\n`);
    this.#sv.con.Print(`touch      :${solid.toString().padStart(padWidth, ' ')}\n`);
    this.#sv.con.Print(`step       :${step.toString().padStart(padWidth, ' ')}\n`);
  }

  /**
   * Parses one edict block from entity text.
   * @returns The remaining entity data after the parsed block.
   */
  ParseEdict(data: string, ent: ServerEdict, initialData: EdictData = {}): string {
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
        throw new CorruptedResourceError('<entities.txt>', 'this.ParseEdict: EOF without closing brace');
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
        throw new CorruptedResourceError('<entities.txt>', 'this.ParseEdict: EOF without closing brace');
      }

      if (parsedValue.token.charCodeAt(0) === 125) {
        throw new CorruptedResourceError('<entities.txt>', 'this.ParseEdict: Closing brace without data');
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
  async LoadFromFile(data: string): Promise<void> {
    let inhibit = 0;
    let ent: ServerEdict | null = null;

    console.assert(this.#sv.server.gameAPI !== null, 'SV.server.gameAPI is required to load entities');

    this.#sv.server.gameAPI!.time = this.#sv.server.time;

    while (true) {
      const parsed = COM.Parse(data);

      if (!parsed.data) {
        break;
      }

      data = parsed.data;

      if (parsed.token !== '{') {
        throw new CorruptedResourceError('<entities.txt>', `this.LoadFromFile: found ${parsed.token} when expecting {`);
      }

      const initialData: EdictData = {};
      ent = ent ? this.Alloc() : (this.#sv.server.edicts[0] as ServerEdict);
      data = this.ParseEdict(data, ent, initialData);

      if (!initialData.classname) {
        this.#sv.con.Print(`No classname for edict ${ent.num}\n`);
        this.Free(ent);
        continue;
      }

      const maySpawn = this.#sv.server.gameAPI!.prepareEntity(ent, initialData.classname as string, initialData);

      if (!maySpawn) {
        this.Free(ent);
        inhibit++;
        continue;
      }

      await this.#sv.WaitForPrecachedResources();

      const spawned = this.#sv.server.gameAPI!.spawnPreparedEntity(ent);

      if (!spawned) {
        this.#sv.con.Print(`Could not spawn entity for edict ${ent.num}:\n`);
        this.Print(ent);
        this.Free(ent);
      }
    }

    this.#sv.con.DPrint(`${inhibit} entities inhibited\n`);
  }

  Init(): void {
    const addCommand = (name: string, handler: (command: ConsoleCommand, ...args: string[]) => void): void => {
      Cmd.AddCommand(name, class EdictCommand extends ConsoleCommand {
        override run(...args: string[]): void {
          handler(this, ...args);
        }
      });
    };

    addCommand('edict', (command, id) => { this.printEdictCommand(command, id); });
    addCommand('edicts', () => { this.printEdictsCommand(); });
    addCommand('edictcount', () => { this.printEdictcountCommand(); });
  }
}

/**
 * Whether `other` is `edict` or one of the edicts `edict` is attached to, directly or through others.
 * @returns True when attaching `other` to `edict` would make a loop, or the chain is implausibly deep.
 */
function isInChainOf(edict: ServerEdict, other: ServerEdict): boolean {
  let current: ServerEdict | null = edict;

  for (let depth = 0; current !== null; depth++) {
    if (current === other || depth > MAX_ATTACHMENT_DEPTH) {
      return true;
    }

    current = current[ATTACHMENT].parent;
  }

  return false;
}

/**
 * An attached entity is where its parent is: its own origin is an offset, so the root of the chain is the edict that
 * has the leaves to look up.
 * @returns The edict at the top of the chain of parents, `edict` itself when it is free-standing.
 */
function attachmentRoot(edict: ServerEdict): ServerEdict {
  let root = edict;

  for (let depth = 0; root[ATTACHMENT].parent !== null && depth < MAX_ATTACHMENT_DEPTH; depth++) {
    root = root[ATTACHMENT].parent;
  }

  return root;
}

/**
 * Mutable server-side wrapper around a game entity instance.
 */
export class ServerEdict {
  static #lastcheckpvs: Visibility | null = null;

  /** The server this edict belongs to. Symbol-keyed so it stays out of the way of game code. */
  readonly [SERVER]: Server;
  readonly num: number;
  free: boolean;
  octreeNode: OctreeNode<ServerEdict> | null;
  leafnums: number[];
  freetime: number;
  entity: BaseEntity | null;

  /** Symbol-keyed like the server, so it stays out of the way of game code and does not make the type nominal. */
  readonly [ATTACHMENT]: AttachmentState = { parent: null, tagName: null, tagReported: false, children: new Set() };

  constructor(num: number, sv: Server) {
    this[SERVER] = sv;
    this.num = num;
    this.free = false;
    this.octreeNode = null;
    this.leafnums = [];
    this.freetime = 0.0;
    this.entity = null;
  }

  /**
   * Clears the currently linked entity instance.
   */
  clear(): void {
    this.clearAttachment();

    if (this.entity) {
      this.entity.free();
      this.entity = null;
    }
  }

  /**
   * Attaches this entity to another, to a tag of the parent's model or to the parent's origin, the way DarkPlaces'
   * `setattachment` does: from now on the clients draw it at the parent's transform times the tag, and this entity's own
   * `origin` and `angles` are its offset in the tag's space (so a game shifts a holstered gun by changing them). It
   * is sent whenever its parent is, wherever the offset puts it.
   *
   * An attached entity should be `SOLID_NOT` and does not move by itself; the engine asserts the former in development.
   * It stays attached when the parent changes model (the tag is looked up again, by name), and is let go of, staying
   * where it was in the world, when the parent is freed. Attaching to itself, or in a loop, is refused with a warning.
   * An unknown tag attaches to the parent's origin and says so once in developer mode.
   * @param parent The edict to follow.
   * @param tagName The name of a tag of the parent's model, such as `tag_weapon`; `null` for the parent's origin.
   */
  setAttachment(parent: ServerEdict, tagName: string | null = null): void {
    console.assert(this.entity?.solid === Defs.solid.SOLID_NOT, 'ServerEdict.setAttachment: an attached entity should be SOLID_NOT', this.entity?.classname);

    if (parent.isFree() || this.isFree()) {
      this[SERVER].con.PrintWarning(`ServerEdict.setAttachment: ${this} or ${parent} is free, not attaching\n`);
      return;
    }

    if (isInChainOf(parent, this)) {
      this[SERVER].con.PrintWarning(`ServerEdict.setAttachment: ${parent} cannot carry ${this}, it would be a loop, not attaching\n`);
      return;
    }

    this.clearAttachment();

    const attachment = this[ATTACHMENT];
    attachment.parent = parent;
    attachment.tagName = tagName === '' ? null : tagName;
    attachment.tagReported = false;
    parent[ATTACHMENT].children.add(this);
  }

  /**
   * Lets go of the parent. The entity's `origin` and `angles`, which were an offset in tag space, are world values
   * again, so a game that detaches on purpose sets them.
   *
   * Note: set the origin with `setOrigin()`, not by assigning `entity.origin`. While attached, the edict was linked
   * into the world at the offset, and only `setOrigin()` relinks it. With a plain assignment the edict keeps the
   * leaves of the old offset, so the clients that should see the entity are not sent it.
   */
  clearAttachment(): void {
    const attachment = this[ATTACHMENT];

    attachment.parent?.[ATTACHMENT].children.delete(this);
    attachment.parent = null;
    attachment.tagName = null;
  }

  /**
   * What a savegame keeps of the attachment.
   * @returns The parent's edict number and the tag name, `null` when this edict is free-standing.
   */
  attachmentSnapshot(): [parent: number, tagName: string | null] | null {
    const attachment = this[ATTACHMENT];

    return attachment.parent === null ? null : [attachment.parent.num, attachment.tagName];
  }

  /**
   * The edict this one is attached to.
   * @returns The parent, `null` when this edict is free-standing.
   */
  get attachmentParent(): ServerEdict | null {
    return this[ATTACHMENT].parent;
  }

  /**
   * The edict at the top of the chain of parents this one hangs on: the one whose place decides where this one is.
   * @returns The root, this edict itself when it is free-standing.
   */
  get attachmentRoot(): ServerEdict {
    return attachmentRoot(this);
  }

  /**
   * The edicts attached to this one.
   * @returns The children, in no particular order.
   */
  get attachedChildren(): ReadonlySet<ServerEdict> {
    return this[ATTACHMENT].children;
  }

  /**
   * The tag of the parent's current model this entity follows, which is what goes on the wire.
   * @returns The index, -1 for the parent's origin: not attached, no tag name, or a model without that tag.
   */
  attachmentTagIndex(): number {
    const attachment = this[ATTACHMENT];

    if (attachment.parent === null || attachment.tagName === null) {
      return -1;
    }

    const index = ServerAttachments.tagIndex(this[SERVER], attachment.parent, attachment.tagName);

    if (index < 0 && !attachment.tagReported) {
      attachment.tagReported = true;
      this[SERVER].con.DPrint(`ServerEdict.attachmentTagIndex: ${attachment.parent} has no tag ${attachment.tagName}, ${this} follows its origin\n`);
    }

    return index;
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

    const entity = this.entity!;
    return `Edict (${entity.classname}, num: ${this.num}, origin: ${entity.origin})`;
  }

  /**
   * Gives up this edict so it can be reused later.
   */
  freeEdict(): void {
    this[SERVER].ed.Free(this);
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
  setMinMaxSize(min: Vector, max: Vector, touchTriggers = true): void {
    console.assert(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2], 'Edict.setMinMaxSize: backwards mins/maxs');

    const entity = this.entity!;
    entity.mins = min.copy();
    entity.maxs = max.copy();
    entity.size = max.copy().subtract(min);
    this.linkEdict(touchTriggers);
  }

  /**
   * Moves the entity to a new origin and relinks it.
   */
  setOrigin(vec: Vector): void {
    this.entity!.origin = vec.copy();
    this.linkEdict(false);
  }

  /**
   * Relinks the edict in the area tree.
   */
  linkEdict(touchTriggers = false): void {
    this[SERVER].area.linkEdict(this, touchTriggers);
  }

  /**
   * Sets the model, also setting mins/maxs when applicable.
   */
  setModel(model: string, touchTriggers = true): void {
    let i: number;

    for (i = 0; i < this[SERVER].server.modelPrecache.length; i++) {
      if (this[SERVER].server.modelPrecache[i] === model) {
        break;
      }
    }

    if (i === this[SERVER].server.modelPrecache.length) {
      throw new HostError(`Edict.setModel: ${model} not precached`);
    }

    const entity = this.entity!;
    entity.model = model;
    entity.modelindex = i;

    const mod = this[SERVER].server.models[i];

    if (mod instanceof Promise) {
      // The size of the model once it has loaded, unless the entity has another model or size by then: a game that
      // sizes the entity right after setModel (setSize) must keep that size. setMinMaxSize stores new vectors, so a
      // changed `mins` or `maxs` object means the size was set since.
      const { mins, maxs } = entity;

      void mod.then((loadedModel) => {
        console.assert(loadedModel !== null, `Edict.setModel: failed to load model ${model}`);

        if (this.entity !== entity || entity.modelindex !== i || entity.mins !== mins || entity.maxs !== maxs) {
          return;
        }

        this.setMinMaxSize(loadedModel!.mins, loadedModel!.maxs, touchTriggers);
      });
      return;
    }

    if (mod) {
      this.setMinMaxSize(mod.mins, mod.maxs, touchTriggers);
    } else {
      this.setMinMaxSize(Vector.origin, Vector.origin, touchTriggers);
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
    return this[SERVER].movement.walkMove(this, yaw, dist);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @returns True when the drop succeeded.
   */
  dropToFloor(z = -2048.0): boolean {
    const entity = this.entity!;
    const end = entity.origin.copy().add(new Vector(0.0, 0.0, z));
    const trace = this[SERVER].collision.move(entity.origin, entity.mins, entity.maxs, end, 0, this);

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
    return this[SERVER].movement.checkBottom(this);
  }

  /**
   * Converts this edict into a static entity for client signon.
   */
  makeStatic(): void {
    const entity = this.entity!;
    const message = this[SERVER].server.signon;
    const modelIndex = this[SERVER].ModelIndex(entity.model)!;
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

    // Most decorations play no sequence, so the block only names the fields that were set.
    const sequence = entity.sequence ?? -1;
    const framerate = entity.framerate ?? 1.0;
    let fields = 0;

    if (sequence !== -1) {
      fields |= Protocol.sequenceField.sequence;
    }

    const animtime = entity.animtime ?? null;

    if (animtime !== null) {
      fields |= Protocol.sequenceField.animtime;
    }

    if (framerate !== 1.0) {
      fields |= Protocol.sequenceField.framerate;
    }

    message.writeByte(fields);

    if (fields & Protocol.sequenceField.sequence) {
      message.writeShort(sequence);
    }

    if (fields & Protocol.sequenceField.animtime) {
      message.writeFloat(animtime!);
    }

    if (fields & Protocol.sequenceField.framerate) {
      message.writeFloat(framerate);
    }

    message.writeAngleVector(entity.angles);
    message.writeCoordVector(entity.origin);
    this.freeEdict();
  }

  /**
   * Returns the next client that is a valid auto-aim/AI target.
   * @returns The selected client edict, or null when none is visible.
   */
  getNextBestClient(): ServerEdict | null {
    if (this[SERVER].server.time - this[SERVER].server.lastchecktime >= 0.1) {
      let check = this[SERVER].server.lastcheck;

      if (check <= 0) {
        check = 1;
      } else if (check > this[SERVER].svs.maxclients) {
        check = this[SERVER].svs.maxclients;
      }

      let i = 1;

      if (check !== this[SERVER].svs.maxclients) {
        i += check;
      }

      let ent: ServerEdict;

      for (;; i++) {
        if (i === this[SERVER].svs.maxclients + 1) {
          i = 1;
        }

        ent = this[SERVER].server.edicts[i] as ServerEdict;

        if (i === check) {
          break;
        }

        if (ent.isFree()) {
          continue;
        }

        const entity = ent.entity!;

        if (entity.health <= 0.0 || (entity.flags & Defs.flags.FL_NOTARGET) !== 0) {
          continue;
        }

        break;
      }

      this[SERVER].server.lastcheck = i;
      ServerEdict.#lastcheckpvs = this[SERVER].server.worldmodel!.getPvsByPoint(ent.entity!.origin.copy().add(ent.entity!.view_ofs));
      this[SERVER].server.lastchecktime = this[SERVER].server.time;
    }

    const ent = this[SERVER].server.edicts[this[SERVER].server.lastcheck] as ServerEdict;
    const entity = ent.entity;

    if (ent.isFree() || entity === null || entity.health <= 0.0) {
      return null;
    }

    const lastcheckpvs = ServerEdict.#lastcheckpvs;

    if (lastcheckpvs === null) {
      return null;
    }

    const leaf = this[SERVER].server.worldmodel!.getLeafIndexForPoint(this.entity!.origin.copy().add(this.entity!.view_ofs));

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
    return pxs.areRevealed(attachmentRoot(this).leafnums);
  }

  /**
   * Takes one chase step toward this entity's goal entity, or straight toward `target` (such as a navigation
   * waypoint) when given. See `ServerMovement.moveToGoal`.
   * @returns True when the entity moved or turned toward a new direction.
   */
  moveToGoal(dist: number, target: Vector | null = null): boolean {
    return this[SERVER].movement.moveToGoal(this, dist, target);
  }

  /**
   * Returns an auto-aim direction for this entity.
   * @returns The resolved aim direction.
   */
  aim(direction: Vector): Vector {
    const entity = this.entity!;
    const dir = direction.copy();
    const origin = entity.origin.copy();
    const start = origin.add(new Vector(0.0, 0.0, 20.0));
    const end = new Vector(start[0] + 2048.0 * dir[0], start[1] + 2048.0 * dir[1], start[2] + 2048.0 * dir[2]);
    const trace = this[SERVER].collision.move(start, Vector.origin, Vector.origin, end, 0, this);

    const hitEntity = trace.ent?.entity || null;

    // direct hit on a valid target, return the original direction
    if (hitEntity !== null && hitEntity.takedamage === Defs.damage.DAMAGE_AIM && (!this[SERVER].teamplay!.value || entity.team <= 0 || entity.team !== hitEntity.team)) {
      return dir;
    }

    const bestdir = dir.copy();
    let bestdist = this[SERVER].aim!.value;
    let bestent: ServerEdict | null = null;

    // check if there’s a better target in the vicinity
    for (const check of this[SERVER].engineAPI.FindInRadius(trace.endpos, 128.0)) {
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

      if (this[SERVER].teamplay!.value !== 0 && entity.team > 0 && entity.team === checkEntity.team) {
        continue;
      }

      const center = checkEntity.origin.copy().add(checkEntity.mins.copy().add(checkEntity.maxs).multiply(0.5));
      dir.set(center).subtract(start);
      dir.normalize();

      const dist = dir.dot(bestdir);

      if (dist < bestdist) {
        continue;
      }

      const trace = this[SERVER].collision.move(start, Vector.origin, Vector.origin, center, 0, this);

      if (trace.ent === check) {
        bestdist = dist;
        bestent = check;
      }
    }

    if (bestent !== null) {
      const bestEntity = bestent.entity!;
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
    for (let i = this.num + 1; i < this[SERVER].server.num_edicts; i++) {
      const edict = this[SERVER].server.edicts[i] as ServerEdict;

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
    const entity = this.entity!;
    const angles = entity.angles;
    angles[1] = this[SERVER].movement.changeYaw(this);
    entity.angles = angles;
    return angles[1];
  }

  /**
   * Returns the corresponding client object.
   * @returns The mapped client slot, or null when none exists.
   */
  getClient(): ServerClient | null {
    return (this[SERVER].svs.clients[this.num - 1] as ServerClient | undefined) ?? null;
  }

  /**
   * Checks whether this edict is a player-client slot.
   * @returns True when the edict is within the active client slot range.
   */
  isClient(): boolean {
    return this.num > 0 && this.num <= this[SERVER].svs.maxclients;
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
});
