import Vector from '../../../shared/Vector.mjs';

import { damage, dead, flags, moveType, solid, content, attn, channel } from '../Defs.mjs';
import { ServerGameAPI } from '../GameAPI.mjs';
import { Serializer } from '../helper/MiscHelpers.mjs';

/** @typedef {import('../../../engine/server/Edict.mjs').ServerEdict} ServerEdict */

class ScheduledThink {
  constructor(nextThink, callback, identifier, isRequired) {
    this._serializer = new Serializer(this);
    this._serializer.startFields();
    this.nextThink = nextThink;
    this.callback = callback;
    this.identifier = identifier;
    this.isRequired = isRequired;
    this._serializer.endFields();
  }
};

/**
 * @access package
 */
export default class BaseEntity {
  static classname = null;

  /** @returns {string} entity classname */
  get classname() {
    // @ts-ignore
    return this.constructor.classname;
  }

  get edict() {
    return this.edict_wf.deref();
  }

  /**
   * @param {ServerEdict} edict linked edict
   * @param {ServerGameAPI} gameAPI server game API
   */
  constructor(edict, gameAPI) {
    // hooking up the edict and the entity, also the APIs
    /** @private */
    this.edict_wf = new WeakRef(edict);
    this.edict.entity = this;
    this.engine = gameAPI.engine;
    this.game = gameAPI;

    this._serializer = new Serializer(this, this.engine);
    this._serializer.startFields();

    // base settings per Entity
    /**
     * @type {number} This is mostly useful for entities that need precise, smooth movement over time, like doors and platforms. It’s only set on entities with MOVETYPE_PUSHER, also the engine is using this only on SV.PushMove. This value is not the same as `game.time`. @see {@link this.game.time}
     */
    this.ltime = 0.0; // local time for entity (NOT time)
    this.origin = new Vector();
    this.oldorigin = new Vector();
    this.angles = new Vector();
    this.mins = new Vector(); // bounding box extents relative to origin
    this.maxs = new Vector(); // bounding box extents relative to origin
    this.absmin = new Vector();
    this.absmax = new Vector();
    this.size = new Vector(); // maxs - mins
    this.velocity = new Vector();
    this.avelocity = new Vector();
    /** @type {number} @see {moveType} */
    this.movetype = moveType.MOVETYPE_NONE;
    /** @type {number} @see {solid} */
    this.solid = solid.SOLID_NOT;
    /** @type {number} @see {flags} */
    this.flags = flags.FL_NONE; // SV.WriteClientdataToMessage
    this.spawnflags = 0;
    /** @type {number} @see {content} */
    this.watertype = content.CONTENT_EMPTY;
    /** determines the waterlevel: 0 outside, 1 inside, > 1 different contents */
    this.waterlevel = 0; // SV.WriteClientdataToMessage
    /** used by the engine to handle water and air move after a teleportation */
    this.teleport_time = 0;

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
    /** @type {?BaseEntity} set by the phyiscs engine */
    this.groundentity = null;
    /** @type {?BaseEntity} this is mainly used by QuakeC, not us */
    this.chain = null; // FIXME: consider removing

    // relationships between entities
    /** @type {?BaseEntity} entity, who launched a missile */
    this.owner = null;
    /** @type {?string} targets to kill, used by Subs */
    this.killtarget = null;
    /** @type {?string} targets to trigger, used by Subs */
    this.target = null;
    /** @type {?string} target name to be addressed, used by Subs */
    this.targetname = null;

    this.movedir = new Vector(); // mostly for doors, but also used for waterjump

    // attacking and damage related (FIXME: should maybe put this to a different class)
    /** @type {number} */
    this.deadflag = dead.DEAD_NO;
    /** @type {number} */
    this.takedamage = damage.DAMAGE_NO;
    this.dmg = 0; // CR: find out the values
    this.dmg_take = 0; // SV.WriteClientdataToMessage
    this.dmg_save = 0; // SV.WriteClientdataToMessage
    /** @type {?BaseEntity} set by DamageHandler.damage */
    this.dmg_inflictor = null; // SV.WriteClientdataToMessage
    /** @type {?BaseEntity} set by DamageHandler.damage */
    this.dmg_attacker = null;
    this.show_hostile = 0;
    /** @type {number} can be used for all sorts of repeat next kind of tracking */
    this.attack_finished = 0;
    /** @type {number} can be used to keep track of when the next pain state is possible */
    this.pain_finished = 0;

    /** @type {?string} message for triggers or map name */
    this.message = null; // trigger messages

    // states, sub and thinking
    /** @type {?import('./Subs.mjs').Sub} @protected */
    this._sub = null; // needs to be initialized optionally
    /** @private */
    this._stateNext = null;
    /** @private */
    this._stateCurrent = null;
    /** @private */
    this._scheduledThinks = [];

    this._serializer.endFields();

    /** @private */
    this._states = {};

    /** @type {?import('./Weapons.mjs').DamageHandler} @public */
    this._damageHandler = null; // needs to be initialized optionally

    this._declareFields();
    this._initStates();

    Object.seal(this);

    // this is used to prepopulate fields from ED.LoadFromFile and SV.SpawnServer
    if (this.engine.IsLoading()) {
      this._precache();
    }
  }

  /** @returns {number} volume */
  get volume() {
    return this.size[0] * this.size[1] * this.size[2];
  }

  /**
   * Allows initialization of fields before the object gets frozen.
   * @protected
   */
  _declareFields() {
    // allows you to define all fields prior to spawn
    // make sure to prefix private fields with an underscore
    // make sure to call this._serializer.startFields() and this._serializer.endFields(), otherwise these fields won’t be saved

    // this._serializer.startFields();
    // this._myPrivateField = 123;
    // this.weight = 400;
    // this._serializer.endFields();
  }

  /**
   * All Precache* calls are placed here, it’s invoked by the engine indirectly upon loading
   * @protected
   */
  _precache() {
    // this.engine.PrecacheModel('models/box.mdl');
  }

  /**
   * Configures the state machine.
   * @protected
   */
  _initStates() {
    // place all animation states and scripted sequences here
    // this._defineState('army_stand1', 'stand1', 'army_stand2', function () { this._ai.stand(); });
  }

  /**
   * Defines a state for the state machine.
   * @protected
   * @param {string} state state name
   * @param {?string|number} keyframe frame/keyframe name the model should be in
   * @param {?string} nextState state name of the automatic next state
   * @param {?Function} handler additional code to be executed
   */
  _defineState(state, keyframe, nextState = null, handler = null) {
    this._states[state] = { keyframe, nextState, handler };
  }

  /**
   * Will start the state machine at the given state.
   * If you leave state null, it will simply continue with the next state.
   * @param {?string} state optional new state
   * @returns {boolean} whether the state is valid
   */
  _runState(state = null) {
    // console.debug('_runState: requested, next, current', state, this._stateNext, this._stateCurrent);

    if (!state) {
      state = this._stateNext;
    }

    if (!state) {
      return false;
    }

    if (!this._states[state]) {
      // console.warn('_runState: state not defined!', state);
      return false;
    }

    const data = this._states[state];

    this._stateCurrent = state;
    // CR: for some reason I spent an hour to figure out why the nextState is not set, and it was because of this line:
    // this._stateNext = data.nextState !== state ? data.nextState : null;
    this._stateNext = data.nextState || null;

    // this is simulating QuakeC VM’s PR.op.state opcode
    // - set frame
    // - set nextthink
    // - execute the rest

    const animation = this.game._modelData[this.model];

    if (typeof (data.keyframe) === 'number') {
      this.frame = data.keyframe;
      this.keyframe = data.keyframe;
    } else if (animation && data.keyframe) {
      const frame = animation.frames.indexOf(data.keyframe);

      if (frame) {
        this.frame = frame;
        this.keyframe = data.keyframe;
      }

      // // set frame2 for linear interpolation between frames (CR: not thought out yet)
      // if (this._stateNext) {
      //   const nextFrame = animation.frames.indexOf(this._states[this._stateNext].keyframe)
      //   this.frame2 = nextFrame !== -1 ? nextFrame : null;
      // } else {
      //   this.frame2 = null;
      // }
    }

    // console.debug('_runState: requested, next, current', state, this._stateNext, this._stateCurrent, this.frame, this.keyframe);

    // create or update the next think for the animation state
    this._scheduleThink(this.game.time + 0.1, function () { this._runState(); }, 'animation-state-machine');

    // call any additional code
    if (data.handler) {
      data.handler.call(this);
    }

    return true;
  }

  /**
   * Schedules a think.
   * @package
   * @param {number} nextThink when to call back in seconds starting from game.time
   * @param {Function} callback callback function, thisArg and the first argument is going to be this
   * @param {?string} identifier optional identifier to overwrite existing scheduled thinks
   * @param {boolean} isRequired this think needs to be executed, even when it’s overdue
   */
  _scheduleThink(nextThink, callback, identifier = null, isRequired = false) {
    const think = identifier ? this._scheduledThinks.find((think) => think.identifier === identifier) : null;

    if (think) {
      think.nextThink = nextThink;
      think.callback = callback;
      think.isRequired = isRequired;
    } else {
      this._scheduledThinks.push(new ScheduledThink(nextThink, callback, identifier, isRequired));
    }

    this._scheduledThinks.sort((a, b) => a.nextThink - b.nextThink);

    // set next think
    this.nextthink = this._scheduledThinks[0].nextThink;
  }

  /**
   * Runs the next scheduled think and sets nextthink accordingly, if applicable.
   * @private
   * @returns {boolean} true, if there was something to execute
   */
  _runScheduledThinks() {
    if (!this._scheduledThinks || this._scheduledThinks.length === 0) {
      return false;
    }

    const { callback } = this._scheduledThinks.shift();

    callback.call(this, this);

    // freed in the meantime
    if (!this._scheduledThinks) {
      return false;
    }

    // skip over all passed thinks
    // FIXME: what’s the alternative to check time against for moveType.MOVETYPE_PUSH?
    if (this.movetype !== moveType.MOVETYPE_PUSH) {
      while (this._scheduledThinks.length > 0 && this.game.time > this._scheduledThinks[0].nextThink) {
        const { callback, isRequired } = this._scheduledThinks.shift();

        if (isRequired) {
          callback.call(this, this);
        }

        // freed in the meantime
        if (!this._scheduledThinks) {
          return false;
        }
      }
    }

    if (this._scheduledThinks.length > 0) {
      this.nextthink = this._scheduledThinks[0].nextThink;
    }

    return true;
  }

  /**
   * Tries to inflict damage on an entity, depends on the entity having a damage handler.
   * @param {BaseEntity | null} victimEntity entity that receives damage
   * @param {number} damage damage points
   * @param {?BaseEntity} attackerEntity entity who is actually orchestrating the attack, this is already the entity what is attacking, defaults to this
   * @param {?Vector} hitPoint the exact hit position (if nuff, origin will be used)
   * @returns {boolean} true, if entity could receive damage
   */
  damage(victimEntity, damage, attackerEntity = null, hitPoint = null) {
    if (!victimEntity || !victimEntity._damageHandler) {
      return false;
    }

    victimEntity._damageHandler.damage(this, attackerEntity || this, damage, hitPoint || victimEntity.origin);

    return true;
  }

  /**
   * Checks if this entity can receive damage from a given attacker.
   * @param {BaseEntity} attackerEntity entity who is attacking/inflicting
   * @returns {boolean} true, if this entity can receive damage
   */
  canReceiveDamage(attackerEntity) {
    if (!this._damageHandler) {
      return false;
    }

    return this._damageHandler.canReceiveDamage(attackerEntity);
  }

  /**
   * Completely resets all thinking and purges all scheduled thinks.
   */
  resetThinking() {
    this._scheduledThinks = [];
    this.nextthink = -1.0;
  }

  /**
   * Tries to cast all initialData values (which are strings) to their corresponding types.
   * This is mainly called upon spawn new entities.
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

      if (key[0] === '_' || key[0] === '#') {
        // do not overwrite private fields
        continue;
      }

      if (!(key in this)) {
        console.warn(`BaseEntity.assignInitialData: invalid key on entity (${this})`, this, key, value);
        continue;
      }

      switch (true) {
        case this[key] instanceof Vector:
          this[key] = value instanceof Vector ? value.copy() : new Vector(...value.split(' ').map((n) => parseFloat(n)));
          break;

        case typeof (this[key]) === 'number':
          this[key] = parseFloat(value);
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

  /**
   * Sets the origin, the engine will set origin property accordingly and relink the edict to related areas, but do not trigger touchs.
   * @param {Vector} origin position in the world
   */
  setOrigin(origin) {
    this.edict.setOrigin(origin);
  }

  /**
   * Sets model, the engine will also set properties model, modelindex as well.
   * The engine will also set mins/maxs based on the model causing a relink and touch cascade.
   * To clear model, use unsetModel().
   * @param {string} modelname e.g. progs/player.mdl
   */
  setModel(modelname) {
    if (this.engine.IsLoading()) {
      this.engine.PrecacheModel(modelname);
    }

    this.edict.setModel(modelname);
  }

  /**
   * Clears the entity off a model properly. Optionally, it will reset sizes as well.
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
   * Sets bounding box sizes.
   * The engine will relink, check collisions and call touch, if applicable.
   * Always use setSize _after_ setModel.
   * @param {Vector} mins the nearest point
   * @param {Vector} maxs the farthest point
   */
  setSize(mins, maxs) {
    this.edict.setMinMaxSize(mins, maxs);
  }

  /**
   * Determines the center point of the entity by looking at the absolute bounding box.
   * @returns {Vector} center point of the entity
   */
  get centerPoint() {
    return this.absmin.copy().add(this.absmax).multiply(0.5);
  }

  /**
   * Tests equality on Entity/Edict level.
   * @param {BaseEntity|ServerEdict} otherEntity other
   * @returns {boolean} true, if equal
   */
  equals(otherEntity) {
    // @ts-ignore
    otherEntity = otherEntity !== null && (otherEntity.entity instanceof BaseEntity) ? otherEntity.entity : otherEntity;

    // @ts-ignore
    return otherEntity ? this.edict.equals(otherEntity.edict) : false;
  }

  /**
   * Returns allocated Edict number.
   * @returns {number} edict Id
   */
  get edictId() {
    return this.edict.num;
  }

  /**
   * @returns {boolean} true, if this is worldspawn.
   */
  isWorld() {
    return this.edictId === 0;
  }

  /**
   * @returns {boolean} true, if this is considered being an actor.
   */
  isActor() {
    return false;
  }

  /**
   * @returns {string} String representation (not serialization) of this entity.
   */
  toString() {
    return `${this.constructor.name} (${this.classname}, num: ${this.edictId}, origin: ${this.origin})`;
  }

  /**
   * Returns a vector along which this entity can shoot.
   * Usually, this entity is a player, and the vector returned is calculated by auto aiming to the closest enemy entity.
   * NOTE: The original code and unofficial QuakeC reference docs say there’s an argument (speed/misslespeed), but it’s unused.
   * @param {Vector} direction e.g. forward
   * @returns {Vector} aim direction
   */
  aim(direction) {
    return this.edict.aim(direction);
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw
   * @param {number} dist
   * @returns {boolean} true, if the move was successful
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
   * @returns {boolean} true, if the dropping succeeded
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
   * Makes this entity static and frees underlying edict.
   * NOTE: Once this entity has been made static, there’s no interaction possible anymore.
   */
  makeStatic() {
    this.edict.makeStatic();
  }

  /**
   * Spawn an ambient (looping) sound.
   * @param {string} sfxName e.g. sounds/door1.wav
   * @param {number} volume [0..1]
   * @param {number} attenuation attenuation (see {@link attn})
   */
  spawnAmbientSound(sfxName, volume, attenuation) {
    this.engine.PrecacheSound(sfxName);
    this.engine.SpawnAmbientSound(this.centerPoint, sfxName, volume, attenuation);
  }

  /**
   * Starts a sound bound to an edict.
   * @param {number} channel what sound channel to use, it will overwrite currently playing sounds (see {@link channel})
   * @param {string} sfxName e.g. sounds/door1.wav
   * @param {number} volume [0..1]
   * @param {number} attenuation attenuation (see {@link attn})
   */
  startSound(channel, sfxName, volume = 1.0, attenuation = attn.ATTN_NORM) {
    this.engine.PrecacheSound(sfxName);
    this.engine.StartSound(this.edict, channel, sfxName, volume, attenuation);
  }

  /**
   * Releases this entity and frees underlying edict immediately.
   */
  remove() {
    this.edict.freeEdict();
  }

  /**
   * It will make an entity appear to be removed, but it will not free the edict yet.
   * When to use? During a think, touch or blocked callback, when you want to remove the entity, but you do not want to throw the engine off its track.
   */
  lazyRemove() {
    this.unsetModel(true);
    this.solid = solid.SOLID_NOT;
    this.movetype = moveType.MOVETYPE_NONE;
    this.resetThinking();
    this._scheduleThink(this.game.time + 0.1, () => this.remove(), 'remove', true);
  }

  /**
   * Resets this entity. Useful for dealing with respawning players and other entities when required.
   */
  clear() {
    this.resetThinking();
    this.dmg_attacker = null;
    this.dmg_inflictor = null;
    this.owner = null;
    this.chain = null; // FIXME: consider removing
    this.groundentity = null;
  }

  /**
   * Frees this entity, nulls any variable possibly pointing to an object. Afterwards it is meant for being garbage-collected.
   */
  free() {
    for (const prop in this) {
      this[prop] = undefined;
    }
  }

  /**
   * Called upon spawning an entity, sets things like model, sizes, move types etc.
   */
  spawn() {
  }

  /**
   * Called when nextthink is reached, invoked by the game engine (server code).
   * When overriding, make sure to call super.think(), otherwise you will loose the scheduled thinking infrastructure.
   */
  think() {
    this._runScheduledThinks();
  }

  // === Interactions ===

  /**
   * This object is used (by another player or NPC), invoked by the game code.
   * @param {BaseEntity} usedByEntity what entity is using this one
   */
  // eslint-disable-next-line no-unused-vars
  use(usedByEntity) {
  }

  /**
   * This object is blocked, invoked by the physics engine.
   * @param {BaseEntity} blockedByEntity what entity is blocking this one
   */
  // eslint-disable-next-line no-unused-vars
  blocked(blockedByEntity) {
  }

  /**
   * This object is touched, invoked by the physics engine.
   * @param {BaseEntity} touchedByEntity what entity is touching this one
   */
  // eslint-disable-next-line no-unused-vars
  touch(touchedByEntity) {
  }

  /**
   * Based on QuakeC’s EntitiesTouching(this, otherEntity), compares mins and maxs to see if they intersect.
   * @param {BaseEntity} otherEntity other entity
   * @returns {boolean} true if this is touching the other entity
   */
  isTouching(otherEntity) {
    for (let i = 0; i < 3; i++) {
      if (this.mins[i] > otherEntity.maxs[i]) {
        return false;
      }

      if (this.maxs[i] < otherEntity.mins[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Searches the next entity matching field equals value.
   * @param {string} field what field to search
   * @param {string} value what value to match the value under field
   * @param {?BaseEntity} lastEntity last entity to start searching from (default: this)
   * @param {boolean} loopSearch if true and there is no next entity, start all over once more
   * @returns {?BaseEntity} found entity
   */
  findNextEntityByFieldAndValue(field, value, lastEntity = this, loopSearch = false) {
    const edict = this.engine.FindByFieldAndValue(field, value, lastEntity ? lastEntity.edictId + 1 : 0);
    return edict ? edict.entity : (loopSearch ? this.findFirstEntityByFieldAndValue(field, value) : null);
  }

  /**
   * Searches the first entity matching field equals value.
   * @param {string} field what field to search
   * @param {string} value what value to match the value under field
   * @returns {?BaseEntity} found entity
   */
  findFirstEntityByFieldAndValue(field, value) {
    const edict = this.engine.FindByFieldAndValue(field, value);
    return edict ? edict.entity : null;
  }

  /**
   * Searches all entity matching field equals value.
   * @param {string} field what field to search
   * @param {string} value what value to match the value under field
   * @yields {BaseEntity} matching entity
   */
  *findAllEntitiesByFieldAndValue(field, value) {
    for (const edict of this.engine.FindAllByFieldAndValue(field, value)) {
      yield edict.entity;
    }
  }

  /**
   * Returns client (or object that has a client enemy) that would be * a valid target.
   * If there are more than one valid options, they are cycled each frame.
   * If (self.origin + self.viewofs) is not in the PVS of the target, null is returned.
   * @returns {?BaseEntity} found client
   */
  getNextBestClient() {
    const edict = this.edict.getNextBestClient();
    return edict ? edict.entity : null;
  }

  /**
   * @param {BaseEntity} target target entity
   * @param {boolean} ignoreMonsters whether to pass through monsters
   * @returns {*} trace information
   */
  tracelineToEntity(target, ignoreMonsters) {
    const start = this.origin.copy().add(this.view_ofs ? this.view_ofs : Vector.origin);
    const end = target.origin.copy().add(target.view_ofs ? target.view_ofs : Vector.origin);

    return this.engine.Traceline(start, end, ignoreMonsters, this.edict);
  }

  /**
   * @param {Vector} target target point
   * @param {boolean} ignoreMonsters whether to pass through monsters
   * @returns {*} trace information
   */
  tracelineToVector(target, ignoreMonsters) {
    const start = this.origin.copy().add(this.view_ofs ? this.view_ofs : Vector.origin);

    return this.engine.Traceline(start, target, ignoreMonsters, this.edict);
  }

  /**
   * @param {Vector} origin starting point
   * @param {Vector} target ending point
   * @param {boolean} ignoreMonsters whether to pass through monsters
   * @returns {*} trace information
   */
  traceline(origin, target, ignoreMonsters) {
    return this.engine.Traceline(origin, target, ignoreMonsters, this.edict);
  }

  /**
   * Move this entity toward its goal. Used for monsters.
   * @param {number} distance move distance
   * @returns {boolean} true, when successful
   */
  moveToGoal(distance) {
    return this.edict.moveToGoal(distance);
  }

  serialize() {
    return this._serializer.serialize();
  }

  deserialize(data) {
    this._serializer.deserialize(data);
  }
};
