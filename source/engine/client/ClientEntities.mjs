import Vector from '../../shared/Vector.mjs';
import { eventBus, registry } from '../registry.mjs';
import * as Def from '../common/Def.mjs';
import { effect } from '../../shared/Defs.mjs';
import Chase from './Chase.mjs';
import { DefaultClientEdictHandler } from './ClientLegacy.mjs';
import { BaseClientEdictHandler } from '../../shared/ClientEdict.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';

let { CL, Con, Mod, PR, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Mod = registry.Mod;
  PR = registry.PR;
  R = registry.R;
});

export class ClientDlight {
  /** @type {number} light radius */
  radius = 0.0;

  /** @type {Vector} light color */
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
    const time = CL.state.time - CL.state.oldtime;

    this.radius -= this.decay * time;

    if (this.radius < 0.0) {
      this.radius = 0;
    }
  }
};

export class ClientBeam {
  start = new Vector();
  end = new Vector();

  /** @type {BaseModel} what model to use to draw the beam */
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
export class ClientEdict {
  /** @type {BaseClientEdictHandler} */
  #handler = null;

  /** @param {number} num entity number */
  constructor(num) {
    this.classname = null;
    this.num = num;
    this.model = null;
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.solid = 0;
    /** @type {?Vector} used to keep track of origin changes, unset when no previous origin is known */
    this.originPrevious = null;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    /** @type {?Vector} used to keep track of angles changes, unset when no previous angles is known */
    this.anglesPrevious = null;
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.dlightbits = 0;
    this.dlightframe = 0;
    /** keeps track of last updates */
    this.msg_time = [0.0, 0.0];
    /** keeps track of origin changes */
    this.msg_origins = [new Vector(), new Vector()];
    /** keeps track of angle changes */
    this.msg_angles = [new Vector(), new Vector()];
    this.leafs = [];
    /** count of received updates */
    this.updatecount = 0;
    /** whether is ClientEntity is about to get freed */
    this.free = false;
    this.syncbase = 0.0;
    this.maxs = new Vector();
    this.mins = new Vector();

    /** @type {ClientEdict} */
    const that = this;

    /**
     * holds lerped origin and angles for rendering purposes
     */
    this.lerp = {
      get origin() {
        if (that.originPrevious === null || CL.nolerp.value) {
          return that.origin;
        }
        const f = CL.LerpPoint();
        const o0 = that.origin;
        const o1 = that.originPrevious;
        if (o0.distanceTo(o1) > 100.0) {
          return o0; // clamp sudden origin changes
        }
        return new Vector(
          o1[0] + (o0[0] - o1[0]) * f,
          o1[1] + (o0[1] - o1[1]) * f,
          o1[2] + (o0[2] - o1[2]) * f,
        );
      },
      get angles() {
        if (that.anglesPrevious === null || CL.nolerp.value) {
          return that.angles;
        }
        const f = CL.LerpPoint();
        const a0 = that.angles;
        const a1 = that.anglesPrevious;
        return new Vector(
          a1[0] + (a0[0] - a1[0]) * f,
          a1[1] + (a0[1] - a1[1]) * f,
          a1[2] + (a0[2] - a1[2]) * f,
        );
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
    this.frame = 0;
    this.skinnum = 0;
    this.colormap = 0;
    this.effects = 0;
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.dlightbits = 0;
    this.dlightframe = 0;
    this.msg_time[0] = 0.0;
    this.msg_time[1] = 0.0;
    this.msg_origins[0].clear();
    this.msg_origins[1].clear();
    this.msg_angles[0].clear();
    this.msg_angles[1].clear();
    this.leafs.length = 0;
    this.updatecount = 0;
    this.free = false;
    this.maxs.clear();
    this.mins.clear();
    this.originPrevious = null;
    this.anglesPrevious = null;
  }

  /**
   * Links the entity to the current world model.
   * This has to be called after the origin for a client-side entity has been changed.
   */
  linkEdict() {
    console.assert(CL.state.worldmodel !== null, 'worldmodel must be set before linking an entity');
    console.assert(this.isStatic(), 'linkEdict is only valid for client-side entities');
    R.currententity = this;
    R.emins = this.origin.copy().add(this.model.mins);
    R.emaxs = this.origin.copy().add(this.model.maxs);
    R.SplitEntityOnNode(CL.state.worldmodel.nodes[0]);
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
        Con.DPrint('No ClientEdictHandler for entity: ' + this.classname + '\n');
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
    if (!doLerp) {
      this.origin.set(this.msg_origins[0]);
      this.angles.set(this.msg_angles[0]);
      return;
    }

    if (this.num === 1) {
      console.log('updatePosition', this.num, this.classname, this.origin, this.angles);
    }

    if (this.originPrevious === null) {
      this.originPrevious = this.origin.copy();
    } else {
      this.originPrevious.set(this.origin);
    }

    if (this.anglesPrevious === null) {
      this.anglesPrevious = this.angles.copy();
    } else {
      this.anglesPrevious.set(this.angles);
    }

    const origin_old = this.msg_origins[0].copy();
    const angles_old = this.msg_angles[0].copy();

    let f = CL.LerpPoint();

    const delta = new Vector();

    // clamp sudden origin changes and don’t lerp here
    for (let j = 0; j < 3; j++) {
      delta[j] = this.msg_origins[0][j] - origin_old[j];
      if ((delta[j] > 100.0) || (delta[j] < -100.0)) {
        f = 1.0;
      }
    }

    for (let j = 0; j < 3; j++) {
      this.origin[j] = origin_old[j] + f * delta[j];
      let d = this.msg_angles[0][j] - angles_old[j];
      if (d > 180.0) {
        d -= 360.0;
      } else if (d < -180.0) {
        d += 360.0;
      }
      this.angles[j] = angles_old[j] + f * d;
    }
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

  constructor() {
    this.clear();
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

    this.static_entities.push(ent);

    if (classname !== null) {
      ent.classname = classname;
      ent.loadHandler();
    }

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
        pitch = (Math.atan2(dist[2], Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1])) * 180.0 / Math.PI) || 0;
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
        const ent = this.allocateTempEntity();
        ent.origin = org.copy();
        ent.model = b.model;
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

    for (let i = 1; i < this.entities.length; i++) {
      const clent = this.entities[i];

      // freed entity or invisible entity
      if (clent.free || !clent.model || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      // const oldorg = clent.originPrevious ? clent.originPrevious : clent.origin;

      // apply prediction for non-player entities
      clent.updatePosition(clent.num !== CL.state.viewentity);

      // do not render the player entity, unless we are in chase cam mode
      if (i === CL.state.viewentity && !Chase.active.value) {
        continue;
      }

      clent.emit();
      this.visedicts[this.num_visedicts++] = clent;
    }

    // get the PVS for the current view
    const viewleaf = Mod.PointInLeaf(R.refdef.vieworg, CL.state.worldmodel);
    const vis = (R.novis.value !== 0) ? Mod.novis : Mod.LeafPVS(viewleaf, CL.state.worldmodel);

    for (const clent of this.static_entities) {
      // freed entity or invisible entity
      if (clent.free || !clent.model || (clent.effects & effect.EF_NODRAW)) {
        continue;
      }

      let j = 0;
      for (; j < clent.leafs.length; j++) {
        const leaf = clent.leafs[j];
        if ((leaf < 0) || ((vis[leaf >> 3] & (1 << (leaf & 7))) !== 0)) {
          break;
        }
      }

      if (j === clent.leafs.length) {
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
