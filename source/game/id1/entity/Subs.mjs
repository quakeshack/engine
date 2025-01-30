/* global Vector */

import { moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";

export class TriggerBaseEntity extends BaseEntity {
  spawn() {
    super.spawn();

    // trigger angles are used for one-way touches.  An angle of 0 is assumed
    // to mean no restrictions, so use a yaw of 360 instead.

    if (!this.angles.isOrigin()) {
      this._sub.setMovedir();
    }

    this.solid = solid.SOLID_TRIGGER;
    this.setModel(this.model); // set size and link into world
    this.movetype = moveType.MOVETYPE_NONE;
    this.unsetModel();
  }
};

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
export class TriggerField extends BaseEntity {
  static classname = 'subs_triggerfield';

  _declareFields() {
    this.flags = triggerFieldFlags.TFF_NONE;
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
    if (otherEntity instanceof TriggerField) {
      return;
    }

    if (otherEntity.isWorld()) {
      return;
    }

    if (!(this.flags & triggerFieldFlags.TFF_ANY_ENTITY_TRIGGERS) && !otherEntity.isActor()) {
      return;
    }

    if (!(this.flags & triggerFieldFlags.TFF_DEAD_BODIES_TRIGGER) && otherEntity.health <= 0) {
      return;
    }

    if (this.game.time < this.attack_finished) {
      return;
    }

    this.attack_finished = this.game.time + 1.0;

    // TODO: activator = other; ?? -- copied from QuakeC

    this.owner.use(otherEntity);
  }
};

/**
 * helper class to make entities more interactive:
 * - movements
 * - delayed interactions
 */
export class Sub {
  /**
   * @param {BaseEntity} entity
   */
  constructor(entity) {
    /** @type {BaseEntity} associated entity */
    this._entity = entity;
    this._moveData = {};
    Object.seal(this);

    this.reset();
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
  }

  /**
   * called in think() to handle any sub thinking
   * @returns returns true, when regular execution is OK
   */
  think() {
    if (this._moveData.active) {
      if (this._moveData.finalOrigin) {
        this._entity.setOrigin(this._moveData.finalOrigin);
        this._entity.velocity.clear();
      }

      if (this._moveData.finalAngle) {
        this._entity.angles = this._moveData.finalAngle;
        this._entity.avelocity.clear();
      }

      this._entity.nextthink = -1.0;
      if (this._moveData.callback instanceof Function) {
        this._moveData.callback.call(this._entity);
      }

      this._moveData.active = false;
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
    if (!tspeed) {
      throw new TypeError("No speed is defined!");
    }

    this._moveData.active = true;
    this._moveData.callback = callback;
    this._moveData.finalOrigin = tdest;

    // check if we are already in place
    if (this._entity.origin.equals(tdest)) {
      this._entity.velocity.clear();
      this._entity.nextthink = this._entity.ltime + 0.1;
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
      this._entity.nextthink = this._entity.ltime + 0.1;
      return;
    }

    // set nextthink to trigger a think when dest is reached
    this._entity.nextthink = this._entity.ltime + traveltime;

    // scale the destdelta vector by the time spent traveling to get velocity
    this._entity.velocity = vdestdelta.multiply(1.0 / traveltime);
  }

  useTargets() {
    // TODO: SUB_UseTargets();
  }
};
