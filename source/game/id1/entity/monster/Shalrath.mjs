import Vector from '../../../../shared/Vector.mjs';

import { channel, moveType, solid } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import BaseEntity from '../BaseEntity.mjs';
import { BaseProjectile } from '../Weapons.mjs';
import { WalkMonster } from './BaseMonster.mjs';
import ZombieMonster from './Zombie.mjs';

export const qc = `
$cd id1/models/shalrath
$origin 0 0 24
$base base
$skin skin
$scale 0.7

$frame attack1 attack2 attack3 attack4 attack5 attack6 attack7 attack8
$frame attack9 attack10 attack11

$frame pain1 pain2 pain3 pain4 pain5

$frame death1 death2 death3 death4 death5 death6 death7

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7 walk8 walk9 walk10
$frame walk11 walk12
`;

/**
 * QUAKED monster_shalrath (1 0 0) (-32 -32 -24) (32 32 48) Ambush
 */
export default class ShalrathMonsterEntity extends WalkMonster {
  static classname = 'monster_shalrath';
  static _health = 400;
  static _size = [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0)];
  static _modelDefault = 'progs/shalrath.mdl';
  static _modelHead = 'progs/h_shal.mdl';

  get netname() {
    return 'a Vore';
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _initStates() {
    // Stand
    this._defineState('shal_stand', 'walk1', 'shal_stand', function () { this._ai.stand(); });

    // Walk
    this._defineState('shal_walk1', 'walk2', 'shal_walk2', function () { this.idleSound(); this._ai.walk(6); });
    this._defineState('shal_walk2', 'walk3', 'shal_walk3', function () { this._ai.walk(4); });
    this._defineState('shal_walk3', 'walk4', 'shal_walk4', function () { this._ai.walk(0); });
    this._defineState('shal_walk4', 'walk5', 'shal_walk5', function () { this._ai.walk(0); });
    this._defineState('shal_walk5', 'walk6', 'shal_walk6', function () { this._ai.walk(0); });
    this._defineState('shal_walk6', 'walk7', 'shal_walk7', function () { this._ai.walk(0); });
    this._defineState('shal_walk7', 'walk8', 'shal_walk8', function () { this._ai.walk(5); });
    this._defineState('shal_walk8', 'walk9', 'shal_walk9', function () { this._ai.walk(6); });
    this._defineState('shal_walk9', 'walk10', 'shal_walk10', function () { this._ai.walk(5); });
    this._defineState('shal_walk10', 'walk11', 'shal_walk11', function () { this._ai.walk(0); });
    this._defineState('shal_walk11', 'walk12', 'shal_walk12', function () { this._ai.walk(4); });
    this._defineState('shal_walk12', 'walk1', 'shal_walk1', function () { this._ai.walk(5); });

    // Run
    this._defineState('shal_run1', 'walk2', 'shal_run2', function () { this.idleSound(); this._ai.run(6); });
    this._defineState('shal_run2', 'walk3', 'shal_run3', function () { this._ai.run(4); });
    this._defineState('shal_run3', 'walk4', 'shal_run4', function () { this._ai.run(0); });
    this._defineState('shal_run4', 'walk5', 'shal_run5', function () { this._ai.run(0); });
    this._defineState('shal_run5', 'walk6', 'shal_run6', function () { this._ai.run(0); });
    this._defineState('shal_run6', 'walk7', 'shal_run7', function () { this._ai.run(0); });
    this._defineState('shal_run7', 'walk8', 'shal_run8', function () { this._ai.run(5); });
    this._defineState('shal_run8', 'walk9', 'shal_run9', function () { this._ai.run(6); });
    this._defineState('shal_run9', 'walk10', 'shal_run10', function () { this._ai.run(5); });
    this._defineState('shal_run10', 'walk11', 'shal_run11', function () { this._ai.run(0); });
    this._defineState('shal_run11', 'walk12', 'shal_run12', function () { this._ai.run(4); });
    this._defineState('shal_run12', 'walk1', 'shal_run1', function () { this._ai.run(5); });

    // Attack
    this._defineState('shal_attack1', 'attack1', 'shal_attack2', function () { this.attackSound(); this._ai.face(); });
    this._defineState('shal_attack2', 'attack2', 'shal_attack3', function () { this._ai.face(); });
    this._defineState('shal_attack3', 'attack3', 'shal_attack4', function () { this._ai.face(); });
    this._defineState('shal_attack4', 'attack4', 'shal_attack5', function () { this._ai.face(); });
    this._defineState('shal_attack5', 'attack5', 'shal_attack6', function () { this._ai.face(); });
    this._defineState('shal_attack6', 'attack6', 'shal_attack7', function () { this._ai.face(); });
    this._defineState('shal_attack7', 'attack7', 'shal_attack8', function () { this._ai.face(); });
    this._defineState('shal_attack8', 'attack8', 'shal_attack9', function () { this._ai.face(); });
    this._defineState('shal_attack9', 'attack9', 'shal_attack10', function () { this.launchMissile(); });
    this._defineState('shal_attack10', 'attack10', 'shal_attack11', function () { this._ai.face(); });
    this._defineState('shal_attack11', 'attack11', 'shal_run1', function () {});

    // Pain
    this._defineState('shal_pain1', 'pain1', 'shal_pain2', function () {});
    this._defineState('shal_pain2', 'pain2', 'shal_pain3', function () {});
    this._defineState('shal_pain3', 'pain3', 'shal_pain4', function () {});
    this._defineState('shal_pain4', 'pain4', 'shal_pain5', function () {});
    this._defineState('shal_pain5', 'pain5', 'shal_run1', function () {});

    // Death
    this._defineState('shal_death1', 'death1', 'shal_death2', function () {});
    this._defineState('shal_death2', 'death2', 'shal_death3', function () {});
    this._defineState('shal_death3', 'death3', 'shal_death4', function () {});
    this._defineState('shal_death4', 'death4', 'shal_death5', function () {});
    this._defineState('shal_death5', 'death5', 'shal_death6', function () {});
    this._defineState('shal_death6', 'death6', 'shal_death7', function () {});
    this._defineState('shal_death7', 'death7', 'shal_death7', function () {});
  }

  _precache() {
    super._precache();

    this.engine.PrecacheModel('progs/v_spike.mdl');

    this.engine.PrecacheSound('shalrath/attack.wav');
    this.engine.PrecacheSound('shalrath/attack2.wav');
    this.engine.PrecacheSound('shalrath/death.wav');
    this.engine.PrecacheSound('shalrath/idle.wav');
    this.engine.PrecacheSound('shalrath/pain.wav');
    this.engine.PrecacheSound('shalrath/sight.wav');
  }

  thinkDie() {
    if (this.health < -90) {
      this._gib(true);
      return;
    }

    this.deathSound();
    this._runState('shal_death1');
    this.solid = solid.SOLID_NOT;
  }

  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    this.painSound();
    this._runState('shal_pain1');
    this.pain_finished = this.game.time + 3.0;
  }

  thinkStand() {
    this._runState('shal_stand');
  }

  thinkWalk() {
    this._runState('shal_walk1');
  }

  thinkRun() {
    this._runState('shal_run1');
  }

  thinkMissile() {
    this._runState('shal_attack1');
  }

  launchMissile() { // QuakeC: shalrath.qc/ShalMissile
    console.log('launchMissile not implemented for ShalrathMonsterEntity', this);

    if (!this.enemy) {
      return;
    }

    const movedir = this.enemy.origin.copy().subtract(this.origin);
    movedir.normalize();
    this.movedir.set(movedir);

    this.engine.SpawnEntity(ShalrathMissileEntity.classname, {
      owner: this,
    });
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, 'shalrath/idle.wav');
    }
  }

  attackSound() {
    this.startSound(channel.CHAN_VOICE, 'shalrath/attack.wav');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'shalrath/pain.wav');
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'shalrath/death.wav');
  }

  hasMissileAttack() {
    return true;
  }
};

export class ShalrathMissileEntity extends BaseProjectile {
  static classname = 'monster_shalrath_missile';

  /**
   * @param {BaseEntity} touchedByEntity impacted entity
   * @protected
   */
  _handleImpact(touchedByEntity) {
    if (this.owner && touchedByEntity.equals(this.owner)) {
      return; // don't explode on owner
    }

    // zombies get a special treatment, because they are more resistant to damage
    if (touchedByEntity instanceof ZombieMonster) {
      this.damage(touchedByEntity, 110, this.owner, this.origin);
    }

    this._damageInflictor.blastDamage(40, this.owner, this.origin);

    this.velocity.normalize();
    this.origin.subtract(this.velocity.multiply(8.0));

    this._becomeExplosion();
  }

  home() {
    const enemy = (/** @type {ShalrathMonsterEntity} */ (this.owner)).enemy;

    if (!enemy || enemy.health < 1) {
      this.remove();
      return;
    }

    const dir = enemy.origin.copy().add(new Vector(0.0, 0.0, 10.0)).subtract(this.origin);
    dir.normalize();
    dir.multiply(this.game.skill === 3 ? 350 : 250);
    this.velocity.set(dir);

    this._scheduleThink(this.game.time + 0.2, () => this.home());
  }

  spawn() {
    console.assert(this.owner, 'Needs an owner');

    super.spawn();

    this.movetype = moveType.MOVETYPE_FLYMISSILE;

    this.velocity.multiply(400.0);

    this.setModel('progs/v_spike.mdl');
    this.setSize(Vector.origin, Vector.origin);

    const enemy = (/** @type {ShalrathMonsterEntity} */ (this.owner)).enemy;
    const dist = this.origin.distanceTo(enemy.origin);
    this._scheduleThink(this.game.time + Math.max(0.1, dist * 0.002), () => this.home());
  }
};

