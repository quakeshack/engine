/* global Vector */

import { attn, channel, content, damage, dead, deathType, flags, items, moveType, solid, vec } from "../Defs.mjs";
import BaseEntity, { Flag } from "./BaseEntity.mjs";
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
 * QUAKED info_player_start (1 0 0) (-16 -16 -24) (16 16 24)
 * The normal starting point for a level.
 */
export class InfoPlayerStart extends InfoNotNullEntity {
  static classname = 'info_player_start';
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

  _selectSpawnPoint() {
    // FIXME: this needs to be done properly

    return this.engine.FindByFieldAndValue('classname', 'info_player_start', this.game.lastspawn ? this.game.lastspawn.edict.num : 0).api;
  }

  /**
   * prints a centered message
   * @param {string} message
   */
  centerPrint(message) {
    this.edict.getClient().centerPrint(message);
  }

  /**
   * sends a message to the player’s console
   * @param {string} message
   */
  consolePrint(message) {
    this.edict.getClient().consolePrint(message);
  }

  decodeLevelParms() {
    if (this.game.serverflags) {
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
    this.items = this.items - (this.items &
      (items.IT_KEY1 | items.IT_KEY2 | items.IT_INVISIBILITY | items.IT_INVULNERABILITY | items.IT_SUIT | items.IT_QUAD));

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
   * @returns
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

  isOutOfAmmo() {

  }

  handleImpulseCommands() {
    // TODO

    // if (self.impulse >= 1 && self.impulse <= 8)
    //   W_ChangeWeapon ();

    // if (self.impulse == 9)
    //   CheatCommand ();
    // if (self.impulse == 10)
    //   CycleWeaponCommand ();
    // if (self.impulse == 11)
    //   ServerflagsCommand ();
    // if (self.impulse == 12)
    //   CycleWeaponReverseCommand ();

    // if (self.impulse == 255)
    //   QuadCheat ();

    // self.impulse = 0;
  }

  _weaponAttack() {

  }

  _weaponFrame() {
    if (this.game.time < this.attack_finished) {
      return;
    }

    this.handleImpulseCommands();

    // check for attack
    if (this.button0) {
      this._superDamageSound();
      this._weaponAttack();
    }
  }

  _superDamageSound() {
    if (this.super_damage_finished > this.game.time && this.super_sound < this.game.time) {
      this.super_sound = this.game.time + 1.0;
      this.startSound(channel.CHAN_BODY, "items/damage3.wav", 1, attn.ATTN_NORM);
    }
  }

  _useThink() {
    if (!this.button1) {
      return;
    }

    // we only allow every 500ms a use
    if (this.use_time >= this.game.time) {
      return;
    }

    const start = this.origin.copy().add(this.view_ofs);
    const { forward } = start.angleVectors();
    const end = start.copy().add(forward.multiply(64.0)); // FIXME: determine best distance

    const mins = new Vector(-64.0, -64.0, -64.0);
    const maxs = new Vector( 64.0,  64.0,  64.0);

    const trace = this.engine.Traceline(start, end, false, this.edict, mins, maxs);

    // FIXME: handle a proper use entity within reach
    if (trace.ent && trace.ent.num > 0) {
      /** @type {BaseEntity} */
      const entity = trace.ent.api;

      entity.use(this);
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

    // TODO: const spot = SelectSpawnPoint()

    this.origin = spot.origin.copy().add(new Vector(0.0, 0.0, 1.0));
    this.angles = spot.angles.copy();
    this.fixangle = true;

    // NOTE: not doing the modelindex_eyes trick
    this.setModel('progs/player.mdl');

    this.setSize(vec.VEC_HULL_MIN, vec.VEC_HULL_MAX);

    this.view_ofs.setTo(0.0, 0.0, 22.0);

    // TODO: player_stand1, spawn fog, tdeath
  }

  /**
   * only called when deadflag is DEAD_DEAD by prethink
   */
  _playerDeathThink() {
    // TODO
  }

  /**
   * handles jump pressed down
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
          this.startSound(this, channel.CHAN_BODY, "misc/water1.wav", 1.0, attn.ATTN_NORM);
        } else {
          this.startSound(this, channel.CHAN_BODY, "misc/water2.wav", 1.0, attn.ATTN_NORM);
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

      this.startSound(channel.CHAN_BODY, "player/plyrjmp8.wav", 1.0, attn.ATTN_NORM);
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
      this.centerPrint('this.waterlevel === 2');
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
    this._useThink();

    // do weapon stuff
    this._weaponFrame();

    // check to see if player landed and play landing sound
    if (this.jump_flag < -300 && (this.flags & flags.FL_ONGROUND) !== 0 && this.health > 0) {
      if (this.watertype === content.CONTENT_WATER) {
        this.startSound(channel.CHAN_BODY, "player/h2ojump.wav", 1.0, attn.ATTN_NORM);
      } else if (this.jump_flag < -650) {
        // TODO: T_Damage (self, world, world, 5);
        this.startSound(channel.CHAN_VOICE, "player/land2.wav", 1.0, attn.ATTN_NORM);
        this.deathtype = deathType.FALLING;
      } else {
        this.startSound(channel.CHAN_VOICE, "player/land.wav", 1.0, attn.ATTN_NORM);
      }

      this.jump_flag = 0;
    }

    if (!(this.flags & flags.FL_ONGROUND)) {
      this.jump_flag = this.velocity[2];
    }

    // TODO: CheckPowerups()
  }
};
