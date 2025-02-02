/* global Vector */

import { EntityAI } from "../../helper/AI.mjs";
import BaseEntity from "../BaseEntity.mjs";

export default class BaseMonster extends BaseEntity {
  _declareFields() {
    super._declareFields();

    this.pausetime = 0;
    /** @type {BaseEntity} */
    this.movetarget = null; // entity
    this.health = 0;

    this.ideal_yaw = 0.0;
    this.yaw_speed = 0.0;
    this.view_ofs = new Vector();

    /** @type {?BaseEntity} acquired target */
    this.enemy = null;
    /** @type {BaseEntity} a movetarget or an enemy */
    this.goalentity = null;

    this._ai = this._newEntityAI();

    /** @type {number} refire count for nightmare */
    this.cnt = 0;
  }

  /**
   * this is used to override a better or more suitable AI for this entity
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
   */
  thinkDie() {
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

  attackFinished(normal) {
    // in nightmare mode, all attack_finished times become 0
    // some monsters refire twice automatically
    this.cnt = 0; // refire count for nightmare
    if (this.game.skill !== 3) {
      this.attack_finished = this.game.time + normal;
    }
  }
}
