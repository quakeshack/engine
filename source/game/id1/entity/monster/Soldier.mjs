/* global Vector */

import { attn, channel, flags, solid } from "../../Defs.mjs";
import { QuakeEntityAI } from "../../helper/AI.mjs";
import { DamageInflictor } from "../Weapons.mjs";
import { WalkMonster } from "./BaseMonster.mjs";

export const qc = `
$cd id1/models/soldier3
$origin 0 -6 24
$base base
$skin skin

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8

$frame death1 death2 death3 death4 death5 death6 death7 death8
$frame death9 death10

$frame deathc1 deathc2 deathc3 deathc4 deathc5 deathc6 deathc7 deathc8
$frame deathc9 deathc10 deathc11

$frame load1 load2 load3 load4 load5 load6 load7 load8 load9 load10 load11

$frame pain1 pain2 pain3 pain4 pain5 pain6

$frame painb1 painb2 painb3 painb4 painb5 painb6 painb7 painb8 painb9 painb10
$frame painb11 painb12 painb13 painb14

$frame painc1 painc2 painc3 painc4 painc5 painc6 painc7 painc8 painc9 painc10
$frame painc11 painc12 painc13

$frame run1 run2 run3 run4 run5 run6 run7 run8

$frame shoot1 shoot2 shoot3 shoot4 shoot5 shoot6 shoot7 shoot8 shoot9

$frame prowl_1 prowl_2 prowl_3 prowl_4 prowl_5 prowl_6 prowl_7 prowl_8
$frame prowl_9 prowl_10 prowl_11 prowl_12 prowl_13 prowl_14 prowl_15 prowl_16
$frame prowl_17 prowl_18 prowl_19 prowl_20 prowl_21 prowl_22 prowl_23 prowl_24
`;

/**
 * QUAKED monster_army (1 0 0) (-16 -16 -24) (16 16 40) Ambush
 */
export default class ArmySoldierMonster extends WalkMonster {
  static classname = 'monster_army';

  static _health = 30;
  static _size = [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0)];

  static _modelDefault = 'progs/soldier.mdl';
  static _modelHead = 'progs/h_guard.mdl';

  get netname() {
    return 'an army soldier';
  }

  _precache() {
    super._precache();

    this.engine.PrecacheSound("soldier/death1.wav");
    this.engine.PrecacheSound("soldier/idle.wav");
    this.engine.PrecacheSound("soldier/pain1.wav");
    this.engine.PrecacheSound("soldier/pain2.wav");
    this.engine.PrecacheSound("soldier/sattck1.wav");
    this.engine.PrecacheSound("soldier/sight1.wav");
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this._aiState = null;
    this._damageInflictor = new DamageInflictor(this);

    this._serializer.endFields();
  }

  _initStates() {
    this._defineState('army_stand1', 'stand1', 'army_stand2', function () { this._ai.stand(); });
    this._defineState('army_stand2', 'stand2', 'army_stand3', function () { this._ai.stand(); });
    this._defineState('army_stand3', 'stand3', 'army_stand4', function () { this._ai.stand(); });
    this._defineState('army_stand4', 'stand4', 'army_stand5', function () { this._ai.stand(); });
    this._defineState('army_stand5', 'stand5', 'army_stand6', function () { this._ai.stand(); });
    this._defineState('army_stand6', 'stand6', 'army_stand7', function () { this._ai.stand(); });
    this._defineState('army_stand7', 'stand7', 'army_stand8', function () { this._ai.stand(); });
    this._defineState('army_stand8', 'stand8', 'army_stand1', function () { this._ai.stand(); });

    this._defineState('army_walk1', 'prowl_1', 'army_walk2', function () { this.idleSound(); this._ai.walk(1); });
    this._defineState('army_walk2', 'prowl_2', 'army_walk3', function () { this._ai.walk(1); });
    this._defineState('army_walk3', 'prowl_3', 'army_walk4', function () { this._ai.walk(1); });
    this._defineState('army_walk4', 'prowl_4', 'army_walk5', function () { this._ai.walk(1); });
    this._defineState('army_walk5', 'prowl_5', 'army_walk6', function () { this._ai.walk(2); });
    this._defineState('army_walk6', 'prowl_6', 'army_walk7', function () { this._ai.walk(3); });
    this._defineState('army_walk7', 'prowl_7', 'army_walk8', function () { this._ai.walk(4); });
    this._defineState('army_walk8', 'prowl_8', 'army_walk9', function () { this._ai.walk(4); });
    this._defineState('army_walk9', 'prowl_9', 'army_walk10', function () { this._ai.walk(2); });
    this._defineState('army_walk10', 'prowl_10', 'army_walk11', function () { this._ai.walk(2); });
    this._defineState('army_walk11', 'prowl_11', 'army_walk12', function () { this._ai.walk(2); });
    this._defineState('army_walk12', 'prowl_12', 'army_walk13', function () { this._ai.walk(1); });
    this._defineState('army_walk13', 'prowl_13', 'army_walk14', function () { this._ai.walk(0); });
    this._defineState('army_walk14', 'prowl_14', 'army_walk15', function () { this._ai.walk(1); });
    this._defineState('army_walk15', 'prowl_15', 'army_walk16', function () { this._ai.walk(1); });
    this._defineState('army_walk16', 'prowl_16', 'army_walk17', function () { this._ai.walk(1); });
    this._defineState('army_walk17', 'prowl_17', 'army_walk18', function () { this._ai.walk(3); });
    this._defineState('army_walk18', 'prowl_18', 'army_walk19', function () { this._ai.walk(3); });
    this._defineState('army_walk19', 'prowl_19', 'army_walk20', function () { this._ai.walk(3); });
    this._defineState('army_walk20', 'prowl_20', 'army_walk21', function () { this._ai.walk(3); });
    this._defineState('army_walk21', 'prowl_21', 'army_walk22', function () { this._ai.walk(2); });
    this._defineState('army_walk22', 'prowl_22', 'army_walk23', function () { this._ai.walk(1); });
    this._defineState('army_walk23', 'prowl_23', 'army_walk24', function () { this._ai.walk(1); });
    this._defineState('army_walk24', 'prowl_24', 'army_walk1', function () { this._ai.walk(1); });

    this._defineState('army_run1', 'run1', 'army_run2', function () { this.idleSound(); this._ai.run(11); });
    this._defineState('army_run2', 'run2', 'army_run3', function () { this._ai.run(15); });
    this._defineState('army_run3', 'run3', 'army_run4', function () { this._ai.run(10); });
    this._defineState('army_run4', 'run4', 'army_run5', function () { this._ai.run(10); });
    this._defineState('army_run5', 'run5', 'army_run6', function () { this._ai.run(8); });
    this._defineState('army_run6', 'run6', 'army_run7', function () { this._ai.run(15); });
    this._defineState('army_run7', 'run7', 'army_run8', function () { this._ai.run(10); });
    this._defineState('army_run8', 'run8', 'army_run1', function () { this._ai.run(8); });

    this._defineState('army_atk1', 'shoot1', 'army_atk2', function () { this._ai.face(); });
    this._defineState('army_atk2', 'shoot2', 'army_atk3', function () { this._ai.face(); });
    this._defineState('army_atk3', 'shoot3', 'army_atk4', function () { this._ai.face(); });
    this._defineState('army_atk4', 'shoot4', 'army_atk5', function () { this._ai.face(); this._fire(); this.effects |= flags.EF_MUZZLEFLASH; });
    this._defineState('army_atk5', 'shoot5', 'army_atk6', function () { this._ai.face(); });
    this._defineState('army_atk6', 'shoot6', 'army_atk7', function () { this._ai.face(); });
    this._defineState('army_atk7', 'shoot7', 'army_atk8', function () { this._ai.face(); });
    this._defineState('army_atk8', 'shoot8', 'army_atk9', function () { this._ai.face(); });
    this._defineState('army_atk9', 'shoot9', 'army_run1', function () { this._ai.face(); });

    this._defineState('army_pain1', 'pain1', 'army_pain2', function () {});
    this._defineState('army_pain2', 'pain2', 'army_pain3', function () {});
    this._defineState('army_pain3', 'pain3', 'army_pain4', function () {});
    this._defineState('army_pain4', 'pain4', 'army_pain5', function () {});
    this._defineState('army_pain5', 'pain5', 'army_pain6', function () {});
    this._defineState('army_pain6', 'pain6', 'army_run1', function () { this._ai.pain(1); });

    this._defineState('army_painb1', 'painb1', 'army_painb2', function () {});
    this._defineState('army_painb2', 'painb2', 'army_painb3', function () { this._ai.painforward(13); });
    this._defineState('army_painb3', 'painb3', 'army_painb4', function () { this._ai.painforward(9); });
    this._defineState('army_painb4', 'painb4', 'army_painb5', function () {});
    this._defineState('army_painb5', 'painb5', 'army_painb6', function () {});
    this._defineState('army_painb6', 'painb6', 'army_painb7', function () {});
    this._defineState('army_painb7', 'painb7', 'army_painb8', function () { this._ai.pain(4); });
    this._defineState('army_painb8', 'painb8', 'army_painb9', function () {});
    this._defineState('army_painb9', 'painb9', 'army_painb10', function () { this._ai.pain(10); });
    this._defineState('army_painb10','painb10','army_painb11',function () {});
    this._defineState('army_painb11','painb11','army_painb12',function () {});
    this._defineState('army_painb12','painb12','army_painb13',function () { this._ai.pain(2); });
    this._defineState('army_painb13','painb13','army_painb14',function () {});
    this._defineState('army_painb14','painb14','army_run1', function () {});

    this._defineState('army_painc1', 'painc1', 'army_painc2', function () {});
    this._defineState('army_painc2', 'painc2', 'army_painc3', function () { this._ai.pain(1); });
    this._defineState('army_painc3', 'painc3', 'army_painc4', function () { this._ai.painforward(1); });
    this._defineState('army_painc4', 'painc4', 'army_painc5', function () { this._ai.painforward(1); });
    this._defineState('army_painc5', 'painc5', 'army_painc6', function () {});
    this._defineState('army_painc6', 'painc6', 'army_painc7', function () { this._ai.pain(1); });
    this._defineState('army_painc7', 'painc7', 'army_painc8', function () { this._ai.painforward(4); });
    this._defineState('army_painc8', 'painc8', 'army_painc9', function () { this._ai.painforward(3); });
    this._defineState('army_painc9', 'painc9', 'army_painc10',function () { this._ai.painforward(6); });
    this._defineState('army_painc10','painc10','army_painc11',function () { this._ai.painforward(8); });
    this._defineState('army_painc11','painc11','army_painc12',function () {});
    this._defineState('army_painc12','painc12','army_painc13',function () {});
    this._defineState('army_painc13','painc13','army_run1',function () {});

    this._defineState('army_die1','death1','army_die2',function () {});
    this._defineState('army_die2','death2','army_die3',function () {});
    this._defineState('army_die3','death3','army_die4',function () { this.solid = solid.SOLID_NOT; this._dropBackpack(); });
    this._defineState('army_die4','death4','army_die5',function () {});
    this._defineState('army_die5','death5','army_die6',function () {});
    this._defineState('army_die6','death6','army_die7',function () {});
    this._defineState('army_die7','death7','army_die8',function () {});
    this._defineState('army_die8','death8','army_die9',function () {});
    this._defineState('army_die9','death9','army_die10',function () {});
    this._defineState('army_die10','death10','army_die10',function () {});

    this._defineState('army_cdie1','deathc1','army_cdie2',function () {});
    this._defineState('army_cdie2','deathc2','army_cdie3',function () { this._ai.back(5); });
    this._defineState('army_cdie3','deathc3','army_cdie4',function () { this.solid = solid.SOLID_NOT; this._dropBackpack(); this._ai.back(4); });
    this._defineState('army_cdie4','deathc4','army_cdie5',function () { this._ai.back(13); });
    this._defineState('army_cdie5','deathc5','army_cdie6',function () { this._ai.back(3); });
    this._defineState('army_cdie6','deathc6','army_cdie7',function () { this._ai.back(4); });
    this._defineState('army_cdie7','deathc7','army_cdie8',function () {});
    this._defineState('army_cdie8','deathc8','army_cdie9',function () {});
    this._defineState('army_cdie9','deathc9','army_cdie10',function () {});
    this._defineState('army_cdie10','deathc10','army_cdie11',function () {});
    this._defineState('army_cdie11','deathc11','army_cdie11',function () {});
  }

  thinkStand() {
    this._runState('army_stand1');
  }

  thinkWalk() {
    this._runState('army_walk1');
  }

  thinkRun() {
    this._runState('army_run1');
  }

  thinkMissile() {
    this._runState('army_atk1');
  }

  thinkPain() {
    if (this.pain_finished > this.game.time) {
      return;
    }

    const r = Math.random();
    if (r < 0.2) {
      this.pain_finished = this.game.time + 0.6;
      this._runState('army_pain1');
    } else if (r < 0.6) {
      this.pain_finished = this.game.time + 1.1;
      this._runState('army_painb1');
    } else {
      this.pain_finished = this.game.time + 1.1;
      this._runState('army_painc1');
    }

    this.painSound();
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -35) {
      this._gib(true);
      return;
    }
    this.deathSound();
    this.solid = solid.SOLID_NOT;
    if (Math.random() < 0.5) {
      this._runState('army_die1');
    } else {
      this._runState('army_cdie1');
    }
  }

  _fire() { // QuakeC: soldier.qc/army_fire
    this._ai.face();
    this.attackSound();

    if (!this.enemy) {
      return;
    }

    const direction = this.enemy.origin.copy().subtract(this.enemy.velocity.copy().multiply(0.2)).subtract(this.origin);
    direction.normalize();

    this._damageInflictor.fireBullets(4, direction, new Vector(0.1, 0.1, 0));
  }

  _dropBackpack() {
    super._dropBackpack({ ammo_shells: 5 });
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'soldier/death1.wav');
  }

  painSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, "soldier/pain1.wav");
    } else {
      this.startSound(channel.CHAN_VOICE, "soldier/pain2.wav");
    }
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, "soldier/sight1.wav");
  }

  idleSound() {
    if (Math.random() >= 0.2) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, 'soldier/idle.wav', 1.0, attn.ATTN_IDLE);
  }

  attackSound() {
    this.startSound(channel.CHAN_WEAPON, 'soldier/sattck1.wav');
  }

  hasMissileAttack() {
    return true;
  }
};
