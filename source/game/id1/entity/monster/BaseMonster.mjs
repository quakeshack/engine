/* global Vector */

import { damage, moveType, solid } from "../../Defs.mjs";
import { EntityAI } from "../../helper/AI.mjs";
import BaseEntity from "../BaseEntity.mjs";
import { GibEntity } from "../Player.mjs";
import { Sub } from "../Subs.mjs";
import { DamageHandler } from "../Weapons.mjs";

export default class BaseMonster extends BaseEntity {

  static _health = 0;
  static _size = [null, null];

  static _modelDefault = null;
  static _modelHead = 'progs/gib1.mdl';

  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    this.pausetime = 0;
    this.pain_finished = 0;
    /** @type {?BaseEntity} */
    this.movetarget = null; // entity
    this.health = 0;

    this.ideal_yaw = 0.0;
    this.yaw_speed = 0.0;
    this.view_ofs = new Vector();

    this.bloodcolor = 73; // FIXME: hardcoded color code (73)

    /** @type {?BaseEntity} acquired target */
    this.enemy = null;
    /** @type {?BaseEntity} a movetarget or an enemy */
    this.goalentity = null;

    /** @type {number} refire count for nightmare */
    this.cnt = 0;

    /** @type {EntityAI} @protected */
    this._ai = this._newEntityAI();

    this._serializer.endFields();

    this._damageHandler = new DamageHandler(this);
    this._sub = new Sub(this);
  }

  _precache() {
    // precache monster model
    this.engine.PrecacheModel(this.constructor._modelDefault);
    this.engine.PrecacheModel(this.constructor._modelHead);

    // gib assets
    this.engine.PrecacheModel("progs/gib1.mdl");
    this.engine.PrecacheModel("progs/gib2.mdl");
    this.engine.PrecacheModel("progs/gib3.mdl");
    this.engine.PrecacheSound("player/udeath.wav");
  }

  /**
   * this is used to override a better or more suitable AI for this entity
   * @protected
   * @returns {EntityAI} responsible entity AI
   */
  _newEntityAI() {
    return new EntityAI(this);
  }

  /**
   * Turns this monster into gibs.
   * @protected
   * @param {boolean} playSound play sound upon gib
   */
  _gib(playSound) {
    GibEntity.gibEntity(this, this.constructor._modelHead, playSound);
  }

  isActor() {
    return true;
  }

  clear() {
    super.clear();
    this.enemy = null;
    this.goalentity = null;
    this.movetarget = null;
    this._ai.clear();
  }

  /**
   * when stands idle
   */
  thinkStand() {
  }

  /**
   * when walking
   */
  thinkWalk() {
  }

  /**
   * when running
   */
  thinkRun() {
  }

  /**
   * when missile is flying towards
   */
  thinkMissile() {
  }

  /**
   * when fighting in melee
   */
  thinkMelee() {
  }

  /**
   * when dying
   * @param {BaseEntity} attackerEntity attacker entity
   */
  // eslint-disable-next-line no-unused-vars
  thinkDie(attackerEntity) {
  }

  /**
   * when getting attacked
   * @param {BaseEntity} attackerEntity attacker entity
   * @param {number} damage damage
   */
  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
  }

  /**
   * Called by the AI code.
   * @returns {*} desired attack state
   */
  checkAttack() { // QuakeC: fight.qc/CheckAttack
    // TODO
    return null;
  }

  _preSpawn() {
    if (this.game.deathmatch || this.game.nomonsters) {
      this.remove();
      return false;
    }

    return true;
  }

  spawn() {
    if (!this._preSpawn()) {
      return;
    }

    const [mins, maxs] = this.constructor._size;

    console.assert(this.constructor._modelDefault, 'Monster model not set');
    console.assert(this.constructor._health > 0, 'Invalid health set');
    console.assert(mins instanceof Vector && maxs instanceof Vector, 'Invalid size set');

    this.health = this.constructor._health;
    this.takedamage = damage.DAMAGE_AIM;
    this.solid = solid.SOLID_SLIDEBOX;
    this.movetype = moveType.MOVETYPE_STEP;

    this.setModel(this.constructor._modelDefault);
    this.setSize(mins, maxs);

    this.game.total_monsters++;
    this._ai.spawn();

    this._scheduleThink(this.nextthink + Math.random() * 0.5, () => this._ai.think());
  }

  use(userEntity) {
    this._ai.use(userEntity);
  }

  painSound() {
    // implement: startSound here
  }

  sightSound() {
    // implement: startSound here
  }

  idleSound() {
    // implement: startSound here
  }

  attackSound() {
    // implement: startSound here
  }

  walk(dist) {
    if (this._ai.findTarget()) {
      return;
    }

    this.moveToGoal(dist);
  }

  /**
   * Currently only called by path_corner when touched and certain checks passed.
   * @param {import('../Misc.mjs').PathCornerEntity} markerEntity marker entity
   */
  moveTargetReached(markerEntity) {
    // TODO: t_movetarget self logic part
  //   if (self.classname == "monster_ogre")
  //     sound (self, CHAN_VOICE, "ogre/ogdrag.wav", 1, ATTN_IDLE);// play chainsaw drag sound

  // //dprint ("t_movetarget\n");
  //   self.goalentity = self.movetarget = find (world, targetname, other.target);
  //   self.ideal_yaw = vectoyaw(self.goalentity.origin - self.origin);
  //   if (!self.movetarget)
  //   {
  //     self.pausetime = time + 999999;
  //     self.th_stand ();
  //     return;
  //   }
  }

  attackFinished(normal) {
    // in nightmare mode, all attack_finished times become 0
    // some monsters refire twice automatically
    this.cnt = 0; // refire count for nightmare
    if (this.game.skill !== 3) {
      this.attack_finished = this.game.time + normal;
    }
  }
};

export class WalkMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};

export class FlyMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};

export class SwimMonster extends BaseMonster {
  _declareFields() {
    super._declareFields();
  }

  spawn() {
    super.spawn();
  }
};
