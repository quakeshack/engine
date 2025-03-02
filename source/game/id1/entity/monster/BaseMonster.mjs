/* global Vector */

import { EntityAI } from "../../helper/AI.mjs";
import BaseEntity from "../BaseEntity.mjs";
import { DamageHandler } from "../Weapons.mjs";

export default class BaseMonster extends BaseEntity {
  _declareFields() {
    super._declareFields();

    this.pausetime = 0;
    this.pain_finished = 0;
    /** @type {BaseEntity} */
    this.movetarget = null; // entity
    this.health = 0;

    this.ideal_yaw = 0.0;
    this.yaw_speed = 0.0;
    this.view_ofs = new Vector();

    this.bloodcolor = 73; // FIXME: hardcoded color code (73)

    /** @type {?BaseEntity} acquired target */
    this.enemy = null;
    /** @type {BaseEntity} a movetarget or an enemy */
    this.goalentity = null;

    /** @protected */
    this._ai = this._newEntityAI();

    /** @type {number} refire count for nightmare */
    this.cnt = 0;

    this._damageHandler = new DamageHandler(this);
  }

  /**
   * this is used to override a better or more suitable AI for this entity
   * @protected
   * @returns {EntityAI} responsible entity AI
   */
  _newEntityAI() {
    return new EntityAI(this);
  }

  isActor() {
    return true;
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

  spawn() {
    this.game.total_monsters++;
    this._ai.spawn();

    this._scheduleThink(this.nextthink + Math.random() * 0.5, () => this._ai.think());
  }

  use(userEntity) {
    this._ai.use(userEntity);
    super.use(userEntity);
  }

  sightSound() {
    // implement: startSound here
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
