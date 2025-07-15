import Vector from '../../../../shared/Vector.mjs';

import { channel, solid, tentType } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import { BaseSpike } from '../Weapons.mjs';
import { WalkMonster } from './BaseMonster.mjs';

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
`,
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
    return 'a Knight';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _precache() {
    super._precache();
    this.engine.PrecacheSound('knight/kdeath.wav');
    this.engine.PrecacheSound('knight/khurt.wav');
    this.engine.PrecacheSound('knight/ksight.wav');
    this.engine.PrecacheSound('knight/sword1.wav');
    this.engine.PrecacheSound('knight/sword2.wav');
    this.engine.PrecacheSound('knight/idle.wav');
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
      this.startSound(channel.CHAN_VOICE, 'knight/idle.wav');
    }
  }

  attackSound() {
    if (Math.random() > 0.5) {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword2.wav');
    } else {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword1.wav');
    }
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'knight/khurt.wav');
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'knight/ksight.wav');
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

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    if (Math.random() < 0.85) {
      this._runState('knight_pain1');
      return;
    } else {
      this._runState('knight_painb1');
    }

    this.pain_finished = this.game.time + 1;
    this.painSound();
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -40) {
      this.startSound(channel.CHAN_VOICE, 'player/udeath.wav');
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

export class KnightSpike extends BaseSpike {
  static classname = 'knightspike';

  static _damage = 9;
  static _tentType = tentType.TE_SPIKE;
  static _model = 'progs/k_spike.mdl';
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
    return 'a Death Knight';
  }

  _precache() {
    super._precache();

    this.engine.PrecacheModel('progs/k_spike.mdl');
    this.engine.PrecacheSound('hknight/attack1.wav');
    this.engine.PrecacheSound('hknight/death1.wav');
    this.engine.PrecacheSound('hknight/pain1.wav');
    this.engine.PrecacheSound('hknight/sight1.wav');
    this.engine.PrecacheSound('hknight/hit.wav');
    this.engine.PrecacheSound('hknight/slash1.wav');
    this.engine.PrecacheSound('hknight/idle.wav');
    this.engine.PrecacheSound('hknight/grunt.wav');
    this.engine.PrecacheSound('knight/sword1.wav');
    this.engine.PrecacheSound('knight/sword2.wav');
  }

  _initStates() {
    // Standing states
    this._defineState('hknight_stand1', 'stand1', 'hknight_stand2', function () { this._ai.stand(); });
    this._defineState('hknight_stand2', 'stand2', 'hknight_stand3', function () { this._ai.stand(); });
    this._defineState('hknight_stand3', 'stand3', 'hknight_stand4', function () { this._ai.stand(); });
    this._defineState('hknight_stand4', 'stand4', 'hknight_stand5', function () { this._ai.stand(); });
    this._defineState('hknight_stand5', 'stand5', 'hknight_stand6', function () { this._ai.stand(); });
    this._defineState('hknight_stand6', 'stand6', 'hknight_stand7', function () { this._ai.stand(); });
    this._defineState('hknight_stand7', 'stand7', 'hknight_stand8', function () { this._ai.stand(); });
    this._defineState('hknight_stand8', 'stand8', 'hknight_stand9', function () { this._ai.stand(); });
    this._defineState('hknight_stand9', 'stand9', 'hknight_stand1', function () { this._ai.stand(); });

    // Walking states
    this._defineState('hknight_walk1', 'walk1', 'hknight_walk2', function () { this.idleSound(); this._ai.walk(2); });
    this._defineState('hknight_walk2', 'walk2', 'hknight_walk3', function () { this._ai.walk(5); });
    this._defineState('hknight_walk3', 'walk3', 'hknight_walk4', function () { this._ai.walk(5); });
    this._defineState('hknight_walk4', 'walk4', 'hknight_walk5', function () { this._ai.walk(4); });
    this._defineState('hknight_walk5', 'walk5', 'hknight_walk6', function () { this._ai.walk(4); });
    this._defineState('hknight_walk6', 'walk6', 'hknight_walk7', function () { this._ai.walk(2); });
    this._defineState('hknight_walk7', 'walk7', 'hknight_walk8', function () { this._ai.walk(2); });
    this._defineState('hknight_walk8', 'walk8', 'hknight_walk9', function () { this._ai.walk(3); });
    this._defineState('hknight_walk9', 'walk9', 'hknight_walk10', function () { this._ai.walk(3); });
    this._defineState('hknight_walk10', 'walk10', 'hknight_walk11', function () { this._ai.walk(4); });
    this._defineState('hknight_walk11', 'walk11', 'hknight_walk12', function () { this._ai.walk(3); });
    this._defineState('hknight_walk12', 'walk12', 'hknight_walk13', function () { this._ai.walk(4); });
    this._defineState('hknight_walk13', 'walk13', 'hknight_walk14', function () { this._ai.walk(6); });
    this._defineState('hknight_walk14', 'walk14', 'hknight_walk15', function () { this._ai.walk(2); });
    this._defineState('hknight_walk15', 'walk15', 'hknight_walk16', function () { this._ai.walk(2); });
    this._defineState('hknight_walk16', 'walk16', 'hknight_walk17', function () { this._ai.walk(4); });
    this._defineState('hknight_walk17', 'walk17', 'hknight_walk18', function () { this._ai.walk(3); });
    this._defineState('hknight_walk18', 'walk18', 'hknight_walk19', function () { this._ai.walk(3); });
    this._defineState('hknight_walk19', 'walk19', 'hknight_walk20', function () { this._ai.walk(3); });
    this._defineState('hknight_walk20', 'walk20', 'hknight_walk1', function () { this._ai.walk(2); });

    // Running states
    this._defineState('hknight_run1', 'run1', 'hknight_run2', function () { this.idleSound(); this._ai.run(20); this._checkForCharge(); });
    this._defineState('hknight_run2', 'run2', 'hknight_run3', function () { this._ai.run(25); });
    this._defineState('hknight_run3', 'run3', 'hknight_run4', function () { this._ai.run(18); });
    this._defineState('hknight_run4', 'run4', 'hknight_run5', function () { this._ai.run(16); });
    this._defineState('hknight_run5', 'run5', 'hknight_run6', function () { this._ai.run(14); });
    this._defineState('hknight_run6', 'run6', 'hknight_run7', function () { this._ai.run(25); });
    this._defineState('hknight_run7', 'run7', 'hknight_run8', function () { this._ai.run(21); });
    this._defineState('hknight_run8', 'run8', 'hknight_run1', function () { this._ai.run(13); });

    // Pain states
    this._defineState('hknight_pain1', 'pain1', 'hknight_pain2', function () { this.painSound(); });
    this._defineState('hknight_pain2', 'pain2', 'hknight_pain3', function () { });
    this._defineState('hknight_pain3', 'pain3', 'hknight_pain4', function () { });
    this._defineState('hknight_pain4', 'pain4', 'hknight_pain5', function () { });
    this._defineState('hknight_pain5', 'pain5', 'hknight_run1', function () { });

    // Death states
    this._defineState('hknight_die1', 'death1', 'hknight_die2', function () { this._ai.forward(10); });
    this._defineState('hknight_die2', 'death2', 'hknight_die3', function () { this._ai.forward(8); });
    this._defineState('hknight_die3', 'death3', 'hknight_die4', function () { this.solid = solid.SOLID_NOT; this._ai.forward(7); });
    this._defineState('hknight_die4', 'death4', 'hknight_die5', function () { });
    this._defineState('hknight_die5', 'death5', 'hknight_die6', function () { });
    this._defineState('hknight_die6', 'death6', 'hknight_die7', function () { });
    this._defineState('hknight_die7', 'death7', 'hknight_die8', function () { });
    this._defineState('hknight_die8', 'death8', 'hknight_die9', function () { this._ai.forward(10); });
    this._defineState('hknight_die9', 'death9', 'hknight_die10', function () { this._ai.forward(11); });
    this._defineState('hknight_die10', 'death10', 'hknight_die11', function () { });
    this._defineState('hknight_die11', 'death11', 'hknight_die12', function () { });
    this._defineState('hknight_die12', 'death12', 'hknight_die12', function () { });

    this._defineState('hknight_dieb1', 'deathb1', 'hknight_dieb2', function () { });
    this._defineState('hknight_dieb2', 'deathb2', 'hknight_dieb3', function () { });
    this._defineState('hknight_dieb3', 'deathb3', 'hknight_dieb4', function () { this.solid = solid.SOLID_NOT; });
    this._defineState('hknight_dieb4', 'deathb4', 'hknight_dieb5', function () { });
    this._defineState('hknight_dieb5', 'deathb5', 'hknight_dieb6', function () { });
    this._defineState('hknight_dieb6', 'deathb6', 'hknight_dieb7', function () { });
    this._defineState('hknight_dieb7', 'deathb7', 'hknight_dieb8', function () { });
    this._defineState('hknight_dieb8', 'deathb8', 'hknight_dieb9', function () { });
    this._defineState('hknight_dieb9', 'deathb9', 'hknight_dieb9', function () { });

    // Magic attack A states
    this._defineState('hknight_magica1', 'magica1', 'hknight_magica2', function () { this._ai.face(); });
    this._defineState('hknight_magica2', 'magica2', 'hknight_magica3', function () { this._ai.face(); });
    this._defineState('hknight_magica3', 'magica3', 'hknight_magica4', function () { this._ai.face(); });
    this._defineState('hknight_magica4', 'magica4', 'hknight_magica5', function () { this._ai.face(); });
    this._defineState('hknight_magica5', 'magica5', 'hknight_magica6', function () { this._ai.face(); });
    this._defineState('hknight_magica6', 'magica6', 'hknight_magica7', function () { this._ai.face(); });
    this._defineState('hknight_magica7', 'magica7', 'hknight_magica8', function () { this.attackShot(-2); });
    this._defineState('hknight_magica8', 'magica8', 'hknight_magica9', function () { this.attackShot(-1); });
    this._defineState('hknight_magica9', 'magica9', 'hknight_magica10', function () { this.attackShot(0); });
    this._defineState('hknight_magica10', 'magica10', 'hknight_magica11', function () { this.attackShot(1); });
    this._defineState('hknight_magica11', 'magica11', 'hknight_magica12', function () { this.attackShot(2); });
    this._defineState('hknight_magica12', 'magica12', 'hknight_magica13', function () { this.attackShot(3); });
    this._defineState('hknight_magica13', 'magica13', 'hknight_magica14', function () { this._ai.face(); });
    this._defineState('hknight_magica14', 'magica14', 'hknight_run1', function () { this._ai.face(); });

    // Magic attack B states
    this._defineState('hknight_magicb1', 'magicb1', 'hknight_magicb2', function () { this._ai.face(); });
    this._defineState('hknight_magicb2', 'magicb2', 'hknight_magicb3', function () { this._ai.face(); });
    this._defineState('hknight_magicb3', 'magicb3', 'hknight_magicb4', function () { this._ai.face(); });
    this._defineState('hknight_magicb4', 'magicb4', 'hknight_magicb5', function () { this._ai.face(); });
    this._defineState('hknight_magicb5', 'magicb5', 'hknight_magicb6', function () { this._ai.face(); });
    this._defineState('hknight_magicb6', 'magicb6', 'hknight_magicb7', function () { this._ai.face(); });
    this._defineState('hknight_magicb7', 'magicb7', 'hknight_magicb8', function () { this.attackShot(-2); });
    this._defineState('hknight_magicb8', 'magicb8', 'hknight_magicb9', function () { this.attackShot(-1); });
    this._defineState('hknight_magicb9', 'magicb9', 'hknight_magicb10', function () { this.attackShot(0); });
    this._defineState('hknight_magicb10', 'magicb10', 'hknight_magicb11', function () { this.attackShot(1); });
    this._defineState('hknight_magicb11', 'magicb11', 'hknight_magicb12', function () { this.attackShot(2); });
    this._defineState('hknight_magicb12', 'magicb12', 'hknight_magicb13', function () { this.attackShot(3); });
    this._defineState('hknight_magicb13', 'magicb13', 'hknight_run1', function () { this._ai.face(); });

    // Magic attack C states
    this._defineState('hknight_magicc1', 'magicc1', 'hknight_magicc2', function () { this._ai.face(); });
    this._defineState('hknight_magicc2', 'magicc2', 'hknight_magicc3', function () { this._ai.face(); });
    this._defineState('hknight_magicc3', 'magicc3', 'hknight_magicc4', function () { this._ai.face(); });
    this._defineState('hknight_magicc4', 'magicc4', 'hknight_magicc5', function () { this._ai.face(); });
    this._defineState('hknight_magicc5', 'magicc5', 'hknight_magicc6', function () { this._ai.face(); });
    this._defineState('hknight_magicc6', 'magicc6', 'hknight_magicc7', function () { this.attackShot(-2); });
    this._defineState('hknight_magicc7', 'magicc7', 'hknight_magicc8', function () { this.attackShot(-1); });
    this._defineState('hknight_magicc8', 'magicc8', 'hknight_magicc9', function () { this.attackShot(0); });
    this._defineState('hknight_magicc9', 'magicc9', 'hknight_magicc10', function () { this.attackShot(1); });
    this._defineState('hknight_magicc10', 'magicc10', 'hknight_magicc11', function () { this.attackShot(2); });
    this._defineState('hknight_magicc11', 'magicc11', 'hknight_run1', function () { this.attackShot(3); });

    // Charge attack A states
    this._defineState('hknight_char_a1', 'char_a1', 'hknight_char_a2', function () { this._ai.charge(20); });
    this._defineState('hknight_char_a2', 'char_a2', 'hknight_char_a3', function () { this._ai.charge(25); });
    this._defineState('hknight_char_a3', 'char_a3', 'hknight_char_a4', function () { this._ai.charge(18); });
    this._defineState('hknight_char_a4', 'char_a4', 'hknight_char_a5', function () { this._ai.charge(16); });
    this._defineState('hknight_char_a5', 'char_a5', 'hknight_char_a6', function () { this._ai.charge(14); });
    this._defineState('hknight_char_a6', 'char_a6', 'hknight_char_a7', function () { this._ai.charge(20); this._ai.melee(); });
    this._defineState('hknight_char_a7', 'char_a7', 'hknight_char_a8', function () { this._ai.charge(21); this._ai.melee(); });
    this._defineState('hknight_char_a8', 'char_a8', 'hknight_char_a9', function () { this._ai.charge(13); this._ai.melee(); });
    this._defineState('hknight_char_a9', 'char_a9', 'hknight_char_a10', function () { this._ai.charge(20); this._ai.melee(); });
    this._defineState('hknight_char_a10', 'char_a10', 'hknight_char_a11', function () { this._ai.charge(20); this._ai.melee(); });
    this._defineState('hknight_char_a11', 'char_a11', 'hknight_char_a12', function () { this._ai.charge(18); this._ai.melee(); });
    this._defineState('hknight_char_a12', 'char_a12', 'hknight_char_a13', function () { this._ai.charge(16); });
    this._defineState('hknight_char_a13', 'char_a13', 'hknight_char_a14', function () { this._ai.charge(14); });
    this._defineState('hknight_char_a14', 'char_a14', 'hknight_char_a15', function () { this._ai.charge(25); });
    this._defineState('hknight_char_a15', 'char_a15', 'hknight_char_a16', function () { this._ai.charge(21); });
    this._defineState('hknight_char_a16', 'char_a16', 'hknight_run1', function () { this._ai.charge(13); });

    // Charge attack B states
    this._defineState('hknight_char_b1', 'char_b1', 'hknight_char_b2', function () { this._checkContinueCharge(); this._ai.charge(23); this._ai.melee(); });
    this._defineState('hknight_char_b2', 'char_b2', 'hknight_char_b3', function () { this._ai.charge(17); this._ai.melee(); });
    this._defineState('hknight_char_b3', 'char_b3', 'hknight_char_b4', function () { this._ai.charge(12); this._ai.melee(); });
    this._defineState('hknight_char_b4', 'char_b4', 'hknight_char_b5', function () { this._ai.charge(22); this._ai.melee(); });
    this._defineState('hknight_char_b5', 'char_b5', 'hknight_char_b6', function () { this._ai.charge(18); this._ai.melee(); });
    this._defineState('hknight_char_b6', 'char_b6', 'hknight_char_b1', function () { this._ai.charge(8); this._ai.melee(); });

    // Slice attack states
    this._defineState('hknight_slice1', 'slice1', 'hknight_slice2', function () { this._ai.charge(9); });
    this._defineState('hknight_slice2', 'slice2', 'hknight_slice3', function () { this._ai.charge(6); });
    this._defineState('hknight_slice3', 'slice3', 'hknight_slice4', function () { this._ai.charge(13); });
    this._defineState('hknight_slice4', 'slice4', 'hknight_slice5', function () { this._ai.charge(4); });
    this._defineState('hknight_slice5', 'slice5', 'hknight_slice6', function () { this._ai.charge(7); this._ai.melee(); });
    this._defineState('hknight_slice6', 'slice6', 'hknight_slice7', function () { this._ai.charge(15); this._ai.melee(); });
    this._defineState('hknight_slice7', 'slice7', 'hknight_slice8', function () { this._ai.charge(8); this._ai.melee(); });
    this._defineState('hknight_slice8', 'slice8', 'hknight_slice9', function () { this._ai.charge(2); this._ai.melee(); });
    this._defineState('hknight_slice9', 'slice9', 'hknight_slice10', function () { this._ai.melee(); });
    this._defineState('hknight_slice10', 'slice10', 'hknight_run1', function () { this._ai.charge(3); });

    // Smash attack states
    this._defineState('hknight_smash1', 'smash1', 'hknight_smash2', function () { this._ai.charge(1); });
    this._defineState('hknight_smash2', 'smash2', 'hknight_smash3', function () { this._ai.charge(13); });
    this._defineState('hknight_smash3', 'smash3', 'hknight_smash4', function () { this._ai.charge(9); });
    this._defineState('hknight_smash4', 'smash4', 'hknight_smash5', function () { this._ai.charge(11); });
    this._defineState('hknight_smash5', 'smash5', 'hknight_smash6', function () { this._ai.charge(10); this._ai.melee(); });
    this._defineState('hknight_smash6', 'smash6', 'hknight_smash7', function () { this._ai.charge(7); this._ai.melee(); });
    this._defineState('hknight_smash7', 'smash7', 'hknight_smash8', function () { this._ai.charge(12); this._ai.melee(); });
    this._defineState('hknight_smash8', 'smash8', 'hknight_smash9', function () { this._ai.charge(2); this._ai.melee(); });
    this._defineState('hknight_smash9', 'smash9', 'hknight_smash10', function () { this._ai.charge(3); this._ai.melee(); });
    this._defineState('hknight_smash10', 'smash10', 'hknight_smash11', function () { this._ai.charge(0); });
    this._defineState('hknight_smash11', 'smash11', 'hknight_run1', function () { this._ai.charge(0); });

    // W attack states
    this._defineState('hknight_watk1', 'w_attack1', 'hknight_watk2', function () { this._ai.charge(2); });
    this._defineState('hknight_watk2', 'w_attack2', 'hknight_watk3', function () { this._ai.charge(0); });
    this._defineState('hknight_watk3', 'w_attack3', 'hknight_watk4', function () { this._ai.charge(0); });
    this._defineState('hknight_watk4', 'w_attack4', 'hknight_watk5', function () { this._ai.melee(); });
    this._defineState('hknight_watk5', 'w_attack5', 'hknight_watk6', function () { this._ai.melee(); });
    this._defineState('hknight_watk6', 'w_attack6', 'hknight_watk7', function () { this._ai.melee(); });
    this._defineState('hknight_watk7', 'w_attack7', 'hknight_watk8', function () { this._ai.charge(1); });
    this._defineState('hknight_watk8', 'w_attack8', 'hknight_watk9', function () { this._ai.charge(4); });
    this._defineState('hknight_watk9', 'w_attack9', 'hknight_watk10', function () { this._ai.charge(5); });
    this._defineState('hknight_watk10', 'w_attack10', 'hknight_watk11', function () { this._ai.charge(3); this._ai.melee(); });
    this._defineState('hknight_watk11', 'w_attack11', 'hknight_watk12', function () { this._ai.charge(2); this._ai.melee(); });
    this._defineState('hknight_watk12', 'w_attack12', 'hknight_watk13', function () { this._ai.charge(2); this._ai.melee(); });
    this._defineState('hknight_watk13', 'w_attack13', 'hknight_watk14', function () { this._ai.charge(0); });
    this._defineState('hknight_watk14', 'w_attack14', 'hknight_watk15', function () { this._ai.charge(0); });
    this._defineState('hknight_watk15', 'w_attack15', 'hknight_watk16', function () { this._ai.charge(0); });
    this._defineState('hknight_watk16', 'w_attack16', 'hknight_watk17', function () { this._ai.charge(1); });
    this._defineState('hknight_watk17', 'w_attack17', 'hknight_watk18', function () { this._ai.charge(1); this._ai.melee(); });
    this._defineState('hknight_watk18', 'w_attack18', 'hknight_watk19', function () { this._ai.charge(3); this._ai.melee(); });
    this._defineState('hknight_watk19', 'w_attack19', 'hknight_watk20', function () { this._ai.charge(4); this._ai.melee(); });
    this._defineState('hknight_watk20', 'w_attack20', 'hknight_watk21', function () { this._ai.charge(6); });
    this._defineState('hknight_watk21', 'w_attack21', 'hknight_watk22', function () { this._ai.charge(7); });
    this._defineState('hknight_watk22', 'w_attack22', 'hknight_run1', function () { this._ai.charge(3); });
  }

  attackShot(offsetY) { // QuakeC: hknight.qc/hknight_shot
    const offang = this.enemy.origin.copy().subtract(this.origin).toAngles();

    offang[1] += offsetY * 6; // offsetY is in -3..3 range

    const { forward } = offang.angleVectors();

    // const org = this.origin.copy().add(this.mins).add(this.size.copy().multiply(0.5)).add(forward.multiply(20.0));

    forward.normalize();

    forward[2] = -forward[2] + (Math.random() - 0.5) * 0.1;

    this.movedir.set(forward);

    this.engine.SpawnEntity(KnightSpike.classname, {
      speed: 300,
      owner: this,
      // CR: the original code uses a precalcuated origin offset (see: org)
    });

    // this.engine.SpawnEntity(Spike.classname, { owner: this });

    this.startSound(channel.CHAN_WEAPON, 'hknight/attack1.wav');
  }

  thinkMelee() { // QuakeC: hknight.qc/hknight_melee
    // CR: the original code cycles through the attack animations globally

    const r = Math.random();

    this.startSound(channel.CHAN_WEAPON, 'hknight/slash1.wav');

    if (r < 0.33) {
      this._runState('hknight_slice1');
    } else if (r < 0.66) {
      this._runState('hknight_smash1');
    } else {
      this._runState('hknight_watk1');
    }
  }

  _checkForCharge() { // QuakeC: hknight.qc/CheckForCharge
    console.log('check for charge', this);

    if (!this._ai.enemyIsVisible) {
      return;
    }

    if (this.game.time < this.attack_finished) {
      return;
    }

    if (Math.abs(this.origin[2] - this.enemy.origin[2]) > 20) {
      return;
    }

    if (this.origin.distanceTo(this.enemy.origin) < 80) {
      return;
    }

    // charge
    this.attackFinished(2.0);
    this._runState('hknight_char_a1');
  }

  _checkContinueCharge() { // QuakeC: hknight.qc/CheckContinueCharge
    console.log('check continue charge', this);

    if (this.game.time > this.attack_finished) {
      this.attackFinished(3.0);
      this._runState('hknight_run1');
      return; // done charging
    }

    if (Math.random() > 0.5) {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword2.wav');
    } else {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword1.wav');
    }
  }

  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    this.painSound();

    if (this.game.time - this.pain_finished > 5) {
      this._runState('hknight_pain1');
      this.pain_finished = this.game.time + 1;
      return;
    }

    if (Math.random() * 30 > damage) {
      return;
    }

    this.pain_finished = this.game.time + 1;
    this._runState('hknight_pain1');
  }

  thinkStand() {
    this._runState('hknight_stand1');
  }

  thinkWalk() {
    this._runState('hknight_walk1');
  }

  thinkRun() {
    this._runState('hknight_run1');
  }

  thinkMissile() {
    this._runState('hknight_magicc1');
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -40) {
      this.startSound(channel.CHAN_VOICE, 'player/udeath.wav');
      this._gib(true);
      return;
    }
    this.deathSound();
    this.solid = solid.SOLID_NOT;
    if (Math.random() > 0.5) {
      this._runState('hknight_die1');
    } else {
      this._runState('hknight_dieb1');
    }
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, 'hknight/idle.wav');
    }
  }

  attackSound() {
    if (Math.random() > 0.5) {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword2.wav');
    } else {
      this.startSound(channel.CHAN_WEAPON, 'knight/sword1.wav');
    }
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'hknight/pain1.wav');
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'hknight/sight1.wav');
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'hknight/death1.wav');
  }

  hasMeleeAttack() {
    return true;
  }

  hasMissileAttack() {
    return true;
  }
};
