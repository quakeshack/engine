/* global Vector */

import { attn, channel, damage, dead, moveType, solid } from "../../Defs.mjs";
import { QuakeEntityAI } from "../../helper/AI.mjs";
import { GibEntity } from "../Player.mjs";
import BaseMonster from "./BaseMonster.mjs";

export const soldierModelQC = `
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

export default class ArmySoldierMonster extends BaseMonster {
  static classname = 'monster_army';

  _precache() {
    this.engine.PrecacheModel("progs/soldier.mdl");
    this.engine.PrecacheModel("progs/h_guard.mdl");
    this.engine.PrecacheModel("progs/gib1.mdl");
    this.engine.PrecacheModel("progs/gib2.mdl");
    this.engine.PrecacheModel("progs/gib3.mdl");

    this.engine.PrecacheSound("soldier/death1.wav");
    this.engine.PrecacheSound("soldier/idle.wav");
    this.engine.PrecacheSound("soldier/pain1.wav");
    this.engine.PrecacheSound("soldier/pain2.wav");
    this.engine.PrecacheSound("soldier/sattck1.wav");
    this.engine.PrecacheSound("soldier/sight1.wav");

    this.engine.PrecacheSound("player/udeath.wav");		// gib death
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _declareFields() {
    super._declareFields();
    this._aiState = null;
  }

  _initStates() {
    this._defineState('army_stand1', 'stand1', 'army_stand2', () => this._ai.stand());
    this._defineState('army_stand2', 'stand2', 'army_stand3', () => this._ai.stand());
    this._defineState('army_stand3', 'stand3', 'army_stand4', () => this._ai.stand());
    this._defineState('army_stand4', 'stand4', 'army_stand5', () => this._ai.stand());
    this._defineState('army_stand5', 'stand5', 'army_stand6', () => this._ai.stand());
    this._defineState('army_stand6', 'stand6', 'army_stand7', () => this._ai.stand());
    this._defineState('army_stand7', 'stand7', 'army_stand8', () => this._ai.stand());
    this._defineState('army_stand8', 'stand8', 'army_stand1', () => this._ai.stand());

    this._defineState('army_walk1', 'prowl_1', 'army_walk2', () => {
      if (Math.random() < 0.2) {
        this.startSound(channel.CHAN_VOICE, 'soldier/idle.wav', 1.0, attn.ATTN_IDLE);
      }
      this._ai.walk(1);
    });
    this._defineState('army_walk2', 'prowl_2', 'army_walk3', () => this._ai.walk(1));
    this._defineState('army_walk3', 'prowl_3', 'army_walk4', () => this._ai.walk(1));
    this._defineState('army_walk4', 'prowl_4', 'army_walk5', () => this._ai.walk(1));
    this._defineState('army_walk5', 'prowl_5', 'army_walk6', () => this._ai.walk(2));
    this._defineState('army_walk6', 'prowl_6', 'army_walk7', () => this._ai.walk(3));
    this._defineState('army_walk7', 'prowl_7', 'army_walk8', () => this._ai.walk(4));
    this._defineState('army_walk8', 'prowl_8', 'army_walk9', () => this._ai.walk(4));
    this._defineState('army_walk9', 'prowl_9', 'army_walk10', () => this._ai.walk(2));
    this._defineState('army_walk10', 'prowl_10', 'army_walk11', () => this._ai.walk(2));
    this._defineState('army_walk11', 'prowl_11', 'army_walk12', () => this._ai.walk(2));
    this._defineState('army_walk12', 'prowl_12', 'army_walk13', () => this._ai.walk(1));
    this._defineState('army_walk13', 'prowl_13', 'army_walk14', () => this._ai.walk(0));
    this._defineState('army_walk14', 'prowl_14', 'army_walk15', () => this._ai.walk(1));
    this._defineState('army_walk15', 'prowl_15', 'army_walk16', () => this._ai.walk(1));
    this._defineState('army_walk16', 'prowl_16', 'army_walk17', () => this._ai.walk(1));
    this._defineState('army_walk17', 'prowl_17', 'army_walk18', () => this._ai.walk(3));
    this._defineState('army_walk18', 'prowl_18', 'army_walk19', () => this._ai.walk(3));
    this._defineState('army_walk19', 'prowl_19', 'army_walk20', () => this._ai.walk(3));
    this._defineState('army_walk20', 'prowl_20', 'army_walk21', () => this._ai.walk(3));
    this._defineState('army_walk21', 'prowl_21', 'army_walk22', () => this._ai.walk(2));
    this._defineState('army_walk22', 'prowl_22', 'army_walk23', () => this._ai.walk(1));
    this._defineState('army_walk23', 'prowl_23', 'army_walk24', () => this._ai.walk(1));
    this._defineState('army_walk24', 'prowl_24', 'army_walk1', () => this._ai.walk(1));

    this._defineState('army_run1', 'run1', 'army_run2', () => {
      if (Math.random() < 0.2) {
        this.startSound(channel.CHAN_VOICE, 'soldier/idle.wav', 1.0, attn.ATTN_IDLE);
      }
      this._ai.run(11);
    });
    this._defineState('army_run2', 'run2', 'army_run3', () => this._ai.run(15));
    this._defineState('army_run3', 'run3', 'army_run4', () => this._ai.run(10));
    this._defineState('army_run4', 'run4', 'army_run5', () => this._ai.run(10));
    this._defineState('army_run5', 'run5', 'army_run6', () => this._ai.run(8));
    this._defineState('army_run6', 'run6', 'army_run7', () => this._ai.run(15));
    this._defineState('army_run7', 'run7', 'army_run8', () => this._ai.run(10));
    this._defineState('army_run8', 'run8', 'army_run1', () => this._ai.run(8));
  }

  thinkStand() {
    if (this.edictId === 13) console.log('thinkStand');
    this._runState('army_stand1');
  }

  thinkWalk() {
    if (this.edictId === 13) console.log('thinkWalk');
    this._runState('army_walk1');
  }

  thinkRun() {
    if (this.edictId === 13) console.log('thinkRun');
    this._runState('army_run1');
  }

  thinkMissile() {
    if (this.edictId === 13) console.log('thinkMissile');
    this._runState('army_atk1');
  }

  thinkPain(attackerEntity, damage) {
    if (this.edictId === 13) console.log('thinkPain');
    // local float r;

    // if (self.pain_finished > time)
    //   return;

    // r = random();

    // if (r < 0.2)
    // {
    //   self.pain_finished = time + 0.6;
    //   army_pain1 ();
    //   sound (self, CHAN_VOICE, "soldier/pain1.wav", 1, ATTN_NORM);
    // }
    // else if (r < 0.6)
    // {
    //   self.pain_finished = time + 1.1;
    //   army_painb1 ();
    //   sound (self, CHAN_VOICE, "soldier/pain2.wav", 1, ATTN_NORM);
    // }
    // else
    // {
    //   self.pain_finished = time + 1.1;
    //   army_painc1 ();
    //   sound (self, CHAN_VOICE, "soldier/pain2.wav", 1, ATTN_NORM);
    // }
  }

  // eslint-disable-next-line no-unused-vars
  thinkDie(attackerEntity) {
    console.log('thinkDie');

    GibEntity.gibEntity(this, 'progs/h_guard.mdl', true);
    // TODO

    // this.resetThinking();
    // this.deadflag = dead.DEAD_DEAD;
    // this.solid = solid.SOLID_NOT;

    // check for gib
    if (this.health < -35.0) {
      GibEntity.gibEntity(this, 'progs/h_guard.mdl', true);
      return;
    }

// // regular death
// 	sound (self, CHAN_VOICE, "soldier/death1.wav", 1, ATTN_NORM);
// 	if (random() < 0.5)
// 		army_die1 ();
// 	else
// 		army_cdie1 ();
  }

  spawn() {
    if (this.game.deathmatch) {
      this.remove();
      return;
    }

    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_STEP;

    this.setModel("progs/soldier.mdl");
    this.setSize(new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0));
    this.health = 30;
    this.takedamage = damage.DAMAGE_AIM;

    super.spawn();
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, "soldier/sight1.wav");
  }
}
