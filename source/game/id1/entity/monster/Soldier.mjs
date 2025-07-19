import Vector from '../../../../shared/Vector.mjs';

import { attn, channel, flags, solid } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import { DamageInflictor, Laser } from '../Weapons.mjs';
import { WalkMonster } from './BaseMonster.mjs';

export const qc = {
  solider:`
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
`,
  enforcer: `
$cd id1/models/enforcer
$origin 0 -6 24
$base base
$skin skin

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8 walk9 walk10
$frame walk11 walk12 walk13 walk14 walk15 walk16

$frame run1 run2 run3 run4 run5 run6 run7 run8

$frame attack1 attack2 attack3 attack4 attack5 attack6
$frame attack7 attack8 attack9 attack10

$frame death1 death2 death3 death4 death5 death6 death7 death8
$frame death9 death10 death11 death12 death13 death14

$frame fdeath1 fdeath2 fdeath3 fdeath4 fdeath5 fdeath6 fdeath7 fdeath8
$frame fdeath9 fdeath10 fdeath11

$frame paina1 paina2 paina3 paina4

$frame painb1 painb2 painb3 painb4 painb5

$frame painc1 painc2 painc3 painc4 painc5 painc6 painc7 painc8

$frame paind1 paind2 paind3 paind4 paind5 paind6 paind7 paind8
$frame paind9 paind10 paind11 paind12 paind13 paind14 paind15 paind16
$frame paind17 paind18 paind19
`};

/**
 * QUAKED monster_army (1 0 0) (-16 -16 -24) (16 16 40) Ambush
 */
export class ArmySoldierMonster extends WalkMonster {
  static classname = 'monster_army';

  static _health = 30;
  static _size = [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0)];

  static _modelDefault = 'progs/soldier.mdl';
  static _modelHead = 'progs/h_guard.mdl';

  get netname() {
    return 'a Grunt';
  }

  _precache() {
    super._precache();

    this.engine.PrecacheSound('soldier/death1.wav');
    this.engine.PrecacheSound('soldier/idle.wav');
    this.engine.PrecacheSound('soldier/pain1.wav');
    this.engine.PrecacheSound('soldier/pain2.wav');
    this.engine.PrecacheSound('soldier/sattck1.wav');
    this.engine.PrecacheSound('soldier/sight1.wav');
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
    this._defineState('army_atk7', 'shoot7', 'army_atk8', function () { this._ai.face(); this._refire('army_atk1'); });
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

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

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
      this.startSound(channel.CHAN_VOICE, 'soldier/pain1.wav');
    } else {
      this.startSound(channel.CHAN_VOICE, 'soldier/pain2.wav');
    }
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'soldier/sight1.wav');
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

/**
 * QUAKED monster_enforcer (1 0 0) (-16 -16 -24) (16 16 40) Ambush
 */
export class ArmyEnforcerMonster extends WalkMonster {
  static classname = 'monster_enforcer';

  static _health = 80;
  static _size = [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 40.0)];

  static _modelDefault = 'progs/enforcer.mdl';
  static _modelHead = 'progs/h_mega.mdl';

  get netname() {
    return 'an Enforcer';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _precache() {
    super._precache();

    this.engine.PrecacheModel('progs/laser.mdl');
    this.engine.PrecacheSound('enforcer/death1.wav');
    this.engine.PrecacheSound('enforcer/enfire.wav');
    this.engine.PrecacheSound('enforcer/enfstop.wav');
    this.engine.PrecacheSound('enforcer/idle1.wav');
    this.engine.PrecacheSound('enforcer/pain1.wav');
    this.engine.PrecacheSound('enforcer/pain2.wav');
    this.engine.PrecacheSound('enforcer/sight1.wav');
    this.engine.PrecacheSound('enforcer/sight2.wav');
    this.engine.PrecacheSound('enforcer/sight3.wav');
    this.engine.PrecacheSound('enforcer/sight4.wav');
  }

  _initStates() {
    this._defineState('enf_stand1', 'stand1', 'enf_stand2', function () { this._ai.stand(); });
    this._defineState('enf_stand2', 'stand2', 'enf_stand3', function () { this._ai.stand(); });
    this._defineState('enf_stand3', 'stand3', 'enf_stand4', function () { this._ai.stand(); });
    this._defineState('enf_stand4', 'stand4', 'enf_stand5', function () { this._ai.stand(); });
    this._defineState('enf_stand5', 'stand5', 'enf_stand6', function () { this._ai.stand(); });
    this._defineState('enf_stand6', 'stand6', 'enf_stand7', function () { this._ai.stand(); });
    this._defineState('enf_stand7', 'stand7', 'enf_stand1', function () { this._ai.stand(); });

    // Walk states
    this._defineState('enf_walk1', 'walk1', 'enf_walk2', function () { this.idleSound(); this._ai.walk(2); });
    this._defineState('enf_walk2', 'walk2', 'enf_walk3', function () { this._ai.walk(4); });
    this._defineState('enf_walk3', 'walk3', 'enf_walk4', function () { this._ai.walk(4); });
    this._defineState('enf_walk4', 'walk4', 'enf_walk5', function () { this._ai.walk(3); });
    this._defineState('enf_walk5', 'walk5', 'enf_walk6', function () { this._ai.walk(1); });
    this._defineState('enf_walk6', 'walk6', 'enf_walk7', function () { this._ai.walk(2); });
    this._defineState('enf_walk7', 'walk7', 'enf_walk8', function () { this._ai.walk(2); });
    this._defineState('enf_walk8', 'walk8', 'enf_walk9', function () { this._ai.walk(1); });
    this._defineState('enf_walk9', 'walk9', 'enf_walk10', function () { this._ai.walk(2); });
    this._defineState('enf_walk10', 'walk10', 'enf_walk11', function () { this._ai.walk(4); });
    this._defineState('enf_walk11', 'walk11', 'enf_walk12', function () { this._ai.walk(4); });
    this._defineState('enf_walk12', 'walk12', 'enf_walk13', function () { this._ai.walk(1); });
    this._defineState('enf_walk13', 'walk13', 'enf_walk14', function () { this._ai.walk(2); });
    this._defineState('enf_walk14', 'walk14', 'enf_walk15', function () { this._ai.walk(3); });
    this._defineState('enf_walk15', 'walk15', 'enf_walk16', function () { this._ai.walk(4); });
    this._defineState('enf_walk16', 'walk16', 'enf_walk1', function () { this._ai.walk(2); });

    // Run states
    this._defineState('enf_run1', 'run1', 'enf_run2', function () { this.idleSound(); this._ai.run(18); });
    this._defineState('enf_run2', 'run2', 'enf_run3', function () { this._ai.run(14); });
    this._defineState('enf_run3', 'run3', 'enf_run4', function () { this._ai.run(7); });
    this._defineState('enf_run4', 'run4', 'enf_run5', function () { this._ai.run(12); });
    this._defineState('enf_run5', 'run5', 'enf_run6', function () { this._ai.run(14); });
    this._defineState('enf_run6', 'run6', 'enf_run7', function () { this._ai.run(14); });
    this._defineState('enf_run7', 'run7', 'enf_run8', function () { this._ai.run(7); });
    this._defineState('enf_run8', 'run8', 'enf_run1', function () { this._ai.run(11); });

    // Attack states
    this._defineState('enf_atk1', 'attack1', 'enf_atk2', function () { this._ai.face(); });
    this._defineState('enf_atk2', 'attack2', 'enf_atk3', function () { this._ai.face(); });
    this._defineState('enf_atk3', 'attack3', 'enf_atk4', function () { this._ai.face(); });
    this._defineState('enf_atk4', 'attack4', 'enf_atk5', function () { this._ai.face(); });
    this._defineState('enf_atk5', 'attack5', 'enf_atk6', function () { this._ai.face(); });
    this._defineState('enf_atk6', 'attack6', 'enf_atk7', function () { this.fire(); });
    this._defineState('enf_atk7', 'attack7', 'enf_atk8', function () { this._ai.face(); });
    this._defineState('enf_atk8', 'attack8', 'enf_atk9', function () { this._ai.face(); });
    this._defineState('enf_atk9', 'attack5', 'enf_atk10', function () { this._ai.face(); });
    this._defineState('enf_atk10', 'attack6', 'enf_atk11', function () { this.fire(); });
    this._defineState('enf_atk11', 'attack7', 'enf_atk12', function () { this._ai.face(); });
    this._defineState('enf_atk12', 'attack8', 'enf_atk13', function () { this._ai.face(); });
    this._defineState('enf_atk13', 'attack9', 'enf_atk14', function () { this._ai.face(); });
    this._defineState('enf_atk14', 'attack10', 'enf_run1', function () { this._ai.face(); this._refire('enf_atk1'); });

    // Pain states
    this._defineState('enf_paina1', 'paina1', 'enf_paina2', function () {});
    this._defineState('enf_paina2', 'paina2', 'enf_paina3', function () {});
    this._defineState('enf_paina3', 'paina3', 'enf_paina4', function () {});
    this._defineState('enf_paina4', 'paina4', 'enf_run1', function () {});

    this._defineState('enf_painb1', 'painb1', 'enf_painb2', function () {});
    this._defineState('enf_painb2', 'painb2', 'enf_painb3', function () {});
    this._defineState('enf_painb3', 'painb3', 'enf_painb4', function () {});
    this._defineState('enf_painb4', 'painb4', 'enf_painb5', function () {});
    this._defineState('enf_painb5', 'painb5', 'enf_run1', function () {});

    this._defineState('enf_painc1', 'painc1', 'enf_painc2', function () {});
    this._defineState('enf_painc2', 'painc2', 'enf_painc3', function () {});
    this._defineState('enf_painc3', 'painc3', 'enf_painc4', function () {});
    this._defineState('enf_painc4', 'painc4', 'enf_painc5', function () {});
    this._defineState('enf_painc5', 'painc5', 'enf_painc6', function () {});
    this._defineState('enf_painc6', 'painc6', 'enf_painc7', function () {});
    this._defineState('enf_painc7', 'painc7', 'enf_painc8', function () {});
    this._defineState('enf_painc8', 'painc8', 'enf_run1', function () {});

    this._defineState('enf_paind1', 'paind1', 'enf_paind2', function () {});
    this._defineState('enf_paind2', 'paind2', 'enf_paind3', function () {});
    this._defineState('enf_paind3', 'paind3', 'enf_paind4', function () {});
    this._defineState('enf_paind4', 'paind4', 'enf_paind5', function () { this._ai.painforward(2); });
    this._defineState('enf_paind5', 'paind5', 'enf_paind6', function () { this._ai.painforward(1); });
    this._defineState('enf_paind6', 'paind6', 'enf_paind7', function () {});
    this._defineState('enf_paind7', 'paind7', 'enf_paind8', function () {});
    this._defineState('enf_paind8', 'paind8', 'enf_paind9', function () {});
    this._defineState('enf_paind9', 'paind9', 'enf_paind10', function () {});
    this._defineState('enf_paind10', 'paind10', 'enf_paind11', function () {});
    this._defineState('enf_paind11', 'paind11', 'enf_paind12', function () { this._ai.painforward(1); });
    this._defineState('enf_paind12', 'paind12', 'enf_paind13', function () { this._ai.painforward(1); });
    this._defineState('enf_paind13', 'paind13', 'enf_paind14', function () { this._ai.painforward(1); });
    this._defineState('enf_paind14', 'paind14', 'enf_paind15', function () {});
    this._defineState('enf_paind15', 'paind15', 'enf_paind16', function () {});
    this._defineState('enf_paind16', 'paind16', 'enf_paind17', function () { this._ai.pain(1); });
    this._defineState('enf_paind17', 'paind17', 'enf_paind18', function () { this._ai.pain(1); });
    this._defineState('enf_paind18', 'paind18', 'enf_paind19', function () {});
    this._defineState('enf_paind19', 'paind19', 'enf_run1', function () {});

    // Death states
    this._defineState('enf_die1', 'death1', 'enf_die2', function () {});
    this._defineState('enf_die2', 'death2', 'enf_die3', function () {});
    this._defineState('enf_die3', 'death3', 'enf_die4', function () { this.solid = solid.SOLID_NOT; this._dropBackpack({ ammo_cells: 5 }); });
    this._defineState('enf_die4', 'death4', 'enf_die5', function () { this._ai.forward(14); });
    this._defineState('enf_die5', 'death5', 'enf_die6', function () { this._ai.forward(2); });
    this._defineState('enf_die6', 'death6', 'enf_die7', function () {});
    this._defineState('enf_die7', 'death7', 'enf_die8', function () {});
    this._defineState('enf_die8', 'death8', 'enf_die9', function () {});
    this._defineState('enf_die9', 'death9', 'enf_die10', function () { this._ai.forward(3); });
    this._defineState('enf_die10', 'death10', 'enf_die11', function () { this._ai.forward(5); });
    this._defineState('enf_die11', 'death11', 'enf_die12', function () { this._ai.forward(5); });
    this._defineState('enf_die12', 'death12', 'enf_die13', function () { this._ai.forward(5); });
    this._defineState('enf_die13', 'death13', 'enf_die14', function () {});
    this._defineState('enf_die14', 'death14', 'enf_die14', function () {});

    this._defineState('enf_fdie1', 'fdeath1', 'enf_fdie2', function () {});
    this._defineState('enf_fdie2', 'fdeath2', 'enf_fdie3', function () {});
    this._defineState('enf_fdie3', 'fdeath3', 'enf_fdie4', function () { this.solid = solid.SOLID_NOT; this._dropBackpack({ ammo_cells: 5 }); });
    this._defineState('enf_fdie4', 'fdeath4', 'enf_fdie5', function () {});
    this._defineState('enf_fdie5', 'fdeath5', 'enf_fdie6', function () {});
    this._defineState('enf_fdie6', 'fdeath6', 'enf_fdie7', function () {});
    this._defineState('enf_fdie7', 'fdeath7', 'enf_fdie8', function () {});
    this._defineState('enf_fdie8', 'fdeath8', 'enf_fdie9', function () {});
    this._defineState('enf_fdie9', 'fdeath9', 'enf_fdie10', function () {});
    this._defineState('enf_fdie10', 'fdeath10', 'enf_fdie11', function () {});
    this._defineState('enf_fdie11', 'fdeath11', 'enf_fdie11', function () {});
  }

  fire() { // QuakeC: enforcer.qc/enforcer_fire
    this.effects |= flags.EF_MUZZLEFLASH;

    const { forward, right } = this.angles.angleVectors();

    const org = this.origin.copy().add(forward.multiply(30.0)).add(right.multiply(8.5)).add(new Vector(0.0, 0.0, 16.0));

    const movedir = this.enemy.origin.copy().subtract(this.origin);
    movedir.normalize();

    this.movedir.set(movedir);

    const laser = this.engine.SpawnEntity(Laser.classname, { owner: this });
    laser.setOrigin(org);
  }

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    const r = Math.random();

    this.pain_finished = this.game.time + 1.0;

    if (r < 0.2) {
      this._runState('enf_paina1');
    } else if (r < 0.4) {
      this._runState('enf_painb1');
    } else if (r < 0.7) {
      this._runState('enf_painc1');
    } else {
      this.pain_finished = this.game.time + 1.0;
      this._runState('enf_paind1');
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

    if (Math.random() < 0.5) {
      this._runState('enf_die1');
    } else {
      this._runState('enf_fdie1');
    }
  }

  thinkStand() {
    this._runState('enf_stand1');
  }

  thinkWalk() {
    this._runState('enf_walk1');
  }

  thinkRun() {
    this._runState('enf_run1');
  }

  thinkMissile() {
    this._runState('enf_atk1');
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, 'enforcer/idle1.wav');
    }
  }

  painSound() {
    if (Math.random() < 0.5) {
      this.startSound(channel.CHAN_VOICE, 'enforcer/pain1.wav');
    } else {
      this.startSound(channel.CHAN_VOICE, 'enforcer/pain2.wav');
    }
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'enforcer/death1.wav');
  }

  sightSound() {
    const r = Math.random();
    if (r < 0.25) {
      this.startSound(channel.CHAN_VOICE, 'enforcer/sight1.wav');
    } else if (r < 0.5) {
      this.startSound(channel.CHAN_VOICE, 'enforcer/sight2.wav');
    } else if (r < 0.75) {
      this.startSound(channel.CHAN_VOICE, 'enforcer/sight3.wav');
    } else {
      this.startSound(channel.CHAN_VOICE, 'enforcer/sight4.wav');
    }
  }

  hasMissileAttack() {
    return true;
  }
};
