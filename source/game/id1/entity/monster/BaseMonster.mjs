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

    /** @type {BaseEntity} */
    this.enemy = null; // acquired target
    /** @type {BaseEntity} */
    this.goalentity = null; // a movetarget or an enemy

    this._ai = this._newEntityAI();
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
    this.nextthink = this.nextthink + Math.random() * 0.5;
    this._ai.spawn();
  }

  think() {
    super.think();
    this._ai.think();
  }

  use(userEntity) {
    this._ai.use(userEntity);
    super.use(userEntity);
  }

  sightSound() {
    // implement: startSound here
  }
}
