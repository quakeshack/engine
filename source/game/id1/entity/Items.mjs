/* global Vector */

import { channel, flags, items, moveType, solid, worldType } from "../Defs.mjs";
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
    // this.dropToFloor();
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

    /** @type {string} sfx to play upon picking it up */
    this.noise = "weapons/lock4.wav";
  }

  regenerate() { // QuakeC: SUB_regen
    this.model = this._model_original;
    this.solid = solid.SOLID_TRIGGER;
    this.startSound(channel.CHAN_VOICE, "items/itembk2.wav");
    this.setOrigin(this.origin);
  }

  toss() {
    this.velocity.setTo(300.0, -100.0 + Math.random() * 200.0, -100.0 + Math.random() * 200.0);
  }

  /**
   * to be overriden, called after healthy player check
   * @protected
   * @param {PlayerEntity} playerEntity user
   * @returns {boolean} whether it’s okay to pick it up
   */
  // eslint-disable-next-line no-unused-vars
  _canPickup(playerEntity) {
    return true;
  }

  /** @param {BaseEntity} otherEntity other */
  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity) || otherEntity.health <= 0 || !this._canPickup(otherEntity)) {
      return;
    }

    /** @type {PlayerEntity} */
    const player = otherEntity;

    // let the player consume this backpack
    if (!player.applyBackpack(this)) {
      return; // player’s inventory is already full
    }

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

    if (items.length > 0) {
      player.consolePrint(`You got ${items.join(', ')}.\n`);
    } else {
      player.consolePrint(`You found an empty item.\n`);
    }

    player.startSound(channel.CHAN_ITEM, this.noise);
    player.dispatchEvent(playerEvent.BONUS_FLASH);

    this._afterTouch(player);
  }

  /**
   * @protected
   * @param {PlayerEntity} playerEntity user
   */
  _afterTouch(playerEntity) {
    // TODO: do not annoy the player by switching around weapons unnecessarily
    const weapon = playerEntity.chooseBestWeapon();

    if (!this.game.deathmatch) {
      playerEntity.setWeapon(weapon);
    } else {
      // TODO: Deathmatch_Weapon (old, new);
    }

    if (this.game.deathmatch && this.regeneration_time > 0) {
      this.solid = solid.SOLID_NOT;
      this._model_original = this.model;
      this.model = null;
      this._scheduleThink(this.game.time + this.regeneration_time, () => this.regenerate());
    } else {
      this.remove();
    }

    // trigger all connected actions
    this._sub.useTargets(playerEntity);
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
    this.remove_after = 0;
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

class BaseAmmoEntity extends BaseItemEntity {
  /** @type {string} model set, when WEAPON_BIG2 is not set */
  static _model = null;
  /** @type {string} model set, when WEAPON_BIG2 is set */
  static _modelBig = null;
  /** @type {number} ammo given, when WEAPON_BIG2 is not set */
  static _ammo = 0;
  /** @type {number} ammo given, when WEAPON_BIG2 is set */
  static _ammoBig = 0;
  /** @type {number} preferred weapon slot */
  static _weapon = 0;

  _precache() {
    if ((this.spawnflags & WEAPON_BIG2) && this.constructor._modelBig) {
      this.engine.PrecacheModel(this.constructor._modelBig);
    } else {
      this.engine.PrecacheModel(this.constructor._model);
    }
  }

  /**
   * Sets the corresponding ammo slot with given ammo.
   * @protected
   * @param {number} ammo given ammo
   */
  // eslint-disable-next-line no-unused-vars
  _setAmmo(ammo) {
    // set the correct slot here
  }

  spawn() {
    super.spawn();

    if ((this.spawnflags & WEAPON_BIG2) && this.constructor._modelBig) {
      this.setModel(this.constructor._modelBig);
      this._setAmmo(this.constructor._ammoBig);
    } else {
      this.setModel(this.constructor._model);
      this._setAmmo(this.constructor._ammo);
    }

    this.weapon = this.constructor._weapon;

    this.setSize(Vector.origin, new Vector(32.0, 32.0, 56.0));
  }
}

/**
 * QUAKED item_shells (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemShellsEntity extends BaseAmmoEntity {
  static classname = 'item_shells';

  static _ammo = 20;
  static _ammoBig = 40;
  static _model = 'maps/b_shell0.bsp';
  static _modelBig = 'maps/b_shell1.bsp';
  static _weapon = 1;

  _setAmmo(ammo) {
    this.ammo_shells = ammo;
  }
};

/**
 * QUAKED item_spikes (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemSpikesEntity extends BaseAmmoEntity {
  static classname = 'item_spikes';

  static _ammo = 25;
  static _ammoBig = 50;
  static _model = 'maps/b_nail0.bsp';
  static _modelBig = 'maps/b_nail1.bsp';
  static _weapon = 2;

  _setAmmo(ammo) {
    this.ammo_nails = ammo;
  }
};

/**
 * QUAKED item_rockets (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemRocketsEntity extends BaseAmmoEntity {
  static classname = 'item_rockets';

  static _ammo = 5;
  static _ammoBig = 10;
  static _model = 'maps/b_rock0.bsp';
  static _modelBig = 'maps/b_rock1.bsp';
  static _weapon = 3;

  _setAmmo(ammo) {
    this.ammo_rockets = ammo;
  }
};

/**
 * QUAKED item_cells (0 .5 .8) (0 0 0) (32 32 32) big
 */
export class ItemCellsEntity extends BaseAmmoEntity {
  static classname = 'item_cells';

  static _ammo = 6;
  static _ammoBig = 12;
  static _model = 'maps/b_batt0.bsp';
  static _modelBig = 'maps/b_batt1.bsp';
  static _weapon = 4;

  _setAmmo(ammo) {
    this.ammo_cells = ammo;
  }
};

class BaseKeyEntity extends BaseItemEntity {
  /** @type {items} key flag */
  static _item = 0;

  static _worldTypeToSound = {
    [worldType.MEDIEVAL]: "misc/medkey.wav", // fallback
    [worldType.RUNES]: "misc/runekey.wav",
    [worldType.BASE]: "misc/basekey.wav",
  };

  static _worldTypeToNetname = {
    [worldType.MEDIEVAL]: "base key", // fallback
    [worldType.RUNES]: "base runekey",
    [worldType.BASE]: "base keycard",
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: "progs/w_s_key.mdl", // fallback
    [worldType.RUNES]: "progs/m_s_key.mdl",
    [worldType.BASE]: "progs/b_s_key.mdl",
  };

  get noise() {
    const worldType = this.game.worldspawn.worldtype;

    if (this.constructor._worldTypeToSound[worldType]) {
      return this.constructor._worldTypeToSound[worldType];
    }

    return this.constructor._worldTypeToSound[worldType.MEDIEVAL];
  }

  set noise(noise) {
  }

  get netname() {
    const worldType = this.game.worldspawn.worldtype;

    if (this.constructor._worldTypeToNetname[worldType]) {
      return this.constructor._worldTypeToNetname[worldType];
    }

    return this.constructor._worldTypeToNetname[worldType.MEDIEVAL];
  }

  set netname(netname) {
  }

  get model() {
    const worldType = this.game.worldspawn.worldtype;

    if (this.constructor._worldTypeToModel[worldType]) {
      return this.constructor._worldTypeToModel[worldType];
    }

    return this.constructor._worldTypeToModel[worldType.MEDIEVAL];
  }

  set model(model) {
  }

  _precache() {
    this.engine.PrecacheSound(this.noise);
    this.engine.PrecacheModel(this.model);
  }

  spawn() {
    super.spawn();

    this.setModel(this.model);
    this.setSize(new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 32.0));

    this.items = this.constructor._item;
  }

  regenerate() {
    // no action, keys do not regenerate
  }

  _canPickup(playerEntity) {
    return (playerEntity.items & this.items) === 0;
  }

  /**
   * @protected
   * @param {PlayerEntity} playerEntity user
   */
  _afterTouch(playerEntity) {
    if (!this.game.coop) {
      this.remove();
    }

    this._sub.useTargets(playerEntity);
  }
}

/**
 * QUAKED item_key1 (0 .5 .8) (-16 -16 -24) (16 16 32)
 * SILVER key
 * In order for keys to work
 * you MUST set your maps
 * worldtype to one of the
 * following:
 * 0: medieval
 * 1: metal
 * 2: base
 */
export class SilverKeyEntity extends BaseKeyEntity {
  static classname = 'item_key1';

  static _item = items.IT_KEY1;

  static _worldTypeToNetname = {
    [worldType.MEDIEVAL]: "silver key", // fallback
    [worldType.RUNES]: "silver runekey",
    [worldType.BASE]: "silver keycard",
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: "progs/w_s_key.mdl", // fallback
    [worldType.RUNES]: "progs/m_s_key.mdl",
    [worldType.BASE]: "progs/b_s_key.mdl",
  };
};

/**
 * QUAKED item_key2 (0 .5 .8) (-16 -16 -24) (16 16 32)
 * GOLD key
 * In order for keys to work
 * you MUST set your maps
 * worldtype to one of the
 * following:
 * 0: medieval
 * 1: metal
 * 2: base
 */
export class GoldKeyEntity extends BaseKeyEntity {
  static classname = 'item_key2';

  static _item = items.IT_KEY2;

  static _worldTypeToNetname = {
    [worldType.MEDIEVAL]: "gold key", // fallback
    [worldType.RUNES]: "gold runekey",
    [worldType.BASE]: "gold keycard",
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: "progs/w_g_key.mdl", // fallback
    [worldType.RUNES]: "progs/m_g_key.mdl",
    [worldType.BASE]: "progs/b_g_key.mdl",
  };
};

