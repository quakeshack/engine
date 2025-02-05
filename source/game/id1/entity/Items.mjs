/* global Vector */

import { attn, channel, flags, moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { PlayerEntity, playerEvent } from "./Player.mjs";

class BaseItemEntity extends BaseEntity {
  spawn() {
    this.flags = flags.FL_ITEM;
    this.solid = solid.SOLID_TRIGGER;
    this.movetype = moveType.MOVETYPE_TOSS;
  }
}

export class BackpackEntity extends BaseItemEntity {
  static classname = 'item_backpack';

  _declareFields() {
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.items = 0;
    this.netname = null;
    this.remove_after = 120;
  }

  /** @param {BaseEntity} otherEntity other */
  touch(otherEntity) { // TODO: QuakeC: items.qc/BackpackTouch
    if (!(otherEntity instanceof PlayerEntity) || otherEntity.health <= 0) {
      return;
    }

    /** @type {PlayerEntity} */
    const player = otherEntity;

    player.consolePrint("You picked up a backpack\n"); // TODO: better text
    player.startSound(channel.CHAN_ITEM, "weapons/lock4.wav");
    player.dispatchEvent(playerEvent.BONUS_FLASH);

    this.remove();

    const weapon = player.chooseBestWeapon();

    if (!this.game.deathmatch) {
      player.setWeapon(weapon);
    } else {
      // TODO: Deathmatch_Weapon (old, new);
    }
  }

  spawn() {
    super.spawn();

    this.setModel('progs/backpack.mdl');
    this.setSize(new Vector(-16.0, -16.0, 0.0), new Vector(16.0, 16.0, 56.0));

    // make it disappear after a while
    if (this.remove_after > 0) {
      this._scheduleThink(this.game.time + this.remove_after, () => this.remove());
    }
  }
};
