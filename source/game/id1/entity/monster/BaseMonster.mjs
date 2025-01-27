import { EntityAI } from "../../helper/AI.mjs";
import BaseEntity from "../BaseEntity.mjs";

export default class BaseMonster extends BaseEntity {
  _declareFields() {
    super._declareFields();

    this.pausetime = 0;
    this.movetarget = null; // entity
    this.health = 0;

    this._ai = new EntityAI(this);
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

  walkmonsterStart() {
    // TODO
  }

  /**
   * when getting attacked
   *
   * @param {BaseEntity} attackerEntity
   * @param {number} damage
   */
  // eslint-disable-next-line no-unused-vars
  thinkPain(attackerEntity, damage) {
  }
}
