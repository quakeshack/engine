/* global Vector, SV */

import { damage, dead, flags, moveType, solid, content, channel, attn } from "../Defs.mjs";
import { ServerGameAPI } from "../GameAPI.mjs";
import { Flag } from "../helper/MiscHelpers.mjs";

export default class BaseEntity {
  static classname = null;

  get classname() {
    return this.constructor.classname;
  }

  set classname(_) {
    throw new TypeError('Cannot set property classname');
  }

  /**
   * @param {SV.Edict} edict linked edict
   * @param {ServerGameAPI} gameAPI server game API
   */
  constructor(edict, gameAPI) {
    // hooking up the edict and the entity, also the APIs
    this.edict = edict;
    this.edict.api = this;
    this.engine = gameAPI.engine;
    this.game = gameAPI;

    // base settings per Entity
    /**
     * @type {number} This is mostly useful for entities that need precise, smooth movement over time, like doors and platforms. It’s only set on entities with MOVETYPE_PUSHER, also the engine is using this only on SV.PushMove.
     */
    this.ltime = 0.0; // local time for entity (NOT time)
    this.origin = new Vector();
    this.oldorigin = new Vector();
    this.angles = new Vector();
    this.mins = new Vector(); // bounding box extents reletive to origin
    this.maxs = new Vector(); // bounding box extents reletive to origin
    this.absmin = new Vector();
    this.absmax = new Vector();
    this.size = new Vector(); // maxs - mins
    this.velocity = new Vector();
    this.avelocity = new Vector();
    /** @type {moveType} */
    this.movetype = moveType.MOVETYPE_NONE;
    /** @type {solid} */
    this.solid = solid.SOLID_NOT;
    /** @type {flags} */
    this.flags = flags.FL_NONE;
    this.spawnflags = 0;
    /** @type {content} */
    this.watertype = content.CONTENT_EMPTY;
    this.waterlevel = 0;

    // Quake model related
    this.model = null;
    this.modelindex = 0;
    this.frame = 0;
    this.frame2 = 0;
    this.skin = 0;
    this.effects = 0;

    // QuakeJS model related
    /** @type {?number} */
    this.keyframe = null;

    this.nextthink = 0.0;
    /** @type {?SV.Edict} set by the phyiscs engine */
    this.groundentity = null; // FIXME: this is an Edict, not an entity
    /** @type {?BaseEntity} this is mainly used by QuakeC, not us */
    this.chain = null;

    // relationships between entities
    /** @type {?BaseEntity} entity, who launched a missile */
    this.owner = null;
    /** @type {?BaseEntity} target entity */
    this.target = null;
    /** @type {?string} target name */
    this.targetname = null; // string

    this.movedir = new Vector(); // mostly for doors, but also used for waterjump

    // attacking and damage related (FIXME: should maybe put this to a different class)
    this.deadflag = dead.DEAD_NO;
    this.takedamage = damage.DAMAGE_NO;
    this.dmg = 0; // CR: find out the values
    this.show_hostile = 0;
    this.attack_finished = 0;

    /** @type {?string} message for triggers or map name */
    this.message = null; // trigger messages

    // subs
    /** @type {?import('./Subs.mjs').Sub} */
    this._sub = null; // needs to be initialized optionally

    // states
    this._states = {};
    this._stateNext = null;
    this._stateCurrent = null;

    this._declareFields();
    this._initStates();

    Object.seal(this);

    // this is used to prepopulate fields from ED.LoadFromFile and SV.SpawnServer
    if (this.engine.IsLoading()) {
      this._precache();
    }
  }

  // allows you to define all fields prior to spawn
  // make sure to prefix private fields with an underscore
  _declareFields() {
    // this._myPrivateField = 123;
    // this.weight = 400;
  }

  // place all Precache* calls here, it’s invoked by the engine indirectly upon loading
  _precache() {
    // this.engine.PrecacheModel('models/box.mdl');
  }

  // place all animation states and scripted sequences here
  _initStates() {
    // this._defineState('army_stand1', 'stand1', 'army_stand2', () => this._ai.stand());
  }

  /**
   * defines a state for the state machine
   * @param {string} state
   * @param {string} keyframe
   * @param {?string} nextState
   * @param {?Function} handler
   */
  _defineState(state, keyframe, nextState = null, handler = null) {
    this._states[state] = {
      keyframe,
      nextState,
      handler,
    };
  }

  /**
   * will start the state machine at the given state
   * if you leave state null, it will simply continue
   * @param {?string} state optional new state
   * @returns {boolean} whether the state is valid
   */
  _runState(state = null) {
    if (!state) {
      state = this._stateNext;
    }

    if (!state || !this._states[state]) {
      return false;
    }

    const data = this._states[state];

    this._stateCurrent = state;
    this._stateNext = data.nextState !== state ? data.nextState : null;

    // simulating PR.op.state
    // - set frame
    // - set nextthink

    const animation = this.game._modelData[this.model];

    if (animation) {
      const frame = animation.frames.indexOf(data.keyframe);

      if (frame) {
        this.frame = frame;
        this.keyframe = data.keyframe;
      }

      // set frame2 for linear interpolation between frames
      if (this._stateNext) {
        const nextFrame = animation.frames.indexOf(this._states[this._stateNext].keyframe)
        this.frame2 = nextFrame !== -1 ? nextFrame : null;
      } else {
        this.frame2 = null;
      }
    }

    // schedule next think
    this.nextthink = this.game.time + 0.1;

    // call any additional code
    if (data.handler) {
      data.handler.call(this);
    }

    return true;
  }

  /**
   * tries to cast all initialData values (which are strings) to their corresponding types
   * @param {object} initialData map of entity fields
   */
  assignInitialData(initialData) {
    for (const [key, value] of Object.entries(initialData)) {
      // special check for classname
      if (key === 'classname') {
        if (this.classname !== value) {
          throw new RangeError('classname from initial data does not match entity classname');
        }

        // do not set
        continue;
      }

      if (key[0] === '_') {
        // do not overwrite private fields
        continue;
      }

      switch (true) {
        case this[key] instanceof Vector:
          this[key] = value instanceof Vector ? value.copy() : new Vector(...value.split(' ').map((n) => parseFloat(n)));
          break;

        case typeof (this[key]) === 'number':
          this[key] = parseFloat(value);
          break;

        case this[key] instanceof Flag:
          this[key].reset().set(value);
          break;

        default:
          this[key] = value;
      }
    }

    // this is used to prepopulate fields from ED.LoadFromFile and SV.SpawnServer
    if (this.engine.IsLoading()) {
      this._precache();
    }
  }

  setOrigin(origin) {
    this.edict.setOrigin(origin);
  }

  setModel(modelname) {
    if (this.engine.IsLoading()) {
      this.engine.PrecacheModel(modelname);
    }

    this.edict.setModel(modelname);
  }

  /**
   * @param {boolean} resetSize optionally resets mins/max to identity
   */
  unsetModel(resetSize = false) {
    this.modelindex = 0;
    this.model = null;

    if (resetSize) {
      this.setSize(Vector.origin, Vector.origin);
    }
  }

  /**
   *
   * @param {Vector} mins
   * @param {Vector} maxs
   */
  setSize(mins, maxs) {
    this.edict.setMinMaxSize(mins, maxs);
  }

  /**
   *
   * @param {BaseEntity} otherEntity other
   * @returns true, if equal
   */
  equals(otherEntity) {
    return otherEntity ? this.edict.equals(otherEntity.edict) : false;
  }

  isWorld() {
    return this.edictId === 0;
  }

  isActor() {
    return false;
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw
   * @param {number} dist
   * @returns {number}
   */
  walkMove(yaw, dist) {
    return this.edict.walkMove(yaw, dist);
  }

  /**
   * Change the horizontal orientation of this entity. Turns towards .ideal_yaw at .yaw_speed.
   * @returns {number} new yaw
   */
  changeYaw() {
    return this.edict.changeYaw();
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} [z] maximum distance to look down to check
   * @returns {number} whether the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    return this.edict.dropToFloor(z);
  }

  /**
   * Checks if the entity is standing on the ground.
   * @returns {boolean} true, if on the ground
   */
  isOnTheFloor() {
    return this.edict.isOnTheFloor();
  }

  /**
   * makes this entity static and frees underlying edict
   * NOTE: once this entity has been made static, there’s no interaction possible anymore
   */
  makeStatic() {
    this.edict.makeStatic();
  }

  /**
   * use this in spawn, it will setup an ambient sound
   * @param {string} sfxName e.g. sounds/door1.wav
   * @param {number} volume [0..1]
   * @param {attn} attenuation attenuation
   */
  spawnAmbientSound(sfxName, volume, attenuation) {
    this.engine.PrecacheSound(sfxName);
    this.engine.SpawnAmbientSound(this.origin, sfxName, volume, attenuation);
  }

  /**
   * starts a sound bound to an edict
   * @param {channel} channel what sound channel to use, it will overwrite currently playing sounds
   * @param {string} sfxName e.g. sounds/door1.wav
   * @param {number} volume [0..1]
   * @param {attn} attenuation attenuation
   */
  startSound(channel, sfxName, volume, attenuation) {
    this.engine.PrecacheSound(sfxName);
    this.engine.StartSound(this.edict, channel, sfxName, volume, attenuation);
  }

  /**
   * allocated Edict number
   * @returns {number} edict Id
   */
  get edictId() {
    return this.edict.num;
  }

  toString() {
    return `${this.classname} (Edict ${this.edictId}, ${this.constructor.name})`;
  }

  /**
   * releases this entity and frees underlying edict
   */
  remove() {
    this.edict.freeEdict();
  }

  clear() {
  }

  /**
   * called upon spawning an entity, sets things like model etc.
   */
  spawn() {
  }

  /**
   * called when nextthink is reached, invoked by the game engine (server code)
   * when overriding, make sure to call super.think()
   */
  think() {
    if (this._sub) {
      this._sub.think();
    }

    this._runState();
  }

  // === Interactions ===

  /**
   * this object is used (by another player or NPC), invoked by the game code
   * @param {BaseEntity} usedByEntity what entity is using this one
   */
  use(usedByEntity) {
    // debug and playing around only
    if (this.edictId > 0 && usedByEntity.classname === 'player') {
      usedByEntity.startSound(channel.CHAN_BODY, "misc/talk.wav", 1.0, attn.ATTN_NORM);
      usedByEntity.centerPrint(`${this}`);
      usedByEntity.consolePrint(
        `movetype = ${this.movetype}\n` +
        `flags = ${new Flag(flags, this.flags)}\n` +
        `frame = ${this.frame}\n` +
        `_stateCurrent = ${this._stateCurrent}\n`);
      console.log('BaseEntity.use:', this);
    }
  }

  /**
   * this object is blocked, invoked by the physics engine
   * @param {BaseEntity} blockedByEntity what entity is blocking this one
   */
  // eslint-disable-next-line no-unused-vars
  blocked(blockedByEntity) {
  }

  /**
   * this object is touched, invoked by the physics engine
   * @param {BaseEntity} touchedByEntity what entity is touching this one
   */
  // eslint-disable-next-line no-unused-vars
  touch(touchedByEntity) {
  }

  /**
   * based on QuakeC’s EntitiesTouching(this, otherEntity)
   * compares mins and maxs to see if they intersect
   * @param {BaseEntity} otherEntity other entity
   * @returns {boolean} true if this is touching the other entity
   */
  isTouching(otherEntity) {
    return this.mins.gt(otherEntity.maxs) && this.maxs.lt(otherEntity.mins);
  }

  /**
   * searches the next entity matching field equals value
   * @param {string} field what field to search
   * @param {string} value what value to match the value under field
   * @returns {?BaseEntity} found entity
   */
  findNextEntityByFieldAndValue(field, value) {
    const edict = this.engine.FindByFieldAndValue(field, value, this.edictId + 1);
    return edict ? edict.api : null;
  }

  /**
   * Returns client (or object that has a client enemy) that would be * a valid target. If there are more than one
   * valid options, they are cycled each frame. If (self.origin + self.viewofs) is not in the PVS of the target, null is returned.
   * @returns {?BaseEntity} found client
   */
  getNextBestClient() {
    const edict = this.edict.getNextBestClient();
    return edict ? edict.api : null;
  }

  /**
   * @param {BaseEntity} target target entity
   * @param {boolean} ignoreMonsters whether to pass through monsters
   */
  tracelineToEntity(target, ignoreMonsters) {
    const start = this.origin.copy().add(this.view_ofs ? this.view_ofs : Vector.origin);
    const end = target.origin.copy().add(target.view_ofs ? target.view_ofs : Vector.origin);

    return this.engine.Traceline(start, end, ignoreMonsters, this.edict);
  }

  /**
   * @param {Vector} target target point
   * @param {boolean} ignoreMonsters whether to pass through monsters
   */
  tracelineToVector(target, ignoreMonsters) {
    const start = this.origin.copy().add(this.view_ofs ? this.view_ofs : Vector.origin);

    return this.engine.Traceline(start, target, ignoreMonsters, this.edict);
  }
};
