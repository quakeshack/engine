/* global Vector */

import { damage, dead, flags, moveType, solid, vec } from "../Defs.mjs";
import BaseEntity from "./BaseEntity.mjs";
import { InfoNotNullEntity } from "./Misc.mjs";

/**
 * QUAKED info_player_start (1 0 0) (-16 -16 -24) (16 16 24)
 * The normal starting point for a level.
 */
export class InfoPlayerStart extends InfoNotNullEntity {
  classname = 'info_player_start';
};

export class PlayerEntity extends BaseEntity {
  classname = 'player';

  _declareFields() {
    this.view_ofs = new Vector();
    this.punchangle = new Vector();
    this.v_angle = new Vector();

    this.button0 = false; // fire
    this.button1 = false; // use
    this.button2 = false; // jump
  }

  _precache() {
    this.engine.PrecacheModel('progs/player.mdl');
  }

  _selectSpawnPoint() {
    // FIXME: this needs to be done properly

    return this.engine.FindByFieldAndValue('classname', 'info_player_start', this.game.lastspawn ? this.game.lastspawn.edict.num : 0).api;
  }

  putPlayerInServer() {
    const spot = this._selectSpawnPoint();

    this.health = 100;
    this.takedamage = damage.DAMAGE_AIM;
    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_WALK;
    this.show_hostile = 0;
    this.max_health = 100;
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

    // TODO: DecodeLevelParms
    // TODO: W_SetCurrentAmmo

    this.attack_finished = this.time;
    // NOTE: th_pain, th_die set by PlayerEntity

    this.deadflag = dead.DEAD_NO;
    this.pausetime = 0;

    // TODO: const spot = SelectSpawnPoint()

    this.origin = spot.origin.copy().add(new Vector(0.0, 0.0, 1.0));
    this.angles = spot.angles.copy();
    this.fixangle = true;

    // NOTE: not doing the modelindex_eyes trick
    this.setModel('progs/player.mdl');

    this.setSize(vec.VEC_HULL_MIN, vec.VEC_HULL_MAX);

    this.view_ofs = new Vector(0.0, 0.0, 22.0);

    // TODO: player_stand1, spawn fog, tdeath
  }
};
