/* global Vector */

import { channel, flags, items, moveType, solid } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { PlayerEntity, playerEvent } from "./Player.mjs";
import { Sub } from "./Subs.mjs";

// respawn times
// - backpack: never
// - weapon: 30s
// - powerup: 60s (or 300s when invisibility or invulnerability)
// - health: 20s
// - armor: 20s
// - ammo: 30s

const WEAPON_BIG2 = 1;

/**
 * maps item to a string
 */
export const itemNames = {
  [items.IT_AXE]: "Axe",
  [items.IT_SHOTGUN]: "Shotgun",
  [items.IT_SUPER_SHOTGUN]: "Double-barrelled Shotgun",
  [items.IT_NAILGUN]: "Nailgun",
  [items.IT_SUPER_NAILGUN]: "Super Nailgun",
  [items.IT_GRENADE_LAUNCHER]: "Grenade Launcher",
  [items.IT_ROCKET_LAUNCHER]: "Rocket Launcher",
  [items.IT_LIGHTNING]: "Thunderbolt",

  [items.IT_INVISIBILITY]: "Ring of Shadows",
  [items.IT_SUIT]: "Biosuit",
  [items.IT_INVULNERABILITY]: "Pentagram of Protection",
  [items.IT_QUAD]: "Quad Damage",

  [items.IT_KEY1]: "Silver Key",
  [items.IT_KEY2]: "Gold Key",
};

class BaseItemEntity extends BaseEntity {
  spawn() {
    this.flags = flags.FL_ITEM;
    this.solid = solid.SOLID_TRIGGER;
    this.movetype = moveType.MOVETYPE_TOSS;
    this.origin[2] += 6.0;
    this.dropToFloor();
  }

  _declareFields() {
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.items = 0;

    /** preferred weapon after pickup */
    this.weapon = 0;

    /** @type {number} seconds until respawn */
    this.regeneration_time = 20.0;

    /** @private */
    this._model_original = null;

    this._sub = new Sub(this);
  }

  regenerate() { // QuakeC: SUB_regen
    this.model = this._model_original;
    this.solid = solid.SOLID_TRIGGER;
    this.startSound(channel.CHAN_VOICE, "items/itembk2.wav");
    this.setOrigin(this.origin);
  }

  /** @param {BaseEntity} otherEntity other */
  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity) || otherEntity.health <= 0) {
      return;
    }

    /** @type {PlayerEntity} */
    const player = otherEntity;

    const items = [];

    // check if this items is new in player’s inventory
    if (this.items > 0 && (player.items & this.items) !== this.items) {
      for (const [item, name] of Object.entries(itemNames)) {
        if ((this.items & ~player.items) & item) { // only mention new items
          items.push(name);
        }
      }
    }

    if (this.ammo_shells > 0) {
      items.push(`${this.ammo_shells} shells`);
    }

    if (this.ammo_nails > 0) {
      items.push(`${this.ammo_nails} nails`);
    }

    if (this.ammo_rockets > 0) {
      items.push(`${this.ammo_rockets} rockets`);
    }

    if (this.ammo_cells > 0) {
      items.push(`${this.ammo_cells} cells`);
    }

    player.applyBackpack(this); // let the player consume this backpack

    if (items.length > 0) {
      player.consolePrint(`You got ${items.join(', ')}.\n`);
    } else {
      player.consolePrint(`You found an empty backpack.\n`);
    }

    player.startSound(channel.CHAN_ITEM, "weapons/lock4.wav");
    player.dispatchEvent(playerEvent.BONUS_FLASH);

    const weapon = player.chooseBestWeapon();

    if (!this.game.deathmatch) {
      player.setWeapon(weapon);
    } else {
      // TODO: Deathmatch_Weapon (old, new);
    }

    this._afterTouch(player);
  }

  /**
   * @protected
   * @param {PlayerEntity} playerEntity user
   */
  _afterTouch(playerEntity) {
    if (this.game.deathmatch && this.regeneration_time > 0) {
      this.solid = solid.SOLID_NOT;
      this._model_original = this.model;
      this.model = null;
      this._scheduleThink(this.game.time + this.regeneration_time, () => this.regenerate());
    } else {
      this.remove();
    }

    if (this._sub) {
      this._sub.useTargets(playerEntity);
    }
  }
}

/**
 * QUAKED item_backpack (0 .5 .8) (-16 -16 0) (16 16 32)
 * QuakeShack extension. In vanilla Quake only spawned by monsters/players upon their death.
 *
 * A backpack can contain a bunch of items as well as ammo.
 */
export class BackpackEntity extends BaseItemEntity {
  static classname = 'item_backpack';

  _declareFields() {
    super._declareFields();
    this.remove_after = 120;
    this.regeneration_time = 0; // never respawn by default
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

/**
 * QUAKED item_shells (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemShellsEntity extends BaseItemEntity {
  static classname = 'item_shells';

  _precache() {
    if (this.spawnflags & WEAPON_BIG2) {
      this.engine.PrecacheModel('maps/b_shell1.bsp');
    } else {
      this.engine.PrecacheModel('maps/b_shell0.bsp');
    }
  }

  spawn() {
    super.spawn();

    if (this.spawnflags & WEAPON_BIG2) {
      this.setModel('maps/b_shell1.bsp');
      this.ammo_shells = 40;
    } else {
      this.setModel('maps/b_shell0.bsp');
      this.ammo_shells = 20;
    }

    this.weapon = 1;

    this.setSize(Vector.origin, new Vector(32.0, 32.0, 56.0));
  }
};

/**
 * QUAKED item_rockets (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemRocketsEntity extends BaseItemEntity {
  static classname = 'item_rockets';

  _precache() {
    if (this.spawnflags & WEAPON_BIG2) {
      this.engine.PrecacheModel('maps/b_rock1.bsp');
    } else {
      this.engine.PrecacheModel('maps/b_rock0.bsp');
    }
  }

  spawn() {
    super.spawn();

    if (this.spawnflags & WEAPON_BIG2) {
      this.setModel('maps/b_rock1.bsp');
      this.ammo_rockets = 10;
    } else {
      this.setModel('maps/b_rock0.bsp');
      this.ammo_rockets = 5;
    }

    this.weapon = 3;

    this.setSize(Vector.origin, new Vector(32.0, 32.0, 56.0));
  }
};
