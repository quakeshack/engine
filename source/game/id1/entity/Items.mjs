import Vector from '../../../shared/Vector.mjs';

import { channel, flags, items, moveType, solid, tentType, worldType } from '../Defs.mjs';
import BaseEntity from './BaseEntity.mjs';
import { PlayerEntity, playerEvent } from './Player.mjs';
import { Sub } from './Subs.mjs';

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
  [items.IT_AXE]: 'Axe',
  [items.IT_SHOTGUN]: 'Shotgun',
  [items.IT_SUPER_SHOTGUN]: 'Double-barrelled Shotgun',
  [items.IT_NAILGUN]: 'Nailgun',
  [items.IT_SUPER_NAILGUN]: 'Super Nailgun',
  [items.IT_GRENADE_LAUNCHER]: 'Grenade Launcher',
  [items.IT_ROCKET_LAUNCHER]: 'Rocket Launcher',
  [items.IT_LIGHTNING]: 'Thunderbolt',

  [items.IT_INVISIBILITY]: 'Ring of Shadows',
  [items.IT_SUIT]: 'Biosuit',
  [items.IT_INVULNERABILITY]: 'Pentagram of Protection',
  [items.IT_QUAD]: 'Quad Damage',

  [items.IT_KEY1]: 'Silver Key',
  [items.IT_KEY2]: 'Gold Key',
};

export class BaseItemEntity extends BaseEntity {
  spawn() {
    this.flags = flags.FL_ITEM;
    this.solid = solid.SOLID_TRIGGER;
    this.movetype = moveType.MOVETYPE_TOSS;
    this.origin[2] += 6.0;
    // this.dropToFloor();
  }

  _declareFields() {
    this._serializer.startFields();

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

    /** @type {string} sfx to play upon picking it up */
    this.noise = 'weapons/lock4.wav';

    this._serializer.endFields();

    this._sub = new Sub(this);
  }

  regenerate() { // QuakeC: SUB_regen
    this.model = this._model_original;
    this.solid = solid.SOLID_TRIGGER;
    this.startSound(channel.CHAN_VOICE, 'items/itembk2.wav');
    this.setOrigin(this.origin);
    this.engine.DispatchTempEntityEvent(tentType.TE_TELEPORT, this.centerPoint); // CR: added neat teleport in effect
  }

  toss() {
    this.velocity.setTo(300.0, -100.0 + Math.random() * 200.0, -100.0 + Math.random() * 200.0);
  }

  /**
   * To be overriden, called after healthy player check.
   * @protected
   * @param {PlayerEntity} playerEntity user
   * @returns {boolean} whether it’s okay to pick it up
   */
  // eslint-disable-next-line no-unused-vars
  _canPickup(playerEntity) {
    return true;
  }

  /**
   * Can be overriden, called after healthy player check
   * @protected
   * @param {PlayerEntity} playerEntity user
   * @returns {boolean} whether it’s okay to pick it up
   */
  _pickup(playerEntity) {
    return playerEntity.applyBackpack(this);
  }

  /** @param {BaseEntity} otherEntity other */
  touch(otherEntity) {
    if (!(otherEntity instanceof PlayerEntity) || otherEntity.health <= 0 || !this._canPickup(otherEntity)) {
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

    // let the player consume this backpack
    if (!this._pickup(player)) {
      return; // player’s inventory is already full
    }

    if (items.length > 0) {
      player.consolePrint(`You got ${items.join(', ')}.\n`);
    } else if (this.netname) {
      player.consolePrint(`You got ${this.netname}!\n`);
    } else {
      player.consolePrint('You found an empty item.\n');
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
    // trigger all connected actions
    this._sub.useTargets(playerEntity);

    if (this.game.deathmatch && this.regeneration_time > 0) {
      this.solid = solid.SOLID_NOT;
      this._model_original = this.model;
      this.model = null;
      this._scheduleThink(this.game.time + this.regeneration_time, () => this.regenerate());
    } else {
      this.remove();
    }
  }
};

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

    this._serializer.startFields();

    this.remove_after = 0;

    this._serializer.endFields();
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

export class BaseAmmoEntity extends BaseItemEntity {
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
};

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

export class BaseKeyEntity extends BaseItemEntity {
  /** @type {items} key flag */
  static _item = 0;

  static _worldTypeToSound = {
    [worldType.MEDIEVAL]: 'misc/medkey.wav', // fallback
    [worldType.RUNES]: 'misc/runekey.wav',
    [worldType.BASE]: 'misc/basekey.wav',
  };

  static _worldTypeToNetname = {
    [worldType.MEDIEVAL]: 'base key', // fallback
    [worldType.RUNES]: 'base runekey',
    [worldType.BASE]: 'base keycard',
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: 'progs/w_s_key.mdl', // fallback
    [worldType.RUNES]: 'progs/m_s_key.mdl',
    [worldType.BASE]: 'progs/b_s_key.mdl',
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
    this._sub.useTargets(playerEntity);

    // CR: weird that they can be taken in deathmatch
    if (!this.game.coop) {
      this.remove();
    }
  }
};

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
    [worldType.MEDIEVAL]: 'silver key', // fallback
    [worldType.RUNES]: 'silver runekey',
    [worldType.BASE]: 'silver keycard',
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: 'progs/w_s_key.mdl', // fallback
    [worldType.RUNES]: 'progs/m_s_key.mdl',
    [worldType.BASE]: 'progs/b_s_key.mdl',
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
    [worldType.MEDIEVAL]: 'gold key', // fallback
    [worldType.RUNES]: 'gold runekey',
    [worldType.BASE]: 'gold keycard',
  };

  static _worldTypeToModel = {
    [worldType.MEDIEVAL]: 'progs/w_g_key.mdl', // fallback
    [worldType.RUNES]: 'progs/m_g_key.mdl',
    [worldType.BASE]: 'progs/b_g_key.mdl',
  };
};

export class BaseArtifactEntity extends BaseItemEntity {
  static _item = 0;
  static _regenerationTime = 60;

  static _model = null;
  static _noise = null;
  static _precache = { sounds: [] };

  _precache() {
    this.engine.PrecacheModel(this.constructor._model);
    for (const sound of this.constructor._precache.sounds) {
      this.engine.PrecacheSound(sound);
    }
  }

  spawn() {
    super.spawn();

    this.noise = this.constructor._noise;
    this.items |= this.constructor._item;
    this.regeneration_time = this.constructor._regenerationTime;

    this.setModel(this.constructor._model);
    this.setSize(new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 32.0));
  }

  _afterTouch(playerEntity) {
    this._updateTimers(playerEntity);
    super._afterTouch(playerEntity);
  }

  /**
   * Called when successfully picked up the artifact.
   * @param {PlayerEntity} playerEntity player who picked it up
   * @protected
   */
  // eslint-disable-next-line no-unused-vars
  _updateTimers(playerEntity) {
    // update timers here, e.g. super_time = 1, super_damage_finished = time + 30 etc.
  }
};

/**
 * QUAKED item_artifact_invulnerability (0 .5 .8) (-16 -16 -24) (16 16 32)
 * Player is invulnerable for 30 seconds
 */
export class InvulnerabilityEntity extends BaseArtifactEntity {
  static classname = 'item_artifact_invulnerability';

  static _item = items.IT_INVULNERABILITY;
  static _model = 'progs/invulner.mdl';
  static _noise = 'items/protect.wav';

  static _regenerationTime = 300; // 5 mins

  static _precache = {
    sounds: [
      'items/protect.wav',
      'items/protect2.wav',
      'items/protect3.wav',
    ],
  };

  _updateTimers(playerEntity) {
    playerEntity.invincible_time = 1;
    playerEntity.invincible_finished = this.game.time + 30;
  }
};

/**
 * QUAKED item_artifact_invisibility (0 .5 .8) (-16 -16 -24) (16 16 32)
 * Player is invisible for 30 seconds
 */
export class InvisibilityEntity extends BaseArtifactEntity {
  static classname = 'item_artifact_invisibility';

  static _item = items.IT_INVISIBILITY;
  static _model = 'progs/invisibl.mdl';
  static _noise = 'items/inv1.wav';

  static _regenerationTime = 300; // 5 mins

  static _precache = {
    sounds: [
      'items/inv1.wav',
      'items/inv2.wav',
      'items/inv3.wav',
    ],
  };

  _updateTimers(playerEntity) {
    playerEntity.invisible_time = 1;
    playerEntity.invisible_finished = this.game.time + 30;
  }
};

/**
 * QUAKED item_artifact_envirosuit (0 .5 .8) (-16 -16 -24) (16 16 32)
 * Player takes no damage from water or slime for 30 seconds
 */
export class RadsuitEntity extends BaseArtifactEntity {
  static classname = 'item_artifact_envirosuit';

  static _item = items.IT_SUIT;
  static _model = 'progs/suit.mdl';
  static _noise = 'items/suit.wav';

  static _precache = {
    sounds: [
      'items/suit.wav',
      'items/suit2.wav',
    ],
  };

  _updateTimers(playerEntity) {
    playerEntity.rad_time = 1;
    playerEntity.radsuit_finished = this.game.time + 30;
  }
};

/**
 * QUAKED item_artifact_super_damage (0 .5 .8) (-16 -16 -24) (16 16 32)
 * The next attack from the player will do 4x damage
 */
export class SuperDamageEntity extends BaseArtifactEntity {
  static classname = 'item_artifact_super_damage';

  static _item = items.IT_QUAD;
  static _model = 'progs/quaddama.mdl';
  static _noise = 'items/damage.wav';

  static _precache = {
    sounds: [
      'items/damage.wav',
      'items/damage2.wav',
      'items/damage3.wav',
    ],
  };

  _updateTimers(playerEntity) {
    playerEntity.super_time = 1;
    playerEntity.super_damage_finished = this.game.time + 30;
  }
};

/**
 * QUAKED item_sigil (0 .5 .8) (-16 -16 -24) (16 16 32) E1 E2 E3 E4
 * End of level sigil, pick up to end episode and return to jrstart.
 */
export class SigilEntity extends BaseItemEntity {
  static classname = 'item_sigil';

  static _models = ['progs/end1.mdl', 'progs/end2.mdl', 'progs/end3.mdl', 'progs/end4.mdl'];

  get netname() {
    return 'the rune';
  }

  // CR: I’m not sure at all if this logic is actually being used (see QuakeC: items.qc/sigil_touch)
  // get classname() {
  //   // HACK: somewhat shitty hack to not break original Quake maps
  //   if (this.spawnflags === 15) {
  //     return this.constructor.classname + ' (used)';
  //   }

  //   return this.constructor.classname;
  // }

  _precache() {
    this.engine.PrecacheSound('misc/runekey.wav');

    for (let i = 0; i < 4; i++) {
      if ((this.spawnflags & (1 << i))) {
        this.engine.PrecacheModel(this.constructor._models[i]);
        break;
      }
    }
  }

  _declareFields() {
    super._declareFields();
    this._serializer.startFields();

    this.noise = 'misc/runekey.wav';

    this._serializer.endFields();
  }

  // eslint-disable-next-line no-unused-vars
  _pickup(playerEntity) {
    this.game.serverflags |= this.spawnflags & 15;
    this.spawnflags = 15; // used in the classname hack

    return true;
  }

  _afterTouch(playerEntity) {
    this.solid = solid.SOLID_NOT;
    this.unsetModel();

    // trigger all connected actions
    this._sub.useTargets(playerEntity);
  }

  spawn() {
    super.spawn();

    for (let i = 0; i < 4; i++) {
      if ((this.spawnflags & (1 << i))) {
        this.setModel(this.constructor._models[i]);
        break;
      }
    }

    this.setSize(new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 32.0));
  }
};

/**
 * QUAKED item_health (.3 .3 1) (0 0 0) (32 32 32) rotten megahealth
 * Health box. Normally gives 25 points.
 * Rotten box heals 5-10 points,
 * megahealth will add 100 health, then
 * rot you down to your maximum health limit,
 * one point per second.
 */
export class HealthItemEntity extends BaseItemEntity {
  static classname = 'item_health';

  static H_NORMAL = 0;
  static H_ROTTEN = 1;
  static H_MEGA = 2;

  /** @protected */
  static _config = {
    [HealthItemEntity.H_NORMAL]: {
      model: 'maps/b_bh25.bsp',
      noise: 'items/health1.wav',
      healamount: 25,
      items: 0,
    },
    [HealthItemEntity.H_ROTTEN]: {
      model: 'maps/b_bh10.bsp',
      noise: 'items/r_item1.wav',
      healamount: 15,
      items: 0,
    },
    [HealthItemEntity.H_MEGA]: {
      model: 'maps/b_bh100.bsp',
      noise: 'items/r_item2.wav',
      healamount: 100,
      items: items.IT_SUPERHEALTH,
    },
  };

  _declareFields() {
    super._declareFields();
    this._serializer.startFields();

    this.healamount = 0;

    this._serializer.endFields();
  }

  get netname() {
    return `${this.healamount} health`;
  }

  /** @protected */
  get _config() {
    return HealthItemEntity._config[this.spawnflags & 3];
  }

  _precache() {
    this.engine.PrecacheModel(this._config.model);
    this.engine.PrecacheSound(this._config.noise);
  }

  _canPickup(playerEntity) {
    return playerEntity.health < ((this.spawnflags & HealthItemEntity.H_MEGA) !== 0 ? 250 : playerEntity.max_health);
  }

  _pickup(playerEntity) {
    if (this.items > 0) {
      playerEntity.applyBackpack(this);
    }

    return playerEntity.applyHealth(this.healamount, (this.spawnflags & HealthItemEntity.H_MEGA) !== 0);
  }

  _takeHealth() {
    /** @type {PlayerEntity} */
    const player = this.owner;

    if (player.health > player.max_health) {
      player.health--;
      this._scheduleThink(this.game.time + 1.0, () => this._takeHealth());
      return;
    }

    player.items &= ~items.IT_SUPERHEALTH;

    this.owner = null;

    if (this.game.deathmatch === 1) {
      this._scheduleThink(this.game.time + this.regeneration_time, () => this.regenerate());
      return;
    }

    this.remove();
  }

  _afterTouch(playerEntity) {
    this.solid = solid.SOLID_NOT;
    this._model_original = this.model;
    this.model = null;
    this.owner = playerEntity;

    // trigger all connected actions
    this._sub.useTargets(playerEntity);

    // chipping away the player’s health when mega is running
    if (this.spawnflags & HealthItemEntity.H_MEGA) {
      this._scheduleThink(this.game.time + 5.0, () => this._takeHealth());
    } else {
      this.remove();
    }
  }

  spawn() {
    console.assert([HealthItemEntity.H_NORMAL, HealthItemEntity.H_MEGA, HealthItemEntity.H_ROTTEN].includes(this.spawnflags & 3), 'Spawnflags are not set correctly');

    this.regeneration_time = 20;
    this.noise = this._config.noise;
    this.setModel(this.model = this._config.model);
    this.healamount = this._config.healamount;
    this.items = this._config.items;

    super.spawn();
  }
};

export class BaseArmorEntity extends BaseItemEntity {
  static _armortype = 0;
  static _armorvalue = 0;
  static _item = 0;
  static _skin = 0;

  get netname() {
    return 'the armor';
  }

  _pickup(playerEntity) {
    playerEntity.armortype = this.constructor._armortype;
    playerEntity.armorvalue = this.constructor._armorvalue;

    playerEntity.items &= ~(items.IT_ARMOR1 | items.IT_ARMOR2 | items.IT_ARMOR3);
    playerEntity.applyBackpack(this);

    return true;
  }

  _canPickup(playerEntity) {
    return playerEntity.armortype * playerEntity.armorvalue < this.constructor._armortype * this.constructor._armorvalue;
  }

  _precache() {
    this.engine.PrecacheModel('progs/armor.mdl');
  }

  spawn() {
    super.spawn();

    this.skin = this.constructor._skin;
    this.items = this.constructor._item;

    this.noise = 'items/armor1.wav';

    this.regeneration_time = 20;

    this.setModel('progs/armor.mdl');
    this.setSize(new Vector(-16.0, -16.0, 0.0), new Vector(16.0, 16.0, 56.0));
  }
};

/**
 * QUAKED item_armor1 (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class LightArmorEntity extends BaseArmorEntity {
  static classname = 'item_armor1';

  static _armortype = 0.3;
  static _armorvalue = 100;
  static _item = items.IT_ARMOR1;
  static _skin = 0;
};

/**
 * QUAKED item_armor2 (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class StrongArmorEntity extends BaseArmorEntity {
  static classname = 'item_armor2';

  static _armortype = 0.6;
  static _armorvalue = 150;
  static _item = items.IT_ARMOR2;
  static _skin = 1;
};

/**
 * QUAKED item_armorInv (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class HeavyArmorEntity extends BaseArmorEntity {
  static classname = 'item_armorInv';

  static _armortype = 0.8;
  static _armorvalue = 200;
  static _item = items.IT_ARMOR3;
  static _skin = 2;
};

export class BaseWeaponEntity extends BaseItemEntity {
  static _model = null;
  static _weapon = 0;

  _precache() {
    this.engine.PrecacheModel(this.constructor._model);
  }

  spawn() {
    this.items = this.constructor._weapon;
    this.weapon = this.constructor._weapon;
    this.regeneration_time = 30.0;
    this.setModel(this.constructor._model);
    this.setSize(new Vector(-16.0, -16.0, 0.0), new Vector(16.0, 16.0, 56.0));

    super.spawn();
  }
};

/**
 * QUAKED weapon_supershotgun (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponSuperShotgun extends BaseWeaponEntity {
  static classname = 'weapon_supershotgun';

  static _model = 'progs/g_shot.mdl';
  static _weapon = items.IT_SUPER_SHOTGUN;

  spawn() {
    this.ammo_shells = 5;
    super.spawn();
  }
};

/**
 * QUAKED weapon_nailgun (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponNailgun extends BaseWeaponEntity {
  static classname = 'weapon_nailgun';

  static _model = 'progs/g_nail.mdl';
  static _weapon = items.IT_NAILGUN;

  spawn() {
    this.ammo_nails = 30;
    super.spawn();
  }
};

/**
 * QUAKED weapon_supernailgun (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponSuperNailgun extends BaseWeaponEntity {
  static classname = 'weapon_supernailgun';

  static _model = 'progs/g_nail2.mdl';
  static _weapon = items.IT_SUPER_NAILGUN;

  spawn() {
    this.ammo_nails = 30;
    super.spawn();
  }
};

/**
 * QUAKED weapon_grenadelauncher (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponGrenadeLauncher extends BaseWeaponEntity {
  static classname = 'weapon_grenadelauncher';

  static _model = 'progs/g_rock.mdl';
  static _weapon = items.IT_GRENADE_LAUNCHER;

  spawn() {
    this.ammo_rockets = 5;
    super.spawn();
  }
};

/**
 * QUAKED weapon_rocketlauncher (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponRocketLauncher extends BaseWeaponEntity {
  static classname = 'weapon_rocketlauncher';

  static _model = 'progs/g_rock2.mdl';
  static _weapon = items.IT_ROCKET_LAUNCHER;

  spawn() {
    this.ammo_rockets = 5;
    super.spawn();
  }
};

/**
 * QUAKED weapon_lightning (0 .5 .8) (-16 -16 0) (16 16 32)
 */
export class WeaponThunderbolt extends BaseWeaponEntity {
  static classname = 'weapon_lightning';

  static _model = 'progs/g_light.mdl';
  static _weapon = items.IT_LIGHTNING;

  spawn() {
    this.ammo_cells = 15;
    super.spawn();
  }
};
