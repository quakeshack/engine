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
