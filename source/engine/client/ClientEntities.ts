import type { ClientEventValue } from '../../shared/GameInterfaces.ts';
import type { SFX } from './Sound.ts';
import type { BaseModel } from '../common/model/BaseModel.ts';
import type { BrushModel } from '../common/Mod.ts';
import type { Pmove } from '../common/Pmove.ts';

import Vector from '../../shared/Vector.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';
import * as Def from '../common/Def.ts';
import { content, effect, solid } from '../../shared/Defs.ts';
import Chase from './Chase.ts';
import { DefaultClientEdictHandler } from './ClientLegacy.ts';
import { BaseClientEdictHandler } from '../../shared/ClientEdict.ts';
import { ClientEngineAPI } from '../common/GameAPIs.ts';
import { revealedVisibility, type Node } from '../common/model/BSP.ts';

interface ClientEntityLerpState {
  readonly frame: [number, number, number];
  readonly origin: Vector;
  readonly angles: Vector;
}

interface TempEntitySounds {
  wizhit: SFX | null;
  knighthit: SFX | null;
  tink1: SFX | null;
  ric1: SFX | null;
  ric2: SFX | null;
  ric3: SFX | null;
  explosion: SFX | null;
}

let { CL, Con, Mod, PR, R, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Mod, PR, R, S } = getClientRegistry());
});

export class ClientDlight {
  /** light radius */
  radius = 0.0;

  /** light color, RGB */
  color = new Vector(1.0, 1.0, 1.0);

  /** origin */
  origin = new Vector();

  /** time when this light is considered gone */
  die = 0.0;

  /** radius decrease per second, e.g. 300 */
  decay = 0.0;

  /** entity number */
  entity = 0;

  minlight = 0;

  isFree(): boolean {
    return this.radius < 0.0 || this.die < CL.state.time;
  }

  clear(): void {
    this.radius = 0.0;
    this.color.setTo(1.0, 1.0, 1.0);
    this.origin.clear();
    this.die = 0.0;
    this.decay = 0.0;
    this.entity = 0;
    this.minlight = 0;
  }

  think(): void {
    this.radius -= this.decay * CL.state.time;

    if (this.radius < 0.0) {
      this.radius = 0;
    }
  }
}

export class ClientBeam {
  start = new Vector();
  end = new Vector();

  /** what model to use to draw the beam */
  model: BaseModel | null = null;

  entity = 0;
  endtime = 0.0;
}

/**
 * Client edict maps to a server edict.
 * It is used to keep track of entities on the client side.
 * Optionally there can be a ClientEdictHandler for each entity handling
 * more complex logic that is not part of a client-server session.
 */
export class ClientEdict { // TODO: extends Protocol.EntityState
  #handler: BaseClientEdictHandler | null = null;

  classname: string | null;
  readonly num: number;
  model: BaseModel | null;
  modelindex: number;
  framePrevious: number | null;
  frameTime: number;
  frame: number;
  skinnum: number;
  colormap: number;
  effects: number;
  /** alpha value for rendering */
  alpha: number;
  solid: number;
  originPrevious: Vector;
  originTime: number;
  origin: Vector;
  anglesPrevious: Vector;
  anglesTime: number;
  angles: Vector;
  velocityPrevious: Vector;
  velocityTime: number;
  velocity: Vector;
  dlightbits: number;
  dlightframe: number;
  /** keeps track of origin changes */
  msg_origins: [Vector, Vector];
  /** keeps track of angle changes */
  msg_angles: [Vector, Vector];
  /** keeps track of velocity changes */
  msg_velocity: [Vector, Vector];
  leafs: number[];
  /** count of received updates */
  updatecount: number;
  /** whether is ClientEntity is ready to be recycled */
  free: boolean;
  syncbase: number;
  /** we are using this to lerp animations and positions as well as in future steering client entities */
  nextthink: number;
  maxs: Vector;
  mins: Vector;
  /** entity fields pushed by the server */
  extended: Record<string, ClientEventValue>;
  /** server time when this entity was last updated (legacy demo playback only) */
  msgtime: number;
  /** force-link flag: snap to current position, no interpolation (legacy demo playback only) */
  forcelink: boolean;
  readonly lerp: ClientEntityLerpState;

  /** @param num entity number */
  constructor(num: number) {
    this.classname = null;
    this.num = num;
    this.model = null;
    this.modelindex = 0;
    this.framePrevious = null;
    this.frameTime = 0.0;
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.originPrevious = new Vector(Infinity, Infinity, Infinity);
    this.originTime = 0.0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.anglesPrevious = new Vector(Infinity, Infinity, Infinity);
    this.anglesTime = 0.0;
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.velocityPrevious = new Vector(Infinity, Infinity, Infinity);
    this.velocityTime = 0.0;
    this.velocity = new Vector();
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_origins = [new Vector(), new Vector()];
    this.msg_angles = [new Vector(), new Vector()];
    this.msg_velocity = [new Vector(), new Vector()];
    this.leafs = [];
    this.updatecount = 0;
    this.free = false;
    this.syncbase = 0.0;
    this.nextthink = -1;
    this.maxs = new Vector();
    this.mins = new Vector();
    this.extended = {};
    this.msgtime = 0.0;
    this.forcelink = false;

    const that = this;

    /**
     * holds lerped origin and angles for rendering purposes
     */
    this.lerp = {
      get frame(): [number, number, number] {
        const time = CL.state.clientMessages.mtime[0];
        if (that.nextthink <= time || that.framePrevious === null || CL.nolerp.value) {
          return [that.frame, that.frame, 0];
        }
        return [that.framePrevious, that.frame, (time - that.frameTime) / (that.nextthink - that.frameTime)];
      },
      get origin(): Vector {
        const time = CL.state.clientMessages.mtime[0];
        if (that.nextthink <= time || CL.nolerp.value || that.originPrevious.isInfinite()) {
          return that.origin;
        }
        const f = Math.min(1, Math.max(0, (time - that.originTime) / (that.nextthink - that.originTime)));
        const o0 = that.origin;
        const o1 = that.originPrevious;
        const l = new Vector(
          o1[0] + (o0[0] - o1[0]) * f,
          o1[1] + (o0[1] - o1[1]) * f,
          o1[2] + (o0[2] - o1[2]) * f,
        );
        return l;
      },
      get angles(): Vector {
        const time = CL.state.clientMessages.mtime[0];
        if (that.nextthink <= time || CL.nolerp.value || that.anglesPrevious.isInfinite()) {
          return that.angles;
        }
        const f = Math.min(1, Math.max(0, (time - that.anglesTime) / (that.nextthink - that.anglesTime)));
        const a0 = that.angles;
        const a1 = that.anglesPrevious;
        const d = a0.copy().subtract(a1);
        for (let i = 0; i < 3; i++) { // avoid snapping around
          if (d[i] > 180) { d[i] -= 360; }
          if (d[i] < -180) { d[i] += 360; }
        }
        const v = new Vector(
          a1[0] + d[0] * f,
          a1[1] + d[1] * f,
          a1[2] + d[2] * f,
        );
        return v;
      },
    };

    Object.freeze(this.lerp);
    Object.seal(this);
  }

  isStatic(): boolean {
    return this.num === -1;
  }

  equals(other: { num: number } | null): boolean {
    // CR: playing with fire here
    return other !== null && (this === other || (this.num !== -1 && this.num === other.num));
  }

  freeEdict(): void {
    this.model = null;
    this.framePrevious = null;
    this.frameTime = 0.0;
    this.frame = 0;
    this.modelindex = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.velocity.clear();
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_origins[0].clear();
    this.msg_origins[1].clear();
    this.msg_angles[0].clear();
    this.msg_angles[1].clear();
    this.leafs.length = 0;
    this.updatecount = 0;
    this.free = false;
    this.maxs.clear();
    this.mins.clear();
    this.originTime = 0.0;
    this.originPrevious.setTo(Infinity, Infinity, Infinity);
    this.anglesTime = 0.0;
    this.anglesPrevious.setTo(Infinity, Infinity, Infinity);
    this.velocityTime = 0.0;
    this.velocityPrevious.setTo(Infinity, Infinity, Infinity);
    this.nextthink = -1;
    this.msgtime = 0.0;
    this.forcelink = false;
    // make sure we delete the field, not just replace the holding object
    for (const key of Object.keys(this.extended)) {
      delete this.extended[key];
    }
  }

  /**
   * Links the entity to the current world model.
   * This has to be called after the origin for a client-side entity has been changed.
   */
  linkEdict(): void {
    const worldmodel = CL.state.worldmodel;

    console.assert(worldmodel !== null, 'worldmodel must be set before linking an entity');
    console.assert(this.isStatic(), 'linkEdict is only valid for client-side entities');
    console.assert(this.model !== null, 'model must be set before linking an entity');

    if (worldmodel === null || this.model === null) {
      return;
    }

    const rootNode = worldmodel.nodes[0];
    console.assert(rootNode !== undefined, 'worldmodel must have a root node before linking an entity');
    if (rootNode === undefined) {
      return;
    }

    const emins = this.origin.copy().add(this.model.mins);
    const emaxs = this.origin.copy().add(this.model.maxs);
    this.#splitEntityOnNode(rootNode, emins, emaxs);
  }

  /**
   * @param node BSP node to split the entity on
   * @param emins entity mins
   * @param emaxs entity maxs
   */
  #splitEntityOnNode(node: Node, emins: Vector, emaxs: Vector): void {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }

    if (node.contents < 0) {
      this.leafs[this.leafs.length] = node.num;
      return;
    }

    const plane = node.plane;
    if (plane === null) {
      return;
    }

    const sides = Vector.boxOnPlaneSide(emins, emaxs, plane);
    const frontChild = node.children[0];
    const backChild = node.children[1];

    if ((sides & 1) !== 0 && frontChild !== null && typeof frontChild !== 'number') {
      this.#splitEntityOnNode(frontChild, emins, emaxs);
    }

    if ((sides & 2) !== 0 && backChild !== null && typeof backChild !== 'number') {
      this.#splitEntityOnNode(backChild, emins, emaxs);
    }
  }

  /**
   * Sets the origin of the entity.
   * Only valid for client-side entities.
   * @param origin new position of the entity
   */
  setOrigin(origin: Vector): void {
    this.origin.set(origin);
    this.linkEdict();
  }

  /** loads handler based on set classname */
  loadHandler(): void {
    const handler = (() => {
      const ClientAPI = PR.QuakeJS?.ClientGameAPI;

      if (!ClientAPI || this.classname === null) {
        return null;
      }

      const entityHandler = ClientAPI.GetClientEdictHandler(this.classname);

      if (!entityHandler) {
        // Con.DPrint('No ClientEdictHandler for entity: ' + this.classname + '\n');
        return null;
      }

      return entityHandler;
    })() ?? DefaultClientEdictHandler;

    this.#handler = new handler(this, ClientEngineAPI);
  }

  /**
   * Sets origin and angles according to the current message.
   * @param doLerp whether to do a point lerp
   */
  updatePosition(doLerp: boolean): void {
    const time = CL.state.clientMessages.mtime[0];

    // not precisely a position, but it is part of the lerp too
    if (time > this.nextthink || this.framePrevious === null) {
      this.frameTime = time;
      this.framePrevious = this.frame;
    }

    if (!doLerp) {
      this.origin.set(this.msg_origins[0]);
      this.angles.set(this.msg_angles[0]);
      this.velocity.set(this.msg_velocity[0]);
      return;
    }

    // if (this.num === 120) {
    //   console.log('updatePosition', this.num, this.classname, this.origin, this.angles, this.velocity);
    // }

    // reset previous values when nextthink is over
    if (time >= this.nextthink || this.originPrevious.isInfinite() || this.origin.distanceTo(this.originPrevious) > 150) {
      this.originTime = time;
      this.originPrevious.set(this.origin);
    }

    if (time >= this.nextthink || this.anglesPrevious.isInfinite()) {
      this.anglesTime = time;
      this.anglesPrevious.set(this.angles);
    }

    if (time >= this.nextthink || this.velocityPrevious.isInfinite() || this.velocity.distanceTo(this.velocityPrevious) > 150) {
      this.velocityTime = time;
      this.velocityPrevious.set(this.velocity);
    }

    this.angles.set(this.msg_angles[0]);
    this.origin.set(this.msg_origins[0]);
    this.velocity.set(this.msg_velocity[0]);
  }

  spawn(): void {
    if (this.#handler) {
      this.#handler.spawn();
    }
  }

  emit(): void {
    if (this.#handler) {
      this.#handler.emit();
    }
  }

  think(): void {
    if (this.#handler) {
      this.#handler.think();
    }
  }

  toString(): string {
    return `${this.num.toFixed(0).padStart(3, ' ')}: ${(this.classname || '(no classname)').padEnd(32)} ${(this.model?.name || '-').padEnd(32)}: [${this.origin}], ${this.angles}`;
  }
}

export default class ClientEntities {
  /** all entities */
  static_entities: ClientEdict[] = [];

  /** all server managed entities */
  entities: ClientEdict[] = [];

  /** visible entities staged for the next frame */
  visedicts: ClientEdict[] = [];

  /** all temporary entities, will last one frame */
  temp_entities: ClientEdict[] = [];

  /** current dynamic lights */
  dlights: ClientDlight[] = [];

  /** current configured lightstyles (set by the server) */
  lightstyle: string[] = [];

  /** current beams */
  beams: ClientBeam[] = [];

  num_temp_entities = 0;
  num_visedicts = 0;

  tempEntitySounds: TempEntitySounds = {
    wizhit: null,
    knighthit: null,
    tink1: null,
    ric1: null,
    ric2: null,
    ric3: null,
    explosion: null,
  };

  /** available tent models, initialized in initTempEntities */
  tempEntityModels: Record<string, BaseModel | null> = {};

  constructor() {
    this.clear();
  }

  async initTempEntities(): Promise<void> {
    this.tempEntitySounds = {
      wizhit: S.PrecacheSound('wizard/hit.wav'),
      knighthit: S.PrecacheSound('hknight/hit.wav'),
      tink1: S.PrecacheSound('weapons/tink1.wav'),
      ric1: S.PrecacheSound('weapons/ric1.wav'),
      ric2: S.PrecacheSound('weapons/ric2.wav'),
      ric3: S.PrecacheSound('weapons/ric3.wav'),
      explosion: S.PrecacheSound('weapons/r_exp3.wav'),
    };

    for (const { model, name } of await Promise.all([
      'progs/bolt.mdl',
      'progs/bolt2.mdl',
      'progs/bolt3.mdl',
      'progs/beam.mdl', // CR: does not exist in Quake
    ].map((model) => Mod.ForNameAsync(model, false, Mod.scope.client).then((loadedModel) => ({ model: loadedModel, name: model }))))) {
      this.tempEntityModels[name] = model;
    }
  }

  /**
   * @param id lightstyle number
   * @param style lightstyle sequence
   */
  setLightstyle(id: number, style: string): void {
    console.assert(id >= 0 && id < this.lightstyle.length, 'id must be in range');

    this.lightstyle[id] = style;
  }

  clear(): void {
    this.static_entities.length = 0;
    this.visedicts.length = 0;
    this.entities.length = 0;
    this.temp_entities.length = 0;

    this.num_temp_entities = 0;
    this.num_visedicts = 0;

    // preallocate
    this.dlights.length = Def.limits.dlights;
    this.lightstyle.length = Def.limits.lightstyles;
    this.beams.length = Def.limits.beams;

    for (let i = 0; i < Def.limits.dlights; i++) {
      this.dlights[i] = new ClientDlight();
    }

    for (let i = 0; i < Def.limits.lightstyles; i++) {
      this.lightstyle[i] = '';
    }

    for (let i = 0; i < Def.limits.beams; i++) {
      this.beams[i] = new ClientBeam();
    }
  }

  setSolidEntities(pmove: Pmove): void {
    pmove.clearEntities();

    for (const clent of this.getEntities()) {
      if (clent.num === 0 || clent.model === null) {
        continue;
      }

      // Only solid entities participate in player movement collision.
      // SOLID_TRIGGER and SOLID_NOT entities must not block the player.
      const s = clent.solid;
      if (s !== solid.SOLID_BSP && s !== solid.SOLID_BBOX && s !== solid.SOLID_SLIDEBOX) {
        continue;
      }

      const brushModel = s === solid.SOLID_BSP ? clent.model as BrushModel : null;
      pmove.addEntity(clent, brushModel);
    }
  }

  printEntities(): void {
    Con.Print('Entities:\n');
    for (const ent of this.getEntities()) {
      if (ent.model === null) {
        continue;
      }

      Con.Print(`${ent}\n`);
    }
  }

  allocateDynamicLight(entityId: number): ClientDlight {
    let dl: ClientDlight | null = null;

    if (entityId === -1) {
      entityId = 0;
    }

    // go by entity number first
    if (entityId !== 0) {
      for (let i = 0; i < Def.limits.dlights; i++) {
        if (this.dlights[i].entity === entityId) {
          dl = this.dlights[i];
          break;
        }
      }
    }

    // find a free one
    if (dl === null) {
      for (let i = 0; i < Def.limits.dlights; i++) {
        if (this.dlights[i].isFree()) {
          dl = this.dlights[i];
          break;
        }
      }

      // if no free one found, use the first one
      if (dl === null) {
        dl = this.dlights[0];
      }
    }

    dl.origin = new Vector();
    dl.radius = 0.0;
    dl.die = 0.0;
    dl.decay = 0.0;
    dl.minlight = 0.0;
    dl.entity = entityId;
    dl.color.setTo(1.0, 1.0, 1.0);
    return dl;
  }

  /**
   * Allocates a temporary entity. It will last one frame.
   * @param classname optional classname to set for the temporary entity
   * @returns a new temporary entity
   */
  allocateTempEntity(classname: string | null = null): ClientEdict {
    const ent = new ClientEdict(-1);

    this.temp_entities[this.num_temp_entities++] = ent;
    this.visedicts[this.num_visedicts++] = ent;

    if (classname !== null) {
      ent.classname = classname;
      ent.loadHandler();
    }

    return ent;
  }

  /**
   * Allocates a client-only entity.
   * It will not be managed by the server and is used for client-side effects (debris, gibs, projectiles etc.).
   * @param classname optional classname to set for the temporary entity
   * @returns a new client-only entity
   */
  allocateClientEntity(classname: string | null = null): ClientEdict {
    const ent = new ClientEdict(-1);

    if (classname !== null) {
      ent.classname = classname;
      ent.loadHandler();
    }

    ent.free = false;
    ent.updatecount = 1; // force it to be considered for rendering

    // find a free static entity slot
    for (let i = 0; i < this.static_entities.length; i++) {
      if (this.static_entities[i].free) {
        this.static_entities[i] = ent;
        return ent;
      }
    }

    this.static_entities.push(ent);

    return ent;
  }

  /**
   * Returns a client entity by its number.
   * If the entity does not exist, it will be allocated as a null entity.
   * @param num entity number
   * @returns entity
   */
  getEntity(num: number): ClientEdict {
    if (this.entities[num] !== undefined) {
      return this.entities[num];
    }

    console.assert(num >= 0, 'num must be >= 0, -1 is reserved for static entities');

    // preallocate entities
    while (this.entities.length <= num) {
      this.entities.push(new ClientEdict(this.entities.length));
    }

    return this.entities[num]!;
  }

  #thinkTempEntities(): void {
    // TODO: rework
    this.num_temp_entities = 0;
    for (let i = 0; i < Def.limits.beams; i++) {
      let yaw: number;
      let pitch: number;
      const b = this.beams[i];
      if (b.model === null || b.endtime < CL.state.time) {
        continue;
      }
      if (b.entity === CL.state.viewentity) {
        if (CL.state.playerentity === null) {
          continue;
        }

        b.start = CL.state.playerentity.origin.copy();
      }
      const dist = b.end.copy().subtract(b.start);
      if ((dist[0] === 0.0) && (dist[1] === 0.0)) {
        yaw = 0;
        pitch = dist[2] > 0.0 ? 90 : 270;
      } else {
        yaw = (Math.atan2(dist[1], dist[0]) * 180.0 / Math.PI) || 0;
        if (yaw < 0) {
          yaw += 360;
        }
        pitch = (Math.atan2(dist[2], Math.hypot(dist[0], dist[1])) * 180.0 / Math.PI) || 0;
        if (pitch < 0) {
          pitch += 360;
        }
      }
      const org = b.start.copy();

      let d = dist.len();

      if (d !== 0.0) {
        dist.normalize();
      }

      while (d > 0.0) {
        // non-vanilla feature: colors and fullbright beam (TODO: feature flag)
        const dl = this.allocateDynamicLight(0);
        dl.origin = org.copy();
        dl.radius = 50;
        dl.die = CL.state.time + 0.1;
        dl.color.setTo(0.7, 0.7, 1.0);

        const ent = this.allocateTempEntity();
        ent.origin = org.copy();
        ent.model = b.model;
        ent.effects |= effect.EF_FULLBRIGHT; // <<< this too
        ent.angles = new Vector(pitch, yaw, Math.random() * 360.0);
        org[0] += dist[0] * 30.0;
        org[1] += dist[1] * 30.0;
        org[2] += dist[2] * 30.0;
        d -= 30.0;
        ent.spawn();
      }
    }
  }

  #thinkDlights(): void {
    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = this.dlights[i];

      if (dl.isFree()) {
        continue;
      }

      dl.think();
    }
  }

  #thinkEntities(): void {
    for (const clent of this.getEntities()) {
      clent.think();
    }
  }

  think(): void {
    this.#thinkEntities();
    this.#thinkTempEntities();
    this.#thinkDlights();
  }

  #emitEntities(): void {
    // reset all visible entities
    this.num_visedicts = 0;

    const isLegacy = CL.cls.legacy_demo === true;
    const mtime0 = CL.state.clientMessages.mtime[0];

    for (let i = 1; i < this.entities.length; i++) {
      const clent = this.entities[i];

      // freed entity
      if (clent.free) {
        continue;
      }

      // entity has not been updated yet
      if (clent.updatecount === 0) {
        continue;
      }

      // legacy demo playback: no update anymore, consider it gone
      if (isLegacy && clent.msgtime !== mtime0) {
        clent.model = null;
        continue;
      }

      // skip position update for the player when prediction already set the correct position
      if (CL.state.predicted && clent.num === CL.state.viewentity) {
        // prediction already set origin/velocity, only update angles from server state
        clent.angles.set(clent.msg_angles[0]);
      } else {
        clent.updatePosition(clent.num !== CL.state.viewentity);
      }

      // if the entity is not visible, skip it
      if (clent.model === null || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // do not render the player entity, unless we are in chase cam mode
      if (i === CL.state.viewentity && !Chase.active.value) {
        continue;
      }

      clent.emit();
      this.visedicts[this.num_visedicts++] = clent;
    }

    const worldmodel = CL.state.worldmodel;
    console.assert(worldmodel !== null, 'worldmodel must be set before emitting client entities');
    if (worldmodel === null) {
      return;
    }

    // get the PVS for the current view
    const rendererState = R as typeof R & { novis: { value: number } };
    const vis = rendererState.novis.value !== 0 ? revealedVisibility : worldmodel.getPvsByPoint(R.refdef.vieworg);

    for (const clent of this.static_entities) {
      // freed entity or invisible entity
      if (clent.free || clent.model === null || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // entity has not been updated yet
      if (clent.updatecount === 0) {
        continue;
      }

      // not visible in PVS
      if (!vis.areRevealed(clent.leafs)) {
        continue;
      }

      clent.emit();
      this.visedicts[this.num_visedicts++] = clent;
    }
  }

  #emitProjectiles(): void {
    // TODO: implement
  }

  #emitTempEntities(): void {
    for (let i = 0; i < this.num_temp_entities; i++) {
      const ent = this.temp_entities[i];
      if (ent.model === null || ent.free) {
        continue;
      }

      ent.emit();

      this.visedicts[this.num_visedicts++] = ent;
    }
  }

  emit(): void {
    if (CL.state.worldmodel === null) {
      // no world model, nothing to render
      return;
    }

    this.#emitEntities();
    this.#emitProjectiles();
    this.#emitTempEntities();
  }

  /**
   * Returns all entities in the game.
   * Both client-only and server entities.
   * @yields entity
   */
  *getEntities(): Generator<ClientEdict, void, void> {
    for (const entity of this.entities) {
      if (!entity || entity.free) {
        continue;
      }

      yield entity;
    }

    for (const entity of this.static_entities) {
      if (!entity || entity.free) {
        continue;
      }

      yield entity;
    }
  }

  /**
   * Contains all entities that are staged to be rendered.
   * @yields entity
   */
  *getVisibleEntities(): Generator<ClientEdict, void, void> {
    for (let i = 0; i < this.num_visedicts; i++) {
      const entity = this.visedicts[i];
      if (entity !== undefined) {
        yield entity;
      }
    }
  }
}
