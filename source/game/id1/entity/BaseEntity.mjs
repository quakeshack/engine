/* global Vector */

import { moveType, solid } from "../Defs.mjs";

export default class BaseEntity {
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

    // Quake model related
    this.model = null;
    this.modelindex = 0;
    this.frame = 0;
    this.skin = 0;
    this.effects = 0;

    // QuakeJS model related
    this.keyframe = null;

    this.nextthink = 0.0;
    this.groundentity = null; // this is an edict, not an entity
    this.chain = null;

    this._states = {};
    this._stateNext = null;
    this._stateCurrent = null;

    this._declareFields();
    this._initStates();

    // this is used to prepopulate fields from ED.LoadFromFile and SV.SpawnServer
    if (this.engine.IsLoading()) {
      this._precache();
    }
  }

  // allows you to define all fields prior to spawn
  _declareFields() {
  }

  // allows you to place all Precache* calls
  _precache() {
  }

  // allows you to init all available states
  _initStates() {
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
      switch (true) {
        case this[key] instanceof Vector:
          this[key] = value instanceof Vector ? value.copy() : new Vector(...value.split(' ').map((n) => parseFloat(n)));
          break;

        case typeof(this[key]) === 'number':
          this[key] = parseFloat(value);
          break;

        default:
          this[key] = value;
      }
    }
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

  setSize(mins, maxs) {
    this.edict.setMinMaxSize(mins, maxs);
  }

  equals(otherEntity) {
    return otherEntity ? this.edict.equals(otherEntity.edict) : false;
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

  spawnAmbientSound(sfxName, volume, attn) {
    this.engine.PrecacheSound (sfxName);
    this.engine.SpawnAmbientSound (this.origin, sfxName, volume, attn);
  }

  /**
   * releases this entity and frees underlying edict
   */
  remove() {
    this.edict.freeEdict();
  }

  clear() {
  }

  spawn() {
  }

  think() {
    this._runState();
  }

  // eslint-disable-next-line no-unused-vars
  use(otherEntity) {
  }

  // eslint-disable-next-line no-unused-vars
  blocked(otherEntity) {
  }

  touch(otherEntity) {
    if (otherEntity && otherEntity.classname === 'player') {
      this.use(otherEntity);
    }
  }
};
