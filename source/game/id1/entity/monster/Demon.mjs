import Vector from '../../../../shared/Vector.mjs';

import { MeatSprayEntity, WalkMonster } from './BaseMonster.mjs';
import { attn, channel, flags, range, solid } from '../../Defs.mjs';
import { ATTACK_STATE, QuakeEntityAI } from '../../helper/AI.mjs';

export const qc = `
$cd id1/models/demon3
$scale	0.8
$origin 0 0 24
$base base
$skin base

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9
$frame stand10 stand11 stand12 stand13

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8

$frame run1 run2 run3 run4 run5 run6

$frame leap1 leap2 leap3 leap4 leap5 leap6 leap7 leap8 leap9 leap10
$frame leap11 leap12

$frame pain1 pain2 pain3 pain4 pain5 pain6

$frame death1 death2 death3 death4 death5 death6 death7 death8 death9

$frame attacka1 attacka2 attacka3 attacka4 attacka5 attacka6 attacka7 attacka8
$frame attacka9 attacka10 attacka11 attacka12 attacka13 attacka14 attacka15
`;

/**
 * QUAKED monster_demon1 (1 0 0) (-32 -32 -24) (32 32 64) Ambush
 */
export default class DemonMonster extends WalkMonster {
  static classname = 'monster_demon1';
  static _health = 300;
  static _size = [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0)];
  static _modelDefault = 'progs/demon.mdl';
  static _modelHead = 'progs/h_demon.mdl';

  get netname() {
    return 'a Fiend';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _declareFields() {
    super._declareFields();
    this._serializer.startFields();
    this._isLeaping = false;
    this._serializer.endFields();
  }

  _precache() {
    super._precache();

    for (const s of [
      'demon/ddeath.wav',
      'demon/dhit2.wav',
      'demon/djump.wav',
      'demon/dpain1.wav',
      'demon/idle1.wav',
      'demon/sight2.wav',
    ]) {
      this.engine.PrecacheSound(s);
    }
  }

  _initStates() {
    // stand states
    this._defineState('demon1_stand1', 'stand1', 'demon1_stand2', function() { this._ai.stand(); });
    this._defineState('demon1_stand2', 'stand2', 'demon1_stand3', function() { this._ai.stand(); });
    this._defineState('demon1_stand3', 'stand3', 'demon1_stand4', function() { this._ai.stand(); });
    this._defineState('demon1_stand4', 'stand4', 'demon1_stand5', function() { this._ai.stand(); });
    this._defineState('demon1_stand5', 'stand5', 'demon1_stand6', function() { this._ai.stand(); });
    this._defineState('demon1_stand6', 'stand6', 'demon1_stand7', function() { this._ai.stand(); });
    this._defineState('demon1_stand7', 'stand7', 'demon1_stand8', function() { this._ai.stand(); });
    this._defineState('demon1_stand8', 'stand8', 'demon1_stand9', function() { this._ai.stand(); });
    this._defineState('demon1_stand9', 'stand9', 'demon1_stand10', function() { this._ai.stand(); });
    this._defineState('demon1_stand10', 'stand10', 'demon1_stand11', function() { this._ai.stand(); });
    this._defineState('demon1_stand11', 'stand11', 'demon1_stand12', function() { this._ai.stand(); });
    this._defineState('demon1_stand12', 'stand12', 'demon1_stand13', function() { this._ai.stand(); });
    this._defineState('demon1_stand13', 'stand13', 'demon1_stand1', function() { this._ai.stand(); });

    // walk states
    this._defineState('demon1_walk1', 'walk1', 'demon1_walk2', function() { this.idleSound(); this._ai.walk(8); });
    this._defineState('demon1_walk2', 'walk2', 'demon1_walk3', function() { this._ai.walk(6); });
    this._defineState('demon1_walk3', 'walk3', 'demon1_walk4', function() { this._ai.walk(6); });
    this._defineState('demon1_walk4', 'walk4', 'demon1_walk5', function() { this._ai.walk(7); });
    this._defineState('demon1_walk5', 'walk5', 'demon1_walk6', function() { this._ai.walk(4); });
    this._defineState('demon1_walk6', 'walk6', 'demon1_walk7', function() { this._ai.walk(6); });
    this._defineState('demon1_walk7', 'walk7', 'demon1_walk8', function() { this._ai.walk(10); });
    this._defineState('demon1_walk8', 'walk8', 'demon1_walk1', function() { this._ai.walk(10); });

    // run states
    this._defineState('demon1_run1', 'run1', 'demon1_run2', function() { this.idleSound(); this._ai.run(20); });
    this._defineState('demon1_run2', 'run2', 'demon1_run3', function() { this._ai.run(15); });
    this._defineState('demon1_run3', 'run3', 'demon1_run4', function() { this._ai.run(36); });
    this._defineState('demon1_run4', 'run4', 'demon1_run5', function() { this._ai.run(20); });
    this._defineState('demon1_run5', 'run5', 'demon1_run6', function() { this._ai.run(15); });
    this._defineState('demon1_run6', 'run6', 'demon1_run1', function() { this._ai.run(36); });

    // jump states
    this._defineState('demon1_jump1', 'leap1', 'demon1_jump2', function() { this._ai.face(); });
    this._defineState('demon1_jump2', 'leap2', 'demon1_jump3', function() { this._ai.face(); });
    this._defineState('demon1_jump3', 'leap3', 'demon1_jump4', function() { this._ai.face(); this._leap(); });
    this._defineState('demon1_jump4', 'leap4', 'demon1_jump5', function() { this._ai.face(); });
    this._defineState('demon1_jump5', 'leap5', 'demon1_jump6', function() {});
    this._defineState('demon1_jump6', 'leap6', 'demon1_jump7', function() {});
    this._defineState('demon1_jump7', 'leap7', 'demon1_jump8', function() {});
    this._defineState('demon1_jump8', 'leap8', 'demon1_jump9', function() {});
    this._defineState('demon1_jump9', 'leap9', 'demon1_jump10', function() {});
    this._defineState('demon1_jump10', 'leap10', 'demon1_jump1', function() { this.nextthink = this.game.time + 3; /* HACK: if three seconds pass, assume demon is stuck and jump again */ });
    this._defineState('demon1_jump11', 'leap11', 'demon1_jump12', function() {});
    this._defineState('demon1_jump12', 'leap12', 'demon1_run1', function() {});

    // attack states
    this._defineState('demon1_atta1', 'attacka1', 'demon1_atta2', function() { this._ai.charge(4); });
    this._defineState('demon1_atta2', 'attacka2', 'demon1_atta3', function() { this._ai.charge(0); });
    this._defineState('demon1_atta3', 'attacka3', 'demon1_atta4', function() { this._ai.charge(0); });
    this._defineState('demon1_atta4', 'attacka4', 'demon1_atta5', function() { this._ai.charge(1); });
    this._defineState('demon1_atta5', 'attacka5', 'demon1_atta6', function() { this._ai.charge(2); this._meleeAttack(200); });
    this._defineState('demon1_atta6', 'attacka6', 'demon1_atta7', function() { this._ai.charge(1); });
    this._defineState('demon1_atta7', 'attacka7', 'demon1_atta8', function() { this._ai.charge(6); });
    this._defineState('demon1_atta8', 'attacka8', 'demon1_atta9', function() { this._ai.charge(8); });
    this._defineState('demon1_atta9', 'attacka9', 'demon1_atta10', function() { this._ai.charge(4); });
    this._defineState('demon1_atta10', 'attacka10', 'demon1_atta11', function() { this._ai.charge(2); });
    this._defineState('demon1_atta11', 'attacka11', 'demon1_atta12', function() { this._meleeAttack(-200); });
    this._defineState('demon1_atta12', 'attacka12', 'demon1_atta13', function() { this._ai.charge(5); });
    this._defineState('demon1_atta13', 'attacka13', 'demon1_atta14', function() { this._ai.charge(8); });
    this._defineState('demon1_atta14', 'attacka14', 'demon1_atta15', function() { this._ai.charge(4); });
    this._defineState('demon1_atta15', 'attacka15', 'demon1_run1', function() { this._ai.charge(4); });

    // pain states
    this._defineState('demon1_pain1', 'pain1', 'demon1_pain2', function() {});
    this._defineState('demon1_pain2', 'pain2', 'demon1_pain3', function() {});
    this._defineState('demon1_pain3', 'pain3', 'demon1_pain4', function() {});
    this._defineState('demon1_pain4', 'pain4', 'demon1_pain5', function() {});
    this._defineState('demon1_pain5', 'pain5', 'demon1_pain6', function() {});
    this._defineState('demon1_pain6', 'pain6', 'demon1_run1', function() {});

    // die states
    this._defineState('demon1_die1', 'death1', 'demon1_die2', function() { this.deathSound(); });
    this._defineState('demon1_die2', 'death2', 'demon1_die3', function() {});
    this._defineState('demon1_die3', 'death3', 'demon1_die4', function() {});
    this._defineState('demon1_die4', 'death4', 'demon1_die5', function() {});
    this._defineState('demon1_die5', 'death5', 'demon1_die6', function() {});
    this._defineState('demon1_die6', 'death6', 'demon1_die7', function() { this.solid = solid.SOLID_NOT; });
    this._defineState('demon1_die7', 'death7', 'demon1_die8', function() {});
    this._defineState('demon1_die8', 'death8', 'demon1_die9', function() {});
    this._defineState('demon1_die9', 'death9', 'demon1_die9', function() {});
  }

  thinkStand() { this._runState('demon1_stand1'); }
  thinkWalk() { this._runState('demon1_walk1'); }
  thinkRun() { this._runState('demon1_run1'); }
  thinkMissile() { this._runState('demon1_jump1'); }
  thinkMelee() { this._runState('demon1_atta1'); }

  thinkPain(attackerEntity, damage) {
    if (this._isLeaping) {
      return;
    }

    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    this.pain_finished = this.game.time + 1;
    this.painSound();

    if (Math.random() * 200 > damage) {
      return; // didn't flinch
    }

    this._runState('demon1_pain1');
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);
    if (this.health < -80) {
      this._gib(true);
      return;
    }
    this._runState('demon1_die1');
  }

  checkAttack() {
    if (this._ai.enemyRange === range.RANGE_MELEE) {
      return ATTACK_STATE.AS_MELEE;
    }
    if (this._checkJump()) {
      this.startSound(channel.CHAN_VOICE, 'demon/djump.wav');
      return ATTACK_STATE.AS_MISSILE;
    }
    return null;
  }

  touch(touchedByEntity) {
    if (!this._isLeaping) {
      return;
    }

    if (this.health <= 0) {
      return;
    }

    if (touchedByEntity.takedamage) {
      if (this.velocity.len() > 400) {
        const ldmg = 40 + 10 * Math.random();
        this.damage(touchedByEntity, ldmg);
      }
    }

    if (!this.isOnTheFloor()) {
      if (this.flags & flags.FL_ONGROUND) { // jump randomly to not get hung up
        this._isLeaping = false;
        this._runState('demon1_jump1');
      }
      return; // not on the ground yet
    }

    this._isLeaping = false;
    this._runState('demon1_jump11');
  }

  /**
   * @returns {boolean} whether the demon should perform a jump attack
   */
  _checkJump() {
    if (!this.enemy) {
      return false;
    }

    if (this.origin[2] + this.mins[2] > this.enemy.origin[2] + this.enemy.mins[2] + 0.75 * this.enemy.size[2]) {
      return false;
    }

    if (this.origin[2] + this.maxs[2] < this.enemy.origin[2] + this.enemy.mins[2] + 0.25 * this.enemy.size[2]) {
      return false;
    }

    const dist = this.enemy.origin.copy().subtract(this.origin);
    dist[2] = 0;
    const distance = dist.len();

    if (distance < 100) {
      return false;
    }

    if (distance > 200 && Math.random() < 0.9) {
      return false;
    }

    return true;
  }

  /**
   * @returns {void}
   */
  _leap() {
    this._isLeaping = true;
    const { forward } = this.angles.angleVectors();
    this.origin[2]++;
    this.velocity.set(forward.multiply(600).add(new Vector(0, 0, 250)));
    this.flags &= ~flags.FL_ONGROUND;
  }

  // eslint-disable-next-line no-unused-vars
  use(_userEntity) {
    // no interaction
  }

  /**
   * Melee attack logic (QC: Demon_Melee)
   * @param {number} meleeSideForce force to apply to the side for the meat spray
   */
  _meleeAttack(meleeSideForce) {
    this._ai.face();
    this.walkMove(this.ideal_yaw, 12); // allow a little closing

    if (!this.enemy) {
      return;
    }

    if (this.enemy.origin.distanceTo(this.origin) > 100) {
      return;
    }

    if (!this.enemy.canReceiveDamage(this)) {
      return;
    }

    this.attackSound();

    const ldmg = 10 + 5 * Math.random();
    this.damage(this.enemy, ldmg);

    const { forward, right } = this.angles.angleVectors();
    MeatSprayEntity.sprayMeat(this, forward.multiply(16.0).add(this.origin), right.multiply(meleeSideForce));
  }

  idleSound() {
    if (Math.random() >= 0.2) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, 'demon/idle1.wav', 1.0, attn.ATTN_IDLE);
  }

  attackSound() {
    this.startSound(channel.CHAN_WEAPON, 'demon/dhit2.wav');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'demon/dpain1.wav');
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'demon/ddeath.wav');
  }

  hasMeleeAttack() {
    return true;
  }

  hasMissileAttack() {
    return true;
  }
}
