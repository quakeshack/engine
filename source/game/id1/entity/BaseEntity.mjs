/* global Vector */

import { damage, dead, flags, moveType, solid, content, channel, attn } from "../Defs.mjs";

/**
 * helper class to deal with flags stored in bits
 */
export class Flag {
  constructor(enumMap, ...values) {
    this._enum = enumMap;
    this._value = 0;

    Object.seal(this);

    this.set(...values);
  }

  toString() {
    return Object.entries(this._enum)
      .filter(([, flag]) => (flag > 0 && this._value & flag) === flag)
      .map(([name]) => name)
      .join(', ');
  }

  has(...flags) {
    for (const flag of flags) {
      if (this._value & flag === flag) {
        return true;
      }
    }

    return false;
  }

  set(...flags) {
    const values = Object.values(this._enum);

    for (const flag of flags) {
      if (!values.includes(flag)) {
        throw new TypeError('Unknown flag ' + flag);
      }

      this._value |= flag;
    }

    return this;
  }

  unset(...flags) {
    for (const flag of flags) {
      this._value &= ~flag;
    }

    return this;
  }

  reset() {
    this._value = 0;

    return this;
  }
}

export default class BaseEntity {
  static classname = null;

  get classname() {
    return this.constructor.classname;
  }

  set classname(_) {
    throw new TypeError('Cannot set property classname');
  }

  constructor(edict, gameAPI) {
    // hooking up the edict and the entity, also the APIs
    this.edict = edict;
    this.edict.api = this;
    this.engine = gameAPI.engine;
    this.game = gameAPI;

    // base settings per Entity
    this.ltime = 0.0; // local time for entity
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
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_NOT;
    this.flags = flags.FL_NONE;
    this.spawnflags = 0;
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
    this.keyframe = null;

    this.nextthink = 0.0;
    this.groundentity = null; // FIXME: this is an Edict, not an entity
    this.chain = null; // this is mainly used by QuakeC, not us

    // relationships between entities
    this.owner = null; // entity, who launched a missile
    this.target = null; // entity
    this.targetname = null; // string

    this.movedir = new Vector(); // mostly for doors, but also used for waterjump

    // attacking and damage related (FIXME: should maybe put this to a different class)
    this.deadflag = dead.DEAD_NO;
    this.takedamage = damage.DAMAGE_NO;
    this.dmg = 0; // CR: find out the values
    this.show_hostile = 0;
    this.attack_finished = 0;

    this.message = null; // trigger messages

    // subs
    this._moveData = {};
    this._subReset();

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
   * @param {string | null} nextState
   * @param {Function | null} handler
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
   * @param {string | null} state
   * @returns
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
   * @param {Object} initialData
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

        case typeof(this[key]) === 'number':
          this[key] = parseFloat(value);
          break;

        case this[key] instanceof Flag:
          this[key].reset().set(value);
          break;

        default:
          this[key] = value;
      }
    }
  }

  /**
   * QuakeEd only writes a single float for angles (bad idea), so up and down are just constant angles.
   */
  _setMovedir() {
    if (this.angles.equalsTo(0.0, -1.0, 0.0)) {
      this.movedir.setTo(0.0, 0.0, 1.0);
    } else if (this.angles.equalsTo(0.0, -2.0, 0.0)) {
      this.movedir.setTo(0.0, 0.0, -1.0);
    } else {
      const { forward } = this.angles.angleVectors();
      this.movedir.set(forward);
    }

    this.angles.setTo(0.0, 0.0, 0.0);
  }

  setOrigin(origin) {
    this.edict.setOrigin(origin);
  }

  setModel(modelname) {
    if (this.engine.IsLoading()) {
      this.engine.PrecacheModel (modelname);
    }

    this.edict.setModel (modelname);
  }

  unsetModel() {
    this.modelindex = 0;
    this.model = null;
    // FIXME: invoke setModel on edict?
  }

  setSize(mins, maxs) {
    this.edict.setMinMaxSize(mins, maxs);
  }

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
   */
  walkMove(yaw, dist) {
    return this.edict.walkMove(yaw, dist);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} [z=-2048.0] maximum distance to look down to check
   * @returns whether the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    return this.edict.dropToFloor(z);
  }

  /**
   * Checks if the entity is standing on the ground.
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
   * @param {string} sfxName
   * @param {number} volume
   * @param {attn} attenuation
   */
  spawnAmbientSound(sfxName, volume, attenuation) {
    this.engine.PrecacheSound(sfxName);
    this.engine.SpawnAmbientSound (this.origin, sfxName, volume, attenuation);
  }

  /**
   * starts a sound bound to an edict
   * @param {channel} channel
   * @param {string} sfxName
   * @param {number} volume
   * @param {attn} attenuation
   */
  startSound(channel, sfxName, volume, attenuation) {
    this.engine.PrecacheSound(sfxName);
    this.engine.StartSound(this.edict, channel, sfxName, volume, attenuation);
  }

  /**
   * allocated Edict number
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
   * when overriding, make sure to call _subThink() and _runState() yourself.
   */
  think() {
    this._subThink();
    this._runState();
  }

  // === Interactions ===

  /**
   * this object is used (by another player or NPC), invoked by the game code
   * @param {BaseEntity} touchedByEntity
   */
  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
    // debug and playing around only
    if (this.edictId > 0 && usedByEntity.classname === 'player') {
      usedByEntity.startSound(channel.CHAN_BODY, "misc/talk.wav", 1.0, attn.ATTN_NORM);
      usedByEntity.centerPrint(
        `${this}\n\n` +
        `movetype = ${this.movetype}, ` +
        `flags = ${new Flag(flags, this.flags)}`);
    }
  }

  /**
   * this object is blocked, invoked by the physics engine
   * @param {BaseEntity} touchedByEntity
   */
  // eslint-disable-next-line no-unused-vars
  blocked(blockedByEntity) {
  }

  /**
   * this object is touched, invoked by the physics engine
   * @param {BaseEntity} touchedByEntity
   */
  // eslint-disable-next-line no-unused-vars
  touch(touchedByEntity) {
    // // CR: emulating original Quake behavior
    // if (touchedByEntity && touchedByEntity.classname === 'player') {
    //   this.use(touchedByEntity);
    // }
  }

  /**
   * based on QuakeC’s EntitiesTouching(this, otherEntity)
   * compares mins and maxs to see if they intersect
   * @param {BaseEntity} otherEntity
   */
  isTouching(otherEntity) {
    return this.mins.gt(otherEntity.maxs) && this.maxs.lt(otherEntity.mins);
  }

  /**
   * searches the next entity matching field equals value
   * @param {string} field
   * @param {string} value
   * @returns {BaseEntity|null}
   */
  findNextEntityByFieldAndValue(field, value) {
    const edict = this.engine.FindByFieldAndValue(field, value, this.edictId + 1);
    return edict ? edict.api : null;
  }

  // === Movements etc. ===

  /**
   * called in think() to handle any sub thinking
   * @returns returns true, when regular execution is OK
   */
  _subThink() {
    if (this._moveData.active) {
      if (this._moveData.finalOrigin) {
        this.setOrigin(this._moveData.finalOrigin);
        this.velocity.clear();
      }

      if (this._moveData.finalAngle) {
        this.angles = this._moveData.finalAngle;
        this.avelocity.clear();
      }

      this.nextthink = -1.0;
      if (this._moveData.callback) {
        this._moveData.callback();
      }

      this._moveData.active = false;

      return false;
    }

    return true;
  }

  _subReset() {
    this._moveData.finalAngle = null;
    this._moveData.finalOrigin = null;
    this._moveData.callback = null;
    this._moveData.active = false;
  }

  _subCalcMove(tdest, tspeed, callback) {
    if (!tspeed) {
      throw new TypeError("No speed is defined!");
    }

    this._moveData.active = true;
    this._moveData.callback = callback;
    this._moveData.finalOrigin = tdest;

    // check if we are already in place
    if (this.origin.equals(tdest)) {
      this.velocity.clear();
      this.nextthink = this.ltime + 0.1;
      return;
    }

    // set destdelta to the vector needed to move
    const vdestdelta = tdest.copy().subtract(this.origin);

    const len = vdestdelta.len();

    // divide by speed to get time to reach dest
    const traveltime = len / tspeed;

    if (traveltime < 0.1) {
      // too soon
      this.velocity.clear();
      this.nextthink = this.ltime + 0.1;
      return;
    }

    // set nextthink to trigger a think when dest is reached
    this.nextthink = this.ltime + traveltime;

    // scale the destdelta vector by the time spent traveling to get velocity
    this.velocity = vdestdelta.multiply(1.0/traveltime);
  }

  _subUseTargets() {
    // TODO: SUB_UseTargets();
  }
};
