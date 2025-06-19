/* global Vector */

import { channel, solid } from "../../Defs.mjs";
import { QuakeEntityAI } from "../../helper/AI.mjs";
import { WalkMonster } from "./BaseMonster.mjs";

export const qc = {
  knight:`
$cd id1/models/knight
$origin 0 0 24
$base base
$skin badass3

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9

$frame runb1 runb2 runb3 runb4 runb5 runb6 runb7 runb8

//frame runc1 runc2 runc3 runc4 runc5 runc6

$frame runattack1 runattack2 runattack3 runattack4 runattack5
$frame runattack6 runattack7 runattack8 runattack9 runattack10
$frame runattack11

$frame pain1 pain2 pain3

$frame painb1 painb2 painb3 painb4 painb5 painb6 painb7 painb8 painb9
$frame painb10 painb11

//frame attack1 attack2 attack3 attack4 attack5 attack6 attack7
//frame attack8 attack9 attack10 attack11

$frame attackb1 attackb1 attackb2 attackb3 attackb4 attackb5
$frame attackb6 attackb7 attackb8 attackb9 attackb10

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8 walk9
$frame walk10 walk11 walk12 walk13 walk14

$frame kneel1 kneel2 kneel3 kneel4 kneel5

$frame standing2 standing3 standing4 standing5

$frame death1 death2 death3 death4 death5 death6 death7 death8
$frame death9 death10

$frame deathb1 deathb2 deathb3 deathb4 deathb5 deathb6 deathb7 deathb8
$frame deathb9 deathb10 deathb11
`,
  hellKnight: `
$cd id1/models/knight2
$origin 0 0 24
$base base
$skin skin

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8 walk9
$frame walk10 walk11 walk12 walk13 walk14 walk15 walk16 walk17
$frame walk18 walk19 walk20

$frame run1 run2 run3 run4 run5 run6 run7 run8

$frame pain1 pain2 pain3 pain4 pain5

$frame death1 death2 death3 death4 death5 death6 death7 death8
$frame death9 death10 death11 death12

$frame deathb1 deathb2 deathb3 deathb4 deathb5 deathb6 deathb7 deathb8
$frame deathb9

$frame char_a1 char_a2 char_a3 char_a4 char_a5 char_a6 char_a7 char_a8
$frame char_a9 char_a10 char_a11 char_a12 char_a13 char_a14 char_a15 char_a16

$frame magica1 magica2 magica3 magica4 magica5 magica6 magica7 magica8
$frame magica9 magica10 magica11 magica12 magica13 magica14

$frame magicb1 magicb2 magicb3 magicb4 magicb5 magicb6 magicb7 magicb8
$frame magicb9 magicb10 magicb11 magicb12 magicb13

$frame char_b1 char_b2 char_b3 char_b4 char_b5 char_b6

$frame slice1 slice2 slice3 slice4 slice5 slice6 slice7 slice8 slice9 slice10

$frame smash1 smash2 smash3 smash4 smash5 smash6 smash7 smash8 smash9 smash10
$frame smash11

$frame w_attack1 w_attack2 w_attack3 w_attack4 w_attack5 w_attack6 w_attack7
$frame w_attack8 w_attack9 w_attack10 w_attack11 w_attack12 w_attack13 w_attack14
$frame w_attack15 w_attack16 w_attack17 w_attack18 w_attack19 w_attack20
$frame w_attack21 w_attack22

$frame magicc1 magicc2 magicc3 magicc4 magicc5 magicc6 magicc7 magicc8
$frame magicc9 magicc10 magicc11
`
};

/**
 * QUAKED monster_knight (1 0 0) (-16 -16 -24) (16 16 40) Ambush
 */
export class KnightMonster extends WalkMonster {
  static classname = 'monster_knight';

  static _health = 75;
  static _size = [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0)];

  static _modelDefault = 'progs/knight.mdl';
  static _modelHead = 'progs/h_knight.mdl';

  get netname() {
    return 'a knight';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _precache() {
    super._precache();
    this.engine.PrecacheSound("knight/kdeath.wav");
    this.engine.PrecacheSound("knight/khurt.wav");
    this.engine.PrecacheSound("knight/ksight.wav");
    this.engine.PrecacheSound("knight/sword1.wav");
    this.engine.PrecacheSound("knight/sword2.wav");
    this.engine.PrecacheSound("knight/idle.wav");
  }

  _initStates() {
    // Standing states
    this._defineState('knight_stand1', 'stand1', 'knight_stand2', function () { this._ai.stand(); });
    this._defineState('knight_stand2', 'stand2', 'knight_stand3', function () { this._ai.stand(); });
    this._defineState('knight_stand3', 'stand3', 'knight_stand4', function () { this._ai.stand(); });
    this._defineState('knight_stand4', 'stand4', 'knight_stand5', function () { this._ai.stand(); });
    this._defineState('knight_stand5', 'stand5', 'knight_stand6', function () { this._ai.stand(); });
    this._defineState('knight_stand6', 'stand6', 'knight_stand7', function () { this._ai.stand(); });
    this._defineState('knight_stand7', 'stand7', 'knight_stand8', function () { this._ai.stand(); });
    this._defineState('knight_stand8', 'stand8', 'knight_stand9', function () { this._ai.stand(); });
    this._defineState('knight_stand9', 'stand9', 'knight_stand1', function () { this._ai.stand(); });

    // Walking states
    this._defineState('knight_walk1', 'walk1', 'knight_walk2', function () { this.idleSound(); this._ai.walk(3); });
    this._defineState('knight_walk2', 'walk2', 'knight_walk3', function () { this._ai.walk(2); });
    this._defineState('knight_walk3', 'walk3', 'knight_walk4', function () { this._ai.walk(3); });
    this._defineState('knight_walk4', 'walk4', 'knight_walk5', function () { this._ai.walk(4); });
    this._defineState('knight_walk5', 'walk5', 'knight_walk6', function () { this._ai.walk(3); });
    this._defineState('knight_walk6', 'walk6', 'knight_walk7', function () { this._ai.walk(3); });
    this._defineState('knight_walk7', 'walk7', 'knight_walk8', function () { this._ai.walk(3); });
    this._defineState('knight_walk8', 'walk8', 'knight_walk9', function () { this._ai.walk(4); });
    this._defineState('knight_walk9', 'walk9', 'knight_walk10', function () { this._ai.walk(3); });
    this._defineState('knight_walk10', 'walk10', 'knight_walk11', function () { this._ai.walk(3); });
    this._defineState('knight_walk11', 'walk11', 'knight_walk12', function () { this._ai.walk(2); });
    this._defineState('knight_walk12', 'walk12', 'knight_walk13', function () { this._ai.walk(3); });
    this._defineState('knight_walk13', 'walk13', 'knight_walk14', function () { this._ai.walk(4); });
    this._defineState('knight_walk14', 'walk14', 'knight_walk1', function () { this._ai.walk(3); });

    // Running states
    this._defineState('knight_run1', 'runb1', 'knight_run2', function () { this.idleSound(); this._ai.run(16); });
    this._defineState('knight_run2', 'runb2', 'knight_run3', function () { this._ai.run(20); });
    this._defineState('knight_run3', 'runb3', 'knight_run4', function () { this._ai.run(13); });
    this._defineState('knight_run4', 'runb4', 'knight_run5', function () { this._ai.run(7); });
    this._defineState('knight_run5', 'runb5', 'knight_run6', function () { this._ai.run(16); });
    this._defineState('knight_run6', 'runb6', 'knight_run7', function () { this._ai.run(20); });
    this._defineState('knight_run7', 'runb7', 'knight_run8', function () { this._ai.run(14); });
    this._defineState('knight_run8', 'runb8', 'knight_run1', function () { this._ai.run(6); });

    // Run attack states
    this._defineState('knight_runatk1', 'runattack1', 'knight_runatk2', function () { this. attackSound(); this._ai.charge(20); });
    this._defineState('knight_runatk2', 'runattack2', 'knight_runatk3', function () { this._ai.chargeSide(); });
    this._defineState('knight_runatk3', 'runattack3', 'knight_runatk4', function () { this._ai.chargeSide(); });
    this._defineState('knight_runatk4', 'runattack4', 'knight_runatk5', function () { this._ai.chargeSide(); });
    this._defineState('knight_runatk5', 'runattack5', 'knight_runatk6', function () { this._ai.meleeSide(); });
    this._defineState('knight_runatk6', 'runattack6', 'knight_runatk7', function () { this._ai.meleeSide(); });
    this._defineState('knight_runatk7', 'runattack7', 'knight_runatk8', function () { this._ai.meleeSide(); });
    this._defineState('knight_runatk8', 'runattack8', 'knight_runatk9', function () { this._ai.meleeSide(); });
    this._defineState('knight_runatk9', 'runattack9', 'knight_runatk10', function () { this._ai.meleeSide(); });
    this._defineState('knight_runatk10', 'runattack10', 'knight_runatk11', function () { this._ai.chargeSide(); });
    this._defineState('knight_runatk11', 'runattack11', 'knight_run1', function () { this._ai.charge(10); });

    // Melee attack states
    this._defineState('knight_atk1', 'attackb1', 'knight_atk2', function () { this.attackSound(); this._ai.charge(0); });
    this._defineState('knight_atk2', 'attackb2', 'knight_atk3', function () { this._ai.charge(7); });
    this._defineState('knight_atk3', 'attackb3', 'knight_atk4', function () { this._ai.charge(4); });
    this._defineState('knight_atk4', 'attackb4', 'knight_atk5', function () { this._ai.charge(0); });
    this._defineState('knight_atk5', 'attackb5', 'knight_atk6', function () { this._ai.charge(3); });
    this._defineState('knight_atk6', 'attackb6', 'knight_atk7', function () { this._ai.charge(4); this._ai.melee(); });
    this._defineState('knight_atk7', 'attackb7', 'knight_atk8', function () { this._ai.charge(1); this._ai.melee(); });
    this._defineState('knight_atk8', 'attackb8', 'knight_atk9', function () { this._ai.charge(3); this._ai.melee(); });
    this._defineState('knight_atk9', 'attackb9', 'knight_atk10', function () { this._ai.charge(1); });
    this._defineState('knight_atk10', 'attackb10', 'knight_run1', function () { this._ai.charge(5); });

    // Pain states
    this._defineState('knight_pain1', 'pain1', 'knight_pain2', function () { this.painSound(); });
    this._defineState('knight_pain2', 'pain2', 'knight_pain3', function () { });
    this._defineState('knight_pain3', 'pain3', 'knight_run1', function () { });

    this._defineState('knight_painb1', 'painb1', 'knight_painb2', function () { this._ai.painforward(0); });
    this._defineState('knight_painb2', 'painb2', 'knight_painb3', function () { this._ai.painforward(3); });
    this._defineState('knight_painb3', 'painb3', 'knight_painb4', function () { });
    this._defineState('knight_painb4', 'painb4', 'knight_painb5', function () { });
    this._defineState('knight_painb5', 'painb5', 'knight_painb6', function () { this._ai.painforward(2); });
    this._defineState('knight_painb6', 'painb6', 'knight_painb7', function () { this._ai.painforward(4); });
    this._defineState('knight_painb7', 'painb7', 'knight_painb8', function () { this._ai.painforward(2); });
    this._defineState('knight_painb8', 'painb8', 'knight_painb9', function () { this._ai.painforward(5); });
    this._defineState('knight_painb9', 'painb9', 'knight_painb10', function () { this._ai.painforward(5); });
    this._defineState('knight_painb10', 'painb10', 'knight_painb11', function () { this._ai.painforward(0); });
    this._defineState('knight_painb11', 'painb11', 'knight_run1', function () { });

    // Bow/kneel states
    this._defineState('knight_bow1', 'kneel1', 'knight_bow2', function () { this._ai.turn(); });
    this._defineState('knight_bow2', 'kneel2', 'knight_bow3', function () { this._ai.turn(); });
    this._defineState('knight_bow3', 'kneel3', 'knight_bow4', function () { this._ai.turn(); });
    this._defineState('knight_bow4', 'kneel4', 'knight_bow5', function () { this._ai.turn(); });
    this._defineState('knight_bow5', 'kneel5', 'knight_bow5', function () { this._ai.turn(); });
    this._defineState('knight_bow6', 'kneel4', 'knight_bow7', function () { this._ai.turn(); });
    this._defineState('knight_bow7', 'kneel3', 'knight_bow8', function () { this._ai.turn(); });
    this._defineState('knight_bow8', 'kneel2', 'knight_bow9', function () { this._ai.turn(); });
    this._defineState('knight_bow9', 'kneel1', 'knight_bow10', function () { this._ai.turn(); });
    this._defineState('knight_bow10', 'walk1', 'knight_walk1', function () { this._ai.turn(); });

    // Death states
    this._defineState('knight_die1', 'death1', 'knight_die2', function () { });
    this._defineState('knight_die2', 'death2', 'knight_die3', function () { });
    this._defineState('knight_die3', 'death3', 'knight_die4', function () { this.solid = solid.SOLID_NOT; });
    this._defineState('knight_die4', 'death4', 'knight_die5', function () { });
    this._defineState('knight_die5', 'death5', 'knight_die6', function () { });
    this._defineState('knight_die6', 'death6', 'knight_die7', function () { });
    this._defineState('knight_die7', 'death7', 'knight_die8', function () { });
    this._defineState('knight_die8', 'death8', 'knight_die9', function () { });
    this._defineState('knight_die9', 'death9', 'knight_die10', function () { });
    this._defineState('knight_die10', 'death10', 'knight_die10', function () { });

    this._defineState('knight_dieb1', 'deathb1', 'knight_dieb2', function () { });
    this._defineState('knight_dieb2', 'deathb2', 'knight_dieb3', function () { });
    this._defineState('knight_dieb3', 'deathb3', 'knight_dieb4', function () { this.solid = solid.SOLID_NOT; });
    this._defineState('knight_dieb4', 'deathb4', 'knight_dieb5', function () { });
    this._defineState('knight_dieb5', 'deathb5', 'knight_dieb6', function () { });
    this._defineState('knight_dieb6', 'deathb6', 'knight_dieb7', function () { });
    this._defineState('knight_dieb7', 'deathb7', 'knight_dieb8', function () { });
    this._defineState('knight_dieb8', 'deathb8', 'knight_dieb9', function () { });
    this._defineState('knight_dieb9', 'deathb9', 'knight_dieb10', function () { });
    this._defineState('knight_dieb10', 'deathb10', 'knight_dieb11', function () { });
    this._defineState('knight_dieb11', 'deathb11', 'knight_dieb11', function () { });
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, "knight/idle.wav");
    }
  }

  attackSound() {
    if (Math.random() > 0.5) {
      this.startSound(channel.CHAN_WEAPON, "knight/sword2.wav");
    } else {
      this.startSound(channel.CHAN_WEAPON, "knight/sword1.wav");
    }
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, "knight/khurt.wav");
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, "knight/ksight.wav");
  }

  thinkStand() {
    this._runState('knight_stand1');
  }

  thinkWalk() {
    this._runState('knight_walk1');
  }

  thinkRun() {
    this._runState('knight_run1');
  }

  thinkMelee() {
    if (this.enemy !== null) {
      const dist = this.enemy.origin.copy().add(this.enemy.view_ofs).subtract(this.origin.copy().add(this.view_ofs)).len();

      if (dist < 80) {
        this._runState('knight_atk1');
        return;
      } else {
        this._runState('knight_runatk1');
        return;
      }
    }

    this._runState('knight_atk1');
  }

  thinkPain() {
    if (this.pain_finished > this.game.time) {
      return;
    }
    // Use knight_pain1 as default, or alternate with knight_painb1 if you want variety
    this._runState('knight_pain1');
    this.pain_finished = this.game.time + 1;
    this.painSound();
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -40) {
      // this.deathSound();
      this.startSound(channel.CHAN_VOICE, "player/udeath.wav");
      this._gib(true);
      return;
    }
    this.deathSound();
    this.solid = solid.SOLID_NOT;
    if (Math.random() < 0.5) {
      this._runState('knight_die1');
    } else {
      this._runState('knight_dieb1');
    }
  }

  hasMeleeAttack() {
    return true;
  }
};

/**
 * QUAKED monster_hell_knight (1 0 0) (-16 -16 -24) (16 16 40) Ambush
 */
export class HellKnightMonster extends KnightMonster {
  static classname = 'monster_hell_knight';

  static _health = 250;

  static _modelDefault = 'progs/hknight.mdl';
  static _modelHead = 'progs/h_hellkn.mdl';

  get netname() {
    return 'a hell knight';
  }

};
