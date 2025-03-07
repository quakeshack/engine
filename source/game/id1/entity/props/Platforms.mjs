/* global Vector */

import { moveType, solid } from "../../Defs.mjs";
import BaseEntity from "../BaseEntity.mjs";
import { PlayerEntity } from "../Player.mjs";
import BasePropEntity, { state } from "./BasePropEntity.mjs";

/**
 * QUAKED func_plat (0 .5 .8) ? PLAT_LOW_TRIGGER
 * speed	default 150
 *
 * Plats are always drawn in the extended position, so they will light correctly.
 *
 * If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.
 *
 * If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determined by the model's height.
 * Set "sounds" to one of the following:
 * 1) base fast
 * 2) chain slow
 */
export class PlatformEntity extends BasePropEntity {
  static classname = 'func_plat';

  static PLAT_LOW_TRIGGER = 1;

  static _sounds = [
    [null, null],
    ['plats/plat1.wav', 'plats/plat2.wav'],
    ['plats/medplat1.wav', 'plats/medplat2.wav'],
  ];

  _declareFields() {
    super._declareFields();

    this.mangle = new Vector();
    this.t_length = 0;
    this.t_width = 0;

    /** @type {PlatformTriggerEntity} @private */
    this._trigger = null;
  }

  _spawnInsideTrigger() {
    this._trigger = new WeakRef(this.engine.SpawnEntity(PlatformTriggerEntity.classname, { owner: this }));
  }

  blocked(blockedByEntity) {
    // TODO: plat_crush
    console.debug('plat_crush');
  }

  use(usedByEntity) {
    // TODO: plat_trigger_use
    console.debug('plat_trigger_use');
  }

  spawn() {
    if (!this.t_length) {
      this.t_length = 80;
    }

    if (!this.t_width) {
      this.t_width = 10;
    }

    if (!this.sounds) {
      this.sounds = 2;
    }

    if (!this.speed) {
      this.speed = 150;
    }

    [this.noise, this.noise1] = this.constructor._sounds[this.sounds];

    this.mangle.set(this.angles);
    this.angles.clear();

    this.solid = solid.SOLID_BSP;
    this.movetype = moveType.MOVETYPE_PUSH;

    // CR: is this even necessary?
    this.setOrigin(this.origin);
    this.setModel(this.model);
    this.setSize(this.mins, this.maxs);

    this.pos1.set(this.origin);
    this.pos2.set(this.origin);

    this.pos2[2] = this.origin[2] - (this.height ? this.height : this.size[2] + 8.0);

    this._spawnInsideTrigger();

    if (this.targetname) {
      this.state = state.STATE_UP;
    } else {
      this.setOrigin(this.pos2);
      this.state = state.STATE_BOTTOM;
    }
  }
};

export class PlatformTriggerEntity extends BaseEntity {
  static classname = 'func_plat_trigger';

  spawn() {
    console.assert(this.owner instanceof PlatformEntity, 'owner must be a PlatformEntity');

    this.movetype = moveType.MOVETYPE_NONE;
    this.solid = solid.SOLID_TRIGGER;

    const tmin = new Vector(), tmax = new Vector();

    tmin.set(this.owner.mins).add(new Vector(25.0, 25.0, 0.0));
    tmax.set(this.owner.maxs).subtract(new Vector(25.0, 25.0, -8.0));
    tmin[2] = tmax[2] - (this.owner.pos1[2] - this.owner.pos2[2] + 8.0);

    if (this.owner.spawnflags & PlatformEntity.PLAT_LOW_TRIGGER) {
      tmax[2] = tmin[2] + 8.0;
    }

    if (this.owner.size[0] <= 50.0) {
      tmin[0] = (this.owner.mins[0] + this.owner.maxs[0]) / 2;
      tmax[0] = tmin[0] + 1.0;
    }

    if (this.owner.size[1] <= 50.0) {
      tmin[1] = (this.owner.mins[1] + this.owner.maxs[1]) / 2;
      tmax[1] = tmin[1] + 1.0;
    }

    this.setSize(tmin, tmax);
  }

  touch(touchedByEntity) {
    if (!(touchedByEntity instanceof PlayerEntity)) {
      return;
    }

    if (touchedByEntity.health <= 0) {
      return;
    }

    // TODO: activate
  }
};
