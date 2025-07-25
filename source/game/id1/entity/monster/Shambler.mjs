import Vector from '../../../../shared/Vector.mjs';

import { channel, effect, solid, tentType } from '../../Defs.mjs';
import { QuakeEntityAI } from '../../helper/AI.mjs';
import { LightGlobeDynamicEntity } from '../Misc.mjs';
import { DamageInflictor } from '../Weapons.mjs';
import { MeatSprayEntity, WalkMonster } from './BaseMonster.mjs';

export const qc = `
$cd id1/models/shams
$origin 0 0 24
$base base
$skin base

$frame stand1 stand2 stand3 stand4 stand5 stand6 stand7 stand8 stand9
$frame stand10 stand11 stand12 stand13 stand14 stand15 stand16 stand17

$frame walk1 walk2 walk3 walk4 walk5 walk6 walk7
$frame walk8 walk9 walk10 walk11 walk12

$frame	run1 run2 run3 run4 run5 run6

$frame smash1 smash2 smash3 smash4 smash5 smash6 smash7
$frame smash8 smash9 smash10 smash11 smash12

$frame swingr1 swingr2 swingr3 swingr4 swingr5
$frame swingr6 swingr7 swingr8 swingr9

$frame swingl1 swingl2 swingl3 swingl4 swingl5
$frame swingl6 swingl7 swingl8 swingl9

$frame magic1 magic2 magic3 magic4 magic5
$frame magic6 magic7 magic8 magic9 magic10 magic11 magic12

$frame pain1 pain2 pain3 pain4 pain5 pain6

$frame death1 death2 death3 death4 death5 death6
$frame death7 death8 death9 death10 death11
`;

/**
 * QUAKED monster_shambler (1 0 0) (-32 -32 -24) (32 32 64) Ambush
 */
export default class ShamblerMonsterEntity extends WalkMonster {
  static classname = 'monster_shambler';
  static _health = 600;
  static _size = [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0)];
  static _modelDefault = 'progs/shambler.mdl';
  static _modelHead = 'progs/h_shams.mdl';

  get netname() {
    return 'a Shambler';
  }

  _declareFields() {
    super._declareFields();

    this._damageInflictor = new DamageInflictor(this);
  }

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _precache() {
    super._precache();

    this.engine.PrecacheModel('progs/s_light.mdl');
    this.engine.PrecacheModel('progs/bolt.mdl');
    this.engine.PrecacheSound('shambler/sattck1.wav');
    this.engine.PrecacheSound('shambler/sboom.wav');
    this.engine.PrecacheSound('shambler/sdeath.wav');
    this.engine.PrecacheSound('shambler/shurt2.wav');
    this.engine.PrecacheSound('shambler/sidle.wav');
    this.engine.PrecacheSound('shambler/ssight.wav');
    this.engine.PrecacheSound('shambler/melee1.wav');
    this.engine.PrecacheSound('shambler/melee2.wav');
    this.engine.PrecacheSound('shambler/smack.wav');
  }

  _initStates() {
    // Stand states
    this._defineState('sham_stand1', 'stand1', 'sham_stand2', () => { this._ai.stand(); });
    this._defineState('sham_stand2', 'stand2', 'sham_stand3', () => { this._ai.stand(); });
    this._defineState('sham_stand3', 'stand3', 'sham_stand4', () => { this._ai.stand(); });
    this._defineState('sham_stand4', 'stand4', 'sham_stand5', () => { this._ai.stand(); });
    this._defineState('sham_stand5', 'stand5', 'sham_stand6', () => { this._ai.stand(); });
    this._defineState('sham_stand6', 'stand6', 'sham_stand7', () => { this._ai.stand(); });
    this._defineState('sham_stand7', 'stand7', 'sham_stand8', () => { this._ai.stand(); });
    this._defineState('sham_stand8', 'stand8', 'sham_stand9', () => { this._ai.stand(); });
    this._defineState('sham_stand9', 'stand9', 'sham_stand10', () => { this._ai.stand(); });
    this._defineState('sham_stand10', 'stand10', 'sham_stand11', () => { this._ai.stand(); });
    this._defineState('sham_stand11', 'stand11', 'sham_stand12', () => { this._ai.stand(); });
    this._defineState('sham_stand12', 'stand12', 'sham_stand13', () => { this._ai.stand(); });
    this._defineState('sham_stand13', 'stand13', 'sham_stand14', () => { this._ai.stand(); });
    this._defineState('sham_stand14', 'stand14', 'sham_stand15', () => { this._ai.stand(); });
    this._defineState('sham_stand15', 'stand15', 'sham_stand16', () => { this._ai.stand(); });
    this._defineState('sham_stand16', 'stand16', 'sham_stand17', () => { this._ai.stand(); });
    this._defineState('sham_stand17', 'stand17', 'sham_stand1', () => { this._ai.stand(); });

    // Walk states
    this._defineState('sham_walk1', 'walk1', 'sham_walk2', () => { this._ai.walk(10); });
    this._defineState('sham_walk2', 'walk2', 'sham_walk3', () => { this._ai.walk(9); });
    this._defineState('sham_walk3', 'walk3', 'sham_walk4', () => { this._ai.walk(9); });
    this._defineState('sham_walk4', 'walk4', 'sham_walk5', () => { this._ai.walk(5); });
    this._defineState('sham_walk5', 'walk5', 'sham_walk6', () => { this._ai.walk(6); });
    this._defineState('sham_walk6', 'walk6', 'sham_walk7', () => { this._ai.walk(12); });
    this._defineState('sham_walk7', 'walk7', 'sham_walk8', () => { this._ai.walk(8); });
    this._defineState('sham_walk8', 'walk8', 'sham_walk9', () => { this._ai.walk(3); });
    this._defineState('sham_walk9', 'walk9', 'sham_walk10', () => { this._ai.walk(13); });
    this._defineState('sham_walk10', 'walk10', 'sham_walk11', () => { this._ai.walk(9); });
    this._defineState('sham_walk11', 'walk11', 'sham_walk12', () => { this._ai.walk(7); });
    this._defineState('sham_walk12', 'walk12', 'sham_walk1', () => { this._ai.walk(7); this.idleSound(); });

    // Run states
    this._defineState('sham_run1', 'run1', 'sham_run2', () => { this._ai.run(20); });
    this._defineState('sham_run2', 'run2', 'sham_run3', () => { this._ai.run(24); });
    this._defineState('sham_run3', 'run3', 'sham_run4', () => { this._ai.run(20); });
    this._defineState('sham_run4', 'run4', 'sham_run5', () => { this._ai.run(20); });
    this._defineState('sham_run5', 'run5', 'sham_run6', () => { this._ai.run(24); });
    this._defineState('sham_run6', 'run6', 'sham_run1', () => { this._ai.run(20); this.idleSound(); });

    // Smash states
    this._defineState('sham_smash1', 'smash1', 'sham_smash2', () => { this.startSound(channel.CHAN_VOICE, 'shambler/melee1.wav'); this._ai.charge(2); });
    this._defineState('sham_smash2', 'smash2', 'sham_smash3', () => { this._ai.charge(6); });
    this._defineState('sham_smash3', 'smash3', 'sham_smash4', () => { this._ai.charge(6); });
    this._defineState('sham_smash4', 'smash4', 'sham_smash5', () => { this._ai.charge(5); });
    this._defineState('sham_smash5', 'smash5', 'sham_smash6', () => { this._ai.charge(4); });
    this._defineState('sham_smash6', 'smash6', 'sham_smash7', () => { this._ai.charge(1); });
    this._defineState('sham_smash7', 'smash7', 'sham_smash8', () => { this._ai.charge(0); });
    this._defineState('sham_smash8', 'smash8', 'sham_smash9', () => { this._ai.charge(0); });
    this._defineState('sham_smash9', 'smash9', 'sham_smash10', () => { this._ai.charge(0); });
    this._defineState('sham_smash10', 'smash10', 'sham_smash11', () => { this.smashAttack(); });
    this._defineState('sham_smash11', 'smash11', 'sham_smash12', () => { this._ai.charge(5); });
    this._defineState('sham_smash12', 'smash12', 'sham_run1', () => { this._ai.charge(4); });

    // Swing left states
    this._defineState('sham_swingl1', 'swingl1', 'sham_swingl2', () => { this.startSound(channel.CHAN_VOICE, 'shambler/melee2.wav'); this._ai.charge(5); });
    this._defineState('sham_swingl2', 'swingl2', 'sham_swingl3', () => { this._ai.charge(3); });
    this._defineState('sham_swingl3', 'swingl3', 'sham_swingl4', () => { this._ai.charge(7); });
    this._defineState('sham_swingl4', 'swingl4', 'sham_swingl5', () => { this._ai.charge(3); });
    this._defineState('sham_swingl5', 'swingl5', 'sham_swingl6', () => { this._ai.charge(7); });
    this._defineState('sham_swingl6', 'swingl6', 'sham_swingl7', () => { this._ai.charge(9); });
    this._defineState('sham_swingl7', 'swingl7', 'sham_swingl8', () => { this._ai.charge(5); this.shamClaw(250); });
    this._defineState('sham_swingl8', 'swingl8', 'sham_swingl9', () => { this._ai.charge(4); });
    this._defineState('sham_swingl9', 'swingl9', 'sham_run1', () => { this._ai.charge(8); if (Math.random() < 0.5) {this._runState('sham_swingr1');} });

    // Swing right states
    this._defineState('sham_swingr1', 'swingr1', 'sham_swingr2', () => { this.startSound(channel.CHAN_VOICE, 'shambler/melee1.wav'); this._ai.charge(1); });
    this._defineState('sham_swingr2', 'swingr2', 'sham_swingr3', () => { this._ai.charge(8); });
    this._defineState('sham_swingr3', 'swingr3', 'sham_swingr4', () => { this._ai.charge(14); });
    this._defineState('sham_swingr4', 'swingr4', 'sham_swingr5', () => { this._ai.charge(7); });
    this._defineState('sham_swingr5', 'swingr5', 'sham_swingr6', () => { this._ai.charge(3); });
    this._defineState('sham_swingr6', 'swingr6', 'sham_swingr7', () => { this._ai.charge(6); });
    this._defineState('sham_swingr7', 'swingr7', 'sham_swingr8', () => { this._ai.charge(6); this.shamClaw(-250); });
    this._defineState('sham_swingr8', 'swingr8', 'sham_swingr9', () => { this._ai.charge(3); });
    this._defineState('sham_swingr9', 'swingr9', 'sham_run1', () => { this._ai.charge(1); this._ai.charge(10); if (Math.random() < 0.5) {this._runState('sham_swingl1');} });

    // Death states
    this._defineState('sham_death1', 'death1', 'sham_death2');
    this._defineState('sham_death2', 'death2', 'sham_death3');
    this._defineState('sham_death3', 'death3', 'sham_death4', () => { this.solid = solid.SOLID_NOT; });
    this._defineState('sham_death4', 'death4', 'sham_death5');
    this._defineState('sham_death5', 'death5', 'sham_death6');
    this._defineState('sham_death6', 'death6', 'sham_death7');
    this._defineState('sham_death7', 'death7', 'sham_death8');
    this._defineState('sham_death8', 'death8', 'sham_death9');
    this._defineState('sham_death9', 'death9', 'sham_death10');
    this._defineState('sham_death10', 'death10', 'sham_death11');
    this._defineState('sham_death11', 'death11', 'sham_death11');

    // Pain states
    this._defineState('sham_pain1', 'pain1', 'sham_pain2');
    this._defineState('sham_pain2', 'pain2', 'sham_pain3');
    this._defineState('sham_pain3', 'pain3', 'sham_pain4');
    this._defineState('sham_pain4', 'pain4', 'sham_pain5');
    this._defineState('sham_pain5', 'pain5', 'sham_pain6');
    this._defineState('sham_pain6', 'pain6', 'sham_run1');

    this._defineState('sham_magic1', 'magic1', 'sham_magic2', () => { this._ai.face(); this.attackSound(); });
    this._defineState('sham_magic2', 'magic2', 'sham_magic3', () => { this._ai.face(); });
    this._defineState('sham_magic3', 'magic3', 'sham_magic3b', () => { this._ai.face(); this._lightBolt(); });
    this._defineState('sham_magic3b', 'magic3', 'sham_magic4', () => { this._ai.face(); });
    this._defineState('sham_magic4', 'magic4', 'sham_magic5', () => { this.effects |= effect.EF_MUZZLEFLASH; });
    this._defineState('sham_magic5', 'magic5', 'sham_magic6', () => { this.effects |= effect.EF_MUZZLEFLASH; });
    this._defineState('sham_magic6', 'magic6', 'sham_magic9', () => { this.castLightning(); });
    // magic7, magic8 are missing
    this._defineState('sham_magic9', 'magic9', 'sham_magic10', () => { this.castLightning(); });
    this._defineState('sham_magic10', 'magic10', 'sham_magic11', () => { this.castLightning(); });
    this._defineState('sham_magic11', 'magic11', 'sham_magic12', () => { if (this.game.skill === 3) {this.castLightning();} });
    this._defineState('sham_magic12', 'magic12', 'sham_run1');
  }

  shamClaw(side) { // QuakeC: shambler.qc/ShamClaw
    if (!this.enemy) {
      return;
    }

    this._ai.charge(10);

    const distance = this.origin.distanceTo(this.enemy.origin);

    if (distance > 100) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 20;

    this.damage(this.enemy, ldmg);

    if (side) {
      MeatSprayEntity.sprayMeat(this);
    }
  }

  castLightning() { // QuakeC: shambler.qc/CastLightning
    if (!this.enemy) {
      return;
    }

    this.startSound(channel.CHAN_WEAPON, 'shambler/sboom.wav');

    this._ai.face();

    const origin = this.origin.copy().add(new Vector(0.0, 0.0, 40.0));
    const target = this.enemy.origin.copy().subtract(origin).add(new Vector(0.0, 0.0, 16.0));
    target.normalize();
    target.multiply(600.0);
    target.add(this.origin);

    const trace = this.traceline(origin, target, true);

    this._damageInflictor.lightningDamage(origin, trace.point, 10);
    this._damageInflictor.dispatchBeamEvent(tentType.TE_LIGHTNING1, trace.point, origin);
  }

  /**
   * Spawns a light bolt effect at the Shambler's origin.
   * @private
   */
  _lightBolt() { // QuakeC: shambler.qc/sham_magic3
    this.effects |= effect.EF_MUZZLEFLASH;

    this.engine.SpawnEntity(LightGlobeDynamicEntity.classname, {
      origin: this.origin.copy(),
      angles: this.angles.copy(),
    });
  }

  smashAttack() { // QuakeC: shambler.qc/sham_smash10
    if (!this.enemy) {
      return;
    }

    if (this.origin.distanceTo(this.enemy.origin) > 100) {
      return;
    }

    if (!this.enemy.canReceiveDamage(this)) {
      return;
    }

    const ldmg = (Math.random() + Math.random() + Math.random()) * 40;

    this.damage(this.enemy, ldmg);

    this.smackSound();

    MeatSprayEntity.sprayMeat(this);
    MeatSprayEntity.sprayMeat(this);
  }

  thinkMelee() {
    const r = Math.random();

    if (r > 0.6 || this.health === 600) {
      this._runState('sham_smash1');
    } else if (r > 0.3) {
      this._runState('sham_swingr1');
    } else {
      this._runState('sham_swingl1');
    }
  }

  thinkPain(attackerEntity, damage) {
    this.painSound();

    if (this.health <= 0) {
      return;
    }

    if (Math.random() * 400 > damage) {
      return;
    }

    if (this.pain_finished > this.game.time) {
      return;
    }

    this._ai.foundTarget(attackerEntity);

    this.pain_finished = this.game.time + 2.0;

    this._runState('sham_pain1');
  }

  thinkDie() {
    if (this.health < -60) {
      this._gib(true);
      return;
    }

    this.deathSound();
    this._runState('sham_death1');
  }

  thinkStand() {
    this._runState('sham_stand1');
  }

  thinkWalk() {
    this._runState('sham_walk1');
  }

  thinkRun() {
    this._runState('sham_run1');
  }

  thinkMissile() {
    this.pain_finished = this.game.time + 2.0;
    this._runState('sham_magic1');
  }

  painSound() {
    this.startSound(channel.CHAN_VOICE, 'shambler/shurt2.wav');
  }

  deathSound() {
    this.startSound(channel.CHAN_VOICE, 'shambler/sdeath.wav');
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.startSound(channel.CHAN_VOICE, 'shambler/sidle.wav');
    }
  }

  sightSound() {
    this.startSound(channel.CHAN_VOICE, 'shambler/ssight.wav');
  }

  smackSound() {
    this.startSound(channel.CHAN_VOICE, 'shambler/smack.wav');
  }

  attackSound() {
    this.startSound(channel.CHAN_VOICE, 'shambler/sattck1.wav');
  }

  hasMeleeAttack() {
    return true;
  }

  hasMissileAttack() {
    return true;
  }
}

