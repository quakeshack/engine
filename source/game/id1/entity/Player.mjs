import Vector from '../../../shared/Vector.mjs';

import { attn, channel, content, damage, dead, deathType, effect, flags, hull, items, moveType, solid } from '../Defs.mjs';
import { crandom, Flag, Serializer } from '../helper/MiscHelpers.mjs';
import BaseEntity from './BaseEntity.mjs';
import { BackpackEntity } from './Items.mjs';
import { BubbleSpawnerEntity, InfoNotNullEntity, IntermissionCameraEntity, TeleportEffectEntity } from './Misc.mjs';
import { MeatSprayEntity } from './monster/BaseMonster.mjs';
import { Backpack, DamageHandler, PlayerWeapons, weaponConfig } from './Weapons.mjs';
import { CopyToBodyQue } from './Worldspawn.mjs';

/**
 * used to emit effects etc. to the client
 * @enum {string}
 * @readonly
 */
export const playerEvent = {
  BONUS_FLASH: 'bf',
  DAMAGE_FLASH: 'dmg',
};

export const qc = `

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

/**
 * QUAKED info_player_start2 (1 0 0) (-16 -16 -24) (16 16 24)
 * Only used on start map for the return point from an episode.
 */
export class InfoPlayerStart2 extends InfoNotNullEntity {
  static classname = 'info_player_start2';
};

/**
 * Saved out by quaked in region mode.
 * Details: https://quakewiki.org/wiki/testplayerstart
 */
export class InfoPlayerStartTest extends InfoNotNullEntity {
  static classname = 'testplayerstart';
};

/**
 * QUAKED info_player_deathmatch (1 0 1) (-16 -16 -24) (16 16 24)
 * potential spawning position for deathmatch games
 */
export class InfoPlayerStartDeathmatch extends InfoNotNullEntity {
  static classname = 'info_player_deathmatch';
};

/**
 * QUAKED info_player_coop (1 0 1) (-16 -16 -24) (16 16 24)
 * potential spawning position for coop games
 */
export class InfoPlayerStartCoop extends InfoNotNullEntity {
  static classname = 'info_player_coop';
};

export class PlayerEntity extends BaseEntity {
  static classname = 'player';

  _declareFields() {
    /** @protected */
    this._weapons = new PlayerWeapons(this);

    this._serializer.startFields();

    // relevant for view
    this.view_ofs = new Vector(); // SV.WriteClientdataToMessage
    this.punchangle = new Vector(); // SV.WriteClientdataToMessage
    this.v_angle = new Vector();
    this.fixangle = false; // SV.WriteClientdataToMessage
    this.idealpitch = 0; // SV.WriteClientdataToMessage

    // interaction states
    this.button0 = false; // fire
    this.button1 = false; // use
    this.button2 = false; // jump

    // backpack and health
    this.items = 0;
    // this.items2 = 0; // CR: need to investigate this more closely
    this.health = 0;
    this.armortype = 0; // SV.WriteClientdataToMessage
    this.armorvalue = 0; // SV.WriteClientdataToMessage
    this.ammo_shells = 0; // SV.WriteClientdataToMessage
    this.ammo_nails = 0; // SV.WriteClientdataToMessage
    this.ammo_rockets = 0; // SV.WriteClientdataToMessage
    this.ammo_cells = 0; // SV.WriteClientdataToMessage
    this.weapon = 0; // SV.WriteClientdataToMessage
    this.max_health = 100; // players maximum health is stored here
    this.currentammo = 0; // SV.WriteClientdataToMessage
    this.weaponmodel = null; // SV.WriteClientdataToMessage
    this.weaponframe = 0; // SV.WriteClientdataToMessage
    this.impulse = 0; // cycle weapons, cheats, etc.

    // set to time+0.2 whenever a client fires a
    // weapon or takes damage.  Used to alert
    // monsters that otherwise would let the player go
    this.show_hostile = 0;

    this.jump_flag = 0.0;		// player jump flag (CR: it’s called a flag, but self.jump_flag = self.velocity_z sometimes)
    this.swim_flag = 0.0;		// player swimming sound flag (CR: it’s called a flag, but it’s a float)
    this.air_finished = 0;	// when time > air_finished, start drowning
    this.bubble_count = 0;	// keeps track of the number of bubbles
    this.deathtype = deathType.NONE;		// keeps track of how the player died

    // expiration of items
    this.super_time = 0;
    this.super_damage_finished = 0;
    this.rad_time = 0;
    this.radsuit_finished = 0;
    this.invisible_time = 0;
    this.invisible_finished = 0;
    this.invincible_time = 0;
    this.invincible_finished = 0;
    /** @type {{[key: number]: number}} next invincible sound time per attacking entity */
    this.invincible_sound_time = {};

    // time related checks
    this.super_sound = 0; // time for next super attack sound

    // multiplayer fun
    this.netname = null;
    this.colormap = 0;
    this.team = 0;
    this.frags = 0;

    // relevant for damage etc.
    this.bloodcolor = 73; // FIXME: hardcoded color code (73)

    /** @type {number} used for forced movement time (e.g. trigger_push) */
    this.fly_time = 0;

    /** @type {number} set by teleporters to keep the player from moving a while, also after death keeping from respawn too early */
    this.pausetime = 0;

    /** @protected */
    this._damageTime = 0;

    /** @protected */
    this._modelIndex = {
      player: null,
      eyes: null,
    };

    Serializer.makeSerializable(this._modelIndex);

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
  }

  _precache() {
    // CR: Worldspawn is taking care of all the precaches for the player entity.
  }

  /** @protected */
  _enterRunningState() {
    if (this.weapon === items.IT_AXE) {
      this._runState('player_run_axe1');
      return;
    }

    this._runState('player_run1');
  }

  /** @protected */
  _enterStandingState() {
    if (this.weapon === items.IT_AXE) {
      this._runState('player_stand_axe1');
      return;
    }

    this._runState('player_stand1');
  }

  /** @protected */
  _enterPainState() {
    if (this.weaponframe > 0) {
      return;
    }

    if (this.invisible_finished > this.game.time) {
      return; // eyes don't have pain frames
    }

    if (this.weapon === items.IT_AXE) {
      this._runState('player_pain_axe1');
      return;
    }

    this._runState('player_pain1');
  }

  /** @protected */
  _attackStateDone() {
    this.weaponframe = 0;

    // that replaces the next state player_run with a custom logic
    this._scheduleThink(this.game.time + 0.1, () => {
      if (this._stateAssertStanding()) {
        this._enterStandingState();
        return;
      }

      if (this._stateAssertRunning()) {
        this._enterRunningState();
        return;
      }

      // should not happen
    }, 'animation-state-machine');
  }

  /**
   * @protected
   * @returns {boolean} false, when changed to standing state
   */
  _stateAssertRunning() {
    // fallback to stand state, when not running
    if (this.velocity[0] === 0.0 && this.velocity[1] === 0.0) { // NOTE: only xy movement
      this._enterStandingState();
      return false;
    }

    return true;
  }

  /**
   * @protected
   * @returns {boolean} false, when changed to running state
   */
  _stateAssertStanding() {
    // fallback to stand state, when not running
    if (this.velocity[0] !== 0.0 && this.velocity[1] !== 0.0) { // NOTE: only xy movement
      this._enterRunningState();
      return false;
    }

    return true;
  }

  _initStates() {
    // CR:  This state machine not only controls animations, but also defines when an axe attack is actually launched.
    //      Yet another fun was unrolling the running and standing states to fit it our state machine infrastructure.

    this._defineState('player_run1', 'rockrun1', 'player_run2', function () { this._stateAssertRunning(); this.weaponframe = 0; });
    this._defineState('player_run2', 'rockrun2', 'player_run3', function () { this._stateAssertRunning(); });
    this._defineState('player_run3', 'rockrun3', 'player_run4', function () { this._stateAssertRunning(); });
    this._defineState('player_run4', 'rockrun4', 'player_run5', function () { this._stateAssertRunning(); });
    this._defineState('player_run5', 'rockrun5', 'player_run6', function () { this._stateAssertRunning(); });
    this._defineState('player_run6', 'rockrun6', 'player_run1', function () { this._stateAssertRunning(); });

    this._defineState('player_run_axe1', 'axrun1', 'player_run_axe2', function () { this._stateAssertRunning(); this.weaponframe = 0; });
    this._defineState('player_run_axe2', 'axrun2', 'player_run_axe3', function () { this._stateAssertRunning(); });
    this._defineState('player_run_axe3', 'axrun3', 'player_run_axe4', function () { this._stateAssertRunning(); });
    this._defineState('player_run_axe4', 'axrun4', 'player_run_axe5', function () { this._stateAssertRunning(); });
    this._defineState('player_run_axe5', 'axrun5', 'player_run_axe6', function () { this._stateAssertRunning(); });
    this._defineState('player_run_axe6', 'axrun6', 'player_run_axe1', function () { this._stateAssertRunning(); });

    this._defineState('player_stand1', 'stand1', 'player_stand2', function () { this._stateAssertStanding(); this.weaponframe = 0; });
    this._defineState('player_stand2', 'stand2', 'player_stand3', function () { this._stateAssertStanding(); });
    this._defineState('player_stand3', 'stand3', 'player_stand4', function () { this._stateAssertStanding(); });
    this._defineState('player_stand4', 'stand4', 'player_stand5', function () { this._stateAssertStanding(); });
    this._defineState('player_stand5', 'stand5', 'player_stand1', function () { this._stateAssertStanding(); });

    this._defineState('player_stand_axe1', 'axstnd1', 'player_stand_axe2', function () { this._stateAssertStanding(); this.weaponframe = 0; });
    this._defineState('player_stand_axe2', 'axstnd2', 'player_stand_axe3', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe3', 'axstnd3', 'player_stand_axe4', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe4', 'axstnd4', 'player_stand_axe5', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe5', 'axstnd5', 'player_stand_axe6', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe6', 'axstnd6', 'player_stand_axe7', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe7', 'axstnd7', 'player_stand_axe8', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe8', 'axstnd8', 'player_stand_axe9', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe9', 'axstnd9', 'player_stand_axe10', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe10', 'axstnd10', 'player_stand_axe11', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe11', 'axstnd11', 'player_stand_axe12', function () { this._stateAssertStanding(); });
    this._defineState('player_stand_axe12', 'axstnd12', 'player_stand_axe1', function () { this._stateAssertStanding(); });

    this._defineState('player_shot1', 'shotatt1', 'player_shot2', function () { this.weaponframe = 1; this.effects |= effect.EF_MUZZLEFLASH; });
    this._defineState('player_shot2', 'shotatt2', 'player_shot3', function () { this.weaponframe = 2; });
    this._defineState('player_shot3', 'shotatt3', 'player_shot4', function () { this.weaponframe = 3; });
    this._defineState('player_shot4', 'shotatt4', 'player_shot5', function () { this.weaponframe = 4; });
    this._defineState('player_shot5', 'shotatt5', 'player_shot6', function () { this.weaponframe = 5; });
    this._defineState('player_shot6', 'shotatt6', null, function () { this.weaponframe = 6; this._attackStateDone(); });

    this._defineState('player_rocket1', 'rockatt1', 'player_rocket2', function () { this.weaponframe = 1; this.effects |= effect.EF_MUZZLEFLASH; });
    this._defineState('player_rocket2', 'rockatt2', 'player_rocket3', function () { this.weaponframe = 2; });
    this._defineState('player_rocket3', 'rockatt3', 'player_rocket4', function () { this.weaponframe = 3; });
    this._defineState('player_rocket4', 'rockatt4', 'player_rocket5', function () { this.weaponframe = 4; });
    this._defineState('player_rocket5', 'rockatt5', 'player_rocket6', function () { this.weaponframe = 5; });
    this._defineState('player_rocket6', 'rockatt6', null, function () { this.weaponframe = 6; this._attackStateDone(); });

    this._defineState('player_axe1', 'axatt1', 'player_axe2', function () { this.weaponframe = 1; });
    this._defineState('player_axe2', 'axatt2', 'player_axe3', function () { this.weaponframe = 2; });
    this._defineState('player_axe3', 'axatt3', 'player_axe4', function () { this.weaponframe = 3; this._weapons.fireAxe(); });
    this._defineState('player_axe4', 'axatt4', null, function () { this.weaponframe = 4; this._attackStateDone(); });

    this._defineState('player_axeb1', 'axattb1', 'player_axeb2', function () { this.weaponframe = 5; });
    this._defineState('player_axeb2', 'axattb2', 'player_axeb3', function () { this.weaponframe = 6; });
    this._defineState('player_axeb3', 'axattb3', 'player_axeb4', function () { this.weaponframe = 7; this._weapons.fireAxe(); });
    this._defineState('player_axeb4', 'axattb4', null, function () { this.weaponframe = 8; this._attackStateDone(); });

    this._defineState('player_axec1', 'axattc1', 'player_axec2', function () { this.weaponframe = 1; });
    this._defineState('player_axec2', 'axattc2', 'player_axec3', function () { this.weaponframe = 2; });
    this._defineState('player_axec3', 'axattc3', 'player_axec4', function () { this.weaponframe = 3; this._weapons.fireAxe(); });
    this._defineState('player_axec4', 'axattc4', null, function () { this.weaponframe = 4; this._attackStateDone(); });

    this._defineState('player_axed1', 'axattd1', 'player_axed2', function () { this.weaponframe = 5; });
    this._defineState('player_axed2', 'axattd2', 'player_axed3', function () { this.weaponframe = 6; });
    this._defineState('player_axed3', 'axattd3', 'player_axed4', function () { this.weaponframe = 7; this._weapons.fireAxe(); });
    this._defineState('player_axed4', 'axattd4', null, function () { this.weaponframe = 8; this._attackStateDone(); });

    this._defineState('player_pain1', 'pain1', 'player_pain2', function () { this.weaponframe = 0; this._painSound(); });
    this._defineState('player_pain2', 'pain2', 'player_pain3');
    this._defineState('player_pain3', 'pain3', 'player_pain4');
    this._defineState('player_pain4', 'pain4', 'player_pain5');
    this._defineState('player_pain5', 'pain5', 'player_pain6');
    this._defineState('player_pain6', 'pain6', null, function () { this._attackStateDone(); });

    this._defineState('player_pain_axe1', 'axpain1', 'player_pain_axe2', function () { this.weaponframe = 0; this._painSound(); });
    this._defineState('player_pain_axe2', 'axpain2', 'player_pain_axe3');
    this._defineState('player_pain_axe3', 'axpain3', 'player_pain_axe4');
    this._defineState('player_pain_axe4', 'axpain4', 'player_pain_axe5');
    this._defineState('player_pain_axe5', 'axpain5', 'player_pain_axe6');
    this._defineState('player_pain_axe6', 'axpain6', null, function () { this._attackStateDone(); });

    this._defineState('player_diea1', 'deatha1', 'player_diea2');
    this._defineState('player_diea2', 'deatha2', 'player_diea3');
    this._defineState('player_diea3', 'deatha3', 'player_diea4');
    this._defineState('player_diea4', 'deatha4', 'player_diea5');
    this._defineState('player_diea5', 'deatha5', 'player_diea6');
    this._defineState('player_diea6', 'deatha6', 'player_diea7');
    this._defineState('player_diea7', 'deatha7', 'player_diea8');
    this._defineState('player_diea8', 'deatha8', 'player_diea9');
    this._defineState('player_diea9', 'deatha9', 'player_diea10');
    this._defineState('player_diea10', 'deatha10', 'player_diea11');
    this._defineState('player_diea11', 'deatha11', null, function () { this._playerDead(); });

    this._defineState('player_dieb1', 'deathb1', 'player_dieb2');
    this._defineState('player_dieb2', 'deathb2', 'player_dieb3');
    this._defineState('player_dieb3', 'deathb3', 'player_dieb4');
    this._defineState('player_dieb4', 'deathb4', 'player_dieb5');
    this._defineState('player_dieb5', 'deathb5', 'player_dieb6');
    this._defineState('player_dieb6', 'deathb6', 'player_dieb7');
    this._defineState('player_dieb7', 'deathb7', 'player_dieb8');
    this._defineState('player_dieb8', 'deathb8', 'player_dieb9');
    this._defineState('player_dieb9', 'deathb9', null, function () { this._playerDead(); });

    this._defineState('player_diec1', 'deathc1', 'player_diec2');
    this._defineState('player_diec2', 'deathc2', 'player_diec3');
    this._defineState('player_diec3', 'deathc3', 'player_diec4');
    this._defineState('player_diec4', 'deathc4', 'player_diec5');
    this._defineState('player_diec5', 'deathc5', 'player_diec6');
    this._defineState('player_diec6', 'deathc6', 'player_diec7');
    this._defineState('player_diec7', 'deathc7', 'player_diec8');
    this._defineState('player_diec8', 'deathc8', 'player_diec9');
    this._defineState('player_diec9', 'deathc9', 'player_diec10');
    this._defineState('player_diec10', 'deathc10', 'player_diec11');
    this._defineState('player_diec11', 'deathc11', 'player_diec12');
    this._defineState('player_diec12', 'deathc12', 'player_diec13');
    this._defineState('player_diec13', 'deathc13', 'player_diec14');
    this._defineState('player_diec14', 'deathc14', 'player_diec15');
    this._defineState('player_diec15', 'deathc15', null, function () { this._playerDead(); });

    this._defineState('player_died1', 'deathd1', 'player_died2');
    this._defineState('player_died2', 'deathd2', 'player_died3');
    this._defineState('player_died3', 'deathd3', 'player_died4');
    this._defineState('player_died4', 'deathd4', 'player_died5');
    this._defineState('player_died5', 'deathd5', 'player_died6');
    this._defineState('player_died6', 'deathd6', 'player_died7');
    this._defineState('player_died7', 'deathd7', 'player_died8');
    this._defineState('player_died8', 'deathd8', 'player_died9');
    this._defineState('player_died9', 'deathd9', null, function () { this._playerDead(); });

    this._defineState('player_diee1', 'deathe1', 'player_diee2');
    this._defineState('player_diee2', 'deathe2', 'player_diee3');
    this._defineState('player_diee3', 'deathe3', 'player_diee4');
    this._defineState('player_diee4', 'deathe4', 'player_diee5');
    this._defineState('player_diee5', 'deathe5', 'player_diee6');
    this._defineState('player_diee6', 'deathe6', 'player_diee7');
    this._defineState('player_diee7', 'deathe7', 'player_diee8');
    this._defineState('player_diee8', 'deathe8', 'player_diee9');
    this._defineState('player_diee9', 'deathe9', null, function () { this._playerDead(); });

    this._defineState('player_die_ax1', 'axdeth1', 'player_die_ax2');
    this._defineState('player_die_ax2', 'axdeth2', 'player_die_ax3');
    this._defineState('player_die_ax3', 'axdeth3', 'player_die_ax4');
    this._defineState('player_die_ax4', 'axdeth4', 'player_die_ax5');
    this._defineState('player_die_ax5', 'axdeth5', 'player_die_ax6');
    this._defineState('player_die_ax6', 'axdeth6', 'player_die_ax7');
    this._defineState('player_die_ax7', 'axdeth7', 'player_die_ax8');
    this._defineState('player_die_ax8', 'axdeth8', 'player_die_ax9');
    this._defineState('player_die_ax9', 'axdeth9', null, function () { this._playerDead(); });

    this._defineState('player_nail1', 'nailatt1', 'player_nail2', function () { this._attackNailState(); });
    this._defineState('player_nail2', 'nailatt2', 'player_nail1', function () { this._attackNailState(); });

    this._defineState('player_light1', 'nailatt1', 'player_light2', function () { this._attackLightningState(); });
    this._defineState('player_light2', 'nailatt2', 'player_light1', function () { this._attackLightningState(); });
  }

  /** @protected */
  _attackNailState() {
    this.effects |= effect.EF_MUZZLEFLASH;

    if (!this.button0) {
      this._attackStateDone();
      return;
    }

    if (this.weaponframe < 0 || this.weaponframe >= 8) {
      this.weaponframe = 0;
    }

    this.weaponframe++;

    // reset attack finished, otherwise it might be possible to spam impulses in the meantime
    this.attack_finished = this.game.time + 0.2;
  }

  /** @protected */
  _attackLightningState() {
    this.effects |= effect.EF_MUZZLEFLASH;

    if (!this.button0) {
      this._attackStateDone();
      return;
    }

    if (this.weaponframe < 0 || this.weaponframe >= 4) {
      this.weaponframe = 0;
    }

    this.weaponframe++;

    // reset attack finished, otherwise it might be possible to spam impulses in the meantime
    this.attack_finished = this.game.time + 0.2;
  }

  /** @protected */
  _painSound() { // TODO: player.qc/PainSound

    // missing stuff: anything contents

    this.startSound(channel.CHAN_VOICE, `player/pain${Math.floor(Math.random() * 6) + 1}.wav`);
  }

  /** @protected */
  _deathSound() { // TODO: player.qc/DeathSound
    // under water death sound
    if (this.waterlevel === 3) {
      this.startSound(channel.CHAN_VOICE, 'player/h2odeath.wav', 1.0, attn.ATTN_NONE);
      return;
    }

    // regular death sound
    this.startSound(channel.CHAN_VOICE, `player/death${Math.floor(Math.random() * 5) + 1}.wav`, 1.0, attn.ATTN_NONE);
  }

  /**
   * In coop try to find a coop spawn spot,
   * in deathmatch try to find a non occupied deathmatch spawn spot,
   * in singleplayer try to find player start spawn spot.
   * @protected
   * @returns {BaseEntity} selected spawn point
   */
  _selectSpawnPoint() { // QuakeC: client.qc/SelectSpawnPoint
    if (this.game.coop) {
      this.game.lastspawn = this.findNextEntityByFieldAndValue('classname', InfoPlayerStartCoop.classname, this.game.lastspawn, true);

      if (this.game.lastspawn) {
        return this.game.lastspawn;
      }
    } else if (this.game.deathmatch) {
      let spot = this.game.lastspawn;
      let attempts = 32;

      while (attempts-- > 0) {
        spot = this.findNextEntityByFieldAndValue('classname', InfoPlayerStartDeathmatch.classname, spot, true);

        if (!spot) {
          this.engine.ConsoleWarning('PlayerEntity._selectSpawnPoint: There is no deathmatch spawn point on this map!\n');
          break;
        }

        if (!Array.from(this.engine.FindInRadius(spot.origin, 32)).find((entity) => entity instanceof PlayerEntity)) {
          this.game.lastspawn = spot;
          return this.game.lastspawn;
        }
      }
    }

    if (this.game.serverflags) { // return with a rune to start
      const spot = this.findFirstEntityByFieldAndValue('classname', InfoPlayerStart2.classname);

      if (spot) {
        return spot;
      }
    }

    const spot = this.findFirstEntityByFieldAndValue('classname', InfoPlayerStart.classname);
    console.assert(spot !== null, 'info_player_start last resort');
    return spot;
  }

  /** @protected */
  _dropBackpack() {
    const backpack = /** @type {BackpackEntity} */ (this.engine.SpawnEntity(BackpackEntity.classname, {
      origin: this.origin.copy().subtract(new Vector(0.0, 0.0, 24.0)),
      items: this.weapon,
      ammo_cells: this.ammo_cells,
      ammo_nails: this.ammo_nails,
      ammo_rockets: this.ammo_rockets,
      ammo_shells: this.ammo_shells,
      regeneration_time: 0, // do not regenerate
      remove_after: 120, // remove after 120s
    }));

    // toss it around
    backpack.toss();
  }

  /** @protected */
  _playerDie() { // QuakeC: player.qc/PlayerDie
    this.items &= ~(items.IT_INVISIBILITY);
    this.invisible_finished = 0; // don't die as eyes
    this.invincible_finished = 0;
    this.super_damage_finished = 0;
    this.radsuit_finished = 0;
    this.modelindex = this._modelIndex.player; // don't use eyes

    if (this.game.deathmatch || this.game.coop) {
      this._dropBackpack();
    }

    this.weaponmodel = null;
    this.weaponframe = 0;
    this.view_ofs.setTo(0.0, 0.0, -8.0);
    this.deadflag = dead.DEAD_DYING;
    this.solid = solid.SOLID_NOT;
    this.flags &= ~(flags.FL_ONGROUND);
    this.movetype = moveType.MOVETYPE_TOSS;

    if (this.flags & flags.FL_INWATER) {
      // FIXME: if in lava, we can burn it up. if in water, make the dead corpse float up
      this.velocity.clear();
    } else {
      if (this.velocity[2] < 10.0) {
        this.velocity[2] += Math.random() * 300.0;
      }
    }

    if (this.health < -40.0) {
      GibEntity.gibEntity(this, 'progs/h_player.mdl', true);
      this._playerDead();
      return;
    }

    BubbleSpawnerEntity.bubble(this, 20);

    this._deathSound();

    this.angles[0] = 0.0;
    this.angles[2] = 0.0;

    if (this.weapon === items.IT_AXE) {
      this._runState('player_die_ax1');
      return;
    }

    // TODO: temp1 check

    switch (Math.floor(Math.random() * 5)) {
      case 0: this._runState('player_diea1'); break;
      case 1: this._runState('player_dieb1'); break;
      case 2: this._runState('player_diec1'); break;
      case 3: this._runState('player_died1'); break;
      case 4: this._runState('player_diee1'); break;
    }
  }

  /** @protected */
  _playerDead() { // QuakeC: player.qc/PlayerDead
    this.resetThinking();
    // allow respawn after a certain time
    this.pausetime = this.game.time + 1.0;
    this.deadflag = dead.DEAD_DEAD;
  }

  /**
   * Prints a centered message.
   * @param {string} message message
   */
  centerPrint(message) {
    this.edict.getClient().centerPrint(message);
  }

  /**
   * Sends a message to the player’s console.
   * @param {string} message message
   */
  consolePrint(message) {
    this.edict.getClient().consolePrint(message);
  }

  /**
   * Dispatches a client event to the player’s frontend.
   * @param {playerEvent} plEvent player event
   * @param {...any} args additional parameters
   */
  // eslint-disable-next-line no-unused-vars
  dispatchEvent(plEvent, ...args) {
    // FIXME: another chapter of fun ahead
    if (plEvent === playerEvent.BONUS_FLASH) {
      this.edict.getClient().sendConsoleCommands('bf\n');
    }
  }

  decodeLevelParms() {
    if (this.game.serverflags) {
      // HACK: maps/start.bsp
      if (this.game.worldspawn.model === 'maps/start.bsp') {
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
  setWeapon(weapon = this.weapon) {
    if (!Object.values(items).includes(weapon)) {
      throw new RangeError('Weapon not defined in items');
    }

    this.weapon = weapon;
    this.items &= ~(this.items & (items.IT_SHELLS | items.IT_NAILS | items.IT_ROCKETS | items.IT_CELLS));

    const config = weaponConfig.get(this.weapon);
    if (config) {
      this.currentammo = config.currentammo ? this[config.currentammo] : null;
      this.weaponmodel = config.weaponmodel;
      this.weaponframe = config.weaponframe;
      if (config.items) {
        this.items |= items[config.items];
      }
    } else {
      this.currentammo = 0;
      this.weaponmodel = null;
      this.weaponframe = 0;
    }

    this._enterRunningState(); // get out of any weapon firing states
  }

  /**
   * QuakeC: W_BestWeapon
   * @returns {number} weapon number
   */
  chooseBestWeapon() {
    const it = this.items;
    let bestWeapon = items.IT_AXE; // Default weapon
    let maxPriority = 0;

    for (const [weapon, config] of weaponConfig.entries()) {
      const hasWeapon = it & weapon; // Check if player has this weapon
      const hasAmmo = config.currentammo === 0 || this[config.currentammo] > 0; // Check if ammo is available
      const isUsable = !(weapon === items.IT_LIGHTNING && this.waterlevel > 1); // Lightning unusable in water

      if (hasWeapon && hasAmmo && isUsable && config.priority > maxPriority) {
        bestWeapon = weapon;
        maxPriority = config.priority;
      }
    };

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
   * @returns {boolean} true, if any out of that backpack was taken
   */
  applyBackpack(backpack) {
    let backpackUsed = false, ammoUsed = false;

    const ammo_nails = Math.min(200, this.ammo_nails + backpack.ammo_nails);
    const ammo_cells = Math.min(100, this.ammo_cells + backpack.ammo_cells);
    const ammo_rockets = Math.min(100, this.ammo_rockets + backpack.ammo_rockets);
    const ammo_shells = Math.min(100, this.ammo_shells + backpack.ammo_shells);

    if (ammo_nails !== this.ammo_nails) {
      this.ammo_nails = ammo_nails;
      backpackUsed = true;
      ammoUsed = true;
    }

    if (ammo_cells !== this.ammo_cells) {
      this.ammo_cells = ammo_cells;
      backpackUsed = true;
      ammoUsed = true;
    }

    if (ammo_rockets !== this.ammo_rockets) {
      this.ammo_rockets = ammo_rockets;
      backpackUsed = true;
      ammoUsed = true;
    }

    if (ammo_shells !== this.ammo_shells) {
      this.ammo_shells = ammo_shells;
      backpackUsed = true;
      ammoUsed = true;
    }

    if ((this.items & backpack.items) !== backpack.items) {
      this.items |= backpack.items;
      backpackUsed = true;
    }

    if (ammoUsed && (backpack.items & (
      items.IT_SHOTGUN | items.IT_SUPER_SHOTGUN |
      items.IT_NAILGUN | items.IT_SUPER_NAILGUN |
      items.IT_GRENADE_LAUNCHER | items.IT_ROCKET_LAUNCHER |
      items.IT_LIGHTNING
    ))) {
      this.setWeapon(this.chooseBestWeapon());
    }

    return backpackUsed;
  }

  /**
   * Heal player.
   * @param {number} healthpoints how many HPs to heal
   * @param {?boolean} ignoreLimit optionally ignore max_health, default false
   * @returns {boolean} true, if health was applied. false, if dead or max_health hit
   */
  applyHealth(healthpoints, ignoreLimit = false) {
    if (this.health <= 0) {
      return false;
    }

    if (!ignoreLimit && this.health >= this.max_health) {
      return false;
    }

    healthpoints = Math.ceil(healthpoints);

    this.health += healthpoints;

    if (!ignoreLimit && this.health >= this.max_health) {
      this.health = this.max_health;
    }

    this.health = Math.min(this.health, 250);

    return true;
  }

  /**
   * Checks ammo situation for the currently selected weapon.
   * @returns {boolean} true, if the current weapon has ammo
   */
  checkAmmo() {
    return this._weapons.checkAmmo();
  }

  /**
   * Shots a 128 units long trace line and prints what it has hit, useful for debugging entities.
   * @private
   */
  _explainEntity() {
    if (!this._canUseCheats()) {
      return;
    }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = this.angles.angleVectors();
    const end = start.copy().add(forward.multiply(128.0));

    const mins = new Vector(-8.0, -8.0, -8.0);
    const maxs = new Vector(8.0, 8.0, 8.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    if (trace.entity) {
      const tracedEntity = trace.entity;
      this.startSound(channel.CHAN_BODY, 'misc/talk.wav');
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

  /** @private */
  _testStuff() {
    MeatSprayEntity.sprayMeat(this);
  }

  /** @private */
  _killRay() {
    if (!this._canUseCheats()) {
      return;
    }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = this.angles.angleVectors();
    const end = start.copy().add(forward.multiply(128.0));

    const mins = new Vector(-8.0, -8.0, -8.0);
    const maxs = new Vector(8.0, 8.0, 8.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    if (trace.entity) {
      this.damage(trace.entity, 50000.0);
    }
  }

  /** @private */
  _cheatCommandGeneric() {
    if (!this._canUseCheats()) {
      return;
    }

    this.applyBackpack({
      weapon: 0,
      items:
        items.IT_AXE |
        items.IT_SHOTGUN |
        items.IT_SUPER_SHOTGUN |
        items.IT_NAILGUN |
        items.IT_SUPER_NAILGUN |
        items.IT_GRENADE_LAUNCHER |
        items.IT_ROCKET_LAUNCHER |
        items.IT_LIGHTNING |
        items.IT_KEY1 | items.IT_KEY2,
      ammo_rockets: 25,
      ammo_nails: 100,
      ammo_shells: 50,
      ammo_cells: 100,
    });

    this.dispatchEvent(playerEvent.BONUS_FLASH);
  }

  /** @private */
  _cheatCommandQuad() {
    if (!this._canUseCheats()) {
      return;
    }

    this.super_time = 1.0;
    this.super_damage_finished = this.game.time + 30.0;
    this.items |= items.IT_QUAD;
  }

  /** @private */
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
        this.setWeapon();
        return;
      }
    }
  }

  /** @private */
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
        this.setWeapon();
        return;
      }
    }
  }

  /**
   * @private
   * @returns {boolean} true, when cheats are allowed
   */
  _canUseCheats() {
    if (!this.game.deathmatch && !this.game.coop) {
      return true;
    }

    if (!this.engine.GetCvar('sv_cheats').value) {
      this.consolePrint('Cheats are not enabled on this server.\n');
      return false;
    }

    return true;
  }

  /**
   * handles impulse commands
   * @private
   */
  _handleImpulseCommands() {
    if (this.impulse >= 1 && this.impulse <= 8) {
      // CR: in vanilla Quake impulse code represents the weapon slot within this range
      this._weaponChange(this.impulse);
    }

    switch (this.impulse) {
      case 66:
        this._explainEntity();
        break;

      case 101:
        this._testStuff();
        break;

      case 100:
        this._killRay();
        break;

      case 9:
        this._cheatCommandGeneric();
        break;

      case 10:
        this._cycleWeaponCommand();
        break;

      case 11:
        this.consolePrint('Not implemented.\n');
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

  /** @protected */
  _weaponAttack() { // QuakeC: weapons.qc/W_Attack
    if (!this._weapons.checkAmmo()) {
      return;
    }

    this.show_hostile = this.game.time + 1.0; // wake monsters up

    switch (this.weapon) {
      case items.IT_AXE: { // CR: we do not call this._weapons.fireAxe here, it will be done down the state machine
        this.startSound(channel.CHAN_WEAPON, 'weapons/ax1.wav');
        const r = Math.random();
        if (r < 0.25) {
          this._runState('player_axe1');
        } else if (r < 0.5) {
          this._runState('player_axeb1');
        } else if (r < 0.75) {
          this._runState('player_axec1');
        } else {
          this._runState('player_axed1');
        }
        this.attack_finished = this.game.time + 0.5;
      }
        break;

      case items.IT_SHOTGUN:
        this._runState('player_shot1');
        this._weapons.fireShotgun();
        this.attack_finished = this.game.time + 0.5;
        break;

      case items.IT_SUPER_SHOTGUN:
        this._runState('player_shot1');
        this._weapons.fireSuperShotgun();
        this.attack_finished = this.game.time + 0.7;
        break;

      case items.IT_ROCKET_LAUNCHER:
        this._runState('player_rocket1');
        this._weapons.fireRocket();
        this.attack_finished = this.game.time + 0.8;
        break;

      case items.IT_GRENADE_LAUNCHER:
        this._runState('player_rocket1');
        this._weapons.fireGrenade();
        this.attack_finished = this.game.time + 0.8;
        break;

      case items.IT_NAILGUN:
        this._runState('player_nail1');
        this._weapons.fireNailgun();
        this.attack_finished = this.game.time + 0.2;
        break;

      case items.IT_SUPER_NAILGUN:
        this._runState('player_nail1');
        this._weapons.fireSuperNailgun();
        this.attack_finished = this.game.time + 0.2;
        break;

      case items.IT_LIGHTNING:
        this._runState('player_light1');
        this._weapons.fireLightning();
        this.attack_finished = this.game.time + 0.1;
        break;

      default:
        this.consolePrint(`_weaponAttack: ${this.weapon} not implemented\n`);
        this.attack_finished = this.game.time + 0.1;
        break;
    }
  }

  /**
   * @protected
   * @param {number} slot (selected slot)
   */
  _weaponChange(slot) { // W_ChangeWeapon
    let outOfAmmo = false;
    let weapon = 0;

    switch (slot) {
      case 1:
        weapon = items.IT_AXE;
        break;
      case 2:
        weapon = items.IT_SHOTGUN;
        if (this.ammo_shells < 1) {outOfAmmo = true;}
        break;
      case 3:
        weapon = items.IT_SUPER_SHOTGUN;
        if (this.ammo_shells < 2) {outOfAmmo = true;}
        break;
      case 4:
        weapon = items.IT_NAILGUN;
        if (this.ammo_nails < 1) {outOfAmmo = true;}
        break;
      case 5:
        weapon = items.IT_SUPER_NAILGUN;
        if (this.ammo_nails < 2) {outOfAmmo = true;}
        break;
      case 6:
        weapon = items.IT_GRENADE_LAUNCHER;
        if (this.ammo_rockets < 1) {outOfAmmo = true;}
        break;
      case 7:
        weapon = items.IT_ROCKET_LAUNCHER;
        if (this.ammo_rockets < 1) {outOfAmmo = true;}
        break;
      case 8:
        weapon = items.IT_LIGHTNING;
        if (this.ammo_cells < 1) {outOfAmmo = true;}
        break;
      default:
        break;
    }

    this.impulse = 0;

    if (!(this.items & weapon)) {
      this.consolePrint('no weapon.\n');
      return;
    }

    if (outOfAmmo) {
      this.consolePrint('not enough ammo.\n');
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
      this.startSound(channel.CHAN_BODY, 'items/damage3.wav', 1, attn.ATTN_NORM);
    }
  }

  _powerupFrame() { // QuakeC: client.qc/CheckPowerups
    if (this.health <= 0) {
      return;
    }

    // Invisibility
    if (this.invisible_finished) {
      if (this.invisible_sound < this.game.time) {
        this.startSound(channel.CHAN_AUTO, 'items/inv3.wav', 0.5, attn.ATTN_IDLE);
        this.invisible_sound = this.game.time + (Math.random() * 3 + 1);
      }

      if (this.invisible_finished < this.game.time + 3) {
        if (this.invisible_time === 1) {
          this.consolePrint('Ring of Shadows magic is fading\n');
          this.dispatchEvent(playerEvent.BONUS_FLASH);
          this.startSound(channel.CHAN_AUTO, 'items/inv2.wav');
          this.invisible_time = this.game.time + 1;
        }
        if (this.invisible_time < this.game.time) {
          this.invisible_time = this.game.time + 1;
          this.dispatchEvent(playerEvent.BONUS_FLASH);
        }
      }

      if (this.invisible_finished < this.game.time) {
        this.items &= ~items.IT_INVISIBILITY;
        this.invisible_finished = 0;
        this.invisible_time = 0;
        this.modelindex = this._modelIndex.player;
      } else {
        this.modelindex = this._modelIndex.eyes;
        this.frame = 0; // during eyes, keep animation static
      }
    }

    // Invincibility
    if (this.invincible_finished) {
      if (this.invincible_finished < this.game.time + 3) {
        if (this.invincible_time === 1) {
          this.consolePrint('Protection is almost burned out\n');
          this.dispatchEvent(playerEvent.BONUS_FLASH);
          this.startSound(channel.CHAN_AUTO, 'items/protect2.wav');
          this.invincible_time = this.game.time + 1;
        }

        if (this.invincible_time < this.game.time) {
          this.invincible_time = this.game.time + 1;
          this.dispatchEvent(playerEvent.BONUS_FLASH);
        }
      }

      if (this.invincible_finished < this.game.time) {
        this.items &= ~items.IT_INVULNERABILITY;
        this.invincible_time = 0;
        this.invincible_finished = 0;
        this.invincible_sound_time = {};
      }

      this.effects = this.invincible_finished > this.game.time ? this.effects | effect.EF_DIMLIGHT : this.effects & ~effect.EF_DIMLIGHT;
    }

    // Super Damage
    if (this.super_damage_finished) {
      if (this.super_damage_finished < this.game.time + 3) {
        if (this.super_time === 1) {
          this.consolePrint('Quad Damage is wearing off\n');
          this.dispatchEvent(playerEvent.BONUS_FLASH);
          this.startSound(channel.CHAN_AUTO, 'items/damage2.wav');
          this.super_time = this.game.time + 1;
        }
        if (this.super_time < this.game.time) {
          this.super_time = this.game.time + 1;
          this.dispatchEvent(playerEvent.BONUS_FLASH);
        }
      }
      if (this.super_damage_finished < this.game.time) {
        this.items &= ~items.IT_QUAD;
        this.super_damage_finished = 0;
        this.super_time = 0;
      }
      this.effects = this.super_damage_finished > this.game.time ? this.effects | effect.EF_DIMLIGHT : this.effects & ~effect.EF_DIMLIGHT;
    }

    // Suit
    if (this.radsuit_finished) {
      this.air_finished = this.game.time + 12;
      if (this.radsuit_finished < this.game.time + 3) {
        if (this.rad_time === 1) {
          this.consolePrint('Air supply in Biosuit expiring\n');
          this.dispatchEvent(playerEvent.BONUS_FLASH);
          this.startSound(channel.CHAN_AUTO, 'items/suit2.wav');
          this.rad_time = this.game.time + 1;
        }
        if (this.rad_time < this.game.time) {
          this.rad_time = this.game.time + 1;
          this.dispatchEvent(playerEvent.BONUS_FLASH);
        }
      }
      if (this.radsuit_finished < this.game.time) {
        this.items &= ~items.IT_SUIT;
        this.rad_time = 0;
        this.radsuit_finished = 0;
      }
    }
  }

  /** @protected */
  _useThink() {
    if (!this.button1) {
      return;
    }

    // CR: we can add some Half-Life like logic here (pull/push objects, use buttons etc.)
  }

  /**
   * Resets the player state.
   */
  clear() {
    super.clear();
    this.takedamage = damage.DAMAGE_AIM;
    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_WALK;
    this.show_hostile = 0;
    /** @type {number} regular hp limit */
    this.max_health = 100;
    /** @type {number} current and starting health */
    this.health = 100;
    this.flags = flags.FL_CLIENT;
    /** @type {number} time when drowning starts */
    this.air_finished = this.game.time + 12;
    /** @type {number} initial water damage */
    this.dmg = 2;
    this.super_damage_finished = 0;
    this.radsuit_finished = 0;
    this.invisible_finished = 0;
    this.invincible_finished = 0;
    this.effects = 0;
    this.invincible_time = 0;

    this.attack_finished = this.game.time;
    this.deadflag = dead.DEAD_NO;
    this.pausetime = 0; // CR: used by teleporters

    // CR: fields added by me later
    this.jump_flag = 0;

    this.punchangle.clear();
    this.velocity.clear();
    this.avelocity.clear();
    this.fixangle = true;
    this.view_ofs.setTo(0.0, 0.0, 22.0);

    this.setModel('progs/eyes.mdl');
    this._modelIndex.eyes = this.modelindex;
    this.setModel('progs/player.mdl');
    this._modelIndex.player = this.modelindex;

    this.setSize(hull[0][0], hull[0][1]);

    this.decodeLevelParms();
    this.setWeapon();
  }

  /**
   * called by PutClientInServer
   */
  putPlayerInServer() {
    const spot = this._selectSpawnPoint();
    this.origin = spot.origin.copy().add(new Vector(0.0, 0.0, 1.0));
    this.angles = spot.angles.copy();

    this.clear(); // CR: keep clear after setting origin, otherwise setModel will trigger a touch due to relinking after setting mins/maxs

    this._enterStandingState();

    if (this.game.deathmatch || this.game.coop) {
      const { forward } = this.angles.angleVectors();
      const origin = forward.multiply(20.0).add(this.origin);

      this.engine.SpawnEntity(TeleportEffectEntity.classname, { origin });
    }

    this.engine.SpawnEntity(TelefragTriggerEntity.classname, {
      origin: this.origin,
      owner: this,
    });
  }

  /**
   * only called when deadflag is DEAD_DEAD by prethink
   * @protected
   */
  _playerDeathThink() {
    if (this.flags & flags.FL_ONGROUND) {
      const forward = this.velocity.len() - 20.0;
      if (forward <= 0) {
        this.velocity.clear();
      } else {
        this.velocity.normalize();
        this.velocity.multiply(forward);
      }
    }

    // wait for all buttons released
    if (this.deadflag === dead.DEAD_DEAD) {
      if (this.button0 || this.button1 || this.button2) {
        return;
      }

      this.deadflag = dead.DEAD_RESPAWNABLE;
      return;
    }

    // wait for any button down
    if (!this.button0 && !this.button1 && !this.button2) {
      return;
    }

    // release all buttons
    this.button0 = false;
    this.button1 = false;
    this.button2 = false;

    // we keep the player dead for a while
    if (this.pausetime < this.game.time) {
      this._respawn();
    }
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
      if (this.watertype === content.CONTENT_WATER) {
        this.velocity[2] = 100;
      } else if (this.watertype === content.CONTENT_SLIME) {
        this.velocity[2] = 80;
      } else {
        this.velocity[2] = 50;
      }

      // play swiming sound
      if (this.swim_flag < this.game.time) {
        this.swim_flag = this.game.time + 1.0;
        if (Math.random() < 0.5) {
          this.startSound(channel.CHAN_BODY, 'misc/water1.wav');
        } else {
          this.startSound(channel.CHAN_BODY, 'misc/water2.wav');
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
        return; // don't pogo stick
      }

      this.flags &= ~flags.FL_JUMPRELEASED;
      this.flags &= ~flags.FL_ONGROUND;	// don't stairwalk

      this.button2 = 0;

      this.startSound(channel.CHAN_BODY, 'player/plyrjmp8.wav');
    }

    this.velocity[2] += 270.0;
  }

  /**
   * @protected
   */
  _playerWaterMove() {
    if (this.movetype === moveType.MOVETYPE_NOCLIP) {
      return;
    }

    if (this.health < 0) {
      return;
    }

    if (this.waterlevel !== 3) {
      if (this.air_finished < this.game.time) {
        this.startSound(channel.CHAN_VOICE, 'player/gasp2.wav');
      } else if (this.air_finished < this.game.time + 9.0) {
        this.startSound(channel.CHAN_VOICE, 'player/gasp1.wav');
      }
      this.air_finished = this.game.time + 12.0;
      this.dmg = 2;
    } else if (this.air_finished < this.game.time) {
      // drown!
      if (this.pain_finished < this.game.time) {
        this.dmg += 2;
        if (this.dmg > 15) {
          this.dmg = 10;
        }
        this.damage(this, this.dmg);
        BubbleSpawnerEntity.bubble(this, Math.ceil(this.dmg / 4));
        this.pain_finished = this.game.time + 1.0;
      }
    }

    if (!this.waterlevel) {
      if (this.flags & flags.FL_INWATER) {
        // play leave water sound
        this.startSound(channel.CHAN_BODY, 'misc/outwater.wav');
        this.flags &= ~flags.FL_INWATER;
      }
      return;
    }

    if (this.watertype === content.CONTENT_LAVA) {
      // do damage
      if (this._damageTime < this.game.time) {
        if (this.radsuit_finished > this.game.time) {
          this._damageTime = this.game.time + 1.0;
        } else {
          this._damageTime = this.game.time + 0.2;
        }
        this.damage(this, 10 * this.waterlevel);
      }
    } else if (this.watertype === content.CONTENT_SLIME) {
      // do damage
      if (this._damageTime < this.game.time && this.radsuit_finished < this.game.time) {
        this._damageTime = this.game.time + 1.0;
        this.damage(this, 4 * this.waterlevel);
      }
    }

    if (!(this.flags & flags.FL_INWATER)) {
      // player enter water sound
      if (this.watertype === content.CONTENT_LAVA) {
        this.startSound(channel.CHAN_BODY, 'player/inlava.wav');
      } else if (this.watertype === content.CONTENT_WATER) {
        this.startSound(channel.CHAN_BODY, 'player/inh2o.wav');
      } else if (this.watertype === content.CONTENT_SLIME) {
        this.startSound(channel.CHAN_BODY, 'player/slimbrn2.wav');
      }

      this.flags |= flags.FL_INWATER;
      this._damageTime = 0;
    }

    if (!(this.flags & flags.FL_WATERJUMP)) {
      this.velocity = this.velocity.subtract(this.velocity.copy().multiply(0.8 * this.waterlevel * this.game.frametime));
    }
  }

  /** @protected */
  _playerWaterJump() {
    if (this.waterlevel !== 2) {
      return;
    }

    // FIXME: doesn’t work on chris2.map, even in QuakeC

    const start = this.origin.copy();
    start[2] += 8.0;

    const { forward } = this.angles.angleVectors();
    forward[2] = 0.0;
    forward.normalize();
    forward.multiply(24.0);

    const end = start.copy().add(forward);

    const traceWaist = this.traceline(start, end, true);
    if (traceWaist.fraction < 1.0) { // solid at waist
      start[2] += this.maxs[2] - 8.0;
      end.set(start).add(forward);
      // this.movedir.set(traceWaist.plane.normal.multiply(-50.0)); // FIXME: CR seems to be unused?
      const traceEye = this.traceline(start, end, true);
      if (traceEye.fraction === 1.0) { // open at eye level
        this.flags |= flags.FL_WATERJUMP;
        this.velocity[2] = 225.0;
        this.flags &= ~flags.FL_JUMPRELEASED;
        this.teleport_time = this.game.time + 2.0; // safety net
      }
    }
  }

  _intermissionThink() { // QuakeC: client.qc/IntermissionThink
    if (this.game.time < this.game.intermission_exittime) {
      return;
    }

    if (!this.button0 && !this.button1 && !this.button2) {
      return;
    }

    this._intermissionExit();
  }

  /**
   * @returns {IntermissionCameraEntity|BaseEntity} intermission camera spot
   */
  _intermissionFindSpot() { // QuakeC: client.qc/FindIntermission
    const spots = Array.from(this.findAllEntitiesByFieldAndValue('classname', IntermissionCameraEntity.classname));

    // randomly choose an intermission spot
    if (spots.length > 0) {
      return spots[Math.floor(Math.random() * spots.length)];
    }

    // fallback to spawn points
    return this._selectSpawnPoint();
  }

  _intermissionExit() { // QuakeC: client.qc/ExitIntermission
    // skip any text in deathmatch
    if (this.game.deathmatch) {
      this.game.loadNextMap();
      return;
    }

    this.game.intermission_exittime = this.game.time + 1.0;
    this.game.intermission_running++;

    // TODO: run some text if at the end of an episode

    if (this.game.intermission_running === 3) {
      if (!this.game.registered) {
        // TODO: shareware mode, sell screen
      }

      if ((this.game.serverflags & 15) === 15) {
        // TODO: all runes screen
      }
    }

    this.game.loadNextMap();
  }

  startIntermission() {
    console.assert(this.game.intermission_running > 0, 'must only be called during intermission running');

    // CR: in vanilla Quake, everyone sees the same spot
    const spot = this._intermissionFindSpot();

    this.view_ofs.clear();
    this.angles.set(spot.mangle || spot.angles);
    this.v_angle.set(spot.mangle || spot.angles);
    this.fixangle = true;
    // nextthink in 500ms?
    this.takedamage = damage.DAMAGE_NO;
    this.solid = solid.SOLID_NOT;
    this.movetype = moveType.MOVETYPE_NONE;
    this.unsetModel();
    this.setOrigin(spot.origin);
  }

  /**
   * player thinking before physics,
   * this is called by the engine per client edict
   */
  playerPreThink() {
    if (this.game.intermission_running) {
      this._intermissionThink(); // otherwise a button could be missed between
      return; // the think tics
    }

    if (this.view_ofs.isOrigin()) {
      return; // intermission or finale
    }

    this.game.checkRules(this);

    // FIXME: the whole player move logic is also happening over at Pmove.js, we need to deduplicate this

    this._playerWaterMove();
    this._playerWaterJump();

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
    this._useThink();

    // do weapon stuff
    this._weaponFrame();

    // check to see if player landed and play landing sound
    if (this.jump_flag < -300 && (this.flags & flags.FL_ONGROUND) !== 0 && this.health > 0) {
      if (this.watertype === content.CONTENT_WATER) {
        this.startSound(channel.CHAN_BODY, 'player/h2ojump.wav');
      } else if (this.jump_flag < -650) {
        this.game.worldspawn.damage(this, 5.0); // CR: lol fixed 5 damage for falling
        this.startSound(channel.CHAN_VOICE, 'player/land2.wav');
        this.deathtype = deathType.FALLING;
      } else {
        this.startSound(channel.CHAN_VOICE, 'player/land.wav');
      }

      this.jump_flag = 0;
    }

    if (!(this.flags & flags.FL_ONGROUND)) {
      this.jump_flag = this.velocity[2];
    }

    // do all powerup stuff last
    this._powerupFrame();
  }

  /**
   * when dying
   * @param {BaseEntity} attackerEntity attacker entity
   */
  thinkDie(attackerEntity) {
    this._playerDie();

    // check for self-inflicted damage first
    if (attackerEntity.equals(this)) {
      if (this.waterlevel > 0) {
        switch (this.watertype) {
          case content.CONTENT_WATER:
            this.engine.BroadcastPrint(`${this.netname} identified as a fish.\n`);
            break;

          case content.CONTENT_SLIME:
            this.engine.BroadcastPrint(`${this.netname} got slimed up.\n`);
            break;

          case content.CONTENT_LAVA:
            this.engine.BroadcastPrint(`${this.netname} tried to swim in lava.\n`);
            break;

          default:
            this.engine.BroadcastPrint(`${this.netname} killed himself in some mysterious liquid.\n`);
        }
      } else {
        this.engine.BroadcastPrint(`${this.netname} killed himself.\n`);
      }

      this.frags--;

      return;
    }

    // try to figure out if there’s a player in the attacker owner chain
    const actualAttacker = (() => {
      let current = attackerEntity, attempts = 10;
      while (current && attempts-- > 0) {
        if (current instanceof PlayerEntity) {
          return current;
        }

        current = current.owner;
      }

      return attackerEntity;
    })();

    // determine the actual killer name by an easy logic
    const name = (() => {
      // let’s check if netname is holding something meaningful
      if (actualAttacker.netname) {
        return actualAttacker.netname;
      }

      // we have no clue what happened here, let’s throw out a class name instead
      return actualAttacker.classname;
    })();

    this.engine.BroadcastPrint(`${name} killed ${this.netname}.\n`); // FIXME: ClientObituary needs to be more fun again
    this.engine.BroadcastObituary(actualAttacker.edictId, this.edictId, actualAttacker.weapon || 0, actualAttacker.items || 0);

    if (actualAttacker instanceof PlayerEntity) {
      // friendly fire subtracts a frag
      actualAttacker.frags += this.team > 0 && this.game.teamplay > 0 && actualAttacker.team === this.team ? -1 : 1;
    }
  }

  /**
   * when getting attacked
   * @param {BaseEntity} attackerEntity attacker entity
   * @param {number} damage damage
   */
  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    this._enterPainState();
  }

  /**
   * called by ClientKill (e.g. “kill” command)
   */
  suicide() {
    // CR:  Vanilla Quake would call set_suicide_frame here, no clue why exactly,
    //      so we are simply inflicting damage to ourself instead and use the same damage handling avenue.
    this.damage(this, 50000);
  }

  /**
   * called by ClientConnect
   */
  connected() {
    this.engine.BroadcastPrint(`${this.netname} entered the game.\n`);

    // make sure the player gets a clean player, including no score (frags, etc.)
    this.clear();
    this.frags = 0;

    // a client connecting during an intermission can cause problems
    if (this.game.intermission_running) {
      this._intermissionExit();
    }

    this.game.sendMissingEntitiesToPlayer(this);
  }

  /**
   * called by ClientDisconnect
   */
  disconnected() {
    if (this.game.gameover) {
      return;
    }

    this._playerDie();
    this._playerDead();

    // We need to unset the model, because the engine is no longer consider this player able to think once it’s disconnect,
    // thus there’s going to be no progressing the state machine as well. In other words: with a model, there’s going to be a statue.
    this.unsetModel();

    if (this.game.deathmatch || this.game.coop) {
      this.engine.SpawnEntity(TeleportEffectEntity.classname, { origin: this.origin });
      this.engine.BroadcastPrint(`${this.netname} left the game.\n`);
    }
  }

  /** @protected */
  _respawn() { // QuakeC: client.qc/respawn
    // CR: this spawn_params is interesting to say the least
    if (this.game.coop) {
      // make a copy of the dead body for appearances sake
      CopyToBodyQue(this.game, this);

      // get the spawn parms as they were at level start
      this.game.SetSpawnParms(this);

      // respawn
      this.putPlayerInServer();
      return;
    }

    if (this.game.deathmatch) {
      // make a copy of the dead body for appearances sake
      CopyToBodyQue(this.game, this);

      // set default spawn parms
      this.game.SetNewParms();

      // respawn
      this.putPlayerInServer();
      return;
    }

    // on a singleplayer game let’s simply restart the map
    this.engine.AppendConsoleText('restart\n');
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
      if (!(this.owner instanceof PlayerEntity) && (this.owner instanceof BaseEntity)) {
        // other monsters explode themselves
        this.damage(this.owner, 50000.0);
        return;
      }
    }

    if (touchedByEntity.health > 0) {
      this.damage(touchedByEntity, 50000.0);
    }
  }

  spawn() {
    console.assert(this.owner, 'Needs an owner');

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
   * Throws around a few giblets.
   * @param {BaseEntity} entity the entity being gibbed
   * @param {?number} damage taken damage (negative)
   */
  static throwGibs(entity, damage = null) {
    // TODO: offload this to the client entity side
    const models = ['progs/gib1.mdl', 'progs/gib2.mdl', 'progs/gib3.mdl'];

    for (let i = 0, max = Math.ceil(entity.volume / 16000); i < max; i++) {
      entity.engine.SpawnEntity(GibEntity.classname, {
        origin: entity.origin.copy(),
        velocity: VelocityForDamage(damage !== null ? damage : entity.health),
        model: models[Math.floor(Math.random() * models.length)],
      });
    }
  }

  /**
   * Throws around a meat giblets.
   * @param {BaseEntity} entity the entity being gibbed
   * @param {Vector} velocity velocity of the giblet
   * @param {?Vector} origin origin of the giblet, defaults to entity.origin
   */
  static throwMeatGib(entity, velocity, origin = entity.origin) {
    entity.engine.SpawnEntity(GibEntity.classname, {
      origin: origin.copy(),
      velocity,
      model: 'progs/zom_gib.mdl', // zombie giblet
    });
  }

  /**
   * Turns entity into a head, will spawn random gibs.
   * @param {BaseEntity} entity entity to be gibbed
   * @param {string} headModel e.g. progs/h_player.mdl
   * @param {?boolean} playSound plays gibbing sounds, if true
   */
  static gibEntity(entity, headModel, playSound = true) {
    if (!entity.isActor() || entity.health > 0) {
      return;
    }

    const damagePoints = entity.health;

    entity.resetThinking();
    entity.setModel(headModel);
    entity.frame = 0;
    entity.movetype = moveType.MOVETYPE_BOUNCE;
    entity.takedamage = damage.DAMAGE_NO;
    entity.solid = solid.SOLID_NOT;
    entity.view_ofs = new Vector(0.0, 0.0, 8.0);
    entity.setSize(new Vector(-16.0, -16.0, 0.0), new Vector(16.0, 16.0, 56.0));
    entity.velocity = VelocityForDamage(damagePoints);
    entity.origin[2] -= 24.0;
    entity.flags &= ~flags.FL_ONGROUND;
    entity.avelocity = (new Vector(0.0, 600.0, 0.0)).multiply(crandom());
    entity.deadflag = dead.DEAD_DEAD;

    GibEntity.throwGibs(entity, damagePoints);

    if (playSound) {
      entity.startSound(channel.CHAN_VOICE, Math.random() < 0.5 ? 'player/gib.wav' : 'player/udeath.wav', 1.0, attn.ATTN_NONE);
    }
  }
};
