import Vector from '../../shared/Vector.ts';
import { eventBus, registry } from '../registry.mjs';
import * as Def from '../common/Def.ts';
import { content, effect, solid } from '../../shared/Defs.ts';
import Chase from './Chase.mjs';
import { DefaultClientEdictHandler } from './ClientLegacy.mjs';
import { BaseClientEdictHandler } from '../../shared/ClientEdict.ts';
import { ClientEngineAPI } from '../common/GameAPIs.ts';
import { SFX } from './Sound.mjs';
import { Node, revealedVisibility } from '../common/model/BSP.ts';
import { BaseModel } from '../common/model/BaseModel.ts';

let { CL, Con, Mod, PR, R, S } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Mod = registry.Mod;
  PR = registry.PR;
  R = registry.R;
  S = registry.S;
});

export class ClientDlight {
  /** @type {number} light radius */
  radius = 0.0;

  /** @type {Vector} light color, RGB */
  color = new Vector(1.0, 1.0, 1.0);

  /** @type {Vector} origin */
  origin = new Vector();

  /** @type {number} time when this light is considered gone */
  die = 0.0;

  /** @type {number} radius decrease per second, e.g. 300 */
  decay = 0.0;

  /** @type {number} entity number */
  entity = 0;

  /** @type {number} */
  minlight = 0;

  isFree() {
    return this.radius < 0.0 || this.die < CL.state.time;
  }

  clear() {
    this.radius = 0.0;
    this.color.setTo(1.0, 1.0, 1.0);
    this.origin.clear();
    this.die = 0.0;
    this.decay = 0.0;
    this.entity = 0;
    this.minlight = 0;
  }

  think() {
    this.radius -= this.decay * CL.state.time;

    if (this.radius < 0.0) {
      this.radius = 0;
    }
  }
};

export class ClientBeam {
  start = new Vector();
  end = new Vector();

  /** @type {import('../common/model/BaseModel.ts').BaseModel} what model to use to draw the beam */
  model = null;

  /** @type {number} */
  entity = 0;

  endtime = 0.0;
};

/**
 * Client edict maps to a server edict.
 * It is used to keep track of entities on the client side.
 * Optionally there can be a ClientEdictHandler for each entity handling
 * more complex logic that is not part of a client-server session.
 */
export class ClientEdict { // TODO: extends Protocol.EntityState
  /** @type {BaseClientEdictHandler} */
  #handler = null;

  /** @param {number} num entity number */
  constructor(num) {
    this.classname = null;
    this.num = num;
    /** @type {BaseModel} */
    this.model = null;
    this.modelindex = 0;
    this.framePrevious = null;
    this.frameTime = 0.0;
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    /** @type {number} alpha value for rendering */
    this.alpha = 1.0;
    this.solid = 0;
    this.originPrevious = new Vector(Infinity, Infinity, Infinity);
    this.originTime = 0.0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.anglesPrevious = new Vector(Infinity, Infinity, Infinity);
    this.anglesTime = 0.0;
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.velocityPrevious = new Vector(Infinity, Infinity, Infinity);;
    this.velocityTime = 0.0;
    this.velocity = new Vector();
    this.dlightbits = 0;
    this.dlightframe = 0;
    /** keeps track of origin changes */
    this.msg_origins = [new Vector(), new Vector()];
    /** keeps track of angle changes */
    this.msg_angles = [new Vector(), new Vector()];
    /** keeps track of velocity changes */
    this.msg_velocity = [new Vector(), new Vector()];
    this.leafs = [];
    /** count of received updates */
    this.updatecount = 0;
    /** whether is ClientEntity is ready to be recycled */
    this.free = false;
    this.syncbase = 0.0;
    /** we are using this to lerp animations and positions as well as in future steering client entities */
    this.nextthink = -1;
    this.maxs = new Vector();
    this.mins = new Vector();
    /** @type {Record<string, import('../../shared/GameInterfaces').SerializableType>} entity fields pushed by the server */
    this.extended = {};
    /** server time when this entity was last updated (legacy demo playback only) */
    this.msgtime = 0.0;
    /** force-link flag: snap to current position, no interpolation (legacy demo playback only) */
    this.forcelink = false;

    /** @type {ClientEdict} */
    const that = this;

    /**
     * holds lerped origin and angles for rendering purposes
     */
    this.lerp = {
      get frame() {
        const time = CL.state.clientMessages.mtime[0];
        if (that.nextthink <= time || that.framePrevious === null || CL.nolerp.value) {
          return [that.frame, that.frame, 0];
        }
        return [that.framePrevious, that.frame, (time - that.frameTime) / (that.nextthink - that.frameTime)];
      },
      get origin() {
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
      get angles() {
        const time = CL.state.clientMessages.mtime[0];
        if (that.nextthink <= time || CL.nolerp.value || that.anglesPrevious.isInfinite()) {
          return that.angles;
        }
        const f = Math.min(1, Math.max(0, (time - that.anglesTime) / (that.nextthink - that.anglesTime)));
        const a0 = that.angles;
        const a1 = that.anglesPrevious;
        const d = a0.copy().subtract(a1);
        for (let i = 0; i < 3; i++) { // avoid snapping around
          if (d[i] > 180)  { d[i] -= 360; };
          if (d[i] < -180) { d[i] += 360; };
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

  isStatic() {
    return this.num === -1;
  }

  equals(other) {
    // CR: playing with fire here
    return this === other || (this.num !== -1 && this.num === other.num);
  }

  freeEdict() {
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
  linkEdict() {
    console.assert(CL.state.worldmodel !== null, 'worldmodel must be set before linking an entity');
    console.assert(this.isStatic(), 'linkEdict is only valid for client-side entities');
    const emins = this.origin.copy().add(this.model.mins);
    const emaxs = this.origin.copy().add(this.model.maxs);
    this.#splitEntityOnNode(CL.state.worldmodel.nodes[0], emins, emaxs);
  }

  /**
   * @param {Node} node BSP node to split the entity on
   * @param {Vector} emins entity mins
   * @param {Vector} emaxs entity maxs
   */
  #splitEntityOnNode(node, emins, emaxs) {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }

    if (node.contents < 0) {
      this.leafs[this.leafs.length] = node.num;
      return;
    }

    const sides = Vector.boxOnPlaneSide(emins, emaxs, node.plane);

    if ((sides & 1) !== 0) {
      this.#splitEntityOnNode(node.children[0], emins, emaxs);
    }

    if ((sides & 2) !== 0) {
      this.#splitEntityOnNode(node.children[1], emins, emaxs);
    }
  }

  /**
   * Sets the origin of the entity.
   * Only valid for client-side entities.
   * @param {Vector} origin new position of the entity
   */
  setOrigin(origin) {
    this.origin.set(origin);
    this.linkEdict();
  }

  /** loads handler based on set classname */
  loadHandler() {
    /** @type {typeof BaseClientEdictHandler} */
    const handler = (() => {
      const ClientAPI = PR.QuakeJS?.ClientGameAPI;

      if (!ClientAPI) {
        return null;
      }

      const handler = ClientAPI.GetClientEdictHandler(this.classname);

      if (!handler) {
        // Con.DPrint('No ClientEdictHandler for entity: ' + this.classname + '\n');
        return null;
      }

      return handler;
    })() || DefaultClientEdictHandler;

    this.#handler = new handler(this, ClientEngineAPI);
  }

  /**
   * Sets origin and angles according to the current message.
   * @param {boolean} doLerp whether to do a point lerp
   */
  updatePosition(doLerp) {

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

  spawn() {
    if (this.#handler) {
      this.#handler.spawn();
    }
  }

  emit() {
    if (this.#handler) {
      this.#handler.emit();
    }
  }

  think() {
    if (this.#handler) {
      this.#handler.think();
    }
  }

  toString() {
    return `${this.num.toFixed(0).padStart(3, ' ')}: ${(this.classname || '(no classname)').padEnd(32)} ${(this.model?.name || '-').padEnd(32)}: [${this.origin}], ${this.angles}`;
  }
};

export default class ClientEntities {
  /** @type {ClientEdict[]} all entities */
  static_entities = [];

  /** @type {ClientEdict[]} all server managed entities */
  entities = [];

  /** @type {ClientEdict[]} visible entities staged for the next frame */
  visedicts = [];

  /** @type {ClientEdict[]} all temporary entities, will last one frame */
  temp_entities = [];

  /** @type {ClientDlight[]} current dynamic lights */
  dlights = [];

  /** @type {string[]} current configured lightstyles (set by the server) */
  lightstyle = [];

  /** @type {ClientBeam[]} current beams */
  beams = [];

  num_temp_entities = 0;
  num_visedicts = 0;

  tempEntitySounds = {
    /** @type {SFX} */
    wizhit: null,
    /** @type {SFX} */
    knighthit: null,
    /** @type {SFX} */
    tink1: null,
    /** @type {SFX} */
    ric1: null,
    /** @type {SFX} */
    ric2: null,
    /** @type {SFX} */
    ric3: null,
    /** @type {SFX} */
    explosion: null,
  };

  /** @type {Record<string, import('../common/Mod.ts').BaseModel>} available tent models, initialized in initTempEntities */
  tempEntityModels = {};

  constructor() {
    this.clear();
  }

  async initTempEntities() {
    this.tempEntitySounds = {
      wizhit: S.PrecacheSound('wizard/hit.wav'),
      knighthit: S.PrecacheSound('hknight/hit.wav'),
      tink1: S.PrecacheSound('weapons/tink1.wav'),
      ric1: S.PrecacheSound('weapons/ric1.wav'),
      ric2: S.PrecacheSound('weapons/ric2.wav'),
      ric3: S.PrecacheSound('weapons/ric3.wav'),
      explosion: S.PrecacheSound('weapons/r_exp3.wav'),
    };

    for (const {model, name} of await Promise.all([
      'progs/bolt.mdl',
      'progs/bolt2.mdl',
      'progs/bolt3.mdl',
      'progs/beam.mdl', // CR: does not exist in Quake
    ].map((model) => Mod.ForNameAsync(model, false, Mod.scope.client).then((m) => ({ model: m, name: model }))))) {
      this.tempEntityModels[name] = model;
    }
  }

  /**
   * @param {number} id lightstyle number
   * @param {string} style lightstyle sequence
   */
  setLightstyle(id, style) {
    console.assert(id >= 0 && id < this.lightstyle.length, 'id must be in range');

    this.lightstyle[id] = style;
  }

  clear() {
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

  setSolidEntities(pmove) {
    pmove.clearEntities();

    for (const clent of this.getEntities()) {
      if (clent.num === 0 || !clent.model) {
        continue;
      }

      // Only solid entities participate in player movement collision.
      // SOLID_TRIGGER and SOLID_NOT entities must not block the player.
      const s = clent.solid;
      if (s !== solid.SOLID_BSP && s !== solid.SOLID_BBOX && s !== solid.SOLID_SLIDEBOX) {
        continue;
      }

      pmove.addEntity(clent, s === solid.SOLID_BSP ? clent.model : null);
    }
  }

  printEntities() {
    Con.Print('Entities:\n');
    for (const ent of this.getEntities()) {
      if (!ent.model) {
        continue;
      }

      Con.Print(`${ent}\n`);
    }
  }

  allocateDynamicLight(entityId) {
    let dl = null;

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
   * @param {string?} classname optional classname to set for the temporary entity
   * @returns {ClientEdict} a new temporary entity
   */
  allocateTempEntity(classname = null) {
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
   * @param {string?} classname optional classname to set for the temporary entity
   * @returns {ClientEdict} a new client-only entity
   */
  allocateClientEntity(classname = null) {
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
   * @param {number} num entity number
   * @returns {ClientEdict} entity
   */
  getEntity(num) {
    if (this.entities[num] !== undefined) {
      return this.entities[num];
    }

    console.assert(num >= 0, 'num must be >= 0, -1 is reserved for static entities');

    // preallocate entities
    while (this.entities.length <= num) {
      this.entities.push(new ClientEdict(this.entities.length));
    }

    return this.entities[num];
  }

  #thinkTempEntities() {
    // TODO: rework
    this.num_temp_entities = 0;
    for (let i = 0; i < Def.limits.beams; i++) {
      let yaw; let pitch;
      const b = this.beams[i];
      if (!b.model || b.endtime < CL.state.time) {
        continue;
      }
      if (b.entity === CL.state.viewentity) {
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

  #thinkDlights() {
    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = this.dlights[i];

      if (dl.isFree()) {
        continue;
      }

      dl.think();
    }
  }

  #thinkEntities() {
    for (const clent of this.getEntities()) {
      clent.think();
    }
  }

  think() {
    this.#thinkEntities();
    this.#thinkTempEntities();
    this.#thinkDlights();
  }

  #emitEntities() {
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
      if (!clent.model || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // do not render the player entity, unless we are in chase cam mode
      if (i === CL.state.viewentity && !Chase.active.value) {
        continue;
      }

      clent.emit();
      this.visedicts[this.num_visedicts++] = clent;
    }

    // get the PVS for the current view
    const vis = R.novis.value !== 0 ? revealedVisibility : CL.state.worldmodel.getPvsByPoint(R.refdef.vieworg);

    for (const clent of this.static_entities) {
      // freed entity or invisible entity
      if (clent.free || !clent.model || (clent.effects & effect.EF_NODRAW)) {
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

  #emitProjectiles() {
    // TODO: implement
  }

  #emitTempEntities() {
    for (let i = 0; i < this.num_temp_entities; i++) {
      const ent = this.temp_entities[i];
      if (!ent.model || ent.free) {
        continue;
      }

      ent.emit();

      this.visedicts[this.num_visedicts++] = ent;
    }
  }

  emit() {
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
   * @yields {ClientEdict} entity
   */
  *getEntities() {
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
   * @yields {ClientEdict} entity
   */
  *getVisibleEntities() {
    for (let i = 0; i < this.num_visedicts; i++) {
      yield this.visedicts[i];
    }
  }
};
