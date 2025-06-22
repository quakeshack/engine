/* global Vector */

import { channel, effect } from "../../Defs.mjs";
import { QuakeEntityAI } from "../../helper/AI.mjs";
import { LightGlobeDynamicEntity } from "../Misc.mjs";
import { MeatSprayEntity, WalkMonster } from "./BaseMonster.mjs";

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

  _newEntityAI() {
    return new QuakeEntityAI(this);
  }

  _precache() {
    super._precache();

    this.engine.PrecacheModel("progs/s_light.mdl");
    this.engine.PrecacheModel("progs/bolt.mdl");
    this.engine.PrecacheSound("shambler/sattck1.wav");
    this.engine.PrecacheSound("shambler/sboom.wav");
    this.engine.PrecacheSound("shambler/sdeath.wav");
    this.engine.PrecacheSound("shambler/shurt2.wav");
    this.engine.PrecacheSound("shambler/sidle.wav");
    this.engine.PrecacheSound("shambler/ssight.wav");
    this.engine.PrecacheSound("shambler/melee1.wav");
    this.engine.PrecacheSound("shambler/melee2.wav");
    this.engine.PrecacheSound("shambler/smack.wav");
  }

  _initStates() {

  }

  shamClaw(side) { // QuakeC: shambler.qc/ShamClaw
    console.log('implement me: shamClaw', this);
  }

  castLightning() { // QuakeC: shambler.qc/CastLightning
    console.log('implement me: castLightning', this);
    this.startSound(channel.CHAN_WEAPON, "shambler/sboom.wav");
  }

  lightGlobe() { // QuakeC: shambler.qc/sham_magic3
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

    this.startSound(channel.CHAN_VOICE, "shambler/smack.wav");

    MeatSprayEntity.sprayMeat(this);
    MeatSprayEntity.sprayMeat(this);
  }

  melee() {
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
    this._ai.foundTarget(attackerEntity);
    this.painSound();

    if (this.health <= 0) {
      return;
    }

    if (Math.random() * 400 > damage) {
      return;
    }

    if (this.pain_finished > this.engine.time) {
      return;
    }

    this.pain_finished = this.engine.time + 2.0;

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
    this._runState('sham_magic1');
  }

  painSound() {
    this.emitSound("shambler/shurt2.wav");
  }

  deathSound() {
    this.emitSound("shambler/sdeath.wav");
  }

  idleSound() {
    if (Math.random() < 0.2) {
      this.emitSound("shambler/sidle.wav");
    }
  }

  sightSound() {
    this.emitSound("shambler/ssight.wav");
  }

  attackSound() {
    // handled in the attack states
  }

  hasMeleeAttack() {
    return true;
  }
}

