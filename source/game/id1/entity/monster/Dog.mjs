import Vector from '../../../../shared/Vector.mjs';

import { attn, channel, flags, range, solid } from '../../Defs.mjs';
import { ATTACK_STATE, QuakeEntityAI } from '../../helper/AI.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { WalkMonster } from './BaseMonster.mjs';

export const qc = `
$cd id1/models/dog
$origin 0 0 24
$base base
$skin skin

$frame attack1 attack2 attack3 attack4 attack5 attack6 attack7 attack8

$frame death1 death2 death3 death4 death5 death6 death7 death8 death9

$frame deathb1 deathb2 deathb3 deathb4 deathb5 deathb6 deathb7 deathb8
$frame deathb9

$frame pain1 pain2 pain3 pain4 pain5 pain6

$frame painb1 painb2 painb3 painb4 painb5 painb6 painb7 painb8 painb9 painb10
$frame painb11 painb12 painb13 painb14 painb15 painb16

$frame run1 run2 run3 run4 run5 run6 run7 run8 run9 run10 run11 run12

$frame leap1 leap2 leap3 leap4 leap5 leap6 leap7 leap8 leap9

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8
`;

export default class DogMonsterEntity extends WalkMonster {
  static classname = 'monster_dog';

  static _health = 25;
  static _size = [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 40.0)];

  static _modelDefault = 'progs/dog.mdl';
  static _modelHead = 'progs/h_dog.mdl';

  get netname() {
    return 'a Rottweiler';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    /** @private */
    this._isLeaping = false;

    this._serializer.endFields();
  }

  _precache() {
    super._precache();

    this.engine.PrecacheSound('dog/dattack1.wav');
    this.engine.PrecacheSound('dog/ddeath.wav');
    this.engine.PrecacheSound('dog/dpain1.wav');
    this.engine.PrecacheSound('dog/dsight.wav');
    this.engine.PrecacheSound('dog/idle.wav');
  }

  _initStates() {
    this._defineState('dog_stand1', 'stand1', 'dog_stand2', function () { this._ai.stand(); });
    this._defineState('dog_stand2', 'stand2', 'dog_stand3', function () { this._ai.stand(); });
    this._defineState('dog_stand3', 'stand3', 'dog_stand4', function () { this._ai.stand(); });
    this._defineState('dog_stand4', 'stand4', 'dog_stand5', function () { this._ai.stand(); });
    this._defineState('dog_stand5', 'stand5', 'dog_stand6', function () { this._ai.stand(); });
    this._defineState('dog_stand6', 'stand6', 'dog_stand7', function () { this._ai.stand(); });
    this._defineState('dog_stand7', 'stand7', 'dog_stand8', function () { this._ai.stand(); });
    this._defineState('dog_stand8', 'stand8', 'dog_stand9', function () { this._ai.stand(); });
    this._defineState('dog_stand9', 'stand9', 'dog_stand1', function () { this._ai.stand(); });

    this._defineState('dog_walk1', 'walk1', 'dog_walk2', function () { this.idleSound(); this._ai.walk(8); });
    this._defineState('dog_walk2', 'walk2', 'dog_walk3', function () { this._ai.walk(8); });
    this._defineState('dog_walk3', 'walk3', 'dog_walk4', function () { this._ai.walk(8); });
    this._defineState('dog_walk4', 'walk4', 'dog_walk5', function () { this._ai.walk(8); });
    this._defineState('dog_walk5', 'walk5', 'dog_walk6', function () { this._ai.walk(8); });
    this._defineState('dog_walk6', 'walk6', 'dog_walk7', function () { this._ai.walk(8); });
    this._defineState('dog_walk7', 'walk7', 'dog_walk8', function () { this._ai.walk(8); });
    this._defineState('dog_walk8', 'walk8', 'dog_walk1', function () { this._ai.walk(8); });

    this._defineState('dog_run1', 'run1', 'dog_run2', function () { this._isLeaping = false; this.idleSound(); this._ai.run(16); });
    this._defineState('dog_run2', 'run2', 'dog_run3', function () { this._ai.run(32); });
    this._defineState('dog_run3', 'run3', 'dog_run4', function () { this._ai.run(32); });
    this._defineState('dog_run4', 'run4', 'dog_run5', function () { this._ai.run(20); });
    this._defineState('dog_run5', 'run5', 'dog_run6', function () { this._ai.run(64); });
    this._defineState('dog_run6', 'run6', 'dog_run7', function () { this._ai.run(32); });
    this._defineState('dog_run7', 'run7', 'dog_run8', function () { this._ai.run(16); });
    this._defineState('dog_run8', 'run8', 'dog_run9', function () { this._ai.run(32); });
    this._defineState('dog_run9', 'run9', 'dog_run10', function () { this._ai.run(32); });
    this._defineState('dog_run10', 'run10', 'dog_run11', function () { this._ai.run(20); });
    this._defineState('dog_run11', 'run11', 'dog_run12', function () { this._ai.run(64); });
    this._defineState('dog_run12', 'run12', 'dog_run1', function () { this._ai.run(32); });

    this._defineState('dog_atta1', 'attack1', 'dog_atta2', function () { this._ai.charge(10); });
    this._defineState('dog_atta2', 'attack2', 'dog_atta3', function () { this._ai.charge(10); });
    this._defineState('dog_atta3', 'attack3', 'dog_atta4', function () { this._ai.charge(10); });
    this._defineState('dog_atta4', 'attack4', 'dog_atta5', function () { this.attackSound(); this._bite(); });
    this._defineState('dog_atta5', 'attack5', 'dog_atta6', function () { this._ai.charge(10); });
    this._defineState('dog_atta6', 'attack6', 'dog_atta7', function () { this._ai.charge(10); });
    this._defineState('dog_atta7', 'attack7', 'dog_atta8', function () { this._ai.charge(10); });
    this._defineState('dog_atta8', 'attack8', 'dog_run1', function () { this._ai.charge(10); });

    this._defineState('dog_leap1', 'leap1', 'dog_leap2', function () { this._ai.face(); });
    this._defineState('dog_leap2', 'leap2', 'dog_leap3', function () { this._ai.face(); this._leap(); });
    this._defineState('dog_leap3', 'leap3', 'dog_leap4', function () { });
    this._defineState('dog_leap4', 'leap4', 'dog_leap5', function () { });
    this._defineState('dog_leap5', 'leap5', 'dog_leap6', function () { });
    this._defineState('dog_leap6', 'leap6', 'dog_leap7', function () { });
    this._defineState('dog_leap7', 'leap7', 'dog_leap8', function () { });
    this._defineState('dog_leap8', 'leap8', 'dog_leap9', function () { });
    this._defineState('dog_leap9', 'leap9', 'dog_run1', function () { });

    this._defineState('dog_pain1', 'pain1', 'dog_pain2', function () { });
    this._defineState('dog_pain2', 'pain2', 'dog_pain3', function () { });
    this._defineState('dog_pain3', 'pain3', 'dog_pain4', function () { });
    this._defineState('dog_pain4', 'pain4', 'dog_pain5', function () { });
    this._defineState('dog_pain5', 'pain5', 'dog_pain6', function () { });
    this._defineState('dog_pain6', 'pain6', 'dog_run1', function () { });

    this._defineState('dog_painb1', 'painb1', 'dog_painb2', function () { });
    this._defineState('dog_painb2', 'painb2', 'dog_painb3', function () { this._ai.pain(4); });
    this._defineState('dog_painb3', 'painb3', 'dog_painb4', function () { this._ai.pain(12); });
    this._defineState('dog_painb4', 'painb4', 'dog_painb5', function () { this._ai.pain(12); });
    this._defineState('dog_painb5', 'painb5', 'dog_painb6', function () { this._ai.pain(2); });
    this._defineState('dog_painb6', 'painb6', 'dog_painb7', function () { });
    this._defineState('dog_painb7', 'painb7', 'dog_painb8', function () { this._ai.pain(4); });
    this._defineState('dog_painb8', 'painb8', 'dog_painb9', function () { });
    this._defineState('dog_painb9', 'painb9', 'dog_painb10', function () { this._ai.pain(10); });
    this._defineState('dog_painb10', 'painb10', 'dog_painb11', function () { });
    this._defineState('dog_painb11', 'painb11', 'dog_painb12', function () { });
    this._defineState('dog_painb12', 'painb12', 'dog_painb13', function () { });
    this._defineState('dog_painb13', 'painb13', 'dog_painb14', function () { });
    this._defineState('dog_painb14', 'painb14', 'dog_painb15', function () { });
    this._defineState('dog_painb15', 'painb15', 'dog_painb16', function () { });
    this._defineState('dog_painb16', 'painb16', 'dog_run1', function () { });

    this._defineState('dog_die1', 'death1', 'dog_die2', function () { });
    this._defineState('dog_die2', 'death2', 'dog_die3', function () { });
    this._defineState('dog_die3', 'death3', 'dog_die4', function () { });
    this._defineState('dog_die4', 'death4', 'dog_die5', function () { });
    this._defineState('dog_die5', 'death5', 'dog_die6', function () { });
    this._defineState('dog_die6', 'death6', 'dog_die7', function () { });
    this._defineState('dog_die7', 'death7', 'dog_die8', function () { });
    this._defineState('dog_die8', 'death8', 'dog_die9', function () { });
    this._defineState('dog_die9', 'death9', 'dog_die9', function () { });

    this._defineState('dog_dieb1', 'deathb1', 'dog_dieb2', function () { });
    this._defineState('dog_dieb2', 'deathb2', 'dog_dieb3', function () { });
    this._defineState('dog_dieb3', 'deathb3', 'dog_dieb4', function () { });
    this._defineState('dog_dieb4', 'deathb4', 'dog_dieb5', function () { });
    this._defineState('dog_dieb5', 'deathb5', 'dog_dieb6', function () { });
    this._defineState('dog_dieb6', 'deathb6', 'dog_dieb7', function () { });
    this._defineState('dog_dieb7', 'deathb7', 'dog_dieb8', function () { });
    this._defineState('dog_dieb8', 'deathb8', 'dog_dieb9', function () { });
    this._defineState('dog_dieb9', 'deathb9', 'dog_dieb9', function () { });
  }

  touch(otherEntity) {
    if (!this._isLeaping || this.health < 0) {
      return;
    }
    // apply damage on impact
    if (otherEntity.takedamage && this.velocity.len() > 300) {
      const damage = 10 + Math.random() * 10;
      this.damage(otherEntity, damage);
    }
    // if still airborne, wait to land
    if (!this.isOnTheFloor()) {
      return;
    }
    // landed: resume running
    this._isLeaping = false;
    this._runState('dog_run1');
  }

  _bite() {
    if (!this.enemy) {
      return;
    }

    this._ai.charge(10);

    if (!this.enemy.canReceiveDamage(this)) {
      return;
    }

    if (this.enemy.origin.distanceTo(this.origin) > 100) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 8;

    this.damage(this.enemy, ldmg);
  }

  /** @private */
  _leap() {
    this._isLeaping = true;
    const { forward } = this.angles.angleVectors();
    // perform leap: move up and forward
    this.origin[2]++;
    // forward speed 300 and upward speed 200
    this.velocity.set(forward.multiply(300.0).add(new Vector(0.0, 0.0, 200.0)));
    // clear onground flag to allow falling
    this.flags &= ~flags.FL_ONGROUND;
  }

  /**
   * Testing command to perform a leap.
   * @param {BaseEntity} userEntity entity invoking the use
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  use(userEntity) {
    // userEntity.damage(this, 20);
    if (this.health < 0) {
      return;
    }

    this.idleSound();
    this._leap();
  }

  thinkStand() {
    this._runState('dog_stand1');
  }

  thinkWalk() {
    this._runState('dog_walk1');
  }

  thinkRun() {
    this._runState('dog_run1');
  }

  thinkMissile() {
    this._runState('dog_leap1');
  }

  thinkMelee() {
    this._runState('dog_atta1');
  }

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    this._ai.foundTarget(attackerEntity);
    this.painSound();

    if (Math.random() > 0.5) {
      this._runState('dog_pain1');
    } else {
      this._runState('dog_painb1');
    }
  }

  thinkDie(attackerEntity) {
    this._sub.useTargets(attackerEntity);

    if (this.health < -35) {
      this._gib(true);
      return;
    }

    this.deathSound();
    this.solid = solid.SOLID_NOT;

    if (Math.random() > 0.5) {
      this._runState('dog_die1');
    } else {
      this._runState('dog_dieb1');
    }
  }

  /** @returns {ATTACK_STATE|null} attack state */
  checkAttack() {
    // if close enough for slashing, go for it
    if (this._checkMelee()) {
      return ATTACK_STATE.AS_MELEE;
    }

    if (this._checkJump()) {
      return ATTACK_STATE.AS_MISSILE;
    }

    return null;
  }

  /** @returns {boolean} if true, good to do a melee attack @private */
  _checkMelee() {
    return this._ai.enemyRange === range.RANGE_MELEE;
  }

  /** @private */
  _checkJump() {
    console.assert(this.enemy, 'active enemy required');

    if (this.origin[2] + this.mins[2] > this.enemy.origin[2] + this.enemy.mins[2] + 0.75 * this.enemy.size[2]) {
      return false;
    }

    if (this.origin[2] + this.maxs[2] < this.enemy.origin[2] + this.enemy.mins[2] + 0.25 * this.enemy.size[2]) {
      return false;
    }

    const dist = this.enemy.origin.copy().subtract(this.origin);
    dist[2] = 0.0;

    const d = dist.len();

    return !(d < 80 || d > 150);
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'dog/ddeath.wav');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'dog/dpain1.wav');
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'dog/dsight.wav');
  }

  idleSound() {
    if (Math.random() >= 0.2) {
      return;
    }

    this.startSound(channel.CHAN_VOICE, 'dog/idle.wav', 1.0, attn.ATTN_IDLE);
  }

  attackSound() {
    this.startSound(channel.CHAN_VOICE, 'dog/dattack1.wav');
  }

  hasMeleeAttack() {
    return true;
  }
};
