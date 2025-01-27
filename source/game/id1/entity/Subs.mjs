/* global Vector */

import { moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";

export class TriggerBaseEntity extends BaseEntity {
  spawn() {
    super.spawn();

    // trigger angles are used for one-way touches.  An angle of 0 is assumed
    // to mean no restrictions, so use a yaw of 360 instead.

    if (!this.angles.isOrigin()) {
      this._setMovedir();
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
}
