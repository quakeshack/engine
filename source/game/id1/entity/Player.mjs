/* global Vector */

import { attn, channel, content, damage, dead, deathType, flags, items, moveType, solid, vec } from "../Defs.mjs";
import { crandom, Flag } from "../helper/MiscHelpers.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { InfoNotNullEntity } from "./Misc.mjs";

/**
 * handy map to manage weapon slots
 */
const weaponConfig = new Map([
  [items.IT_AXE, { currentammo: null, weaponmodel: "progs/v_axe.mdl", weaponframe: 0, priority: 0 }],
  [items.IT_SHOTGUN, { currentammo: "ammo_shells", weaponmodel: "progs/v_shot.mdl", weaponframe: 0, items: "IT_SHELLS", priority: 1 }],
  [items.IT_SUPER_SHOTGUN, { currentammo: "ammo_shells", weaponmodel: "progs/v_shot2.mdl", weaponframe: 0, items: "IT_SHELLS", priority: 2 }],
  [items.IT_NAILGUN, { currentammo: "ammo_nails", weaponmodel: "progs/v_nail.mdl", weaponframe: 0, items: "IT_NAILS", priority: 3 }],
  [items.IT_SUPER_NAILGUN, { currentammo: "ammo_nails", weaponmodel: "progs/v_nail2.mdl", weaponframe: 0, items: "IT_NAILS", priority: 4 }],
  [items.IT_GRENADE_LAUNCHER, { currentammo: "ammo_rockets", weaponmodel: "progs/v_rock.mdl", weaponframe: 0, items: "IT_ROCKETS", priority: 5 }],
  [items.IT_ROCKET_LAUNCHER, { currentammo: "ammo_rockets", weaponmodel: "progs/v_rock2.mdl", weaponframe: 0, items: "IT_ROCKETS", priority: 6 }],
  [items.IT_LIGHTNING, { currentammo: "ammo_cells", weaponmodel: "progs/v_light.mdl", weaponframe: 0, items: "IT_CELLS", priority: 7 }],
]);

/**
 * used to emit effects etc. to the client
 * @enum {string}
 * @readonly
 */
export const playerEvent = {
  BONUS_FLASH: 'bf',
  DAMAGE_FLASH: 'dmg',
};

export const playerModelQC = `

$cd id1/models/player_4
$origin 0 -6 24
$base base
$skin skin

//
// running
//
$frame axrun1 axrun2 axrun3 axrun4 axrun5 axrun6

$frame rockrun1 rockrun2 rockrun3 rockrun4 rockrun5 rockrun6

//
// standing
//
$frame stand1 stand2 stand3 stand4 stand5

$frame axstnd1 axstnd2 axstnd3 axstnd4 axstnd5 axstnd6
$frame axstnd7 axstnd8 axstnd9 axstnd10 axstnd11 axstnd12


//
// pain
//
$frame axpain1 axpain2 axpain3 axpain4 axpain5 axpain6

$frame pain1 pain2 pain3 pain4 pain5 pain6


//
// death
//

$frame axdeth1 axdeth2 axdeth3 axdeth4 axdeth5 axdeth6
$frame axdeth7 axdeth8 axdeth9

$frame deatha1 deatha2 deatha3 deatha4 deatha5 deatha6 deatha7 deatha8
$frame deatha9 deatha10 deatha11

$frame deathb1 deathb2 deathb3 deathb4 deathb5 deathb6 deathb7 deathb8
$frame deathb9

$frame deathc1 deathc2 deathc3 deathc4 deathc5 deathc6 deathc7 deathc8
$frame deathc9 deathc10 deathc11 deathc12 deathc13 deathc14 deathc15

$frame deathd1 deathd2 deathd3 deathd4 deathd5 deathd6 deathd7
$frame deathd8 deathd9

$frame deathe1 deathe2 deathe3 deathe4 deathe5 deathe6 deathe7
$frame deathe8 deathe9

//
// attacks
//
$frame nailatt1 nailatt2

$frame light1 light2

$frame rockatt1 rockatt2 rockatt3 rockatt4 rockatt5 rockatt6

$frame shotatt1 shotatt2 shotatt3 shotatt4 shotatt5 shotatt6

$frame axatt1 axatt2 axatt3 axatt4 axatt5 axatt6

$frame axattb1 axattb2 axattb3 axattb4 axattb5 axattb6

$frame axattc1 axattc2 axattc3 axattc4 axattc5 axattc6

$frame axattd1 axattd2 axattd3 axattd4 axattd5 axattd6
`;

/**
 *
 * @param {number} damage damage taken
 * @returns {Vector} velocity vector based on damage
 */
function VelocityForDamage(damage) {
  const v = new Vector(100.0 * crandom(), 100.0 * crandom(), 100.0 * crandom() + 200.0);

  if (damage > -50) {
    v.multiply(0.7);
  } else if (damage > -200) {
    v.multiply(2.0);
  } else {
    v.multiply(10.0);
  }

  return v;
};

/**
 * QUAKED info_player_start (1 0 0) (-16 -16 -24) (16 16 24)
 * The normal starting point for a level.
 */
export class InfoPlayerStart extends InfoNotNullEntity {
  static classname = 'info_player_start';
};

export class Backpack {
  constructor() {
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.items = 0;
  }
};

export class PlayerEntity extends BaseEntity {
  static classname = 'player';

  _declareFields() {
    // relevant for view
    this.view_ofs = new Vector();
    this.punchangle = new Vector();
    this.v_angle = new Vector();
    this.fixangle = false;

    // interaction states
    this.button0 = false; // fire
    this.button1 = false; // use
    this.button2 = false; // jump

    // backpack and health
    this.items = 0;
    this.health = 0;
    this.armorvalue = 0;
    this.ammo_shells = 0;
    this.ammo_nails = 0;
    this.ammo_rockets = 0;
    this.ammo_cells = 0;
    this.weapon = 0;
    this.armortype = 0;
    this.max_health = 100; // players maximum health is stored here
    this.currentammo = 0;
    this.weaponmodel = null;
    this.weaponframe = 0;
    this.impulse = 0; // cycle weapons, cheats, etc.

    // set to time+0.2 whenever a client fires a
    // weapon or takes damage.  Used to alert
    // monsters that otherwise would let the player go
    this.show_hostile = 0;

    this.jump_flag = 0;		// player jump flag (CR: it’s called a flag, but self.jump_flag = self.velocity_z sometimes)
    this.swim_flag = 0.0;		// player swimming sound flag (CR: it’s called a flag, but it’s a float)
    this.air_finished = 0;	// when time > air_finished, start drowning
    this.bubble_count = 0;	// keeps track of the number of bubbles
    this.deathtype = deathType.NONE;		// keeps track of how the player died

    // expiration of items
    this.super_damage_finished = 0;
    this.radsuit_finished = 0;
    this.invisible_finished = 0;
    this.invincible_finished = 0;
    this.invincible_time = 0;

    // time related checks
    this.super_sound = 0; // time for next super attack sound
    this.use_time = 0;

    // multiplayer fun
    this.netname = null;
    this.colormap = 0;
    this.team = 0;

    // things I’m unsure about:
    this.pausetime = 0;
  }

  _precache() {
    this.engine.PrecacheModel('progs/player.mdl');
  }

  _initStates() {
  }

  _selectSpawnPoint() {
    // TODO: this needs to be done properly

    return this.engine.FindByFieldAndValue('classname', 'info_player_start', this.game.lastspawn ? this.game.lastspawn.edict.num : 0).entity;
  }

  /**
   * prints a centered message
   * @param {string} message message
   */
  centerPrint(message) {
    this.edict.getClient().centerPrint(message);
  }

  /**
   * sends a message to the player’s console
   * @param {string} message message
   */
  consolePrint(message) {
    this.edict.getClient().consolePrint(message);
  }

  /**
   * dispatches a client event to the player’s frontend
   * @param {playerEvent} plEvent player event
   * @param {...any} args additional parameters
   */
  // eslint-disable-next-line no-unused-vars
  dispatchEvent(plEvent, ...args) {
    // TODO: another chapter of fun ahead
    if (plEvent === playerEvent.BONUS_FLASH) {
      this.edict.getClient().sendConsoleCommands('bf\n');
    }
  }

  decodeLevelParms() {
    if (this.game.serverflags) {
      // HACK: maps/start.bsp
      if (this.game.worldspawn.model === "maps/start.bsp") {
        this.game.SetNewParms();
      }
    }

    this.items = this.game.parm1;
    this.health = this.game.parm2;
    this.armorvalue = this.game.parm3;
    this.ammo_shells = this.game.parm4;
    this.ammo_nails = this.game.parm5;
    this.ammo_rockets = this.game.parm6;
    this.ammo_cells = this.game.parm7;
    this.weapon = this.game.parm8;
    this.armortype = this.game.parm9 * 0.01;
  }

  setChangeParms() {
    if (this.health <= 0) {
      this.game.SetNewParms();
      return;
    }

    // remove items
    this.items &= ~(items.IT_KEY1 | items.IT_KEY2 | items.IT_INVISIBILITY | items.IT_INVULNERABILITY | items.IT_SUIT | items.IT_QUAD);

    // cap super health
    this.health = Math.max(50, Math.min(100, this.health)); // CR: what about max_health?
    this.game.parm1 = this.items;
    this.game.parm2 = this.health;
    this.game.parm3 = this.armorvalue;

    this.game.parm4 = Math.max(25, this.ammo_shells);

    this.game.parm5 = this.ammo_nails;
    this.game.parm6 = this.ammo_rockets;
    this.game.parm7 = this.ammo_cells;
    this.game.parm8 = this.weapon;
    this.game.parm9 = this.armortype * 100;
  }

  /**
   * QuakeC: W_SetCurrentAmmo
   * @param {number} weapon (must be in Defs.items)
   */
  setWeapon(weapon) {
    if (!Object.values(items).includes(weapon)) {
      throw new RangeError('Weapon not defined in items');
    }

    // TODO: player_run ();		// get out of any weapon firing states

    this.weapon = weapon;
    this.items = this.items - (this.items & (items.IT_SHELLS | items.IT_NAILS | items.IT_ROCKETS | items.IT_CELLS));

    const config = weaponConfig.get(this.weapon);
    if (config) {
      this.currentammo = config.currentammo ? this[config.currentammo] : null;
      this.weaponmodel = config.weaponmodel;
      this.weaponframe = config.weaponframe;
      if (config.items) {
        this.items = this.items | items[config.items];
      }
    } else {
      this.currentammo = 0;
      this.weaponmodel = null;
      this.weaponframe = 0;
    }
  }

  /**
   * QuakeC: W_BestWeapon
   * @returns {number} weapon number
   */
  chooseBestWeapon() {
    const it = this.items;
    let bestWeapon = items.IT_AXE; // Default weapon
    let maxPriority = 0;

    weaponConfig.forEach((config, weapon) => {
      const hasWeapon = it & weapon; // Check if player has this weapon
      const hasAmmo = config.currentammo === 0 || this[config.currentammo] > 0; // Check if ammo is available
      const isUsable = !(weapon === items.IT_LIGHTNING && this.waterlevel > 1); // Lightning unusable in water

      if (hasWeapon && hasAmmo && isUsable && config.priority > maxPriority) {
        bestWeapon = weapon;
        maxPriority = config.priority;
      }
    });

    return bestWeapon;
  };

  /**
   * QuakeC: self.weapon = W_BestWeapon(); W_SetCurrentAmmo();
   */
  selectBestWeapon() {
    this.setWeapon(this.chooseBestWeapon());
  }

  /**
   * Adds ammo and items found in the Backpack object, will apply caps as well.
   * This does not emit any sound, message and flash effect. It’s completely silent.
   * @param {Backpack} backpack set of ammo, can be a BackpackEntity as well
   */
  applyBackpack(backpack) {
    this.ammo_nails = Math.min(200, this.ammo_nails + backpack.ammo_nails);
    this.ammo_cells = Math.min(100, this.ammo_cells + backpack.ammo_cells);
    this.ammo_rockets = Math.min(100, this.ammo_rockets + backpack.ammo_rockets);
    this.ammo_shells = Math.min(100, this.ammo_shells + backpack.ammo_shells);
    this.items |= backpack.items;
  }

  isOutOfAmmo() {
    // TODO
  }

  /**
   * shots a 128 units long trace line and prints what it has hit, useful for debugging entities
   * @protected
   */
  _explainEntity() {
    // if (this.game.deathmatch || this.game.coop) {
    //   return;
    // }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = this.angles.angleVectors();
    const end = start.copy().add(forward.multiply(128.0));

    const mins = new Vector(-8.0, -8.0, -8.0);
    const maxs = new Vector(8.0, 8.0, 8.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    if (trace.entity) {
      const tracedEntity = trace.entity;
      this.startSound(channel.CHAN_BODY, "misc/talk.wav");
      this.centerPrint(`${tracedEntity}`);
      this.consolePrint(
        `movetype = ${Object.entries(moveType).find(([, val]) => val === tracedEntity.movetype)[0] || 'unknown'}\n` +
        `solid = ${Object.entries(solid).find(([, val]) => val === tracedEntity.solid)[0] || 'unknown'}\n` +
        `flags = ${new Flag(flags, tracedEntity.flags)}\n` +
        `frame = ${tracedEntity.frame}\n` +
        `nextthink (abs) = ${tracedEntity.nextthink}\n` +
        `nextthink (rel) = ${tracedEntity.nextthink - this.game.time}\n` +
        `_stateCurrent = ${tracedEntity._stateCurrent}\n`);
      console.log('tracedEntity:', tracedEntity);
    }
  }

  /** @protected */
  _testStuff() {
    if (this.game.deathmatch || this.game.coop) {
      return;
    }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = this.angles.angleVectors();
    const end = start.copy().add(forward.multiply(128.0));

    const mins = new Vector(-8.0, -8.0, -8.0);
    const maxs = new Vector(8.0, 8.0, 8.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    if (trace.entity) {
      GibEntity.gibEntity(trace.entity, "progs/h_player.mdl");
    }
  }

  /** @protected */
  _cheatCommandGeneric() {
    if (this.game.deathmatch || this.game.coop) {
      return;
    }

    this.ammo_rockets = 100;
    this.ammo_nails = 200;
    this.ammo_shells = 100;
    this.ammo_cells = 200;

    this.items |=
      items.IT_AXE |
      items.IT_SHOTGUN |
      items.IT_SUPER_SHOTGUN |
      items.IT_NAILGUN |
      items.IT_SUPER_NAILGUN |
      items.IT_GRENADE_LAUNCHER |
      items.IT_ROCKET_LAUNCHER |
      items.IT_LIGHTNING |
      items.IT_KEY1 | items.IT_KEY2;

    this.dispatchEvent(playerEvent.BONUS_FLASH);

    this.selectBestWeapon();
  }

  /** @protected */
  _cheatCommandQuad() {
    if (this.game.deathmatch || this.game.coop) {
      return;
    }

    // TODO: this.super_time = 1.0;
    this.super_damage_finished = this.game.time + 30.0;
    this.items |= items.IT_QUAD;
  }

  /** @protected */
  _cycleWeaponCommand() {
    while (true) {
      let am = 0;

      if (this.weapon === items.IT_LIGHTNING) {
        this.weapon = items.IT_AXE;
      } else if (this.weapon === items.IT_AXE) {
        this.weapon = items.IT_SHOTGUN;
        if (this.ammo_shells < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SHOTGUN) {
        this.weapon = items.IT_SUPER_SHOTGUN;
        if (this.ammo_shells < 2) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SUPER_SHOTGUN) {
        this.weapon = items.IT_NAILGUN;
        if (this.ammo_nails < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_NAILGUN) {
        this.weapon = items.IT_SUPER_NAILGUN;
        if (this.ammo_nails < 2) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SUPER_NAILGUN) {
        this.weapon = items.IT_GRENADE_LAUNCHER;
        if (this.ammo_rockets < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_GRENADE_LAUNCHER) {
        this.weapon = items.IT_ROCKET_LAUNCHER;
        if (this.ammo_rockets < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_ROCKET_LAUNCHER) {
        this.weapon = items.IT_LIGHTNING;
        if (this.ammo_cells < 1) {
          am = 1;
        }
      }

      if ((this.items & this.weapon) && am === 0) {
        this.setWeapon(this.weapon);
        return;
      }
    }
  }

  /** @protected */
  _cycleWeaponReverseCommand() {
    while (true) {
      let am = 0;

      if (this.weapon === items.IT_LIGHTNING) {
        this.weapon = items.IT_ROCKET_LAUNCHER;
        if (this.ammo_rockets < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_ROCKET_LAUNCHER) {
        this.weapon = items.IT_GRENADE_LAUNCHER;
        if (this.ammo_rockets < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_GRENADE_LAUNCHER) {
        this.weapon = items.IT_SUPER_NAILGUN;
        if (this.ammo_nails < 2) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SUPER_NAILGUN) {
        this.weapon = items.IT_NAILGUN;
        if (this.ammo_nails < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_NAILGUN) {
        this.weapon = items.IT_SUPER_SHOTGUN;
        if (this.ammo_shells < 2) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SUPER_SHOTGUN) {
        this.weapon = items.IT_SHOTGUN;
        if (this.ammo_shells < 1) {
          am = 1;
        }
      } else if (this.weapon === items.IT_SHOTGUN) {
        this.weapon = items.IT_AXE;
      } else if (this.weapon === items.IT_AXE) {
        this.weapon = items.IT_LIGHTNING;
        if (this.ammo_cells < 1) {
          am = 1;
        }
      }

      if ((this.items & this.weapon) && am === 0) {
        this.setWeapon(this.weapon);
        return;
      }
    }
  }


  /**
   * handles impulse commands
   * @protected
   */
  _handleImpulseCommands() {
    if (this.impulse >= 1 && this.impulse <= 8) {
      this._weaponChange();
    }

    switch (this.impulse) {
      case 66:
        this._explainEntity();
        break;

      case 100:
        this._testStuff();
        break;

      case 9:
        this._cheatCommandGeneric();
        break;

      case 10:
        this._cycleWeaponCommand();
        break;

      case 11:
        this.consolePrint("Not implemented.\n");
        break;

      case 12:
        this._cycleWeaponReverseCommand();
        break;

      case 255:
        this._cheatCommandQuad();
        break;
    }

    this.impulse = 0;
  }

  /**
   * @protected
   * @returns {boolean} true, if the current weapon is okay to use
   */
  _weaponCheckNoAmmo() { // QuakeC: weapons.qc/W_CheckNoAmmo
    if (this.currentammo > 0) {
      return true;
    }

    if (this.weapon === items.IT_AXE) {
      return true;
    }

    this.selectBestWeapon();

    return false;
  }

  /** @protected */
  _weaponAttack() { // QuakeC: weapons.qc/W_Attack
    if (!this._weaponCheckNoAmmo()) {
      return;
    }

    this.show_hostile = this.game.time + 1.0; // wake monsters up

    // TODO
  }

  /** @protected */
  _weaponChange() { // W_ChangeWeapon
    let outOfAmmo = false;
    let weapon = 0;

    switch (this.impulse) {
      case 1:
        weapon = items.IT_AXE;
        break;
      case 2:
        weapon = items.IT_SHOTGUN;
        if (this.ammo_shells < 1) outOfAmmo = true;
        break;
      case 3:
        weapon = items.IT_SUPER_SHOTGUN;
        if (this.ammo_shells < 2) outOfAmmo = true;
        break;
      case 4:
        weapon = items.IT_NAILGUN;
        if (this.ammo_nails < 1) outOfAmmo = true;
        break;
      case 5:
        weapon = items.IT_SUPER_NAILGUN;
        if (this.ammo_nails < 2) outOfAmmo = true;
        break;
      case 6:
        weapon = items.IT_GRENADE_LAUNCHER;
        if (this.ammo_rockets < 1) outOfAmmo = true;
        break;
      case 7:
        weapon = items.IT_ROCKET_LAUNCHER;
        if (this.ammo_rockets < 1) outOfAmmo = true;
        break;
      case 8:
        weapon = items.IT_LIGHTNING;
        if (this.ammo_cells < 1) outOfAmmo = true;
        break;
      default:
        break;
    }

    this.impulse = 0;

    if (!(this.items & weapon)) {
      this.consolePrint("no weapon.\n");
      return;
    }

    if (outOfAmmo) {
      this.consolePrint("not enough ammo.\n");
      return;
    }

    this.setWeapon(weapon);
  }

  /** @protected */
  _weaponFrame() { // QuakeC: client.qc/W_WeaponFrame
    if (this.game.time < this.attack_finished) {
      return;
    }

    this._handleImpulseCommands();

    // check for attack
    if (this.button0) {
      this._superDamageSound();
      this._weaponAttack();
    }
  }

  /** @protected */
  _superDamageSound() {
    if (this.super_damage_finished > this.game.time && this.super_sound < this.game.time) {
      this.super_sound = this.game.time + 1.0;
      this.startSound(channel.CHAN_BODY, "items/damage3.wav", 1, attn.ATTN_NORM);
    }
  }

  /** @protected */
  _useThink() {
    if (!this.button1) {
      return;
    }

    // we only allow every 500ms a use
    if (this.use_time >= this.game.time) {
      return;
    }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = this.angles.angleVectors();
    const end = start.copy().add(forward.multiply(32.0)); // within 32 units of reach

    const mins = new Vector(-8.0, -8.0, -8.0);
    const maxs = new Vector(8.0, 8.0, 8.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    if (trace.entity && !trace.entity.isWorld()) {
      trace.entity.use(this);
    }

    this.use_time = this.game.time + 0.5;
  }

  putPlayerInServer() {
    const spot = this._selectSpawnPoint();

    this.takedamage = damage.DAMAGE_AIM;
    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_WALK;
    this.show_hostile = 0;
    this.max_health = 100;
    this.health = 100; // CR: what about max_health?
    this.flags = flags.FL_CLIENT;
    this.air_finished = this.game.time + 12;
    this.dmg = 2;   		// initial water damage
    this.super_damage_finished = 0;
    this.radsuit_finished = 0;
    this.invisible_finished = 0;
    this.invincible_finished = 0;
    this.effects = 0;
    this.invincible_time = 0;

    // CR: fields added by me later
    this.jump_flag = 0;

    this.decodeLevelParms();
    this.setWeapon(this.weapon);

    this.attack_finished = this.time;
    // NOTE: th_pain, th_die set by PlayerEntity

    this.deadflag = dead.DEAD_NO;
    this.pausetime = 0; // CR: used by teleporters

    this.origin = spot.origin.copy().add(new Vector(0.0, 0.0, 1.0));
    this.angles = spot.angles.copy();
    this.fixangle = true;

    // NOTE: not doing the modelindex_eyes trick
    this.setModel('progs/player.mdl');

    this.setSize(vec.VEC_HULL_MIN, vec.VEC_HULL_MAX);

    this.view_ofs.setTo(0.0, 0.0, 22.0);

    this._runState('player_stand1');

    if (this.game.deathmatch || this.game.coop) {
      const { forward } = this.angles.angleVectors();
      const origin = forward.multiply(20.0).add(this.origin);

      this.engine.SpawnEntity('misc_tfog', { origin });
    }

    this.engine.SpawnEntity('misc_teledeath', {
      origin: this.origin,
      owner: this,
    });
  }

  /**
   * only called when deadflag is DEAD_DEAD by prethink
   * @protected
   */
  _playerDeathThink() {
    // TODO
  }

  /**
   * handles jump pressed down
   * @protected
   */
  _playerJump() {
    if (this.flags & flags.FL_WATERJUMP) {
      return;
    }

    if (this.waterlevel >= 2) {
      if (this.watertype == content.CONTENT_WATER) {
        this.velocity[2] = 100;
      } else if (this.watertype == content.CONTENT_SLIME) {
        this.velocity[2] = 80;
      } else {
        this.velocity[2] = 50;
      }

      // play swiming sound
      if (this.swim_flag < this.game.time) {
        this.swim_flag = this.game.time + 1.0;
        if (Math.random() < 0.5) {
          this.startSound(this, channel.CHAN_BODY, "misc/water1.wav");
        } else {
          this.startSound(this, channel.CHAN_BODY, "misc/water2.wav");
        }
      }

      return;
    }

    // CR: do not check any flags in noclip mode, make pressing jump move up straight
    if (this.movetype !== moveType.MOVETYPE_NOCLIP) {
      if (!(this.flags & flags.FL_ONGROUND)) {
        return;
      }

      if (!(this.flags & flags.FL_JUMPRELEASED)) {
        return;		// don't pogo stick
      }

      this.flags &= ~flags.FL_JUMPRELEASED;
      this.flags &= ~flags.FL_ONGROUND;	// don't stairwalk

      this.button2 = 0;

      this.startSound(channel.CHAN_BODY, "player/plyrjmp8.wav");
    }

    this.velocity[2] += 270.0;
  }

  /**
   * player thinking before physics,
   * this is called by the engine per client edict
   */
  playerPreThink() {
    if (this.game.intermission_running) {
      // TODO: IntermissionThink ();	// otherwise a button could be missed between
      return;					// the think tics
    }

    if (this.view_ofs.isOrigin()) {
      return; // intermission or finale
    }

    // TODO: CheckRules ();
    // TODO: WaterMove ();

    if (this.waterlevel === 2) {
      // TODO: CheckWaterJump ();
      // this.centerPrint('this.waterlevel === 2');
    }

    if (this.deadflag >= dead.DEAD_DEAD) {
      this._playerDeathThink();
      return;
    }

    if (this.deadflag === dead.DEAD_DYING) {
      return;	// dying, so do nothing
    }

    if (this.button2) {
      this._playerJump();
    } else {
      this.flags |= flags.FL_JUMPRELEASED;
    }

    // teleporters can force a non-moving pause time
    if (this.game.time < this.pausetime) {
      this.velocity.clear();
    }

    if (this.game.time > this.attack_finished && this.currentammo === 0 && this.weapon !== items.IT_AXE) {
      this.selectBestWeapon();
    }
  }

  /**
   * player thinking after physics,
   * this is called by the engine per client edict
   */
  playerPostThink() {
    // intermission, finale, or deadish
    if (this.view_ofs.isOrigin() || this.deadflag !== dead.DEAD_NO) {
      return;
    }

    // QuakeShack: handle use requests
    //this._useThink(); // (CR: disabled for now, it’s not properly considered)

    // do weapon stuff
    this._weaponFrame();

    // check to see if player landed and play landing sound
    if (this.jump_flag < -300 && (this.flags & flags.FL_ONGROUND) !== 0 && this.health > 0) {
      if (this.watertype === content.CONTENT_WATER) {
        this.startSound(channel.CHAN_BODY, "player/h2ojump.wav");
      } else if (this.jump_flag < -650) {
        // TODO: T_Damage (self, world, world, 5);
        this.startSound(channel.CHAN_VOICE, "player/land2.wav");
        this.deathtype = deathType.FALLING;
      } else {
        this.startSound(channel.CHAN_VOICE, "player/land.wav");
      }

      this.jump_flag = 0;
    }

    if (!(this.flags & flags.FL_ONGROUND)) {
      this.jump_flag = this.velocity[2];
    }

    // TODO: CheckPowerups()
  }

  isActor() {
    return true;
  }
};

// FIXME: move to triggers
export class TelefragTriggerEntity extends BaseEntity {
  static classname = 'misc_teledeath';

  /** @param {BaseEntity} touchedByEntity touching entity */
  touch(touchedByEntity) {
    if (touchedByEntity.equals(this.owner)) {
      return;
    }

    if (touchedByEntity instanceof PlayerEntity) {
      // TODO: if (other.invincible_finished > time) self.classname = "teledeath2";

      if (!(this.owner instanceof PlayerEntity)) {
        // other monsters explode themselves
        // TODO: T_Damage (self.owner, self, self, 50000);
        return;
      }
    }

    if (touchedByEntity.health > 0) {
      // TODO: T_Damage (other, self, self, 50000);
    }
  }

  spawn() {
    if (!this.owner) {
      this.engine.DebugPrint('TelefragTriggerEntity: removed, because no owner had been set.\n');
      this.remove();
      return;
    }

    const oversize = new Vector(1.0, 1.0, 1.0);
    const mins = this.owner.mins.copy().subtract(oversize);
    const maxs = this.owner.maxs.copy().add(oversize);

    this.solid = solid.SOLID_TRIGGER;
    this.setSize(mins, maxs);

    this._scheduleThink(this.game.time + 0.2, () => this.remove());

    this.game.force_retouch = 2;
  }
};

export class GibEntity extends BaseEntity {
  static classname = 'misc_gib';

  spawn() {
    this.setModel(this.model);
    this.setSize(Vector.origin, Vector.origin);
    this.movetype = moveType.MOVETYPE_BOUNCE;
    this.solid = solid.SOLID_NOT;
    this.avelocity = (new Vector(Math.random(), Math.random(), Math.random())).multiply(600.0);
    this.ltime = this.game.time;
    this.frame = 0;
    this.flags = 0;

    this._scheduleThink(this.ltime + 10.0 + Math.random() * 10.0, () => this.remove());
  }

  /**
   *
   * @param {BaseEntity} entity the entity being gibbed
   * @param {?number} damage taken damage (negative)
   */
  static throwGibs(entity, damage = null) {
    for (const model of ['progs/gib1.mdl', 'progs/gib2.mdl', 'progs/gib3.mdl']) {
      entity.engine.SpawnEntity('misc_gib', {
        origin: entity.origin.copy(),
        velocity: VelocityForDamage(damage !== null ? damage : entity.health),
        model,
      });
    }
  }

  /**
   * turns entity into a head, will spawn random gibs
   * @param {BaseEntity} entity entity to be gibbed
   * @param {string} headModel e.g. progs/h_player.mdl
   * @param {?boolean} playSound plays gibbing sounds, if true
   */
  static gibEntity(entity, headModel, playSound = true) {
    if (!entity.isActor() || entity.health > 0) {
      return;
    }

    const damage = entity.health;

    entity.resetThinking();
    entity.setModel(headModel);
    entity.frame = 0;
    entity.movetype = moveType.MOVETYPE_BOUNCE;
    entity.takedamage = damage.DAMAGE_NO;
    entity.solid = solid.SOLID_NOT;
    entity.view_ofs = new Vector(0.0, 0.0, 8.0);
    entity.setSize(new Vector(-16.0, -16.0, 0.0), new Vector(16.0, 16.0, 56.0));
    entity.velocity = VelocityForDamage(damage);
    entity.origin[2] -= 24.0;
    entity.flags &= ~flags.FL_ONGROUND;
    entity.avelocity = (new Vector(0.0, 600.0, 0.0)).multiply(crandom());

    GibEntity.throwGibs(entity, damage);

    if (playSound) {
      entity.startSound(channel.CHAN_VOICE, Math.random() < 0.5 ? "player/gib.wav" : "player/udeath.wav", 1.0, attn.ATTN_NONE);
    }
  }
};
