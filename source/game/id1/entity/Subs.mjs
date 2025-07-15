import Vector from '../../../shared/Vector.mjs';

import { channel, moveType, solid } from '../Defs.mjs';
import { EntityWrapper } from '../helper/MiscHelpers.mjs';
import BaseEntity from './BaseEntity.mjs';
import { PlayerEntity } from './Player.mjs';

export const triggerFieldFlags = {
  /** Vanilla Quake behavior */
  TFF_NONE: 0,
  /** Dead actors can still trigger the field */
  TFF_DEAD_ACTORS_TRIGGER: 1,
  /** Any entity can trigger the field */
  TFF_ANY_ENTITY_TRIGGERS: 2,
};

/**
 * special entity that will trigger a linked entity’s use method when touched, use flags and {triggerFieldFlags} to adjust behavior
 */
export class TriggerFieldEntity extends BaseEntity {
  static classname = 'subs_triggerfield';

  _declareFields() {
    this._serializer.startFields();

    this.flags = triggerFieldFlags.TFF_NONE;

    this._serializer.endFields();
  }

  spawn() {
    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;

    this.setFieldSize(this.mins, this.maxs);
  }

  setFieldSize(fmins, fmaxs) {
    const dimensions = new Vector(60.0, 60.0, 8.0);
    const mins = fmins.copy().subtract(dimensions);
    const maxs = fmaxs.copy().add(dimensions);
    this.setSize(mins, maxs);
  }

  touch(otherEntity) {
    // CR: upon spawn otherEntity might be another TriggerField, when overlapping
    if (otherEntity instanceof TriggerFieldEntity) {
      return;
    }

    if (otherEntity.isWorld()) {
      return;
    }

    if (!(this.flags & triggerFieldFlags.TFF_ANY_ENTITY_TRIGGERS) && !otherEntity.isActor()) {
      return;
    }

    if (!(this.flags & triggerFieldFlags.TFF_DEAD_ACTORS_TRIGGER) && otherEntity.health <= 0) {
      return;
    }

    if (this.game.time < this.attack_finished) {
      return;
    }

    this.attack_finished = this.game.time + 1.0;

    this.owner.use(otherEntity);
  }
};

/**
 * Special entity that will trigger a linked entity’s useTargets method after a delay.
 * You do not have to spawn this yourself, it will be done by useTargets when a delay is set.
 */
export class DelayedThinkEntity extends BaseEntity {
  static classname = 'subs_delayedthink';

  _declareFields() {
    this._serializer.startFields();

    /** @type {BaseEntity} activator entity */
    this.activator = null;
    /** @type {number} delay in seconds */
    this.delay = 0;

    this._serializer.endFields();

    this._sub = new Sub(this);
  }

  spawn() {
    this.message = this.owner.message;
    this.killtarget = this.owner.killtarget;
    this.target = this.owner.target;

    console.assert(this.owner instanceof BaseEntity, 'owner must be a BaseEntity');
    console.assert(this.activator instanceof BaseEntity, 'owner must be a BaseEntity');
    console.assert(this.delay > 0, 'delay must be greater than 0');
    console.assert(this.killtarget || this.target, 'must have either killtarget or target');

    this._scheduleThink(this.game.time + this.delay, () => {
      this.delay = 0; // CR: reset delay to avoid multiple calls
      this._sub.useTargets(this.activator);
      this.remove();
    });
  }
};

/**
 * helper class to make entities more interactive:
 * - movements
 * - delayed interactions
 * - optional triggers upon use
 */
export class Sub extends EntityWrapper {
  /**
   * @param {BaseEntity} entity bound entity
   */
  constructor(entity) {
    super(entity);

    this._moveData = {};
    this._useData = {};

    this.reset();
  }

  /** @protected */
  _assertEntity() {
    console.assert(this._entity.target !== undefined, 'target property required');
    console.assert(this._entity.killtarget !== undefined, 'killtarget property required');
  }

  /**
   * QuakeEd only writes a single float for angles (bad idea), so up and down are just constant angles.
   */
  setMovedir() {
    if (this._entity.angles.equalsTo(0.0, -1.0, 0.0)) {
      this._entity.movedir.setTo(0.0, 0.0, 1.0);
    } else if (this._entity.angles.equalsTo(0.0, -2.0, 0.0)) {
      this._entity.movedir.setTo(0.0, 0.0, -1.0);
    } else {
      const { forward } = this._entity.angles.angleVectors();
      this._entity.movedir.set(forward);
    }

    this._entity.angles.setTo(0.0, 0.0, 0.0);
  }

  /**
   * resets current state
   */
  reset() {
    this._moveData.finalAngle = null;
    this._moveData.finalOrigin = null;
    this._moveData.callback = null;
    this._moveData.active = false;

    this._useData.callback = null;
  }

  /**
   * @returns {boolean} returns true, when regular execution is OK
   */
  _think() {
    if (this._moveData.active) {
      if (this._moveData.finalOrigin) {
        this._entity.setOrigin(this._moveData.finalOrigin);
        this._entity.velocity.clear();
        this._moveData.finalOrigin = null;
      }

      if (this._moveData.finalAngle) {
        this._entity.angles.set(this._moveData.finalAngle);
        this._entity.avelocity.clear();
        this._moveData.finalAngle = null;
      }

      // this._entity.nextthink = -23.0; // CR: -23 is chosen to mark a thinktime reset by Sub

      if (this._moveData.callback instanceof Function) {
        this._moveData.callback.call(this._entity);
        this._moveData.callback = null;
      }

      this._moveData.active = false;
      return false;
    }

    if (this._useData.callback) {
      if (this._useData.callback instanceof Function) {
        this._useData.callback.call(this._entity);
        this._useData.callback = null;
      }

      return false;
    }

    return true;
  }

  /**
   * sets an entity off on a journey
   * @param {Vector} tdest desired origin vector
   * @param {number} tspeed desired movement speed
   * @param {?Function} callback will be called once the destination has been reached
   */
  calcMove(tdest, tspeed, callback) {
    console.assert(tspeed, 'desired movement speed provided');

    this._moveData.active = true;
    this._moveData.callback = callback;
    this._moveData.finalOrigin = tdest.copy();

    // check if we are already in place
    if (this._entity.origin.equals(tdest)) {
      this._entity.velocity.clear();
      this._entity._scheduleThink(this._entity.ltime + 0.1, function () { this._sub._think(); });
      return;
    }

    // set destdelta to the vector needed to move
    const vdestdelta = tdest.copy().subtract(this._entity.origin);

    const len = vdestdelta.len();

    // divide by speed to get time to reach dest
    const traveltime = len / tspeed;

    if (traveltime < 0.1) {
      // too soon
      this._entity.velocity.clear();
      this._entity._scheduleThink(this._entity.ltime + 0.1, function () { this._sub._think(); });
      return;
    }

    // schedule a think to trigger a think when dest is reached
    this._entity._scheduleThink(this._entity.ltime + traveltime, function () { this._sub._think(); });

    // scale the destdelta vector by the time spent traveling to get velocity
    this._entity.velocity = vdestdelta.multiply(1.0 / traveltime);
  }

  useTargets(activatorEntity) {
    console.assert(activatorEntity !== null, 'activator is required');

    // delayed execution has to be done with a helper entity
    if (this._entity.delay && !this._useData.callback) {
      this._engine.SpawnEntity(DelayedThinkEntity.classname, {
        owner: this._entity,
        delay: this._entity.delay,
        activator: activatorEntity,
      });
      return;
    }

    // print a message, if activator is a player
    if (activatorEntity instanceof PlayerEntity && this._entity.message) {
      activatorEntity.centerPrint(this._entity.message);

      if (!this._entity.noise) {
        activatorEntity.startSound(channel.CHAN_VOICE, 'misc/talk.wav');
      }
    }

    // FIXME: replace the while loops below with FindAllByFieldAndValue

    // remove all killtargets
    if (this._entity.killtarget) {
      /** @type {BaseEntity} */
      let searchEntity = this._game.worldspawn;
      do {
        searchEntity = searchEntity.findNextEntityByFieldAndValue('targetname', this._entity.killtarget);
        if (!searchEntity) {
          return;
        }
        searchEntity.remove();
        // eslint-disable-next-line no-constant-condition
      } while (true);
    }

    // fire targets
    if (this._entity.target) {
      /** @type {BaseEntity} */
      let searchEntity = this._game.worldspawn;
      do {
        searchEntity = searchEntity.findNextEntityByFieldAndValue('targetname', this._entity.target);
        if (!searchEntity) {
          return;
        }
        // CR: this is way more convenient than QuakeC’s version (subs.qc:260)
        searchEntity.use(activatorEntity);
        // eslint-disable-next-line no-constant-condition
      } while (true);
    }
  }
};
